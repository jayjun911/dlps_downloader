const fs = require('fs');
const path = require('path');
const { processDownloadedFiles } = require('../utils/postProcessor');
const logger = require('../utils/logger');

/**
 * ps5dl process <filepath> [--password <pw>]
 *
 * Flow:
 *   1. Is the file a raw .exfat?       → exFAT pipeline (mount → validate → compress)
 *   2. Is it a compressed archive?
 *        → contains .exfat inside?     → exFAT pipeline (extract → mount → validate → compress)
 *        → contains PS5 game files?    → standard pipeline (extract → compress)
 *   Title / PPSA / version come from param.json inside the content, not the filename.
 */
async function processCommand(filePath, options = {}) {
  const absPath = path.resolve(filePath);

  if (!fs.existsSync(absPath)) {
    logger.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  const filename = path.basename(absPath);
  const downloadDir = path.dirname(absPath);
  const ext = path.extname(filename).toLowerCase();
  const isRawExfat = ext === '.exfat';

  try {
    const { registeredFiles, finalTitle, finalPpsa, finalVer } = await processDownloadedFiles({
      downloadedFiles: [{ filename, type: 'GAME' }],
      downloadDir,
      password: options.password || '',
      hostName: 'Manual',
      region: isRawExfat ? 'USA (exFAT)' : 'USA',
      initialTitle: 'Unknown Game',
      initialPpsa: 'Unknown',
    });

    logger.success(`Done: ${finalTitle} [${finalPpsa}][${finalVer}]`);
    if (registeredFiles && registeredFiles.length > 0) {
      registeredFiles.forEach(f => logger.info(`Registered: ${f.fileName}`));
    }
  } catch (err) {
    logger.error(`Processing failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = processCommand;
