const cheerio = require('cheerio');
const { resolveReroute } = require('./rerouteResolver');
const logger = require('../utils/logger');

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
  const isExfat = region.includes('EXFAT');

  if (region.includes('KOR')) {
    return isExfat ? 0 : 1;
  }
  if (region.includes('USA')) {
    return isExfat ? 2 : 4;
  }
  if (region.includes('EUR') || region.includes('EURO')) {
    return isExfat ? 3 : 5;
  }
  return isExfat ? 6 : 7;
}

// Download host priority. Lower index represents higher priority.
const HOST_PRIORITY_PATTERNS = [
  /1fichier\.com|1file/i,
  /datanodes\.to/i,
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
  if (/datanodes\.to/i.test(url)) return 'Datanodes';
  if (/mediafire\.com/i.test(url)) return 'Mediafire';
  if (/akirabox\.com|akia/i.test(url)) return 'Akia';
  if (/vikingfile\.com|viki/i.test(url)) return 'Viki';
  if (/mega\.nz|mega\.co\.nz/i.test(url)) return 'Mega';
  if (/rootz\.so/i.test(url)) return 'Rootz';
  if (/buzzheavier\.com/i.test(url)) return 'Buznew';
  return 'Other';
}

/**
 * Extracts the minimum firmware version from "Works on X.xx and higher" style notes.
 * Returns the major version number (e.g. 7 for "7.xx"), or null if not found.
 */
function extractFirmwareRequirement(text) {
  const lower = text.toLowerCase();

  // "Works on [FW] X.xx" — most common pattern on the site
  let m = lower.match(/works\s+on\s+(?:fw\s+)?(\d+)\.(?:xx|\d+)/);
  if (m) return parseInt(m[1], 10);

  m = lower.match(/works\s+on\s+(?:fw\s+)?(\d+)xx/);
  if (m) return parseInt(m[1], 10);

  // "X.xx and higher / above / +"
  m = lower.match(/(\d+)\.(?:xx|\d+)\s+(?:and|or)\s+(?:higher|above)/);
  if (m) return parseInt(m[1], 10);

  m = lower.match(/(\d+)xx\s+(?:and|or)\s+(?:higher|above)/);
  if (m) return parseInt(m[1], 10);

  // "Note: X.xx ..." where X.xx is followed by higher/above/+
  m = lower.match(/note\s*:\s*(\d+)\.(?:xx|\d+)\s*(?:and\s+(?:higher|above)|\+)?/);
  if (m) return parseInt(m[1], 10);

  return null;
}

/**
 * Helper to determine if a backport should be dropped based on the user's firmware.
 * Used as a FALLBACK when no "Works on X.xx" note is found in the section content.
 */
function shouldDropBackport(text, url = '', label = '') {
  const userFirmware = parseInt(process.env.USER_FIRMWARE || '7', 10);
  const lower = (text + ' ' + url + ' ' + label).toLowerCase();

  const versions = [];
  const matches = lower.match(/\b(3|4|5|6|7|8|9|10|11)\.(?:xx|[0-9]+)\b/g) || [];
  const xxMatches = lower.match(/\b(3|4|5|6|7|8|9|10|11)xx\b/g) || [];

  for (const m of matches.concat(xxMatches)) {
    const numMatch = m.match(/\d+/);
    if (numMatch) versions.push(parseInt(numMatch[0], 10));
  }

  if (versions.length > 0) {
    const minVersion = Math.min(...versions);
    return minVersion < userFirmware;
  }

  return true; // Default: drop if no version info
}

/**
 * Detects type of file from paragraph text, url, or label
 */
function detectTypeFromText(text, url = '', label = '') {
  const lower = (text + ' ' + url + ' ' + label).toLowerCase();
  if (lower.includes('unlock')) return 'UNLOCK';

  // "Game (vX.X) + DLC" → the primary content is the GAME; DLC is just bundled.
  // Detect by checking if 'game' appears in the text before 'dlc'.
  const gameIdx = lower.indexOf('game');
  const dlcIdx = lower.indexOf('dlc');
  if (dlcIdx >= 0) {
    if (gameIdx >= 0 && gameIdx < dlcIdx) return 'GAME';
    return 'DLC';
  }

  if (lower.includes('backport')) return 'BACKPORT';
  if (lower.includes('patch') || lower.includes('update') || lower.includes('fix')) return 'UPDATE';
  if (lower.includes('guide') || lower.includes('readme') || lower.includes('instruction')) return 'INSTALL_GUIDE';
  return 'GAME';
}

