const { chromium } = require('playwright-core');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');

// ── Ad Blocker ──────────────────────────────────────────────────────────────
// Known ad / tracker / popup domains to block outright.
// Covers FileKeeper's ad networks (ethnicspue.com, pwngames, etc.)
const AD_BLOCK_PATTERNS = [
  // FileKeeper ad networks (seen in their HTML)
  'ethnicspue.com',
  'pwngames',
  'qn.ethn',
  // Standard ad networks
  'doubleclick.net',
  'googlesyndication.com',
  'googletagmanager.com',
  'googletagservices.com',
  'adservice.google.com',
  'pagead2.googlesyndication.com',
  'adnxs.com',
  'adsrvr.org',
  'advertising.com',
  'outbrain.com',
  'taboola.com',
  'criteo.com',
  'rubiconproject.com',
  'openx.net',
  'pubmatic.com',
  'smartadserver.com',
  'exoclick.com',
  'trafficjunky.com',
  'hilltopads.net',
  'traffichunt.com',
  'propellerads.com',
  'popcash.net',
  'popads.net',
  'yllix.com',
  'adcash.com',
  'realsrv.com',
  'clickadu.com',
  'bidvertiser.com',
  'ads.facebook.com',
  'connect.facebook.net',
  // Trackers
  'hotjar.com',
  'mixpanel.com',
  'amplitude.com',
  'segment.com',
  'fullstory.com',
  // Pop-under / redirect networks
  'clksite.com',
  'cltrack',
  'click.php',
  'popunder',
];

function isAdRequest(url) {
  const lower = url.toLowerCase();
  return AD_BLOCK_PATTERNS.some(p => lower.includes(p));
}

/**
 * Installs Playwright route-based ad blocking on a page.
 * Also suppresses new-tab pop-unders by closing them immediately.
 */
async function installAdBlocker(context, page) {
  // Block ad network requests at the network level
  await context.route('**/*', (route) => {
    if (isAdRequest(route.request().url())) {
      route.abort();
    } else {
      route.continue();
    }
  });

  // Kill any new popup/tab that opens (pop-under ads)
  context.on('page', async (newPage) => {
    try {
      const url = newPage.url();
      if (!url.includes('filekeeper.net')) {
        await newPage.close();
      }
    } catch (_) {}
  });
}

// ── uBlock Origin from Edge install ──────────────────────────────────────────
// Edge uBlock Origin extension IDs (may vary by install)
const UBLOCK_EDGE_IDS = [
  'odfafepnkmbhccpbejgmiehpchacaeak', // uBlock Origin (Edge Add-ons)
  'cjpalhdlnbpafiamejdnhcphjbkeiagm', // uBlock Origin (Chrome Web Store via Edge)
];

function findUblockExtensionPath() {
  const edgeExtDir = path.join(
    os.homedir(),
    'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Extensions'
  );
  if (!fs.existsSync(edgeExtDir)) return null;
  for (const id of UBLOCK_EDGE_IDS) {
    const extBase = path.join(edgeExtDir, id);
    if (fs.existsSync(extBase)) {
      // Find the version subfolder (e.g. 1.60.0_0)
      const versions = fs.readdirSync(extBase).filter(d =>
        fs.statSync(path.join(extBase, d)).isDirectory()
      );
      if (versions.length > 0) {
        // Pick the highest version
        versions.sort().reverse();
        const extPath = path.join(extBase, versions[0]);
        logger.info(`[FileKeeper] Found uBlock Origin at: ${extPath}`);
        return extPath;
      }
    }
  }
  return null;
}

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

// Hide automation signals
const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
  window.chrome = { runtime: {} };
