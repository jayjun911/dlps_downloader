const cheerio = require('cheerio');
const { resolveReroute } = require('./rerouteResolver');
const logger = require('../utils/logger');

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

const EXCLUDED_DOMAINS = [
  'downloadgameps3.com',  // Guide/Tool links
];

const REROUTE_DOMAIN = 'downloadgameps3.net';

/**
 * Calculates region priority. Lower number represents higher priority.
 * USA (exFAT) -> USA -> KOR -> EUR -> other
 * But user specified: "KOR가 보이면 따로 무조건 high priority로 download"
 * Thus, KOR gets top priority (0), exFAT gets 1, USA gets 2, EUR gets 3, others get 4.
 * Within each region the order is exFAT > .ffpkg > plain (ffpkg = exFAT tier + 0.5).
 */
function getRegionPriority(regionName) {
  const region = regionName.toUpperCase();
  const isExfat = region.includes('EXFAT');
  const isFfpkg = region.includes('FFPKG'); // e.g. "EUR (FFPKG)"

  // Within a region prefer exFAT, then .ffpkg, then plain. ffpkg sits just below
  // exFAT by scoring it at the exFAT tier + 0.5 (still ranked above plain).
  const pick = (exfatVal, plainVal) =>
    isExfat ? exfatVal : (isFfpkg ? exfatVal + 0.5 : plainVal);

  if (region.includes('KOR')) {
    return pick(0, 1);
  }
  if (region.includes('USA')) {
    return pick(2, 4);
  }
  if (region.includes('EUR') || region.includes('EURO')) {
    return pick(3, 5);
  }
  return pick(6, 7);
}

// Download host priority. Lower index represents higher priority.
const HOST_PRIORITY_PATTERNS = [
  /1fichier\.com|1file/i,
  /datanodes\.to/i,
  /mediafire\.com/i,
  /vikingfile\.com|viki/i,
  /akirabox\.com|akia/i,
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

  // "FW REQUIRED: X.xx" — backport sections state the target firmware this way
  m = lower.match(/fw\s+required\s*:?\s*(\d+)\.(?:xx|\d+)/);
  if (m) return parseInt(m[1], 10);

  // "X.xx and higher / above / beyond / up / +"
  m = lower.match(/(\d+)\.(?:xx|\d+)\s+(?:and|or)\s+(?:higher|above|beyond|up|newer|later)/);
  if (m) return parseInt(m[1], 10);

  m = lower.match(/(\d+)xx\s+(?:and|or)\s+(?:higher|above|beyond|up|newer|later)/);
  if (m) return parseInt(m[1], 10);

  // "Note: X.xx ..." where X.xx is followed by higher/above/+
  m = lower.match(/note\s*:\s*(\d+)\.(?:xx|\d+)\s*(?:and\s+(?:higher|above)|\+)?/);
  if (m) return parseInt(m[1], 10);

  return null;
}

/**
 * Extracts a backport's target firmware major version from a backport link block.
 * Block labels are written as "Backport 4.xx", "Backport 4.xx+ (@BestPig)",
 * "BackPort Ver 5.xx", etc. — the firmware sits right after the word. Returns the
 * major version (e.g. 4) or null. Used only on BACKPORT-typed blocks, so the
 * section's *main* firmware requirement is never mistaken for the backport's.
 */
