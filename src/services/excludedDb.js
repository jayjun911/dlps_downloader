const fs = require('fs');
const path = require('path');
const { normalizeTitle } = require('../utils/titleNormalizer');
const { platformDataPath } = require('./platformConfig');

// Per-platform exclusion list, e.g. data/excluded-ps5.json
const EXCLUDED_FILE = platformDataPath('excluded', 'json');

function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

/**
 * Loads the list of excluded games from the JSON file.
 * 
 * @returns {Array<{title: string, normalizedTitle: string, excludedAt: string}>}
 */
function loadExcludedGames() {
  if (!fs.existsSync(EXCLUDED_FILE)) {
    return [];
  }
  try {
    const content = fs.readFileSync(EXCLUDED_FILE, 'utf-8');
    return JSON.parse(content) || [];
  } catch (err) {
    return [];
  }
}

/**
 * Saves the list of excluded games back to the JSON file.
 * 
 * @param {Array<{title: string, normalizedTitle: string, excludedAt: string}>} games 
 */
function saveExcludedGames(games) {
  ensureDirectoryExistence(EXCLUDED_FILE);
  fs.writeFileSync(EXCLUDED_FILE, JSON.stringify(games, null, 2), 'utf-8');
}

/**
 * Checks if a game title is excluded.
 * 
 * @param {string} normalizedTitle 
 * @returns {boolean}
 */
function isExcluded(normalizedTitle) {
  const games = loadExcludedGames();
  return games.some(g => g.normalizedTitle === normalizedTitle);
}

/**
 * Adds a game to the excluded list.
 * 
 * @param {string} title 
 * @returns {boolean} True if added, false if already in the list
 */
function addExcludedGame(title) {
  const games = loadExcludedGames();
  const normalized = normalizeTitle(title);
  
  if (games.some(g => g.normalizedTitle === normalized)) {
    return false;
  }
  
  games.push({
    title,
    normalizedTitle: normalized,
    excludedAt: new Date().toISOString()
  });
  
  saveExcludedGames(games);
  return true;
}

/**
 * Removes a game from the excluded list.
 * 
 * @param {string} title 
 * @returns {boolean} True if removed, false if not found
 */
function removeExcludedGame(title) {
  const games = loadExcludedGames();
  const normalized = normalizeTitle(title);
  
  const filtered = games.filter(g => g.normalizedTitle !== normalized);
  if (filtered.length === games.length) {
    return false;
  }
  
  saveExcludedGames(filtered);
  return true;
}

module.exports = {
  loadExcludedGames,
  isExcluded,
  addExcludedGame,
  removeExcludedGame
};
