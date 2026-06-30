const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { normalizeTitle } = require('../utils/titleNormalizer');
const { getCurrentPlatform, getCurrentPlatformKey } = require('./platformConfig');
const { extractTitleId, detectEmuConsole } = require('../utils/consoleClassifier');

const CACHE_DIR = path.join(__dirname, '../../data/cache');
const SUBPAGE_CACHE_DIR = path.join(CACHE_DIR, 'subpages');

// Web list cache is kept per-platform so switching platforms never mixes lists.
function getWebListCachePath() {
  return path.join(CACHE_DIR, `web-list-${getCurrentPlatformKey()}.json`);
}

// Default cache TTL is 24 hours
const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_HOURS, 10) || 24) * 60 * 60 * 1000;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

const { execSync } = require('child_process');

async function fetchHtml(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'sec-ch-ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1'
      }
    });
    return response.data;
  } catch (err) {
    try {
      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
      const cmd = `curl -s -L -A "${userAgent}" "${url}"`;
      const stdout = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
      if (stdout && stdout.trim().length > 0) {
        return stdout;
      }
    } catch (curlErr) {
      // Ignore curl error
    }
    throw err;
  }
}

const logger = require('../utils/logger');

async function getWebGameList(forceRefresh = false) {
  const platform = getCurrentPlatform();
  const WEB_LIST_CACHE = getWebListCachePath();
  const manualListPath = path.join(CACHE_DIR, 'manual-list.html');
  if (fs.existsSync(manualListPath)) {
    try {
      logger.info(`Using manually provided main game list from ${manualListPath}`);
      const html = fs.readFileSync(manualListPath, 'utf-8');
      const $ = cheerio.load(html);
      const games = [];
      $('ol.display-posts-listing li.listing-item a.title').each((_, el) => {
        const title = $(el).text().trim();
        const href = $(el).attr('href') || '';
        if (href) {
          const urlParts = href.replace(/\/$/, '').split('/');
          const slug = urlParts[urlParts.length - 1];
          games.push({
            title,
            url: href,
            slug,
            normalizedTitle: normalizeTitle(title)
          });
        }
      });
      if (games.length > 0) {
        ensureDirectoryExistence(WEB_LIST_CACHE);
        fs.writeFileSync(WEB_LIST_CACHE, JSON.stringify(games, null, 2), 'utf-8');
        return games;
      }
    } catch (manualErr) {
      logger.error('Failed to parse manual-list.html', manualErr);
    }
  }

  if (!forceRefresh && fs.existsSync(WEB_LIST_CACHE)) {
    const stats = fs.statSync(WEB_LIST_CACHE);
    const age = Date.now() - stats.mtimeMs;
    if (age < CACHE_TTL_MS) {
      try {
        const cachedContent = fs.readFileSync(WEB_LIST_CACHE, 'utf-8');
        // Make sure it's valid JSON list (not 'INVALID...' or empty array from failed fetch)
        const parsed = JSON.parse(cachedContent);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Re-normalize titles dynamically to prevent stale cache discrepancies
          return parsed.map(g => ({
            ...g,
            normalizedTitle: normalizeTitle(g.title)
          }));
        }
      } catch (e) {
        // Fallback
      }
    }
  }

  let html = '';
  let usingFallback = false;

  // Try WordPress REST API first — bypasses Cloudflare
  try {
    const apiRes = await axios.get(`${platform.host}/wp-json/wp/v2/pages?slug=${platform.slug}`, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000
    });
    if (apiRes.data && Array.isArray(apiRes.data) && apiRes.data[0]?.content?.rendered) {
      html = apiRes.data[0].content.rendered;
    }
  } catch (apiErr) {
    // ignore, fall through to direct fetch
  }

  // Direct fetch fallback
  if (!html) {
    const url = forceRefresh
      ? `${platform.host}/${platform.slug}/?_t=${Date.now()}`
      : `${platform.host}/${platform.slug}/`;
    try {
      html = await fetchHtml(url);
      if (html && (html.includes('Just a moment...') || html.includes('challenges.cloudflare.com'))) {
        throw new Error('Cloudflare Turnstile challenge detected.');
      }
    } catch (err) {
      const localFilePath = path.join(__dirname, '../../Initial Plan/game list element.txt');
      if (fs.existsSync(localFilePath)) {
        html = fs.readFileSync(localFilePath, 'utf-8');
        logger.warn('Cloudflare challenge detected. Using local fallback game list: "Initial Plan/game list element.txt"');
        usingFallback = true;
      } else {
        throw err;
      }
    }
  }

  // Debug output
  ensureDirectoryExistence(path.join(CACHE_DIR, 'debug-page.html'));
  if (html) {
    fs.writeFileSync(path.join(CACHE_DIR, 'debug-page.html'), html, 'utf-8');
  }
  
  const $ = cheerio.load(html);
  
  const games = [];
  $('ol.display-posts-listing li.listing-item a.title').each((_, el) => {
    const title = $(el).text().trim();
    const href = $(el).attr('href') || '';
    if (href) {
      // Extract slug from URL
      const urlParts = href.replace(/\/$/, '').split('/');
      const slug = urlParts[urlParts.length - 1];
      games.push({
        title,
        url: href,
        slug,
        normalizedTitle: normalizeTitle(title)
      });
    }
  });

  if (games.length === 0 && !usingFallback) {
    // If parsed nothing but didn't trigger catch, maybe CF returned blank or different DOM
    const localFilePath = path.join(__dirname, '../../Initial Plan/game list element.txt');
    if (fs.existsSync(localFilePath)) {
      logger.warn('Parsed 0 web games. Using local fallback game list: "Initial Plan/game list element.txt"');
      const fallbackHtml = fs.readFileSync(localFilePath, 'utf-8');
      const $fb = cheerio.load(fallbackHtml);
      $fb('ol.display-posts-listing li.listing-item a.title').each((_, el) => {
        const title = $fb(el).text().trim();
        const href = $fb(el).attr('href') || '';
        if (href) {
          const urlParts = href.replace(/\/$/, '').split('/');
          const slug = urlParts[urlParts.length - 1];
          games.push({
            title,
            url: href,
            slug,
            normalizedTitle: normalizeTitle(title)
          });
        }
      });
    }
  }

  ensureDirectoryExistence(WEB_LIST_CACHE);
  fs.writeFileSync(WEB_LIST_CACHE, JSON.stringify(games, null, 2), 'utf-8');
  return games;
}

