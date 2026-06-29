const PS5Platform = require('./PS5Platform');
const PS4Platform = require('./PS4Platform');
const SwitchPlatform = require('./SwitchPlatform');
const BasePlatform = require('./BasePlatform');

const _instances = {};

/**
 * Returns the appropriate Platform handler instance for the given console key.
 *
 * @param {string} consoleKey e.g., 'ps5', 'ps4', 'switch', etc.
 * @returns {BasePlatform}
 */
function getPlatformHandler(consoleKey) {
  const key = (consoleKey || '').toLowerCase();
  
  if (!_instances[key]) {
    switch (key) {
      case 'ps5':
        _instances[key] = new PS5Platform();
        break;
      case 'ps4':
      case 'ps1':
      case 'ps2':
      case 'ps1-2':
      case 'psp':
      case 'saturn':
        // All PS-PKG based consoles use the PS4 platform extraction logic for PKGs
        _instances[key] = new PS4Platform();
        break;
      case 'switch':
        _instances[key] = new SwitchPlatform();
        break;
      default:
        _instances[key] = new BasePlatform();
        break;
    }
  }
  
  return _instances[key];
}

module.exports = {
  getPlatformHandler
};
