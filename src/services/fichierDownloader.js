const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Parses content-disposition header to get a clean filename.
 */
function getFilenameFromDisposition(disposition) {
  if (!disposition) return null;
  
  // 1. Try filename* first (RFC 5987 UTF-8 encoding)
  const filenameStarMatch = disposition.match(/filename\*=\s*UTF-8''([^;\n]+)/i);
  if (filenameStarMatch) {
    try {
      return decodeURIComponent(filenameStarMatch[1].trim());
    } catch (e) {
      // fallback
    }
  }
  
  // 2. Try standard filename="value"
  const filenameMatch = disposition.match(/filename="([^"]+)"/i);
  if (filenameMatch) {
    return filenameMatch[1].trim();
  }
  
  // 3. Try standard filename=value (no quotes)
  const filenameNoQuotesMatch = disposition.match(/filename=([^;\n]+)/i);
  if (filenameNoQuotesMatch) {
    return filenameNoQuotesMatch[1].trim();
  }
  
  return null;
}

/**
 * Downloads a file from 1fichier using premium API.
 * 
 * @param {string} fileUrl 
 * @param {string} destDir 
 * @param {function} onProgress callback for updating download progress
 * @returns {Promise<{destPath: string, filename: string, size: number}>}
 */
async function download1fichier(fileUrl, destDir, onProgress) {
  const apiKey = process.env.FICHIER_API_KEY;
  if (!apiKey) {
    throw new Error('FICHIER_API_KEY is not defined in environment variables.');
  }

  // Ensure download dir exists
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // ── Step 1: Request premium direct download URL ──
  let tokenRes;
  try {
    tokenRes = await axios.post(
      'https://api.1fichier.com/v1/download/get_token.cgi',
      { url: fileUrl, single: 1 },
      { 
        headers: { 
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        } 
      }
    );
  } catch (err) {
    if (err.response && err.response.status === 404) {
      throw new Error('File not found (404) on 1fichier. The download link is likely dead or has been deleted.');
    }
    throw err;
  }

  if (tokenRes.data.status !== 'OK') {
    throw new Error(`1fichier token error: ${tokenRes.data.message || JSON.stringify(tokenRes.data)}`);
  }

  const directUrl = tokenRes.data.url;

  // ── Step 2: Stream Download to avoid OOM ──
  let downloadRes;
  try {
    downloadRes = await axios.get(directUrl, {
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Connection': 'keep-alive'
      }
    });
  } catch (err) {
    if (err.response && err.response.status === 404) {
      throw new Error('Download URL returned 404. The generated direct link has expired or is invalid.');
    }
    throw err;
  }

  // Extract filename from content-disposition header if available
  const disposition = downloadRes.headers['content-disposition'];
  let filename = getFilenameFromDisposition(disposition);
  
  if (!filename) {
    try {
      filename = path.basename(new URL(directUrl).pathname);
    } catch (e) {
      filename = 'downloaded_file.rar';
    }
  }

  // Sanitize filename of any forbidden characters for Windows just in case
  filename = filename.replace(/[\\/:*?"<>|]/g, '_');

  const destPath = path.join(destDir, filename);
  const totalBytes = parseInt(downloadRes.headers['content-length'], 10) || 0;

  // Check if file already exists with same size
  if (fs.existsSync(destPath) && totalBytes > 0) {
    try {
      const stats = fs.statSync(destPath);
      if (stats.size === totalBytes) {
        // Destroy the stream to close connection immediately and release resources
        downloadRes.data.destroy();
        return { destPath, filename, size: stats.size, skipped: true };
      }
    } catch (e) {
      // If error checking stats, proceed with normal download
    }
  }

  const writer = fs.createWriteStream(destPath);
  let receivedBytes = 0;

  downloadRes.data.on('data', (chunk) => {
    receivedBytes += chunk.length;
    if (onProgress) {
      const percent = totalBytes
        ? ((receivedBytes / totalBytes) * 100).toFixed(1)
        : '0';
      const receivedMB = (receivedBytes / (1024 * 1024)).toFixed(1);
      const totalMB = totalBytes
        ? (totalBytes / (1024 * 1024)).toFixed(1)
        : 'Unknown';
      onProgress({ percent, receivedMB, totalMB });
    }
  });

  downloadRes.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve({ destPath, filename, size: receivedBytes }));
    writer.on('error', (err) => {
      // Clean up incomplete file on error
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      reject(err);
    });
  });
}

module.exports = {
  download1fichier
};
