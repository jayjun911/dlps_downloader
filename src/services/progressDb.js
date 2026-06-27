const fs = require('fs');
const path = require('path');
const { platformDataPath } = require('./platformConfig');

// Per-platform in-progress set, e.g. data/progress-ps5.json
const PROGRESS_PATH = platformDataPath('progress', 'json');

function loadProgressSet() {
  try {
    if (fs.existsSync(PROGRESS_PATH)) {
      return new Set(JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8')));
    }
  } catch (e) {}
  return new Set();
}

function markProgress(normalizedTitle) {
  const set = loadProgressSet();
  set.add(normalizedTitle);
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify([...set], null, 2), 'utf-8');
}

function clearProgress(normalizedTitle) {
  const set = loadProgressSet();
  set.delete(normalizedTitle);
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify([...set], null, 2), 'utf-8');
}

module.exports = { loadProgressSet, markProgress, clearProgress };
