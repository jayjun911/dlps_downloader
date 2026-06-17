const cheerio = require('cheerio');
const { resolveReroute } = require('./rerouteResolver');

const EXCLUDED_DOMAINS = [
  'downloadgameps3.com',  // Guide/Tool links
];

const REROUTE_DOMAIN = 'downloadgameps3.net';

/**
 * Calculates region priority. Lower number represents higher priority.
 * USA (exFAT) -> USA -> KOR -> EUR -> other
 * But user specified: "KOR가 보이면 따로 무조건 high priority로 download"
 * Thus, KOR gets top priority (0), exFAT gets 1, USA gets 2, EUR gets 3, others get 4.
 */
function getRegionPriority(regionName) {
  const region = regionName.toUpperCase();
  if (region.includes('KOR')) return 0;
  if (region.includes('EXFAT')) return 1;
  if (region.includes('USA')) return 2;
  if (region.includes('EUR') || region.includes('EURO')) return 3;
  return 4; // Other
}

// Download host priority. Lower index represents higher priority.
const HOST_PRIORITY_PATTERNS = [
  /1fichier\.com|1file/i,
  /mediafire\.com/i,
  /akirabox\.com|akia/i,
  /vikingfile\.com|viki/i,
  /mega\.nz|mega\.co\.nz/i,
  /rootz\.so/i,
  /buzzheavier\.com|buznew/i
];

function getHostPriority(url) {
  for (let i = 0; i < HOST_PRIORITY_PATTERNS.length; i++) {
    if (HOST_PRIORITY_PATTERNS[i].test(url)) return i;
  }
  return HOST_PRIORITY_PATTERNS.length; // lowest priority
}

function getHostNameFromUrl(url) {
  if (/1fichier\.com|1file/i.test(url)) return '1fichier';
  if (/mediafire\.com/i.test(url)) return 'Mediafire';
  if (/akirabox\.com|akia/i.test(url)) return 'Akia';
  if (/vikingfile\.com|viki/i.test(url)) return 'Viki';
  if (/mega\.nz|mega\.co\.nz/i.test(url)) return 'Mega';
  if (/rootz\.so/i.test(url)) return 'Rootz';
  if (/buzzheavier\.com/i.test(url)) return 'Buznew';
  return 'Other';
}

/**
 * Detects type of file from paragraph text, url, or label
 */
/**
 * Helper to determine if a backport should be dropped (if firmware < 7.00).
 */
function shouldDropBackport(text, url = '', label = '') {
  const lower = (text + ' ' + url + ' ' + label).toLowerCase();
  
  // Find all firmware versions mentioned
  const versions = [];
  const matches = lower.match(/\b(3|4|5|6|7|8|9|10|11)\.(?:xx|[0-9]+)\b/g) || [];
  const xxMatches = lower.match(/\b(3|4|5|6|7|8|9|10|11)xx\b/g) || [];
  
  for (const m of matches.concat(xxMatches)) {
    const numMatch = m.match(/\d+/);
    if (numMatch) {
      versions.push(parseInt(numMatch[0], 10));
    }
  }
  
  if (versions.length > 0) {
    // Keep only if at least one firmware is >= 7
    return !versions.some(v => v >= 7);
  }
  
  // Default: if no firmware is mentioned, drop it (safer for PS5 <7.00 backports)
  return true;
}

/**
 * Detects type of file from paragraph text, url, or label
 */
function detectTypeFromText(text, url = '', label = '') {
  const lower = (text + ' ' + url + ' ' + label).toLowerCase();
  if (lower.includes('unlock')) return 'UNLOCK';
  if (lower.includes('dlc')) return 'DLC';
  if (lower.includes('backport')) return 'BACKPORT';
  if (lower.includes('patch') || lower.includes('update') || lower.includes('fix')) return 'UPDATE';
  if (lower.includes('guide') || lower.includes('readme') || lower.includes('instruction')) return 'INSTALL_GUIDE';
  if (lower.includes('game')) return 'GAME';
  return 'GAME';
}

/**
 * Decodes base64 payload and extracts password and direct/reroute links grouped by paragraph/block.
 * 
 * @param {string} base64Payload 
 * @returns {{groups: Array<{type: string, links: Array<{label: string, url: string}>}>, password: string}}
 */