function extractBackportVersion(text) {
  const lower = (text || '').toLowerCase();
  // Firmware immediately following "backport"/"back" (lazy, so the nearest number wins)
  let m = lower.match(/back\s*port[^0-9]*?(\d{1,2})\.(?:xx|\d+)/);
  if (m) return parseInt(m[1], 10);
  m = lower.match(/back[^0-9]*?(\d{1,2})\.(?:xx|\d+)/);
  if (m) return parseInt(m[1], 10);
  // Fall back to a generic firmware note within the block ("FW REQUIRED: N.xx")
  return extractFirmwareRequirement(text);
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
          groups.push({ type, links: [{ label: 'Link', url: sanitizeFichierUrl(trimmedUrl) }], rawText: trimmedUrl });
        }
      }

      // Filter UPDATE groups to only keep the highest version
      const updateGroups = groups.filter(g => g.type === 'UPDATE');
      if (updateGroups.length > 1) {
        let bestGroup = null;
        let bestUpdateVer = -1;
        let bestFwVer = -1;

        for (const g of updateGroups) {
          let updateVer = 0;
          let fwVer = 0;
          const text = g.rawText || g.links.map(l => l.url).join(' ');
          
          const verMatch = text.match(/(?:update|patch|version|v)[\s-]*(\d+\.\d+)/i);
          if (verMatch) updateVer = parseFloat(verMatch[1]);
          
          const fwMatches = text.match(/\b(\d+\.\d+)\b/g);
          if (fwMatches) {
            for (const match of fwMatches) {
              const val = parseFloat(match);
              if (val !== updateVer && val > fwVer) {
                fwVer = val;
              }
            }
          }
          
          if (updateVer > bestUpdateVer || (updateVer === bestUpdateVer && fwVer > bestFwVer)) {
            bestUpdateVer = updateVer;
            bestFwVer = fwVer;
            bestGroup = g;
          }
        }

        const otherGroups = groups.filter(g => g.type !== 'UPDATE');
        if (bestGroup) otherGroups.push(bestGroup);
        groups.length = 0;
        groups.push(...otherGroups);
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
        blockLinks.push({ label, url: sanitizeFichierUrl(url) });
      }
    });

    if (blockLinks.length > 0) {
      const blockFullText = blockText || $(blockEl).text();
      const type = detectTypeFromText(blockFullText);
      // BACKPORT URL filtering: only apply old heuristic when section has no firmware note
      if (type === 'BACKPORT' && firmwareRequirement === null && shouldDropBackport(blockFullText)) {
        return;
      }
      const group = { type, links: blockLinks, rawText: blockFullText };
      // Tag backport groups with their own target firmware (parsed from this block,
      // not the section) so post-processing can name the file [BACK4XX] etc.
      if (type === 'BACKPORT' || type === 'BACK') {
        group.backportFw = extractBackportVersion(blockFullText);
      }
      groups.push(group);
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
        flatLinks.push({ label, url: sanitizeFichierUrl(url) });
      }
    });

    if (flatLinks.length > 0) {
      groups.push({ type: detectTypeFromText(''), links: flatLinks, rawText: '' });
    }
  }

  // Filter UPDATE groups to only keep the highest version
  const updateGroups = groups.filter(g => g.type === 'UPDATE');
  if (updateGroups.length > 1) {
    let bestGroup = null;
    let bestUpdateVer = -1;
    let bestFwVer = -1;

    for (const g of updateGroups) {
      let updateVer = 0;
      let fwVer = 0;
      const text = g.rawText || g.links.map(l => l.url).join(' ');
      
      const verMatch = text.match(/(?:update|patch|version|v)[\s-]*(\d+\.\d+)/i);
      if (verMatch) updateVer = parseFloat(verMatch[1]);
      
      const fwMatches = text.match(/\b(\d+\.\d+)\b/g);
      if (fwMatches) {
        for (const match of fwMatches) {
          const val = parseFloat(match);
          if (val !== updateVer && val > fwVer) {
            fwVer = val;
          }
        }
      }
      
      if (updateVer > bestUpdateVer || (updateVer === bestUpdateVer && fwVer > bestFwVer)) {
        bestUpdateVer = updateVer;
        bestFwVer = fwVer;
        bestGroup = g;
      }
    }

    const otherGroups = groups.filter(g => g.type !== 'UPDATE');
    if (bestGroup) otherGroups.push(bestGroup);
    groups.length = 0;
    groups.push(...otherGroups);
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
async function getBestDownloadLinks(sections, targetPPSA, { skipHosts = [], forceSection = false } = {}) {
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
      // 3. Firmware compatibility check (skipped when user explicitly selected this section)
      if (!forceSection) {
        if (firmwareRequirement !== null) {
          if (firmwareRequirement > userFirmware) {
            logger.warn(`[${section.region}] Requires firmware ${firmwareRequirement}.xx but USER_FIRMWARE=${userFirmware} — saving as fallback`);
            firmwareMismatchSections.push({ section, groups, password, firmwareRequirement });
            continue;
          }
        } else {
          if (/backport/i.test(section.region) && shouldDropBackport(section.region)) {
            continue;
          }
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

        // Resolve reroute URLs — deduplicate same URL (e.g. Akia/Viki/Data all pointing to same archive)
        const uniqueRerouteUrls = [...new Set(rerouteLinks.map(l => l.url))];
        for (const url of uniqueRerouteUrls) {
          try {
            const resolved = await resolveReroute(url);
            candidates = candidates.concat(resolved);
          } catch (e) {
            logger.warn(`Reroute resolution failed for ${url}: ${e.message}`);
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
                finalUrlInfos.push({ url, type: group.type, backportFw: group.backportFw != null ? group.backportFw : null });
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
          const uniqueRerouteUrls = [...new Set(rerouteLinks.map(l => l.url))];
          for (const url of uniqueRerouteUrls) {
            try {
              const resolved = await resolveReroute(url);
              candidates = candidates.concat(resolved);
            } catch (e) {
              logger.warn(`Reroute resolution failed for ${url}: ${e.message}`);
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
                  finalUrlInfos.push({ url, type: group.type, backportFw: group.backportFw != null ? group.backportFw : null });
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