/**
 * Decodes base64 payload and extracts password, download link groups, and firmware requirement.
 *
 * firmwareRequirement: the minimum firmware version parsed from "Works on X.xx and higher" notes.
 * When non-null, getBestDownloadLinks uses it for section compatibility instead of region-name heuristics.
 *
 * @param {string} base64Payload
 * @returns {{groups: Array<{type: string, links: Array<{label: string, url: string}>}>, password: string, firmwareRequirement: number|null}}
 */
function decodeAndExtractLinks(base64Payload) {
  const decoded = Buffer.from(base64Payload, 'base64').toString('utf-8');

  // Try to parse as JSON first (used in newer game pages)
  try {
    const data = JSON.parse(decoded);
    if (data && (Array.isArray(data.URLS) || Array.isArray(data.urls))) {
      const urls = data.URLS || data.urls || [];
      const password = data.Password || data.password || '';

      // Extract firmware requirement from the raw JSON string (covers Note/comment fields)
      const firmwareRequirement = extractFirmwareRequirement(decoded);

      const groups = [];
      for (const url of urls) {
        let trimmedUrl = (url || '').trim();
        // Decode shorteners / click bypasses (e.g. clk.sh) containing base64 URL param
        if (trimmedUrl.includes('url=')) {
          const urlMatch = trimmedUrl.match(/[?&]url=([^&]+)/);
          if (urlMatch) {
            try {
              const decodedUrl = Buffer.from(decodeURIComponent(urlMatch[1]), 'base64').toString('utf-8');
              if (decodedUrl.startsWith('http')) trimmedUrl = decodedUrl;
            } catch (e) {}
          }
        }

        if (trimmedUrl && !EXCLUDED_DOMAINS.some(domain => trimmedUrl.includes(domain))) {
          const type = detectTypeFromText('', trimmedUrl, '');
          // BACKPORT URL filtering: only apply old heuristic when section has no firmware note.
          // When firmwareRequirement is present, section-level filter in getBestDownloadLinks handles it.
          if (type === 'BACKPORT' && firmwareRequirement === null && shouldDropBackport('', trimmedUrl, '')) {
            continue;
          }
          groups.push({ type, links: [{ label: 'Link', url: trimmedUrl }] });
        }
      }

      return { groups, password, firmwareRequirement };
    }
  } catch (err) {
    // Parsing failed, proceed with Cheerio HTML parsing
  }

  const $ = cheerio.load(decoded);

  // Extract password — site sometimes typos "Pasword" (missing s), so match loosely
  const passwordMatch = $.text().match(/Pas+w?ord\s*:\s*([^\s<\n]+)/i);
  const password = passwordMatch ? passwordMatch[1].trim() : '';

  // Extract firmware requirement from full text content
  const firmwareRequirement = extractFirmwareRequirement($.text());

  const groups = [];

  // Group by paragraphs (<p>), list items (<li>), or divs if they contain links
  $('p, li').each((_, blockEl) => {
    const blockText = $(blockEl).clone().children('a').remove().end().text().trim();
    const blockLinks = [];
    $(blockEl).find('a').each((_, el) => {
      let url = ($(el).attr('href') || '').trim();
      const dataDomain = ($(el).attr('data-domain') || '').trim();
      const dataPath = ($(el).attr('data-path') || '').trim();

      if (dataDomain && dataPath) url = dataDomain + dataPath;

      const label = $(el).text().trim() || 'Link';

      // Decode shorteners / click bypasses (e.g. clk.sh) containing base64 URL param
      if (url.includes('url=')) {
        const urlMatch = url.match(/[?&]url=([^&]+)/);
        if (urlMatch) {
          try {
            const decodedUrl = Buffer.from(decodeURIComponent(urlMatch[1]), 'base64').toString('utf-8');
            if (decodedUrl.startsWith('http')) url = decodedUrl;
          } catch (e) {}
        }
      }

      if (url && !EXCLUDED_DOMAINS.some(domain => url.includes(domain))) {
        blockLinks.push({ label, url });
      }
    });

    if (blockLinks.length > 0) {
      const type = detectTypeFromText(blockText || $(blockEl).text());
      // BACKPORT URL filtering: only apply old heuristic when section has no firmware note
      if (type === 'BACKPORT' && firmwareRequirement === null && shouldDropBackport(blockText || $(blockEl).text())) {
        return;
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

      if (dataDomain && dataPath) url = dataDomain + dataPath;

      const label = $(el).text().trim() || 'Link';

      if (url.includes('url=')) {
        const urlMatch = url.match(/[?&]url=([^&]+)/);
        if (urlMatch) {
          try {
            const decodedUrl = Buffer.from(decodeURIComponent(urlMatch[1]), 'base64').toString('utf-8');
            if (decodedUrl.startsWith('http')) url = decodedUrl;
          } catch (e) {}
        }
      }

      if (url && !EXCLUDED_DOMAINS.some(domain => url.includes(domain))) {
        flatLinks.push({ label, url });
      }
    });

    if (flatLinks.length > 0) {
      groups.push({ type: detectTypeFromText(''), links: flatLinks });
    }
  }

  return { groups, password, firmwareRequirement };
}

/**
 * Evaluates all subpage sections for targetPPSA, sorts by region priority,
 * resolves reroutes if necessary, and returns the best download host and URLs.
 *
 * Section compatibility with user firmware:
 *   - If section content has "Works on X.xx and higher" → use X.xx vs USER_FIRMWARE to decide.
 *   - If no such note → fall back to region-name heuristic (shouldDropBackport).
 *
 * @param {Array<{ppsa: string, region: string, base64Payload: string}>} sections
 * @param {string} targetPPSA
 * @returns {Promise<{urls: string[], urlInfo: Array<{url: string, type: string}>, password: string, region: string, hostName: string}>}
 */
async function getBestDownloadLinks(sections, targetPPSA, { skipHosts = [] } = {}) {
  const userFirmware = parseInt(process.env.USER_FIRMWARE || '7', 10);

  // 1. Filter sections matching targetPPSA (if targetPPSA is specified)
  const matchingSections = targetPPSA
    ? sections.filter(sec => sec.ppsa === targetPPSA)
    : sections;

  if (matchingSections.length === 0) {
    throw new Error(`No sections found matching PPSA: ${targetPPSA}`);
  }

  // 2. Sort by region priority
  matchingSections.sort((a, b) => getRegionPriority(a.region) - getRegionPriority(b.region));

  const firmwareMismatchSections = [];

  // Try each region section in order of priority (in case of failure to extract/resolve)
  for (const section of matchingSections) {
    try {
      const { groups, password, firmwareRequirement } = decodeAndExtractLinks(section.base64Payload);
      // 3. Firmware compatibility check
      if (firmwareRequirement !== null) {
        // Content has an explicit "Works on X.xx and higher" note — use it
        if (firmwareRequirement > userFirmware) {
          logger.warn(`[${section.region}] Requires firmware ${firmwareRequirement}.xx but USER_FIRMWARE=${userFirmware} — saving as fallback`);
          firmwareMismatchSections.push({ section, groups, password, firmwareRequirement });
          continue;
        }
        // firmwareRequirement <= userFirmware → compatible, proceed
      } else {
        // No firmware note in content — fall back to region-name heuristic
        if (/backport/i.test(section.region) && shouldDropBackport(section.region)) {
          continue;
        }
      }
      
      let finalUrls = [];
      let finalUrlInfos = [];
      let selectedHostNames = new Set();

      // Resolve and select links for each group (asset) independently
      for (const group of groups) {
        if (group.type === 'BACKPORT' || group.type === 'BACK') {
          const isRequired = (firmwareRequirement !== null && firmwareRequirement > userFirmware);
          if (!isRequired) {
            continue; // Skip downloading this backport as it is not needed
          }
        }
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
            logger.warn(`Reroute resolution failed for ${reroute.url}: ${e.message}`);
          }
        }

        // Filter candidates to only allow valid download hosts or text guides
        const allowedCandidates = candidates.filter(cand => {
          return cand.url.startsWith('text_guide:') || getHostPriority(cand.url) < HOST_PRIORITY_PATTERNS.length;
        });

        if (allowedCandidates.length === 0) {
          if (candidates.length > 0) {
            logger.warn(`[${section.region}] Group "${group.type}" has ${candidates.length} link(s) but none are supported hosts: ${candidates.map(c => c.url).join(', ')}`);
          }
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

          const sortedHostKeys = Object.keys(groupedByHost).map(Number).sort((a, b) => a - b)
            .filter(key => !skipHosts.includes(getHostNameFromUrl(groupedByHost[key][0])));
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
      logger.warn(`[${section.region}] Section processing error: ${err.message}`);
    }
  }

  // No compatible section found — retry with firmware-mismatched sections as last resort
  if (firmwareMismatchSections.length > 0) {
    logger.warn(`No firmware-compatible section found. Falling back to firmware-mismatched section(s) (update USER_FIRMWARE in .env if needed).`);
    for (const { section, groups, password, firmwareRequirement } of firmwareMismatchSections) {
      logger.info(`Analyzing fallback: ${section.ppsa} – ${section.region} (firmware ${firmwareRequirement}.xx)`);
      try {
        let finalUrls = [];
        let finalUrlInfos = [];
        let selectedHostNames = new Set();

        for (const group of groups) {
          let candidates = [];
          const directLinks = group.links.filter(l => !l.url.includes(REROUTE_DOMAIN));
          const rerouteLinks = group.links.filter(l => l.url.includes(REROUTE_DOMAIN));
          candidates = candidates.concat(directLinks);
          for (const reroute of rerouteLinks) {
            try {
              const resolved = await resolveReroute(reroute.url);
              candidates = candidates.concat(resolved);
            } catch (e) {
              logger.warn(`Reroute resolution failed for ${reroute.url}: ${e.message}`);
            }
          }
          const allowedCandidates = candidates.filter(cand =>
            cand.url.startsWith('text_guide:') || getHostPriority(cand.url) < HOST_PRIORITY_PATTERNS.length
          );
          if (allowedCandidates.length === 0) continue;
          const downloadCandidates = allowedCandidates.filter(c => !c.url.startsWith('text_guide:'));
          if (downloadCandidates.length > 0) {
            const groupedByHost = {};
            for (const cand of downloadCandidates) {
              const idx = getHostPriority(cand.url);
              if (!groupedByHost[idx]) groupedByHost[idx] = [];
              if (!groupedByHost[idx].includes(cand.url)) groupedByHost[idx].push(cand.url);
            }
            const sortedKeys = Object.keys(groupedByHost).map(Number).sort((a, b) => a - b)
              .filter(k => !skipHosts.includes(getHostNameFromUrl(groupedByHost[k][0])));
            if (sortedKeys.length > 0) {
              for (const url of groupedByHost[sortedKeys[0]]) {
                if (!finalUrls.includes(url)) {
                  finalUrls.push(url);
                  finalUrlInfos.push({ url, type: group.type });
                  selectedHostNames.add(getHostNameFromUrl(url));
                }
              }
            }
          }
        }

        if (finalUrls.length === 0) continue;
        const hostList = Array.from(selectedHostNames);
        const hostName = hostList.includes('1fichier') ? '1fichier' : (hostList[0] || 'Other');
        return { urls: finalUrls, urlInfo: finalUrlInfos, password, region: section.region, hostName, ppsa: section.ppsa };
      } catch (err) {
        logger.warn(`[${section.region}] Firmware-fallback error: ${err.message}`);
      }
    }
  }

  throw new Error(`Failed to extract any download links for PPSA: ${targetPPSA}`);
}

module.exports = {
  decodeAndExtractLinks,
  getBestDownloadLinks,
  getRegionPriority
};
