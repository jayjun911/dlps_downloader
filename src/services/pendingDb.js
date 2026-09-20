const fs = require('fs');
const path = require('path');
const { platformDataPath } = require('./platformConfig');
const { normalizeTitle } = require('../utils/titleNormalizer');

// Per-platform "pending manual download" queue, e.g. data/pending_manual-ps4.json
// Records games whose pages were opened in the browser (download -i) for manual
// download, so they can later be batch-processed and completed via `process --pending`.
function pendingFile() {
  return platformDataPath('pending_manual', 'json');
}

/**
 * Loads the pending-manual queue for the active platform.
 * @returns {Array<{title, normalizedTitle, url, ppsa, addedAt}>}
 */
function loadPending() {
  const file = pendingFile();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function savePending(entries) {
  const file = pendingFile();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), 'utf-8');
}

/**
 * Upserts a game into the pending-manual queue (keyed by normalized title).
 * A later call with a real PPSA upgrades an earlier 'Unknown' entry.
 */
function addPending({ title, url, ppsa }) {
  const entries = loadPending();
  const normalized = normalizeTitle(title);
  const existing = entries.find(e => e.normalizedTitle === normalized);
  if (existing) {
    if (url) existing.url = url;
    if (ppsa && ppsa !== 'Unknown') existing.ppsa = ppsa;
    savePending(entries);
    return existing;
  }
  const entry = {
    title,
    normalizedTitle: normalized,
    url: url || '',
    ppsa: ppsa || 'Unknown',
    addedAt: new Date().toISOString(),
  };
  entries.push(entry);
  savePending(entries);
  return entry;
}

/**
 * Removes entries whose normalizedTitle is in the given set/array/string. Returns count removed.
 */
function removePending(normalizedTitles) {
  if (!normalizedTitles) return 0;
  const list = Array.isArray(normalizedTitles)
    ? normalizedTitles
    : (normalizedTitles instanceof Set ? Array.from(normalizedTitles) : [normalizedTitles]);

  const removeSet = new Set();
  for (const item of list) {
    if (!item) continue;
    if (typeof item === 'string') {
      removeSet.add(item);
      const norm = normalizeTitle(item);
      if (norm) removeSet.add(norm);
    } else if (typeof item === 'object') {
      if (item.normalizedTitle) removeSet.add(item.normalizedTitle);
      if (item.title) {
        removeSet.add(item.title);
        const norm = normalizeTitle(item.title);
        if (norm) removeSet.add(norm);
      }
    }
  }

  const entries = loadPending();
  const kept = entries.filter(e => {
    const eNorm = e.normalizedTitle || normalizeTitle(e.title || '');
    if (removeSet.has(eNorm)) return false;
    if (e.title && removeSet.has(e.title)) return false;
    return true;
  });

  savePending(kept);
  return entries.length - kept.length;
}

/**
 * Removes pending entries matching a completed game by title, normalizedTitle, ppsa, url, or titleQuery.
 * Returns array of removed entries.
 */
function removePendingForGame({ title = '', normalizedTitle = '', ppsa = '', url = '', titleQuery = '' } = {}) {
  const normTitle = normalizedTitle || (title ? normalizeTitle(title) : '');
  const normQuery = titleQuery ? normalizeTitle(titleQuery) : '';
  const ppsaUpper = (ppsa && ppsa !== 'Unknown') ? ppsa.toUpperCase() : '';
  const cleanUrl = url ? url.trim().toLowerCase().replace(/\/$/, '') : '';

  const entries = loadPending();
  if (entries.length === 0) return [];

  const toRemove = [];
  const kept = [];

  for (const entry of entries) {
    const entryNorm = entry.normalizedTitle || normalizeTitle(entry.title || '');
    const entryPpsa = (entry.ppsa && entry.ppsa !== 'Unknown') ? entry.ppsa.toUpperCase() : '';
    const entryUrl = entry.url ? entry.url.trim().toLowerCase().replace(/\/$/, '') : '';

    let matched = false;

    // 1. Exact normalized title match
    if (normTitle && entryNorm === normTitle) {
      matched = true;
    }
    // 2. Exact query normalized match
    else if (normQuery && entryNorm === normQuery) {
      matched = true;
    }
    // 3. Exact PPSA match
    else if (ppsaUpper && entryPpsa && entryPpsa === ppsaUpper) {
      matched = true;
    }
    // 4. Exact URL match
    else if (cleanUrl && entryUrl && entryUrl === cleanUrl) {
      matched = true;
    }

    if (matched) {
      toRemove.push(entry);
    } else {
      kept.push(entry);
    }
  }

  // Fallback: If no exact match found, but titleQuery was provided,
  // check if there's a unique partial match in pending
  if (toRemove.length === 0 && normQuery && normQuery.length >= 3) {
    const candidateIndices = [];
    kept.forEach((e, idx) => {
      const eNorm = e.normalizedTitle || normalizeTitle(e.title || '');
      if (eNorm.includes(normQuery) || normQuery.includes(eNorm)) {
        candidateIndices.push(idx);
      }
    });

    if (candidateIndices.length === 1) {
      const [idx] = candidateIndices;
      toRemove.push(kept[idx]);
      kept.splice(idx, 1);
    }
  }

  if (toRemove.length > 0) {
    savePending(kept);
  }

  return toRemove;
}

function clearPending() {
  savePending([]);
}

module.exports = {
  loadPending,
  savePending,
  addPending,
  removePending,
  removePendingForGame,
  clearPending,
};
