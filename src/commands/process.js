const fs = require('fs');
const path = require('path');
const { processDownloadedFiles } = require('../utils/postProcessor');
const { sanitizeFileName } = require('../services/unrarService');
const { extractPPSA } = require('../utils/ppsaParser');
const { extractVersion } = require('../utils/versionParser');
const logger = require('../utils/logger');

/**
 * dlps process <filepath|folderpath> [--password <pw>]
 *
 * Flow:
 *   1. Is it a decompressed folder?    → folder pipeline:
 *        → contains .exfat inside?     → mount → validate → compress → cleanup
 *        → contains .ffpkg inside?     → UFS2 pipeline → compress → cleanup
 *        → contains PS5 game files?    → read param.json → compress → cleanup
 *   2. Is the file a raw .exfat?       → exFAT pipeline (mount → validate → compress)
 *   3. Is the file a .ffpkg?           → UFS2 pipeline (validate + read param.json → compress)
 *   4. Is it a compressed archive?
 *        → contains .exfat inside?     → exFAT pipeline (extract → mount → validate → compress)
 *        → contains PS5 game files?    → standard pipeline (extract → compress)
 *   Title / PPSA / version come from param.json inside the content, not the filename.
 */
async function processCommand(targetPath, options = {}) {
  const absPath = path.resolve(targetPath);

  if (!fs.existsSync(absPath)) {
    logger.error(`Path not found: ${absPath}`);
    process.exit(1);
  }

  if (path.resolve(path.dirname(absPath)) === absPath) {
    logger.error('Cannot process filesystem root directory');
    process.exit(1);
  }

  const stat = fs.statSync(absPath);
  const isDirectory = stat.isDirectory();
  const filename = path.basename(absPath);
  const downloadDir = path.dirname(absPath);
  const ext = path.extname(filename).toLowerCase();
  const isRawExfat = !isDirectory && ext === '.exfat';

  const cleanTitle = sanitizeFileName(filename.replace(/\[.*?\]/g, '').trim());

  try {
    const { registeredFiles, finalTitle, finalPpsa, finalVer } = await processDownloadedFiles({
      downloadedFiles: [{ filename, type: 'GAME' }],
      downloadDir,
      password: options.password || '',
      hostName: 'Manual',
      region: isRawExfat ? 'USA (exFAT)' : 'USA',
      // Seed fallback metadata from the filename/folder name — used when param.json can't be
      // read so the output is still sensibly named.
      initialTitle: cleanTitle || 'Unknown Game',
      initialPpsa: extractPPSA(filename) || 'Unknown',
      initialVer: extractVersion(filename) || 'v01.00',
    });

    logger.success(`Done: ${finalTitle} [${finalPpsa}][${finalVer}]`);
    if (registeredFiles && registeredFiles.length > 0) {
      registeredFiles.forEach(f => logger.info(`Registered: ${f.fileName}`));
    }

    const { removePendingForGame } = require('../services/pendingDb');
    const resolvedTitle = (finalTitle && finalTitle !== 'Unknown Game') ? finalTitle : cleanTitle;
    const resolvedPpsa = (finalPpsa && finalPpsa !== 'Unknown') ? finalPpsa : extractPPSA(filename);
    const removed = removePendingForGame({
      title: resolvedTitle,
      ppsa: resolvedPpsa,
      titleQuery: cleanTitle
    });
    if (removed && removed.length > 0) {
      removed.forEach(r => logger.info(`Removed "${r.title}" from pending manual downloads.`));
    }
  } catch (err) {
    logger.error(`Processing failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = processCommand;