function decodeAndExtractLinks(base64Payload) {
  const decoded = Buffer.from(base64Payload, 'base64').toString('utf-8');
  
  // Try to parse as JSON first (used in newer game pages)
  try {
    const data = JSON.parse(decoded);
    if (data && (Array.isArray(data.URLS) || Array.isArray(data.urls))) {
      const urls = data.URLS || data.urls || [];
      const password = data.Password || data.password || '';
      
      const groups = [];
      for (const url of urls) {
        let trimmedUrl = (url || '').trim();
        // Decode shorteners / click bypasses (e.g. clk.sh) containing base64 URL param
        if (trimmedUrl.includes('url=')) {
          const urlMatch = trimmedUrl.match(/[?&]url=([^&]+)/);
          if (urlMatch) {
            try {
              const decodedUrl = Buffer.from(decodeURIComponent(urlMatch[1]), 'base64').toString('utf-8');
              if (decodedUrl.startsWith('http')) {
                trimmedUrl = decodedUrl;
              }
            } catch (e) {
              // ignore
            }
          }
        }
        
        if (trimmedUrl && !EXCLUDED_DOMAINS.some(domain => trimmedUrl.includes(domain))) {
          const type = detectTypeFromText('', trimmedUrl, '');
          if (type === 'BACKPORT' && shouldDropBackport('', trimmedUrl, '')) {
            continue; // Drop backports for firmware < 7.00
          }
          groups.push({
            type,
            links: [{ label: 'Link', url: trimmedUrl }]
          });
        }
      }
      
      return { groups, password };
    }
  } catch (err) {
    // Parsing failed, proceed with Cheerio HTML parsing
  }

  const $ = cheerio.load(decoded);

  // Extract password (usually written like "Password: DLPSGAME.COM")
  const passwordMatch = $.text().match(/Password:\s*([^\s<]+)/i);
  const password = passwordMatch ? passwordMatch[1].trim() : '';

  const groups = [];

  // Group by paragraphs (<p>), list items (<li>), or divs if they contain links
  $('p, li').each((_, blockEl) => {
    const blockText = $(blockEl).clone().children('a').remove().end().text().trim();
    const blockLinks = [];
    $(blockEl).find('a').each((_, el) => {
      let url = ($(el).attr('href') || '').trim();
      const dataDomain = ($(el).attr('data-domain') || '').trim();
      const dataPath = ($(el).attr('data-path') || '').trim();
      
      if (dataDomain && dataPath) {
        url = dataDomain + dataPath;
      }
      
      const label = $(el).text().trim() || 'Link';
      
      // Decode shorteners / click bypasses (e.g. clk.sh) containing base64 URL param
      if (url.includes('url=')) {
        const urlMatch = url.match(/[?&]url=([^&]+)/);
        if (urlMatch) {
          try {
            const decodedUrl = Buffer.from(decodeURIComponent(urlMatch[1]), 'base64').toString('utf-8');
            if (decodedUrl.startsWith('http')) {
              url = decodedUrl;
            }
          } catch (e) {
            // ignore
          }
        }
      }

      // Filter out help guides and tools
      if (url && !EXCLUDED_DOMAINS.some(domain => url.includes(domain))) {
        blockLinks.push({ label, url });
      }
    });

    if (blockLinks.length > 0) {
      const type = detectTypeFromText(blockText || $(blockEl).text());
      if (type === 'BACKPORT' && shouldDropBackport(blockText || $(blockEl).text())) {
        return; // Drop backports for firmware < 7.00
      }
      groups.push({ type, links: blockLinks });
    }
  });

  // Fallback: if no groups were found (flat structure)
  if (groups.length === 0) {
    const flatLinks = [];
    $('a').each((_, el) => {
      let url = ($(el).attr('href') || '').trim();
      const dataDomain = ($(el).attr('data-domain') || '').trim();
      const dataPath = ($(el).attr('data-path') || '').trim();
      
      if (dataDomain && dataPath) {
        url = dataDomain + dataPath;
      }
      
      const label = $(el).text().trim() || 'Link';
      
      if (url.includes('url=')) {
        const urlMatch = url.match(/[?&]url=([^&]+)/);
        if (urlMatch) {
          try {
            const decodedUrl = Buffer.from(decodeURIComponent(urlMatch[1]), 'base64').toString('utf-8');
            if (decodedUrl.startsWith('http')) {
              url = decodedUrl;
            }
          } catch (e) {
            // ignore
          }
        }
      }

      if (url && !EXCLUDED_DOMAINS.some(domain => url.includes(domain))) {
        flatLinks.push({ label, url });
      }
    });

    if (flatLinks.length > 0) {
      const type = detectTypeFromText('');
      groups.push({ type, links: flatLinks });
    }
  }

  return { groups, password };
}

