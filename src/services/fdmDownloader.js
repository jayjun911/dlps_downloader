const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../utils/logger');

const FDM_EXE = process.env.DOWNLOAD_MANAGER || 'C:\\Program Files\\Softdeluxe\\Free Download Manager\\fdm.exe';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function getFilenameFromDisposition(disposition) {
  if (!disposition) return null;
  const filenameStarMatch = disposition.match(/filename\*=\s*UTF-8''([^;\n]+)/i);
  if (filenameStarMatch) {
    try { return decodeURIComponent(filenameStarMatch[1].trim()); } catch (e) {}
  }
  const filenameMatch = disposition.match(/filename="([^"]+)"/i);
  if (filenameMatch) return filenameMatch[1].trim();
  const noQuotesMatch = disposition.match(/filename=([^;\n]+)/i);
  if (noQuotesMatch) return noQuotesMatch[1].trim();
  return null;
}

async function get1fichierDirectUrlAndFilename(fileUrl, password = null) {
  const apiKey = process.env.FICHIER_API_KEY;
  if (!apiKey) throw new Error('FICHIER_API_KEY is not defined in environment variables.');

  let cleanUrl = fileUrl;
  const match = fileUrl.match(/^(https?:\/\/(?:[a-z0-9]+\.)?(?:1fichier\.com|1file\.com)\/(?:\?|#)?)([a-z0-9]{5,20})/i);
  if (match) {
    cleanUrl = `https://1fichier.com/?${match[2].toLowerCase()}`;
  }

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT
  };

  let tokenRes;
  try {
    // Try without password first
    tokenRes = await axios.post(
      'https://api.1fichier.com/v1/download/get_token.cgi',
      { url: cleanUrl, single: 1 },
      { headers }
    );
  } catch (err) {
    if (err.response && (err.response.status === 403 || err.response.status === 401) && password) {
      // Retry with password
      try {
        tokenRes = await axios.post(
          'https://api.1fichier.com/v1/download/get_token.cgi',
          { url: cleanUrl, single: 1, pass: password },
          { headers }
        );
      } catch (retryErr) {
        const msg = retryErr.response?.data?.message || retryErr.message;
        throw new Error(`1fichier API error (tried with password): ${msg}. URL: ${cleanUrl}`);
      }
    } else if (err.response) {
      if (err.response.status === 404) {
        const e = new Error('File not found (404) on 1fichier. The link is likely dead or has been deleted.');
        e.isLinkDead = true;
        throw e;
      }
      const msg = err.response.data?.message || err.message;
      throw new Error(`1fichier API error: ${msg}. URL: ${cleanUrl}`);
    } else {
      throw err;
    }
  }

  if (tokenRes.data.status !== 'OK') {
    throw new Error(`1fichier token error: ${tokenRes.data.message || JSON.stringify(tokenRes.data)}`);
  }

  const directUrl = tokenRes.data.url;

  // HEAD request to get filename from Content-Disposition
  let filename = null;
  try {
    const headRes = await axios.head(directUrl, {
      headers: { 'User-Agent': USER_AGENT },
      maxRedirects: 5,
      timeout: 15000
    });
    filename = getFilenameFromDisposition(headRes.headers['content-disposition']);
    if (!filename) {
      filename = decodeURIComponent(path.basename(new URL(directUrl).pathname));
    }
  } catch (e) {
    try { filename = decodeURIComponent(path.basename(new URL(directUrl).pathname)); } catch (_) {}
  }

  return { directUrl, filename: filename || 'downloaded_file' };
}

async function resolveDatanodesDirectUrl(fileUrl) {
  const { extractDatanodesId } = require('./datanodesDownloader');
  const fileId = extractDatanodesId(fileUrl);
  if (!fileId) throw new Error(`Cannot parse datanodes file ID from URL: ${fileUrl}`);

  const base = 'https://datanodes.to';
  const filePageUrl = `${base}/${fileId}`;
  const downloadPageUrl = `${base}/download`;
  const cookieStore = {};

  const parseCookies = (setCookieHeaders) => {
    if (!setCookieHeaders) return {};
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    const result = {};
    for (const h of arr) {
      const parts = h.split(';')[0].trim().split('=');
      if (parts.length >= 2) result[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
    return result;
  };
  const formatCookies = (store) => Object.entries(store).map(([k, v]) => `${k}=${v}`).join('; ');
  const makeHeaders = (extra = {}) => ({
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    ...extra,
    'Cookie': formatCookies(cookieStore)
  });
  const updateCookies = (response) => {
    const setCookie = response.headers['set-cookie'];
    if (setCookie) Object.assign(cookieStore, parseCookies(setCookie));
  };

  let step1;
  try {
    step1 = await axios.get(filePageUrl, { headers: makeHeaders(), maxRedirects: 0, validateStatus: s => s < 400 || s === 302 || s === 301 });
  } catch (err) {
    if (err.response && err.response.status === 404) {
      const e = new Error(`File not found on datanodes.to (${fileId}). The link may have expired.`);
      e.isLinkDead = true;
      throw e;
    }
    throw err;
  }
  updateCookies(step1);

  const step2 = await axios.get(downloadPageUrl, { headers: makeHeaders({ 'Referer': filePageUrl }), maxRedirects: 5 });
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

  const step3 = await axios.post(downloadPageUrl, new URLSearchParams({
    op: 'download1', usr_login: '', id: fileId, fname, referer: filePageUrl, method_free: 'Free Download >>'
  }).toString(), {
    headers: makeHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': base, 'Referer': downloadPageUrl }),
    maxRedirects: 5
  });
  updateCookies(step3);

  const countdownHtml = step3.data;
  const captchaMatch = countdownHtml.match(/:has-captcha="(true|false)"/);
  if (captchaMatch && captchaMatch[1] === 'true') throw new Error('datanodes.to requires reCAPTCHA. Cannot automate.');

  const randMatch = countdownHtml.match(/\brand="([^"]*)"/);
  const rand = randMatch ? randMatch[1] : '';
  const countdownMatch = countdownHtml.match(/:countdown="(\d+)"/);
  const waitSeconds = countdownMatch ? parseInt(countdownMatch[1], 10) : 0;
  if (waitSeconds > 0) await new Promise(resolve => setTimeout(resolve, (waitSeconds + 1) * 1000));

  const step4 = await axios.post(downloadPageUrl, new URLSearchParams({
    op: 'download2', id: fileId, rand, referer: filePageUrl,
    method_free: 'Free Download >>', method_premium: '', g_captch__a: '1'
  }).toString(), {
    headers: makeHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': base, 'Referer': downloadPageUrl }),
    maxRedirects: 0, validateStatus: s => s < 400
  });
  updateCookies(step4);

  let directUrl;
  try {
    const json = typeof step4.data === 'string' ? JSON.parse(step4.data) : step4.data;
    if (!json.url) throw new Error(`Unexpected response: ${JSON.stringify(json).substring(0, 200)}`);
    directUrl = decodeURIComponent(json.url);
  } catch (e) {
    const loc = step4.headers['location'];
    if (loc && loc.startsWith('http')) { directUrl = loc; }
    else throw new Error(`download2 did not return a URL. Response: ${JSON.stringify(step4.data).substring(0, 200)}`);
  }

  let filename = null;

  // 1. fname from step2 form — the actual filename; prioritize over CDN URL path
  if (fname && fname !== fileId && path.extname(fname) && fname.length <= 255) {
    filename = fname;
  }

  // 2. Content-Disposition from HEAD on direct URL
  if (!filename) {
    try {
      const headRes = await axios.head(directUrl, {
        headers: makeHeaders({ 'Referer': downloadPageUrl }),
        maxRedirects: 5,
        timeout: 15000
      });
      filename = getFilenameFromDisposition(headRes.headers['content-disposition']);
    } catch (e) { /* CDN may not support HEAD */ }
  }

  // 3. URL path basename — only accept if it has a recognisable file extension
  if (!filename) {
    try {
      const urlBase = decodeURIComponent(path.basename(new URL(directUrl).pathname));
      if (urlBase && path.extname(urlBase) && urlBase.length <= 200) filename = urlBase;
    } catch (_) {}
  }

  // 4. Final fallback
  if (!filename) filename = fname || `${fileId}.bin`;

  return { directUrl, filename };
}

const TEMP_EXTS = ['.fdmdownload', '.crdownload', '.part'];

function isTemp(filename) {
  return TEMP_EXTS.some(e => filename.endsWith(e));
}

function stripTemp(filename) {
  for (const e of TEMP_EXTS) {
    if (filename.endsWith(e)) return filename.slice(0, -e.length);
  }
  return filename;
}

/**
 * Waits for FDM to complete downloading.
 *
 * FDM pre-allocates the full file size in <name>.fdmdownload immediately, so
 * size growth cannot indicate progress or completion.  The only reliable signal
 * is: .fdmdownload disappears AND the final file appears (FDM does an atomic rename).
 *
 * Progress is reported as elapsed time + the pre-allocated size for context.
 */
function pollForFile(destDir, expectedFilename, startedAt, onStatus) {
  return new Promise((resolve, reject) => {
    const POLL_MS = 3000;
    const timeoutMinutes = parseInt(process.env.FDM_TIMEOUT_MINUTES || '60', 10);
    const TIMEOUT_MS = timeoutMinutes * 60 * 1000;
    // trackedName may change if FDM chose a slightly different filename
    let trackedName = expectedFilename;

    const fmt = (ms) => {
      const s = Math.floor(ms / 1000);
      return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    };

    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (elapsed > TIMEOUT_MS) {
        clearInterval(timer);
        return resolve({ destPath: null, filename: trackedName, size: 0, skipped: true, fdmTimeout: true });
      }

      try {
        const finalPath = path.join(destDir, trackedName);
        const tempPath  = path.join(destDir, trackedName + '.fdmdownload');

        // ── Completion: final file exists, no in-progress temp ───────────────
        if (fs.existsSync(finalPath) && !fs.existsSync(tempPath)) {
          const size = fs.statSync(finalPath).size;
          if (size > 0) {
            clearInterval(timer);
            return resolve({ destPath: finalPath, filename: trackedName, size });
          }
        }

        // ── Scan only our own .fdmdownload file for progress ────────────────
        // Never adopt a different name — that logic caused cross-game contamination
        // (user-queued FDM downloads or concurrent game downloads got mis-tracked).
        let allocatedStr = '';
        try {
          if (fs.existsSync(tempPath)) {
            const gb = (fs.statSync(tempPath).size / 1024 / 1024 / 1024).toFixed(2);
            allocatedStr = ` / ${gb} GB`;
          }
        } catch (e) {}

        if (onStatus) onStatus(`FDM downloading: ${trackedName} — ${fmt(elapsed)} elapsed${allocatedStr}`);
      } catch (e) {}
    }, POLL_MS);
  });
}

/**
 * Downloads a file using Free Download Manager (FDM).
 * Resolves the direct URL first (for 1fichier via API, for datanodes via flow),
 * then launches FDM and polls until the file is complete.
 *
 * @param {string} fileUrl Original URL (1fichier or datanodes)
 * @param {string} destDir Download destination directory
 * @param {function} onStatus Status callback (string)
 * @param {boolean} is1fichier True if the URL is a 1fichier link
 * @returns {Promise<{destPath: string, filename: string, size: number, skipped?: boolean}>}
 */
async function downloadWithFdm(fileUrl, destDir, onStatus, is1fichier = false, password = null) {
  if (!fs.existsSync(FDM_EXE)) {
    throw new Error(`Free Download Manager not found at: ${FDM_EXE}`);
  }

  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  if (onStatus) onStatus('Resolving direct download URL...');

  let directUrl, filename;
  if (/1fichier\.com|1file\.com/i.test(fileUrl)) {
    ({ directUrl, filename } = await get1fichierDirectUrlAndFilename(fileUrl, password));
  } else if (/mediafire\.com/i.test(fileUrl)) {
    if (onStatus) onStatus('Resolving MediaFire URL...');
    const { resolveMediafireDirectUrl } = require('./mediafireDownloader');
    ({ directUrl, filename } = await resolveMediafireDirectUrl(fileUrl));
  } else {
    if (onStatus) onStatus('Resolving datanodes URL (may take a moment)...');
    ({ directUrl, filename } = await resolveDatanodesDirectUrl(fileUrl));
  }

  filename = filename.replace(/[\\/:*?"<>|]/g, '_').trim();
  if (!filename) filename = 'downloaded_file';

  const destFilePath = path.join(destDir, filename);

  if (fs.existsSync(destFilePath)) {
    return { destPath: destFilePath, filename, size: fs.statSync(destFilePath).size, skipped: true };
  }

  if (onStatus) onStatus(`Launching FDM: ${filename}`);

  // FDM CLI: -u <URL>  -s (silent/no confirmation)  --hidden (suppress window)
  // Output folder and connections are controlled by FDM's own settings —
  // configure FDM's default download folder to match DOWNLOAD_DIR.
  execSync(`"${FDM_EXE}" -u "${directUrl}" -s --hidden`, { stdio: 'ignore' });

  const startedAt = Date.now();
  if (onStatus) onStatus(`FDM downloading: ${filename} — waiting for FDM to start...`);

  const result = await pollForFile(destDir, filename, startedAt, onStatus);

  return result;
}

/**
 * Resolves direct URLs for all fileUrls, queues them all in FDM simultaneously
 * (up to DOWNLOADER_SESSION at a time), then waits for every file concurrently.
 *
 * @returns {Promise<Array<{destPath,filename,size,fileUrl,skipped?}>>}
 */
async function downloadAllWithFdm(fileUrls, destDir, onStatus, is1fichier = false, password = null) {
  if (!fs.existsSync(FDM_EXE)) throw new Error(`FDM not found at: ${FDM_EXE}`);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  // Rolling window: resolve URL → queue in FDM → poll, up to DOWNLOADER_SIMUL_DOWN_LIMIT at a time.
  // URL is resolved immediately before queuing so tokens don't expire while waiting in FDM's queue.
  // All files must complete before returning — extraction never starts mid-download.
  const simultLimit = parseInt(process.env.DOWNLOADER_SIMUL_DOWN_LIMIT || '3', 10);
  const total = fileUrls.length;
  const results = new Array(total).fill(null);
  let firstError = null;

  async function processOne(idx) {
    const fileUrl = fileUrls[idx];
    const prefix = total > 1 ? `[${idx + 1}/${total}] ` : '';

    if (onStatus) onStatus(`${prefix}Resolving URL...`);
    let directUrl, filename;
    if (/1fichier\.com|1file\.com/i.test(fileUrl)) {
      ({ directUrl, filename } = await get1fichierDirectUrlAndFilename(fileUrl, password));
    } else if (/mediafire\.com/i.test(fileUrl)) {
      const { resolveMediafireDirectUrl } = require('./mediafireDownloader');
      ({ directUrl, filename } = await resolveMediafireDirectUrl(fileUrl));
    } else {
      ({ directUrl, filename } = await resolveDatanodesDirectUrl(fileUrl));
    }
    filename = filename.replace(/[\\/:*?"<>|]/g, '_').trim() || 'downloaded_file';

    const destPath = path.join(destDir, filename);
    if (fs.existsSync(destPath)) {
      return { fileUrl, destPath, filename, size: fs.statSync(destPath).size, skipped: true };
    }

    // Queue in FDM immediately after resolving — fresh token, no expiry risk
    execSync(`"${FDM_EXE}" -u "${directUrl}" -s --hidden`, { stdio: 'ignore' });
    const startedAt = Date.now();
    const r = await pollForFile(destDir, filename, startedAt, (msg) => {
      if (onStatus) onStatus(`${prefix}${msg}`);
    });
    return { ...r, fileUrl };
  }

  await new Promise((resolveAll) => {
    let nextIdx = 0;
    let active = 0;

    function startNext() {
      while (active < simultLimit && nextIdx < total) {
        const idx = nextIdx++;
        active++;
        processOne(idx)
          .then(r => { results[idx] = r; })
          .catch(e => { firstError = firstError || e; })
          .finally(() => {
            active--;
            if (active === 0 && nextIdx >= total) resolveAll();
            else startNext();
          });
      }
    }

    startNext();
  });

  if (firstError) throw firstError;
  return results.filter(Boolean);
}

module.exports = { downloadWithFdm, downloadAllWithFdm };
