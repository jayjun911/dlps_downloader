const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

function sanitizeFichierUrl(url) {
  if (!url) return url;
  if (/1fichier\.com|1file/i.test(url)) {
    const match = url.match(/^(https?:\/\/(?:[a-z0-9]+\.)?(?:1fichier\.com|1file\.com)\/(?:\?|#)?)([a-z0-9]{5,20})/i);
    if (match) {
      return `https://1fichier.com/?${match[2].toLowerCase()}`;
    }
  }
  return url;
}

// Regular expression to match allowed download host domains
const DOWNLOAD_HOST_REGEX = /^https?:\/\/(?:www\.)?(?:1fichier\.com|datanodes\.to|mediafire\.com|rootz\.so|akirabox\.com|vikingfile\.com|mega\.nz|buzzheavier\.com|filekeeper\.net)\//i;

// Regular expression to find URLs inside plain text
const PLAIN_TEXT_URL_REGEX = /https?:\/\/(?:www\.)?(?:1fichier\.com|datanodes\.to|mediafire\.com|rootz\.so|akirabox\.com|vikingfile\.com|mega\.nz|buzzheavier\.com|filekeeper\.net)\/[^\s"'<>]+/gi;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const { execSync } = require('child_process');

/**
 * Extracts URL from onclick attribute containing string concatenation (e.g. this.href='https://' + 'akirabox' + '.com/...')
 */
function extractUrlFromOnclick(onclickStr) {
  if (!onclickStr) return null;
  const match = onclickStr.match(/this\.href\s*=\s*([^;]+)/);
  if (match) {
    const expr = match[1].trim();
    // Extract all single/double quoted string literals and join them
    const regex = /'([^']*)'|"([^"]*)"/g;
    let parts = [];
    let m;
    while ((m = regex.exec(expr)) !== null) {
      parts.push(m[1] !== undefined ? m[1] : m[2]);
    }
    if (parts.length > 0) {
      const url = parts.join('');
      if (url.startsWith('http')) {
        return url;
      }
    }
  }
  return null;
}

async function fetchRawHtml(url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT }
    });
    const html = res.data;
    if (html && (html.includes('Just a moment...') || html.includes('challenges.cloudflare.com'))) {
      throw new Error('Cloudflare Turnstile challenge detected.');
    }
    return html;
  } catch (axiosErr) {
    try {
      const cmd = `curl -s -L -A "${USER_AGENT}" "${url}"`;
      const stdout = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
      if (stdout && stdout.trim().length > 0 && !stdout.includes('Just a moment...') && !stdout.includes('challenges.cloudflare.com')) {
        return stdout;
      } else {
        throw axiosErr;
      }
    } catch (curlErr) {
      throw axiosErr;
    }
  }
}

/**
 * Fetches the reroute URL and extracts all valid direct download links.
 * Handing both anchor tags and plain text URLs.
 * 
 * @param {string} rerouteUrl 
 * @param {Set<string>} visited
 * @param {number} depth
 * @returns {Promise<Array<{label: string, url: string}>>}
 */