/**
 * Evaluates all subpage sections for targetPPSA, sorts by region priority,
 * resolves reroutes if necessary, and returns the best download host and URLs.
 * 
 * @param {Array<{ppsa: string, region: string, base64Payload: string}>} sections
 * @param {string} targetPPSA
 * @returns {Promise<{urls: string[], urlInfo: Array<{url: string, type: string}>, password: string, region: string, hostName: string}>}
 */
async function getBestDownloadLinks(sections, targetPPSA) {
  // 1. Filter sections matching targetPPSA (if targetPPSA is specified)
  const matchingSections = targetPPSA 
    ? sections.filter(sec => sec.ppsa === targetPPSA)
    : sections;

  if (matchingSections.length === 0) {
    throw new Error(`No sections found matching PPSA: ${targetPPSA}`);
  }

  // 2. Sort by region priority
  matchingSections.sort((a, b) => {
    return getRegionPriority(a.region) - getRegionPriority(b.region);
  });

  // Try each region section in order of priority (in case of failure to extract/resolve)
  for (const section of matchingSections) {
    try {
      const { groups, password } = decodeAndExtractLinks(section.base64Payload);
      
      let finalUrls = [];
      let finalUrlInfos = [];
      let selectedHostNames = new Set();

      // Resolve and select links for each group (asset) independently
      for (const group of groups) {
        let candidates = [];

        const directLinks = group.links.filter(l => !l.url.includes(REROUTE_DOMAIN));
        const rerouteLinks = group.links.filter(l => l.url.includes(REROUTE_DOMAIN));

        // Add direct links as candidates
        candidates = candidates.concat(directLinks);

        // Resolve reroute URLs
        for (const reroute of rerouteLinks) {
          try {
            const resolved = await resolveReroute(reroute.url);
            candidates = candidates.concat(resolved);
          } catch (e) {
            // Ignore reroute resolution failure
          }
        }

        // Filter candidates to only allow valid download hosts or text guides
        const allowedCandidates = candidates.filter(cand => {
          return cand.url.startsWith('text_guide:') || getHostPriority(cand.url) < HOST_PRIORITY_PATTERNS.length;
        });

        if (allowedCandidates.length === 0) {
          continue;
        }

        const textGuides = allowedCandidates.filter(cand => cand.url.startsWith('text_guide:'));
        const downloadCandidates = allowedCandidates.filter(cand => !cand.url.startsWith('text_guide:'));

        // If there are download candidates, select the best host for this asset group
        if (downloadCandidates.length > 0) {
          const groupedByHost = {};
          for (const cand of downloadCandidates) {
            const priorityIndex = getHostPriority(cand.url);
            if (!groupedByHost[priorityIndex]) {
              groupedByHost[priorityIndex] = [];
            }
            if (!groupedByHost[priorityIndex].includes(cand.url)) {
              groupedByHost[priorityIndex].push(cand.url);
            }
          }

          const sortedHostKeys = Object.keys(groupedByHost).map(Number).sort((a, b) => a - b);
          if (sortedHostKeys.length > 0) {
            const bestHostIndex = sortedHostKeys[0];
            const bestUrls = groupedByHost[bestHostIndex];
            
            for (const url of bestUrls) {
              if (!finalUrls.includes(url)) {
                finalUrls.push(url);
                finalUrlInfos.push({ url, type: group.type });
                selectedHostNames.add(getHostNameFromUrl(url));
              }
            }
          }
        }

        // Add text guides
        for (const tg of textGuides) {
          if (!finalUrls.includes(tg.url)) {
            finalUrls.push(tg.url);
            finalUrlInfos.push({ url: tg.url, type: 'INSTALL_GUIDE' });
          }
        }
      }

      if (finalUrls.length === 0) {
        continue;
      }

      // Determine the primary host name for display/logging
      // If we have 1fichier, use that; otherwise first available
      const hostList = Array.from(selectedHostNames);
      const hostName = hostList.includes('1fichier') ? '1fichier' : (hostList[0] || 'Other');

      return {
        urls: finalUrls,
        urlInfo: finalUrlInfos,
        password,
        region: section.region,
        hostName,
        ppsa: section.ppsa
      };
    } catch (err) {
      // Try next region section
    }
  }

  throw new Error(`Failed to extract any download links for PPSA: ${targetPPSA}`);
}

module.exports = {
  decodeAndExtractLinks,
  getBestDownloadLinks,
  getRegionPriority
};
