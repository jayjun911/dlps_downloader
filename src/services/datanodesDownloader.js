const axios = require('axios');
const fs = require('fs');
const path = require('path');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function parseCookies(setCookieHeaders) {
  if (!setCookieHeaders) return {};
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  const result = {};
  for (const h of arr) {
    const parts = h.split(';')[0].trim().split('=');
    if (parts.length >= 2) {
      result[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  }
  return result;
}

function formatCookieHeader(cookieStore) {
  return Object.entries(cookieStore).map(([k, v]) => `${k}=${v}`).join('; ');
}

function extractDatanodesId(url) {
  const match = url.match(/datanodes\.to\/([a-z0-9]+)/i);
  return match ? match[1] : null;
}

/**
 * Downloads a file from datanodes.to without an account.
 *
 * datanodes flow (as of 2026-06):
 *   GET  /{id}       → 302  Set-Cookie: file_code={id}  Location: /download
 *   GET  /download   → 200  HTML with download form (fname inside)
 *   POST /download   op=download1  → 200  HTML with <download-countdown> Vue component
 *   POST /download   op=download2  → 200  JSON {"url":"..."}
 */
async function downloadFromDatanodes(fileUrl, destDir, onProgress, onStatus) {
  const fileId = extractDatanodesId(fileUrl);
  if (!fileId) throw new Error(`Cannot parse datanodes file ID from URL: ${fileUrl}`);

  const base = 'https://datanodes.to';
  const filePageUrl = `${base}/${fileId}`;
  const downloadPageUrl = `${base}/download`;
  const cookieStore = {};

  const makeHeaders = (extra = {}) => ({
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    ...extra,
    'Cookie': formatCookieHeader(cookieStore)
  });

  const updateCookies = (response) => {
    const setCookie = response.headers['set-cookie'];
    if (setCookie) Object.assign(cookieStore, parseCookies(setCookie));
  };

  // Step 1: GET /{id} — don't follow redirect so we capture Set-Cookie from the 302
  let step1;
  try {
    step1 = await axios.get(filePageUrl, {
      headers: makeHeaders(),
      maxRedirects: 0,
      validateStatus: s => s < 400 || s === 302 || s === 301
    });
  } catch (err) {
    if (err.response && err.response.status === 404) {
      const e = new Error(`File not found on datanodes.to (${fileId}). The link may have expired.`);
      e.isLinkDead = true;
      throw e;
    }
    throw err;
  }
  updateCookies(step1);

  // Step 2: GET /download with the file_code cookie
  const step2 = await axios.get(downloadPageUrl, {
    headers: makeHeaders({ 'Referer': filePageUrl }),
    maxRedirects: 5
  });
  updateCookies(step2);

  // Extract fname — handle both attribute orders, ignoring dummy "Free Download" input
  const fnameInputs = [...step2.data.matchAll(/<input[^>]*name="fname"[^>]*value="([^"]*)"[^>]*>/gi)];
  let fname = fileId;
  for (const m of fnameInputs) {
    if (m[1] && m[1] !== 'Free Download') {
      fname = m[1];
      break;
    }
  }
  if (fname === fileId) {
    const fnameInputMatch = step2.data.match(/<input[^>]*name="fname"[^>]*>/i);
    const fnameValueMatch = fnameInputMatch && fnameInputMatch[0].match(/value="([^"]*)"/i);
    if (fnameValueMatch && fnameValueMatch[1]) fname = fnameValueMatch[1];
  }

  // Step 3: POST download1 → countdown page
  const step3 = await axios.post(downloadPageUrl, new URLSearchParams({
    op: 'download1',
    usr_login: '',
    id: fileId,
    fname,
    referer: filePageUrl,
    method_free: 'Free Download >>'
  }).toString(), {
    headers: makeHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': base,
      'Referer': downloadPageUrl
    }),
    maxRedirects: 5
  });
  updateCookies(step3);

  const countdownHtml = step3.data;

  const randMatch = countdownHtml.match(/\brand="([^"]*)"/);
  const rand = randMatch ? randMatch[1] : '';

  const captchaMatch = countdownHtml.match(/:has-captcha="(true|false)"/);
  if (captchaMatch && captchaMatch[1] === 'true') {
    throw new Error('datanodes.to requires reCAPTCHA for this file. Cannot automate.');
  }

  const countdownMatch = countdownHtml.match(/:countdown="(\d+)"/);
  const waitSeconds = countdownMatch ? parseInt(countdownMatch[1], 10) : 0;
  if (waitSeconds > 0) {
    await new Promise(resolve => setTimeout(resolve, (waitSeconds + 1) * 1000));
  }

  // Step 4: POST download2 → JSON {"url": "..."}
  const step4 = await axios.post(downloadPageUrl, new URLSearchParams({
    op: 'download2',
    id: fileId,
    rand,
    referer: filePageUrl,
    method_free: 'Free Download >>',
    method_premium: '',
    g_captch__a: '1'
  }).toString(), {
    headers: makeHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': base,
      'Referer': downloadPageUrl
    }),
    maxRedirects: 0,
    validateStatus: s => s < 400
  });
  updateCookies(step4);

  let directUrl;
  try {
    const json = typeof step4.data === 'string' ? JSON.parse(step4.data) : step4.data;
    if (!json.url) throw new Error(`Unexpected response: ${JSON.stringify(json).substring(0, 200)}`);
    directUrl = decodeURIComponent(json.url);
  } catch (e) {
    const loc = step4.headers['location'];
    if (loc && loc.startsWith('http')) {
      directUrl = loc;
    } else {
      throw new Error(`download2 did not return a URL. Response: ${JSON.stringify(step4.data).substring(0, 200)}`);
    }
  }

  // Step 5: Stream download
  if (onStatus) onStatus(`Got URL — starting download...`);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const downloadResp = await axios.get(directUrl, {
    responseType: 'stream',
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': downloadPageUrl,
      'Cookie': formatCookieHeader(cookieStore)
    }
  });

  const disposition = downloadResp.headers['content-disposition'];
  let filename = null;
  if (disposition) {
    const m = disposition.match(/filename\*=UTF-8''([^;\n]+)/i) ||
              disposition.match(/filename="([^"]+)"/i) ||
              disposition.match(/filename=([^;\n]+)/i);
    if (m) {
      try { filename = decodeURIComponent(m[1].trim()); } catch (_) { filename = m[1].trim(); }
    }
  }
  if (!filename) {
    try { filename = decodeURIComponent(path.basename(new URL(directUrl).pathname)); }
    catch (_) { filename = fname || `${fileId}.bin`; }
  }
  filename = filename.replace(/[\\/:*?"<>|]/g, '_');

  const destPath = path.join(destDir, filename);
  const totalBytes = parseInt(downloadResp.headers['content-length'], 10) || 0;

  if (fs.existsSync(destPath) && totalBytes > 0) {
    const stats = fs.statSync(destPath);
    if (stats.size === totalBytes) {
      downloadResp.data.destroy();
      return { destPath, filename, size: stats.size, directUrl, skipped: true };
    }
  }

  const writer = fs.createWriteStream(destPath);
  let downloaded = 0;

  await new Promise((resolve, reject) => {
    downloadResp.data.on('data', chunk => {
      downloaded += chunk.length;
      if (onProgress) onProgress(downloaded, totalBytes);
    });
    downloadResp.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    downloadResp.data.on('error', reject);
  });

  return { destPath, filename, size: downloaded, directUrl };
}

module.exports = { downloadFromDatanodes, extractDatanodesId };
