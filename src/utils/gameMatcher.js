const fs = require('fs');
const path = require('path');

const SUBPAGE_CACHE_DIR = path.join(__dirname, '../../data/cache/subpages');

/**
 * Reads a cached subpage JSON and returns all PPSA codes found inside.
 * @param {string} slug
 * @returns {string[]} Array of PPSA codes in uppercase
 */
function getCachedSubpagePpsas(slug) {
  const cachePath = path.join(SUBPAGE_CACHE_DIR, `${slug}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      const content = fs.readFileSync(cachePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed.map(s => s.ppsa ? s.ppsa.toUpperCase() : '').filter(Boolean);
      }
    } catch (e) {
      // ignore
    }
  }
  return [];
}

/**
 * Determines status of a web game by matching either title or PPSA.
 * @param {object} webGame Web game object ({ title, slug, normalizedTitle })
 * @param {Map} localMap Map of normalizedTitle to local game
 * @param {Map} dlMap Map of normalizedTitle to downloaded game
 * @param {Set} excludedSet Set of normalizedTitle exclusions
 * @param {Map} localPpsaMap Map of PPSA to local game
 * @param {Map} dlPpsaMap Map of PPSA to downloaded game
 * @returns {{status: string, ppsa: string}}
 */
function getWebGameStatus(webGame, localMap, dlMap, excludedSet, localPpsaMap, dlPpsaMap, progressSet = null) {
  // 1. Direct title matching
  if (dlMap.has(webGame.normalizedTitle)) {
    return { status: 'downloaded', ppsa: dlMap.get(webGame.normalizedTitle).ppsa || '' };
  }
  if (localMap.has(webGame.normalizedTitle)) {
    return { status: 'local', ppsa: localMap.get(webGame.normalizedTitle).ppsa || '' };
  }
  if (excludedSet.has(webGame.normalizedTitle)) {
    return { status: 'excluded', ppsa: '' };
  }

  // 2. PPSA matching using cached subpages
  const ppsas = getCachedSubpagePpsas(webGame.slug);
  for (const ppsa of ppsas) {
    if (dlPpsaMap.has(ppsa)) {
      return { status: 'downloaded', ppsa };
    }
    if (localPpsaMap.has(ppsa)) {
      return { status: 'local', ppsa };
    }
  }

  // 3. In-progress check
  if (progressSet && progressSet.has(webGame.normalizedTitle)) {
    return { status: 'progress', ppsa: '' };
  }

  return { status: 'tbd', ppsa: '' };
}

module.exports = {
  getCachedSubpagePpsas,
  getWebGameStatus
};
