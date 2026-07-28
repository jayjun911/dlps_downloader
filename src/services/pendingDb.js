const fs = require('fs');
const path = require('path');
const { platformDataPath } = require('./platformConfig');
const { normalizeTitle } = require('../utils/titleNormalizer');

// Per-platform "pending manual download" queue, e.g. data/pending_manual-ps4.json
// Records games whose pages were opened in the browser (download -i) for manual
// download, so they can later be batch-marked completed via `completed --pending`.
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
 * Removes entries whose normalizedTitle is in the given set/array. Returns count removed.
 */
function removePending(normalizedTitles) {
  const remove = new Set(normalizedTitles);
  const entries = loadPending();
  const kept = entries.filter(e => !remove.has(e.normalizedTitle));
  savePending(kept);
  return entries.length - kept.length;
}

function clearPending() {
  savePending([]);
}

module.exports = {
  loadPending,
  savePending,
  addPending,
  removePending,
  clearPending,
};