/**
 * Finds games inside cached web list matching a query.
 * 
 * @param {string} query
 * @returns {Promise<Array<{title: string, url: string, slug: string, normalizedTitle: string}>>}
 */
async function findGameInWebList(query) {
  const normalizedQuery = normalizeTitle(query);
  const webList = await getWebGameList();
  
  // Exact normalized match first
  let match = webList.filter(g => g.normalizedTitle === normalizedQuery);
  if (match.length > 0) return match;
  
  // Contains match
  const matches = webList.filter(g => g.normalizedTitle.includes(normalizedQuery));
  return matches;
}

/**
 * Scrapes a subpage for PPSA segments and base64 payloads.
 * Uses cache if valid.
 * 
 * @param {string} slug
 * @param {string} url
 * @param {boolean} forceRefresh
 * @returns {Promise<Array<{ppsa: string, region: string, base64Payload: string}>>}
 */
async function getGameSubpageData(slug, url, forceRefresh = false) {
  const cachePath = path.join(SUBPAGE_CACHE_DIR, `${slug}.json`);
  const manualHtmlPath = path.join(CACHE_DIR, 'manual_html', `${slug}.html`);
  const scratchpadPath = 'C:\\Users\\Jay Jun\\.gemini\\antigravity-ide\\brain\\769f4f10-bd1e-42db-ad07-f1c114015fa7\\browser\\scratchpad_r6s268vq.md';
  const hasPendingManual = fs.existsSync(manualHtmlPath) || (slug === 'aeterna-noctis-ps5' && fs.existsSync(scratchpadPath));

  if (!forceRefresh && !hasPendingManual && fs.existsSync(cachePath)) {
    const stats = fs.statSync(cachePath);
    const age = Date.now() - stats.mtimeMs;
    if (age < CACHE_TTL_MS) {
      try {
        const cachedContent = fs.readFileSync(cachePath, 'utf-8');
        const parsed = JSON.parse(cachedContent);
        // Support old array format and new { sections, languages } format
        if (Array.isArray(parsed) && parsed.length > 0) {
          return { sections: parsed, languages: [] };
        }
        if (parsed && Array.isArray(parsed.sections) && parsed.sections.length > 0) {
          return parsed;
        }
      } catch (e) {
        // Fallback
      }
    }
  }

  let html = '';
  let usingFallback = false;

  // Temporary migration: copy from scratchpad if present
  if (slug === 'aeterna-noctis-ps5' && fs.existsSync(scratchpadPath)) {
    try {
      const content = fs.readFileSync(scratchpadPath, 'utf-8');
      const htmlStartIdx = content.indexOf('## HTML Content');
      if (htmlStartIdx !== -1) {
        const rawHtml = content.substring(htmlStartIdx + '## HTML Content'.length).trim();
        if (rawHtml) {
          ensureDirectoryExistence(manualHtmlPath);
          fs.writeFileSync(manualHtmlPath, rawHtml, 'utf-8');
          logger.info(`Automatically reconstructed manual HTML for "${slug}" from browser scratchpad.`);
          try {
            fs.renameSync(scratchpadPath, scratchpadPath + '.processed');
          } catch (e) {
            // ignore
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // 1. Try manually saved HTML by user first
  if (fs.existsSync(manualHtmlPath)) {
    html = fs.readFileSync(manualHtmlPath, 'utf-8');
    logger.info(`Using manually provided HTML for "${slug}" from ${manualHtmlPath}`);
    usingFallback = true;
  } else {
    // 2. Try WordPress REST API (turnstile-free)
    try {
      logger.info(`Attempting WordPress REST API lookup for "${slug}"...`);
      const apiRes = await axios.get(`${getCurrentPlatform().host}/wp-json/wp/v2/posts?slug=${slug}`, {
        headers: { 'User-Agent': USER_AGENT }
      });
      if (apiRes.data && Array.isArray(apiRes.data) && apiRes.data.length > 0 && apiRes.data[0].content && apiRes.data[0].content.rendered) {
        html = apiRes.data[0].content.rendered;
        logger.success(`Successfully retrieved content for "${slug}" via WordPress REST API.`);
      }
    } catch (apiErr) {
      // Ignore API error and fallback to standard fetch
    }

    if (!html) {
      try {
        html = await fetchHtml(url);
        if (html && (html.includes('Just a moment...') || html.includes('challenges.cloudflare.com'))) {
          throw new Error('Cloudflare Turnstile challenge detected.');
        }
      } catch (err) {
        // 3. Try local 3D MiniGolf fallback
        const localFilePath = path.join(__dirname, '../../Initial Plan/sub-gamepage.txt');
        if (slug === '3d-minigolf-ps5' && fs.existsSync(localFilePath)) {
          html = fs.readFileSync(localFilePath, 'utf-8');
          logger.warn(`Cloudflare challenge detected. Using local fallback for slug "${slug}": "Initial Plan/sub-gamepage.txt"`);
          usingFallback = true;
        }
        // 4. Prompt user on how to bypass
        else {
          ensureDirectoryExistence(manualHtmlPath);
          throw new Error(`Cloudflare Turnstile challenge blocked automated page scraping.
To bypass this block, please follow these steps:
1. Open this URL in your web browser:
   ${url}
2. Right-click anywhere on the page, select "View Page Source" (or save page as HTML).
3. Copy all HTML source code and save it exactly to this file path:
   ${manualHtmlPath}
4. Re-run your download command!`);
        }
      }
    }
  }

  // If using web API content (which is post body fragment), wrap in mock article classes for Cheerio selector compatibility
  const isWebApiContent = html && !html.includes('<html') && !html.includes('<body');
  const $ = cheerio.load(isWebApiContent ? `<div class="post-body entry-content">${html}</div>` : html);
  const sections = [];

  $('.post-body.entry-content p').each((_, pEl) => {
    const pText = $(pEl).text().trim();
    const idMatch = extractTitleId(pText, { preferConsole: getCurrentPlatformKey() });
    if (idMatch) {
      const ppsa = idMatch.id;
      let region = pText.replace(idMatch.raw, '').replace(/^[–\s\-\u8211\u8212\u2013\u2014]+/i, '').trim();
      
      // Find the next su-spoiler div sibling (up to 3 sibling tags down)
      let nextEl = $(pEl).next();
      for (let i = 0; i < 3; i++) {
        if (!nextEl.length) break;
        if (nextEl.hasClass('su-spoiler')) {
          break;
        }
        nextEl = nextEl.next();
      }
      
      if (nextEl.hasClass('su-spoiler')) {
        const secureDataEl = nextEl.find('.secure-data');
        if (secureDataEl.length) {
          let base64Payload = secureDataEl.attr('data-payload') || '';
          if (!base64Payload) {
            // Fallback: if data-payload is not present, construct base64 payload from the HTML content
            const htmlContent = secureDataEl.html() || nextEl.find('.su-spoiler-content').html() || '';
            if (htmlContent.trim()) {
              base64Payload = Buffer.from(htmlContent.trim()).toString('base64');
            }
          }
          if (base64Payload) {
            let sectionConsole;
            try {
              const payloadText = Buffer.from(base64Payload, 'base64').toString('utf-8');
              sectionConsole = detectEmuConsole(payloadText) || undefined;
            } catch (e) {}
            sections.push({
              ppsa,
              region: region || 'Unknown',
              base64Payload,
              ...(sectionConsole && { console: sectionConsole })
            });
          }
        }
      }
    }
  });

  // Direct spoiler-based scanning (for when PPSA is inside the spoiler payload instead of a paragraph before it)
  $('.su-spoiler').each((_, spoilerEl) => {
    const secureDataEl = $(spoilerEl).find('.secure-data');
    if (secureDataEl.length) {
      let base64Payload = secureDataEl.attr('data-payload') || '';
      if (!base64Payload) {
        const htmlContent = secureDataEl.html() || $(spoilerEl).find('.su-spoiler-content').html() || '';
        if (htmlContent.trim()) {
          base64Payload = Buffer.from(htmlContent.trim()).toString('base64');
        }
      }
      if (base64Payload) {
        // If already added by the paragraph-based path, check if the payload
        // contains an emu tag (e.g. [SATURNtoPS4]) and backfill console field.
        const existing = sections.find(s => s.base64Payload === base64Payload);
        if (existing) {
          if (!existing.console) {
            try {
              const decodedText = Buffer.from(base64Payload, 'base64').toString('utf-8');
              const emuConsole = detectEmuConsole(decodedText);
              if (emuConsole) existing.console = emuConsole;
            } catch (e) {}
          }
          return;
        }

        try {
          const decoded = Buffer.from(base64Payload, 'base64').toString('utf-8');
          const $decoded = cheerio.load(decoded);
          let ppsa = '';
          let region = '';

          $decoded('p, div, span, td, li').each((_, el) => {
            const txt = $decoded(el).text().trim();
            const m2 = extractTitleId(txt, { preferConsole: getCurrentPlatformKey() });
            if (m2) {
              ppsa = m2.id;
              region = txt.replace(m2.raw, '').trim();
              region = region
                .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '-')
                .replace(/^[\s\-\u8211\u8212\u2013\u2014]+/i, '')
                .trim();
              return false; // break
            }
          });

          if (ppsa) {
            sections.push({
              ppsa,
              region: region || 'Unknown',
              base64Payload
            });
          } else {
            // Emulation package (Saturn/PSP/...): no known title-ID prefix,
            // identified by a "<system> to PS4" / "<system> emu" tag. Capture its
            // vanity ID for display and mark the section's console explicitly.
            const decodedText = $decoded.root().text();
            const emuConsole = detectEmuConsole(decodedText);
            if (emuConsole) {
              const vanity = decodedText.match(/\b([A-Z]{2,5}\d{3,6})\b/);
              sections.push({
                ppsa: vanity ? vanity[1].toUpperCase() : emuConsole.toUpperCase(),
                region: `${emuConsole.toUpperCase()}toPS4`,
                console: emuConsole,
                base64Payload
              });
            }
          }
        } catch (e) {
          // ignore
        }
      }
    }
  });

  // Parse "Languages : Japanese, English" from the post body
  const languages = [];
  $('.post-body.entry-content p, .post-body.entry-content li').each((_, el) => {
    const txt = $(el).text().trim();
    const m = txt.match(/^Languages?\s*[:：]\s*(.+)/i);
    if (m) {
      m[1].split(/[,\/]/).forEach(lang => {
        const l = lang.trim();
        if (l) languages.push(l);
      });
      return false; // found — stop iterating
    }
  });

  const result = { sections, languages };
  if (sections.length > 0) {
    ensureDirectoryExistence(cachePath);
    fs.writeFileSync(cachePath, JSON.stringify(result, null, 2), 'utf-8');
  }
  return result;
}

/**
 * Returns true if a fresh, non-empty subpage cache exists for the slug — i.e.
 * getGameSubpageData would serve it without hitting the network. Lets callers
 * skip request throttling on cache hits.
 */
function isSubpageCached(slug) {
  const cachePath = path.join(SUBPAGE_CACHE_DIR, `${slug}.json`);
  if (!fs.existsSync(cachePath)) return false;
  try {
    if (Date.now() - fs.statSync(cachePath).mtimeMs >= CACHE_TTL_MS) return false;
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    return Array.isArray(parsed) && parsed.length > 0;
  } catch (e) {
    return false;
  }
}

module.exports = {
  getWebGameList,
  findGameInWebList,
  getGameSubpageData,
  isSubpageCached
};
