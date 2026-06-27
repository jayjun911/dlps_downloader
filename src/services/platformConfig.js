const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../../data/config.json');
const DEFAULT_PLATFORM = 'ps5';

/**
 * Supported game-console platforms and their source pages on the
 * dlpsgame.com / nswgame.com / downloadgamexbox.com / downloadgamepsp.org
 * family of sites (all run by the same operator on a shared WordPress layout).
 *
 *   host    — site origin
 *   slug    — list-page slug (used for both the WP REST API and the direct URL)
 *   xmlFile — local LaunchBox library file under data/ for this platform
 */
const PLATFORMS = {
  ps5:         { key: 'ps5',         label: 'PlayStation 5',    host: 'https://dlpsgame.com',         slug: 'list-game-ps5',           xmlFile: 'PS5.xml' },
  ps4:         { key: 'ps4',         label: 'PlayStation 4',    host: 'https://dlpsgame.com',         slug: 'list-all-game-ps4',       xmlFile: 'PS4.xml' },
  ps3:         { key: 'ps3',         label: 'PlayStation 3',    host: 'https://dlpsgame.com',         slug: 'list-all-game-ps3',       xmlFile: 'PS3.xml' },
  ps2:         { key: 'ps2',         label: 'PlayStation 2',    host: 'https://dlpsgame.com',         slug: 'list-all-game-ps2',       xmlFile: 'PS2.xml' },
  switch:      { key: 'switch',      label: 'Nintendo Switch',  host: 'https://nswgame.com',          slug: 'list-all-game-switch',    xmlFile: 'Switch.xml' },
  wii:         { key: 'wii',         label: 'Nintendo Wii',     host: 'https://nswgame.com',          slug: 'list-all-game-wii',       xmlFile: 'Wii.xml' },
  wiiu:        { key: 'wiiu',        label: 'Nintendo Wii U',   host: 'https://nswgame.com',          slug: 'list-all-game-wii-u',     xmlFile: 'WiiU.xml' },
  '3ds':       { key: '3ds',         label: 'Nintendo 3DS',     host: 'https://nswgame.com',          slug: 'list-all-game-3ds',       xmlFile: '3DS.xml' },
  'xbox-jtag': { key: 'xbox-jtag',   label: 'Xbox (JTAG/RGH)',  host: 'https://downloadgamexbox.com', slug: 'list-all-game-xbox-jtag', xmlFile: 'XboxJtag.xml' },
  'xbox-iso':  { key: 'xbox-iso',    label: 'Xbox (ISO)',       host: 'https://downloadgamexbox.com', slug: 'list-all-game-xbox-iso',  xmlFile: 'XboxIso.xml' },
  psp:         { key: 'psp',         label: 'PSP / PPSSPP',     host: 'https://downloadgamepsp.org',  slug: 'list-all-game-psp-ppsspp',xmlFile: 'PSP.xml' },
  psvita:      { key: 'psvita',      label: 'PS Vita',          host: 'https://downloadgamepsp.org',  slug: 'list-all-game-psvita',    xmlFile: 'PSVita.xml' },
  pc:          { key: 'pc',          label: 'PC (Windows/Mac)', host: 'https://gamepciso.com',        slug: '',                        xmlFile: 'PC.xml' },
};

function normalizeKey(key) {
  return String(key || '').trim().toLowerCase();
}

function isSupported(key) {
  return Object.prototype.hasOwnProperty.call(PLATFORMS, normalizeKey(key));
}

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (e) {
    // Malformed config — fall back to defaults.
  }
  return {};
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Returns the currently selected platform key, falling back to the default
 * if nothing valid has been configured.
 */
function getCurrentPlatformKey() {
  const key = normalizeKey(readConfig().platform);
  return isSupported(key) ? key : DEFAULT_PLATFORM;
}

/**
 * Returns the full definition object for the currently selected platform.
 */
function getCurrentPlatform() {
  return PLATFORMS[getCurrentPlatformKey()];
}

/**
 * Persists the default platform. Throws on an unsupported key.
 */
function setCurrentPlatform(key) {
  const normalized = normalizeKey(key);
  if (!isSupported(normalized)) {
    throw new Error(`Unsupported platform: "${key}". Supported: ${listPlatformKeys().join(', ')}`);
  }
  const config = readConfig();
  config.platform = normalized;
  writeConfig(config);
  return PLATFORMS[normalized];
}

function listPlatforms() {
  return Object.values(PLATFORMS);
}

function listPlatformKeys() {
  return Object.keys(PLATFORMS);
}

/**
 * Resolves a per-platform data file path under data/.
 * e.g. platformDataPath('downloaded', 'xml') -> <root>/data/downloaded-ps5.xml
 */
function platformDataPath(baseName, ext) {
  return path.join(__dirname, '../../data', `${baseName}-${getCurrentPlatformKey()}.${ext}`);
}

module.exports = {
  PLATFORMS,
  DEFAULT_PLATFORM,
  isSupported,
  getCurrentPlatformKey,
  getCurrentPlatform,
  setCurrentPlatform,
  listPlatforms,
  listPlatformKeys,
  platformDataPath,
};
