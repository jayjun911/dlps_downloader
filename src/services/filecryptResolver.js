'use strict';

/**
 * filecryptResolver.js
 *
 * Resolves filecrypt.cc container links to their actual download URLs.
 *
 * filecrypt.cc uses a Proof-of-Work (PoW) CAPTCHA:
 *  1. Fetch /captchasession/{ID}.json  → { challenge, difficulty }
 *  2. Find nonce N such that SHA1("challenge:N") has >= difficulty leading zero bits
 *  3. POST the solution to the container page
 *  4. Follow redirect to /Link/{ID}.html which contains the real download URL
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ─── SHA-1 leading-zero-bits (ported directly from filecrypt's pow_captcha_worker.js) ─────

const _buf = Buffer.alloc(128);
const _w = new Int32Array(80);

/**
 * Returns the number of leading zero bits in the SHA-1 hash of `str`.
 * Identical logic to the browser worker – only handles short ASCII strings
 * (challenge is a 32-char hex + ':' + numeric nonce, well within 55 bytes).
 * @param {string} str
 * @returns {number}
 */
function sha1LeadingZeros(str) {
  const len = str.length;
  let total = len + 1 + 8;
  total = (total + 63) & ~63;

  _buf.fill(0, 0, total);
  for (let i = 0; i < len; i++) _buf[i] = str.charCodeAt(i) & 0xff;
  _buf[len] = 0x80;

  const bitLen = len * 8;
  _buf[total - 4] = (bitLen >>> 24) & 0xff;
  _buf[total - 3] = (bitLen >>> 16) & 0xff;
  _buf[total - 2] = (bitLen >>> 8) & 0xff;
  _buf[total - 1] = bitLen & 0xff;

  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE,
    h3 = 0x10325476, h4 = 0xC3D2E1F0;

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      _w[i] = (_buf[j] << 24) | (_buf[j + 1] << 16) | (_buf[j + 2] << 8) | _buf[j + 3];
    }
    for (let i = 16; i < 80; i++) {
      const v = _w[i - 3] ^ _w[i - 8] ^ _w[i - 14] ^ _w[i - 16];
      _w[i] = (v << 1) | (v >>> 31);
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }

      const t = (((a << 5) | (a >>> 27)) + f + e + k + _w[i]) | 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) | 0; b = a; a = t;
    }

    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }

  let u = h0 >>> 0; if (u) return Math.clz32(u);
  u = h1 >>> 0; if (u) return 32 + Math.clz32(u);
  u = h2 >>> 0; if (u) return 64 + Math.clz32(u);
  u = h3 >>> 0; if (u) return 96 + Math.clz32(u);
  u = h4 >>> 0; if (u) return 128 + Math.clz32(u);
  return 160;
}

/**
 * Solves the PoW challenge: finds smallest nonce where SHA1(challenge+':'+nonce)
 * has at least `difficulty` leading zero bits.
 * @param {string} challenge
 * @param {number} difficulty
 * @returns {{ nonce: number, elapsed: number, pauses: number }}
 */
function solvePoW(challenge, difficulty) {
  const prefix = challenge + ':';
  const start = Date.now();
  let nonce = 0;
  while (true) {
    if (sha1LeadingZeros(prefix + nonce) >= difficulty) {
      return { nonce, elapsed: Date.now() - start, pauses: 0 };
    }
    nonce++;
  }
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

/**
 * Makes an HTTP(S) GET request.
 * @param {string} url
 * @param {object} extraHeaders
 * @param {string|null} cookieJar - Raw cookie string to send
 * @returns {Promise<{ statusCode, headers, body, setCookies }>}
 */
function httpGet(url, extraHeaders = {}, cookieJar = '') {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': `https://${parsed.hostname}/`,
        ...(cookieJar ? { 'Cookie': cookieJar } : {}),
        ...extraHeaders,
      },
    };
    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
        setCookies: res.headers['set-cookie'] || [],
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Makes an HTTP(S) POST request with form data.
 * @param {string} url
 * @param {object} formData
 * @param {object} extraHeaders
 * @param {string} cookieJar
 * @returns {Promise<{ statusCode, headers, body, setCookies }>}
 */
function httpPost(url, formData, extraHeaders = {}, cookieJar = '') {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = Object.entries(formData)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Origin': `https://${parsed.hostname}`,
        'Referer': url,
        ...(cookieJar ? { 'Cookie': cookieJar } : {}),
        ...extraHeaders,
      },
    };
    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
        setCookies: res.headers['set-cookie'] || [],
      }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Parses Set-Cookie headers and merges into a cookie jar string.
 * @param {string} existing  - current cookie jar
 * @param {string[]} newCookies - array of Set-Cookie header values
 * @returns {string}
 */