`;

// Persistent session storage path
const SESSION_PATH = path.join(__dirname, '../../data/filekeeper_session.json');

/**
 * Extracts the FileKeeper file code from a URL.
 * Handles both https://filekeeper.net/f/CODE and https://filekeeper.net/CODE forms.
 */
function extractFilekeeperCode(url) {
  // Form: /f/CODE (user attempted but wrong — we strip this too for robustness)
  let match = url.match(/filekeeper\.net\/f\/([a-zA-Z0-9_-]+)/i);
  if (match) return match[1];
  // Standard short-URL form: /CODE
  match = url.match(/filekeeper\.net\/([a-zA-Z0-9_-]{6,})/i);
  if (match && !['api', 'register', 'login', 'premium', 'download', 'images', 'js', 'css'].includes(match[1])) {
    return match[1];
  }
  return null;
}

function loadSession() {
  try {
    if (fs.existsSync(SESSION_PATH)) {
      return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
    }
  } catch (_) {}
  return null;
}

function saveSession(cookies) {
  try {
    fs.writeFileSync(SESSION_PATH, JSON.stringify(cookies, null, 2), 'utf-8');
  } catch (_) {}
}

/**
 * Attempts to get the direct download URL via the API using stored session cookies.
 * FileKeeper uses a cookie-based session for logged-in users.
 *
 * Strategy:
 *   1. POST to login with credentials to get session cookies
 *   2. Use session cookies to call the file page, intercept the download XHR/redirect
 */
async function resolveFilekeeperDirectUrl(fileUrl, onStatus) {
  const code = extractFilekeeperCode(fileUrl);
  if (!code) throw new Error(`Cannot parse FileKeeper file code from URL: ${fileUrl}`);

  // Canonical file page URL (no /f/ prefix — that's user profiles)
  const pageUrl = `https://filekeeper.net/${code}`;

  const edgePath = process.env.EDGE_PATH || findEdge();
  if (!edgePath) throw new Error('Microsoft Edge not found. Install Edge or set EDGE_PATH env var.');

  if (onStatus) onStatus(`Opening browser for FileKeeper (${code})...`);

  let directUrl = null;
  let filename = null;

  const savedSession = loadSession();

  // Try to load uBlock Origin from Edge's existing install
  const ublockPath = findUblockExtensionPath();
  const launchArgs = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1000,700',
    '--window-position=100,80',
  ];
  if (ublockPath) {
    launchArgs.push(
      `--load-extension=${ublockPath}`,
      `--disable-extensions-except=${ublockPath}`
    );
    logger.info('[FileKeeper] Loading uBlock Origin into Playwright browser');
  }

  const browser = await chromium.launch({
    executablePath: edgePath,
    headless: false,
    args: launchArgs,
  });

  try {
    const contextOptions = {
      userAgent: USER_AGENT,
      viewport: { width: 1000, height: 700 },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    };

    // Restore saved cookies if available
    if (savedSession && savedSession.length > 0) {
      contextOptions.storageState = { cookies: savedSession, origins: [] };
    }

    const context = await browser.newContext(contextOptions);
    await context.addInitScript(STEALTH_SCRIPT);
    const page = await context.newPage();

    // Install Playwright-level ad blocker (route interception)
    await installAdBlocker(context, page);

    // ── Phase 1: Login if not already logged in ──────────────────────────────
    const email = process.env.FILEKEEPER_EMAIL;
    const password = process.env.FILEKEEPER_PASSWORD;

    if (!savedSession && email && password) {
      if (onStatus) onStatus('Logging into FileKeeper...');
      try {
        await page.goto('https://filekeeper.net/?op=login', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1500);

        // Fill login form
        const emailSelectors = ['input[type="email"]', 'input[name="email"]', 'input[name="login"]', 'input[placeholder*="email" i]'];
        const passSelectors = ['input[type="password"]', 'input[name="password"]', 'input[name="pass"]'];

        for (const sel of emailSelectors) {
          try { await page.fill(sel, email, { timeout: 3000 }); break; } catch (_) {}
        }
        for (const sel of passSelectors) {
          try { await page.fill(sel, password, { timeout: 3000 }); break; } catch (_) {}
        }

        // Submit
        const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Login")', 'button:has-text("Sign In")'];
        for (const sel of submitSelectors) {
          try { await page.click(sel, { timeout: 3000 }); break; } catch (_) {}
        }
        await page.waitForTimeout(2000);

        // Save session cookies
        const cookies = await context.cookies();
        if (cookies.length > 0) {
          saveSession(cookies);
          logger.info('[FileKeeper] Session saved for future use');
        }
      } catch (loginErr) {
        logger.warn(`[FileKeeper] Login attempt failed: ${loginErr.message}. Proceeding without login.`);
      }
    } else if (!savedSession && !email) {
      if (onStatus) onStatus('No FILEKEEPER_EMAIL/PASSWORD set — trying without login...');
    }

    // ── Phase 2: Navigate to file page and intercept download ────────────────
    const linkPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('FileKeeper download URL not captured within 120s.'));
      }, 120000);

      const done = (url, fname) => {
        clearTimeout(timeout);
        resolve({ url, fname });
      };

      // Watch ALL responses for any that look like a real file download
      page.on('response', async (response) => {
        try {
          const respUrl = response.url();
          const status = response.status();
          const ct = response.headers()['content-type'] || '';

          // 1. Direct binary/file response from CDN (non-filekeeper domain)
          if (
            !respUrl.includes('filekeeper.net') &&
            (
              ct.startsWith('application/octet-stream') ||
              ct.startsWith('application/zip') ||
              ct.startsWith('application/x-rar') ||
              ct.includes('download') ||
              /\.(pkg|exfat|zip|rar|iso|bin|7z|nsp|xci)\b/i.test(respUrl)
            ) &&
            status === 200
          ) {
            const disposition = response.headers()['content-disposition'] || '';
            let fname = null;
            const m = disposition.match(/filename\*=UTF-8''([^;\n]+)/i) ||
                      disposition.match(/filename="([^"]+)"/i) ||
                      disposition.match(/filename=([^;\n]+)/i);
            if (m) { try { fname = decodeURIComponent(m[1].trim()); } catch (_) { fname = m[1].trim(); } }
            if (!fname) { try { fname = decodeURIComponent(path.basename(new URL(respUrl).pathname)); } catch (_) {} }
            done(respUrl, fname);
            return;
          }

          // 2. JSON API response containing a download link
          if (ct.includes('application/json') && respUrl.includes('filekeeper.net')) {
            let text;
            try { text = await response.text(); } catch (_) { return; }
            let json;
            try { json = JSON.parse(text); } catch (_) { return; }
            const link = json.url || json.link || json.direct_link || json.download_url || json.dl_link;
            if (link && link.startsWith('http') && !link.includes('filekeeper.net')) {
              let fname = null;
              try { fname = decodeURIComponent(path.basename(new URL(link).pathname)); } catch (_) {}
              done(link, fname);
              return;
            }
          }

          // 3. 302/301 redirect going to a non-filekeeper CDN
          if ((status === 302 || status === 301)) {
            const location = response.headers()['location'] || '';
            if (location.startsWith('http') && !location.includes('filekeeper.net') &&
                !location.includes('google') && !location.includes('cloudflare')) {
              let fname = null;
              try { fname = decodeURIComponent(path.basename(new URL(location).pathname)); } catch (_) {}
              done(location, fname);
              return;
            }
          }
        } catch (_) {}
      });

      page.on('close', () => {
        clearTimeout(timeout);
        reject(new Error('Browser closed before a FileKeeper download URL was captured.'));
      });
    });

    if (onStatus) onStatus(`Navigating to ${pageUrl} ...`);
    // FileKeeper redirects /CODE → /download (302), carrying file context via session/cookie.
    // We navigate and follow the redirect; the /download page has the actual download button.
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for Vue.js to render the page content (the /download page is also Vue-rendered)
    if (onStatus) onStatus('Waiting for page to render...');
    await page.waitForTimeout(3000);

    // Try clicking the download button.
    // From page inspection: BUTTON id="download-button" text="Free download" is the confirmed element.
    if (onStatus) onStatus('Looking for download button...');

    const BUTTON_SELECTORS = [
      // ✅ Confirmed from page inspection (id="download-button")
      '#download-button',
      'button#download-button',
      // Fallback selectors
      'button:has-text("Free download")',
      'button:has-text("Download")',
      'a#download-link',
      '.nixcloud-btn',
      'a.nixcloud-btn',
      '[data-action="download"]',
    ];

    let clicked = false;
    for (const sel of BUTTON_SELECTORS) {
      try {
        await page.waitForSelector(sel, { timeout: 4000, state: 'visible' });
        if (onStatus) onStatus(`Clicking: ${sel}`);
        
        // Force DOM click to bypass invisible ad overlays that steal Playwright's simulated mouse clicks
        await page.evaluate((selector) => {
          const el = document.querySelector(selector);
          if (el) el.click();
        }, sel);
        
        clicked = true;
        if (onStatus) onStatus('Clicked download button — intercepting download URL...');
        break;
      } catch (_) {}
    }

    // After clicking "Free download", FileKeeper generates the link dynamically.
    // Poll <a id="download-link"> for up to 15 seconds.
    if (clicked) {
      if (onStatus) onStatus('Waiting for direct download link to be generated...');
      let directHref = null;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(500);
        directHref = await page.evaluate(() => {
          const el = document.getElementById('download-link');
          if (el && el.href && !el.href.endsWith('#') && el.href.startsWith('http')) return el.href;
          return null;
        }).catch(() => null);
        
        if (directHref && !directHref.includes('filekeeper.net')) {
          break;
        }
        directHref = null;
      }
      
      if (directHref) {
        let fname = null;
        try { fname = decodeURIComponent(path.basename(new URL(directHref).pathname)); } catch (_) {}
        directUrl = directHref;
        filename = fname;
      }
    }

    if (!clicked) {
      if (onStatus) onStatus('Standard selectors failed — scanning all links on page...');
      await page.waitForTimeout(2000);
      const href = await page.evaluate(() => {
        // Look for any visible anchor with download-related text or href
        const links = Array.from(document.querySelectorAll('a, button'));
        const dl = links.find(a =>
          a.offsetParent !== null && (
            (a.href && a.href.includes('download') && !a.href.endsWith('#')) ||
            (a.textContent && /free\s*download|start\s*download/i.test(a.textContent))
          )
        );
        return dl ? (dl.href || null) : null;
      });
      if (href) {
        if (onStatus) onStatus(`Found link via scan: ${href} — navigating...`);
        await page.goto(href, { waitUntil: 'commit', timeout: 20000 });
        clicked = true;
      } else {
        if (onStatus) onStatus('No download button found. Leaving browser open — please click Download manually.');
      }
    }


    // Save updated cookies after interaction
    const updatedCookies = await context.cookies();
    if (updatedCookies.length > 0) saveSession(updatedCookies);

    // If directUrl is not yet populated via DOM extraction, wait for network interception
    if (!directUrl) {
      const { url, fname } = await linkPromise;
      directUrl = url;
      filename = fname;
    }

  } finally {
    await browser.close().catch(() => {});
  }

  // Try to get real filename from Content-Disposition if we don't have one with a proper extension
  if (!filename || !path.extname(filename) || filename.length > 200) {
    try {
      if (onStatus) onStatus('Fetching headers to determine real filename...');
      // Use GET with stream and abort immediately to reliably get headers (HEAD is often blocked or lacks headers on CDNs)
      const controller = new AbortController();
      const headRes = await axios.get(directUrl, {
        responseType: 'stream',
        maxRedirects: 5,
        timeout: 15000,
        validateStatus: () => true,
        signal: controller.signal
      }).catch(e => {
        if (e.response) return e.response;
        throw e;
      });
      
      const disposition = headRes.headers['content-disposition'] || '';
      // Abort the download stream immediately since we only want headers
      controller.abort();
      
      let extracted = null;
      const m = disposition.match(/filename\*=UTF-8''([^;\n]+)/i) ||
                disposition.match(/filename="([^"]+)"/i) ||
                disposition.match(/filename=([^;\n]+)/i);
      if (m) { try { extracted = decodeURIComponent(m[1].trim()); } catch (_) { extracted = m[1].trim(); } }
      if (extracted) filename = extracted;
    } catch (_) {
      // Ignore errors, fallback to URL parsing
    }
  }

  // Fallback to sanitising URL path if still no good filename
  if (!filename || !path.extname(filename)) {
    try { filename = decodeURIComponent(path.basename(new URL(directUrl).pathname)); } catch (_) {}
  }
  filename = (filename || `filekeeper_${extractFilekeeperCode(fileUrl)}`).replace(/[\\/:*?"<>|]/g, '_').trim();
  if (!filename) filename = `filekeeper_${extractFilekeeperCode(fileUrl)}`;

  logger.info(`[FileKeeper] Resolved ${filename} → ${directUrl.substring(0, 80)}...`);
  return { directUrl, filename };
}

/**
 * Entry point called from fdmDownloader — resolves the direct URL then lets
 * FDM handle the actual transfer.
 */
async function downloadFromFilekeeper(fileUrl, destDir, onStatus) {
  return resolveFilekeeperDirectUrl(fileUrl, onStatus);
}

module.exports = { downloadFromFilekeeper, resolveFilekeeperDirectUrl, extractFilekeeperCode };
