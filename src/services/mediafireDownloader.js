const axios = require('axios');
const fs = require('fs');
const path = require('path');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function extractMediafireId(url) {
  const match = url.match(/mediafire\.com\/file\/([a-z0-9]+)/i);
  return match ? match[1] : null;
}

/**
 * Resolves a MediaFire file URL to a direct CDN download URL and filename.
 * 
 * @param {string} fileUrl e.g. https://www.mediafire.com/file/uq1wy6gmhnacnsc/file
 * @returns {Promise<{directUrl: string, filename: string}>}
 */
async function resolveMediafireDirectUrl(fileUrl) {
  const fileId = extractMediafireId(fileUrl);
  if (!fileId) {
    throw new Error(`Cannot parse MediaFire file ID from URL: ${fileUrl}`);
  }

  const response = await axios.get(fileUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    }
  });

  const html = response.data;
  
  // Extract direct download link (id="downloadButton")
  const downloadButtonMatch = html.match(/id="downloadButton"[^>]*href="([^"]+)"/i) || 
                              html.match(/href="([^"]+)"[^>]*id="downloadButton"/i);
  
  if (!downloadButtonMatch) {
    // Check if the file has been removed or page has captcha
    if (html.includes('The key you provided for file access was invalid') || html.includes('dangerous file')) {
      const e = new Error(`File is blocked, dangerous, or not found on MediaFire (${fileId}).`);
      e.isLinkDead = true;
      throw e;
    }
    throw new Error(`Could not find downloadButton link on MediaFire page. Page structure might have changed.`);
  }

  const directUrl = downloadButtonMatch[1];

  // Extract filename
  // 1. Try to extract from the direct link itself
  let filename = null;
  try {
    const urlPath = new URL(directUrl).pathname;
    const base = path.basename(urlPath);
    if (base && base !== fileId) {
      filename = decodeURIComponent(base);
    }
  } catch (e) {}

  // 2. Fallback to extracting from class="filename" in HTML
  if (!filename) {
    const filenameMatch = html.match(/<div[^>]*class="filename"[^>]*>([^<]+)<\/div>/i);
    if (filenameMatch) {
      filename = filenameMatch[1].trim();
    }
  }

  // 3. Last fallback
  if (!filename) {
    filename = `${fileId}.bin`;
  }

  return { directUrl, filename };
}

/**
 * Downloads a file from mediafire.com.
 */
async function downloadFromMediafire(fileUrl, destDir, onProgress, onStatus) {
  if (onStatus) onStatus('Resolving MediaFire link...');
  
  const { directUrl, filename } = await resolveMediafireDirectUrl(fileUrl);
  const cleanFilename = filename.replace(/[\\/:*?"<>|]/g, '_').trim();
  const destPath = path.join(destDir, cleanFilename);

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Check if file already exists with same size
  let expectedSize = 0;
  try {
    const headResp = await axios.head(directUrl, {
      headers: { 'User-Agent': USER_AGENT }
    });
    expectedSize = parseInt(headResp.headers['content-length'], 10) || 0;
  } catch (e) {}

  if (fs.existsSync(destPath) && expectedSize > 0) {
    const stats = fs.statSync(destPath);
    if (stats.size === expectedSize) {
      return { destPath, filename: cleanFilename, size: stats.size, directUrl, skipped: true };
    }
  }

  if (onStatus) onStatus(`Starting streaming download: ${cleanFilename}...`);

  const response = await axios.get(directUrl, {
    responseType: 'stream',
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': fileUrl
    }
  });

  const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
  const writer = fs.createWriteStream(destPath);
  let downloaded = 0;

  await new Promise((resolve, reject) => {
    response.data.on('data', chunk => {
      downloaded += chunk.length;
      if (onProgress) onProgress(downloaded, totalBytes);
    });
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    response.data.on('error', reject);
  });

  return { destPath, filename: cleanFilename, size: downloaded, directUrl };
}

module.exports = {
  resolveMediafireDirectUrl,
  downloadFromMediafire,
  extractMediafireId
};