function mergeCookies(existing, newCookies) {
  const jar = {};
  // parse existing
  for (const pair of existing.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) jar[k.trim()] = v.join('=').trim();
  }
  // parse new
  for (const cookie of newCookies) {
    const part = cookie.split(';')[0].trim();
    const [k, ...v] = part.split('=');
    if (k) jar[k.trim()] = v.join('=').trim();
  }
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ─── Main resolver ────────────────────────────────────────────────────────────

/**
 * Extracts the container ID from a filecrypt.cc URL.
 * e.g. https://filecrypt.cc/Container/0C394169C0.html → "0C394169C0"
 * @param {string} url
 * @returns {string|null}
 */
function extractContainerId(url) {
  const m = url.match(/filecrypt\.cc\/Container\/([A-Z0-9]+)\.html/i);
  return m ? m[1] : null;
}

/**
 * Resolves a filecrypt.cc container URL to real download URLs.
 *
 * Steps:
 *  1. GET container page → grab cookies + session path
 *  2. GET /captchasession/{id}.json → { challenge, difficulty }
 *  3. Solve PoW locally
 *  4. POST solution to container page
 *  5. Parse redirect → follow to /Link/{id}.html
 *  6. Extract download URLs from Link page
 *
 * @param {string} containerUrl  - e.g. "https://filecrypt.cc/Container/0C394169C0.html"
 * @param {object} [options]
 * @param {(msg: string) => void} [options.onProgress] - progress callback
 * @returns {Promise<string[]>}  - list of resolved download URLs
 */
