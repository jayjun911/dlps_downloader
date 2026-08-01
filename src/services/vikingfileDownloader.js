const { chromium } = require('playwright-core');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function findEdge() {
  for (const p of EDGE_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Injected before any page script runs — hides all Playwright/automation signals
// that Cloudflare Turnstile uses to detect bots.
const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
  window.chrome = { runtime: {} };
`;

function extractVikingfileHash(url) {
  const match = url.match(/vik(?:1ng|ing)file\.(?:com|site)\/f\/([a-zA-Z0-9_\-]+)/i);
  return match ? match[1] : null;
}

/**
 * Downloads a file from vikingfile.com using a real Edge browser to solve
 * Cloudflare Turnstile. The browser window is visible so Turnstile can
 * verify the session. It auto-solves within ~5 seconds for normal sessions.
 * If Turnstile shows a checkbox challenge, the user can click it.
 */
async function downloadFromVikingfile(fileUrl, destDir, onProgress, onStatus) {
  const hash = extractVikingfileHash(fileUrl);
  if (!hash) throw new Error(`Cannot parse vikingfile hash from URL: ${fileUrl}`);

  const pageUrl = `https://vik1ngfile.site/f/${hash}`;

  if (onStatus) onStatus('Opening Edge browser for Cloudflare Turnstile...');

  const edgePath = findEdge();
  if (!edgePath) throw new Error('Microsoft Edge not found. Install Edge or set EDGE_PATH env var.');

  let directUrl = null;

  const browser = await chromium.launch({
    executablePath: process.env.EDGE_PATH || edgePath,
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=900,650',
      '--window-position=100,100',
    ]
  });

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 900, height: 650 },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    });

    // Hide webdriver flag before any page script runs
    await context.addInitScript(STEALTH_SCRIPT);

    const page = await context.newPage();

    // Intercept the XHR POST response that contains {"link": "..."}
    // vikingfile posts cf-turnstile-response + ipv4 + ipv6 to the same /f/{hash} URL
    const linkPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Turnstile timed out after 120s.'));
      }, 120000);

      page.on('response', async (response) => {
        const respUrl = response.url();
        if (respUrl.includes('/f/') && response.request().method() === 'POST') {
          try {
            const text = await response.text();
            const json = JSON.parse(text);
            if (json.link) {
              clearTimeout(timeout);
              resolve(decodeURIComponent(json.link));
            }
          } catch (_) {}
        }
      });

      page.on('close', () => {
        clearTimeout(timeout);
        reject(new Error('Browser was closed before getting the download link.'));
      });
    });

    if (onStatus) onStatus('Browser open — Turnstile solving (click checkbox in browser if prompted)');
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    directUrl = await linkPromise;

  } finally {
    await browser.close().catch(() => {});
  }

  if (onStatus) onStatus('Got download URL — starting transfer...');

  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const downloadResp = await axios.get(directUrl, {
    responseType: 'stream',
    headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://vik1ngfile.site/' }
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
    catch (_) { filename = `${hash}.bin`; }
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

/**
 * Resolves only the direct download URL from a vikingfile link via browser.
 * Does NOT download the file — use this when handing off to FDM.
 */
async function resolveVikingfileDirectUrl(fileUrl, onStatus) {
  const hash = extractVikingfileHash(fileUrl);
  if (!hash) throw new Error(`Cannot parse vikingfile hash from URL: ${fileUrl}`);

  const pageUrl = `https://vik1ngfile.site/f/${hash}`;
  const edgePath = process.env.EDGE_PATH || findEdge();
  if (!edgePath) throw new Error('Microsoft Edge not found.');

  if (onStatus) onStatus('Opening Edge browser for Vikingfile Turnstile...');

  const browser = await chromium.launch({
    executablePath: edgePath,
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=900,650', '--window-position=100,100'],
  });

  let directUrl = null;
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 900, height: 650 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    await context.addInitScript(STEALTH_SCRIPT);
    const page = await context.newPage();

    directUrl = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Vikingfile Turnstile timed out after 120s.')), 120000);
      page.on('response', async (response) => {
        if (response.url().includes('/f/') && response.request().method() === 'POST') {
          try {
            const json = JSON.parse(await response.text());
            if (json.link) { clearTimeout(t); resolve(decodeURIComponent(json.link)); }
          } catch (_) {}
        }
      });
      page.on('close', () => { clearTimeout(t); reject(new Error('Browser closed before Vikingfile link was captured.')); });
      if (onStatus) onStatus('Browser open — Turnstile solving (click checkbox if prompted)');
      page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(reject);
    });
  } finally {
    await browser.close().catch(() => {});
  }

  if (!directUrl) throw new Error(`Failed to resolve Vikingfile direct URL for: ${fileUrl}`);

  let filename = null;
  try { filename = decodeURIComponent(path.basename(new URL(directUrl).pathname)); } catch (_) {}
  filename = (filename || `vikingfile_${hash}`).replace(/[\\/:*?"<>|]/g, '_').trim();

  return { directUrl, filename };
}

module.exports = { downloadFromVikingfile, resolveVikingfileDirectUrl, extractVikingfileHash };
