const logger = require('../utils/logger');
const fs = require('fs');

/**
 * Base platform handler defining the interface for platform-specific logic.
 */
class BasePlatform {
  /**
   * Returns the name of the platform (e.g., 'Base', 'PS5', 'PS4').
   */
  getName() {
    return 'Base';
  }

  /**
   * Handles error during download.
   * Allows platform-specific cleanup or error formatting (e.g., PS5 exFAT renaming).
   * If it throws, the caller will catch it and abort.
   *
   * @param {Error} err The error thrown during download
   * @param {Array} downloadedFiles Currently downloaded files array
   * @param {string} downloadDir The download directory
   * @param {string} sectionRegion The region string of the current section
   * @param {boolean} downloadStarted Whether the download had started
   */
  handleDownloadError(err, downloadedFiles, downloadDir, sectionRegion, downloadStarted) {
    // Default: just do nothing special, let caller throw it
  }

  /**
   * Cleans up partial files when aborting a download.
   *
   * @param {Array} downloadedFiles Currently downloaded files array
   * @param {string} downloadDir The download directory
   * @param {string} sectionRegion The region string of the current section
   */
  cleanupPartialFiles(downloadedFiles, downloadDir, sectionRegion) {
    for (const fileItem of downloadedFiles) {
      const filePath = require('path').join(downloadDir, fileItem.filename);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (e) {
        // ignore cleanup error
      }
    }
  }

  /**
   * Pre-download logic for filtering or restructuring links.
   * Modifies bestLinks in place or returns a new object.
   */
  preDownloadFilter(bestLinks, options) {
    return bestLinks;
  }

  /**
   * Post processes the downloaded files.
   * Returns an array of successfully registered files.
   *
   * @param {Object} params
   * @param {Array} params.downloadedFiles List of files that were downloaded
   * @param {string} params.downloadDir The directory where files are located
   * @param {string} params.password Extracted password (if any)
   * @param {string} params.hostName Download host name
   * @param {string} params.region Region tag
   * @param {string} params.initialTitle The game title
   * @param {string} params.initialPpsa The title ID / PPSA
   * @param {string} params.initialVer The version string
   * @returns {Promise<Array>} Array of registered file objects { fileName, type, backportFw, ... }
   */
  async postProcess(params) {
    throw new Error('postProcess not implemented on BasePlatform');
  }
}

module.exports = BasePlatform;