async function resolveReroute(rerouteUrl, visited = new Set(), depth = 0) {
  if (depth > 2) return [];
  if (visited.has(rerouteUrl)) return [];
  visited.add(rerouteUrl);

  const archiveIdMatch = rerouteUrl.match(/\/archives\/(\d+)/);
  const archiveId = archiveIdMatch ? archiveIdMatch[1] : '';
  const manualRerouteHtmlPath = archiveId 
    ? path.join(__dirname, `../../data/cache/manual_html/reroute-${archiveId}.html`)
    : '';

  try {
    let htmlData;
    let usedApi = false;
    if (manualRerouteHtmlPath && fs.existsSync(manualRerouteHtmlPath)) {
      htmlData = fs.readFileSync(manualRerouteHtmlPath, 'utf-8');
    } else {
      // 1. Try WordPress REST API first (since it is Turnstile-free)
      if (archiveId) {
        try {
          const apiRes = await axios.get(`https://downloadgameps3.net/wp-json/wp/v2/posts/${archiveId}`, {
            headers: { 'User-Agent': USER_AGENT }
          });
          if (apiRes.data && apiRes.data.content && apiRes.data.content.rendered) {
            htmlData = apiRes.data.content.rendered;
            usedApi = true;
          }
        } catch (apiErr) {
          // Ignore and fallback
        }
      }

      if (!htmlData) {
        htmlData = await fetchRawHtml(rerouteUrl);
      }
    }

    if (htmlData && (htmlData.includes('Just a moment...') || htmlData.includes('challenges.cloudflare.com'))) {
      throw new Error(`Cloudflare Turnstile challenge blocked resolving reroute URL.
To bypass this block, please follow these steps:
1. Open this URL in your web browser:
   ${rerouteUrl}
2. Right-click anywhere on the page, select "View Page Source" (or save page as HTML).
3. Copy all HTML source code and save it exactly to this file path:
   ${manualRerouteHtmlPath}
4. Re-run your download command!`);
    }

    const extractLinks = (html) => {
      const $ = cheerio.load(html);
      const linksMap = new Map();
      const nestedReroutes = [];
      const REROUTE_ARCHIVE_REGEX = /downloadgameps3\.net\/archives\/(\d+)/i;

      $('a').each((_, el) => {
        let url = ($(el).attr('href') || '').trim();
        const dataDomain = ($(el).attr('data-domain') || '').trim();
        const dataPath = ($(el).attr('data-path') || '').trim();
        const onclickAttr = ($(el).attr('onclick') || '').trim();
        
        if (dataDomain && dataPath) {
          url = dataDomain + dataPath;
        } else if (onclickAttr) {
          const onclickUrl = extractUrlFromOnclick(onclickAttr);
          if (onclickUrl) {
            url = onclickUrl;
          }
        }
        
        const label = $(el).text().trim() || 'Link';
        if (url) {
          if (DOWNLOAD_HOST_REGEX.test(url)) {
            linksMap.set(sanitizeFichierUrl(url), label);
          } else if (REROUTE_ARCHIVE_REGEX.test(url) && url !== rerouteUrl) {
            nestedReroutes.push(url);
          }
        }
      });

      const pageText = $('body').text() || '';
      const textUrls = pageText.match(PLAIN_TEXT_URL_REGEX) || [];
      for (const url of textUrls) {
        const trimmedUrl = url.trim();
        const cleanUrl = sanitizeFichierUrl(trimmedUrl);
        if (!linksMap.has(cleanUrl)) {
          linksMap.set(cleanUrl, 'Text Link');
        }
      }

      return { linksMap, nestedReroutes };
    };

    let { linksMap, nestedReroutes } = extractLinks(htmlData);

    // Fallback if API returned no links (often due to dynamic JS / custom data attribute filtering in WP REST API)
    if (usedApi && linksMap.size === 0 && nestedReroutes.length === 0 && !manualRerouteHtmlPath) {
      try {
        const rawHtml = await fetchRawHtml(rerouteUrl);
        const res = extractLinks(rawHtml);
        linksMap = res.linksMap;
        nestedReroutes = res.nestedReroutes;
      } catch (err) {
        // ignore
      }
    }

    // Resolve nested reroutes recursively
    for (const nestedUrl of nestedReroutes) {
      try {
        const nestedLinks = await resolveReroute(nestedUrl, visited, depth + 1);
        for (const nl of nestedLinks) {
          if (!linksMap.has(nl.url)) {
            linksMap.set(nl.url, nl.label);
          }
        }
      } catch (e) {
        // Ignore nested resolution failures
      }
    }

    // If no links were resolved, check if this page is a text installation guide
    if (linksMap.size === 0) {
      const $ = cheerio.load(htmlData);
      const entryContent = $('.entry-content, .post-content, .post-entry').first();
      const entryText = entryContent.length > 0 ? entryContent.text() : $('body').text();
      
      const cleanLines = entryText.split('\n')
        .map(line => line.trim())
        .filter(line => {
          const lower = line.toLowerCase();
          return line.length > 0 && 
                 !lower.includes('guide bypass google drive') && 
                 !lower.includes('guide fix download link') && 
                 !lower.includes('guide fix error') && 
                 !lower.includes('dlpsgame.com') && 
                 !lower.includes('link download free') &&
                 !lower.includes('skip to content');
        });
      
      const bodyText = cleanLines.join('\n').trim();
      const textLower = bodyText.toLowerCase();
      
      const isGuide = textLower.includes('how to install') || 
                      textLower.includes('guide') || 
                      textLower.includes('readme') || 
                      textLower.includes('instruction') || 
                      textLower.includes('unlock all dlc');
                      
      if (isGuide && bodyText.length > 10) {
        const resolvedLinks = [{ label: 'INSTALL_GUIDE', url: `text_guide:${bodyText}` }];
        return resolvedLinks;
      }
    }

    // Convert Map back to list of objects
    const resolvedLinks = [];
    linksMap.forEach((label, url) => {
      resolvedLinks.push({ label, url });
    });

    return resolvedLinks;
  } catch (err) {
    throw new Error(`Failed to resolve reroute URL: ${rerouteUrl}. Error: ${err.message}`);
  }
}

module.exports = {
  resolveReroute
};