async function resolveFilecrypt(containerUrl, options = {}) {
  const { onProgress = () => { } } = options;

  const containerId = extractContainerId(containerUrl);
  if (!containerId) throw new Error(`Invalid filecrypt URL: ${containerUrl}`);

  const base = 'https://filecrypt.cc';

  // ── Step 1: Load the container page to get cookies and session ID ──
  onProgress('filecrypt: Loading container page...');
  const pageResp = await httpGet(containerUrl);
  let cookieJar = mergeCookies('', pageResp.setCookies);

  // Extract the captcha session path from the HTML
  // e.g. data-session="/captchasession/CFE80A62C0.json"
  const sessionMatch = pageResp.body.match(/data-session="([^"]+)"/);
  if (!sessionMatch) {
    // Could be Cloudflare-blocked or no captcha needed
    // Try to extract links directly
    onProgress('filecrypt: No PoW captcha found, trying direct parse...');
    return extractLinksFromPage(pageResp.body, containerUrl);
  }
  const sessionPath = sessionMatch[1];

  // ── Step 2: Fetch PoW challenge ──
  onProgress(`filecrypt: Fetching PoW challenge from ${sessionPath}...`);
  const sessionResp = await httpGet(
    `${base}${sessionPath}`,
    { 'Accept': 'application/json', 'Referer': containerUrl },
    cookieJar
  );
  cookieJar = mergeCookies(cookieJar, sessionResp.setCookies);

  let session;
  try {
    session = JSON.parse(sessionResp.body);
  } catch (e) {
    throw new Error(`filecrypt: Failed to parse session JSON: ${sessionResp.body.substring(0, 200)}`);
  }

  if (!session.success || !session.challenge) {
    // autosolve mode or no challenge
    if (session.autosolve) {
      onProgress('filecrypt: Autosolve mode, submitting empty PoW...');
    } else {
      throw new Error(`filecrypt: Unexpected session response: ${JSON.stringify(session)}`);
    }
  }

  const { challenge, difficulty } = session.challenge || {};
  const challengeId = challenge?.id || session.challenge;

  let nonce = 0, elapsed = 0, pauses = 0;

  if (!session.autosolve && challenge) {
    // ── Step 3: Solve PoW ──
    onProgress(`filecrypt: Solving PoW (difficulty=${difficulty}, challenge=${challenge.challenge || challengeId})...`);
    const challengeStr = challenge.challenge || challenge;
    const result = solvePoW(String(challengeStr), difficulty);
    nonce = result.nonce;
    elapsed = result.elapsed;
    pauses = result.pauses;
    onProgress(`filecrypt: PoW solved! nonce=${nonce} in ${elapsed}ms`);
  }

  // ── Step 4: POST solution ──
  // Build form data matching the HTML hidden fields:
  // pow_id, pow_nonce, pow_elapsed, pow_pauses, pow_data, pow_x
  const challengeStr = (challenge && challenge.challenge) ? challenge.challenge : (challenge || '');
  const powId = (challenge && challenge.id) ? challenge.id : '';
  
  const formData = {
    pow_id: powId,
    pow_nonce: String(nonce),
    pow_elapsed: String(elapsed),
    pow_pauses: String(pauses),
    pow_data: '',
    pow_x: '',
  };

  onProgress(`filecrypt: Submitting PoW solution (nonce=${nonce})...`);
  const postResp = await httpPost(containerUrl, formData, {
    'Referer': containerUrl,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  }, cookieJar);
  cookieJar = mergeCookies(cookieJar, postResp.setCookies);

  // ── Step 5: Follow redirect to Link page ──
  let linkUrl = null;

  // Check for 302/301 redirect
  if ([301, 302, 303, 307, 308].includes(postResp.statusCode) && postResp.headers.location) {
    linkUrl = postResp.headers.location;
    if (!linkUrl.startsWith('http')) linkUrl = `${base}${linkUrl}`;
    onProgress(`filecrypt: Redirected to ${linkUrl}`);
  } else {
    // Check for JS redirect in body: location.href='https://filecrypt.cc/Link/XXXX.html'
    const jsRedirect = postResp.body.match(/location\.href=['"]([^'"]+filecrypt\.cc\/Link\/[^'"]+)['"]/);
    if (jsRedirect) {
      linkUrl = jsRedirect[1];
      onProgress(`filecrypt: JS redirect to ${linkUrl}`);
    } else {
      // Maybe the link is inline in the POST response
      const inlineLinks = extractLinksFromPage(postResp.body, containerUrl);
      if (inlineLinks.length > 0) {
        onProgress(`filecrypt: Found ${inlineLinks.length} link(s) in POST response`);
        return inlineLinks;
      }
      // Extract Link ID from body
      const linkMatch = postResp.body.match(/\/Link\/([A-Z0-9]+)\.html/i);
      if (linkMatch) {
        linkUrl = `${base}/Link/${linkMatch[1]}.html`;
        onProgress(`filecrypt: Found link path in body: ${linkUrl}`);
      } else {
        onProgress(`filecrypt: POST response (${postResp.statusCode}): ${postResp.body.substring(0, 500)}`);
        throw new Error('filecrypt: Could not find redirect after PoW submission');
      }
    }
  }

  // ── Step 6: Fetch the Link page and extract download URL ──
  onProgress(`filecrypt: Fetching link page: ${linkUrl}`);
  const linkResp = await httpGet(linkUrl, { 'Referer': containerUrl }, cookieJar);

  const urls = extractLinksFromPage(linkResp.body, linkUrl);
  if (urls.length > 0) {
    onProgress(`filecrypt: Found ${urls.length} download URL(s)`);
    return urls;
  }

  // Last resort: check for redirect
  if ([301, 302, 303, 307, 308].includes(linkResp.statusCode) && linkResp.headers.location) {
    const finalUrl = linkResp.headers.location;
    onProgress(`filecrypt: Final redirect to ${finalUrl}`);
    return [finalUrl];
  }

  throw new Error(`filecrypt: No download URLs found on link page: ${linkUrl}\nBody: ${linkResp.body.substring(0, 500)}`);
}

/**
 * Extracts download URLs from a filecrypt link or container page.
 * Looks for known file hosts in anchor tags.
 * @param {string} html
 * @param {string} baseUrl
 * @returns {string[]}
 */
function extractLinksFromPage(html, baseUrl) {
  const urls = [];
  const knownHosts = [
    /mediafire\.com/i,
    /1fichier\.com/i,
    /datanodes\.to/i,
    /mega\.nz/i,
    /vikingfile\.com/i,
    /akirabox\.com/i,
    /rootz\.so/i,
    /buzzheavier\.com/i,
    /pixeldrain\.com/i,
    /gofile\.io/i,
  ];

  // Match all href attributes
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1];
    if (knownHosts.some(pattern => pattern.test(href))) {
      if (!urls.includes(href)) urls.push(href);
    }
  }

  // Also look for JS openLink calls: openLink('XXXX')
  const openLinkRegex = /openLink\(['"]([A-Z0-9]+)['"]\)/gi;
  while ((match = openLinkRegex.exec(html)) !== null) {
    const linkId = match[1];
    const linkUrl = `https://filecrypt.cc/Link/${linkId}.html`;
    if (!urls.includes(linkUrl)) urls.push(linkUrl);
  }

  return urls;
}

module.exports = { resolveFilecrypt, solvePoW, sha1LeadingZeros, extractContainerId };
