const fs = require('fs');
const path = require('path');
const ora = require('ora');
const { loadLocalLibrary } = require('../services/localLibrary');
const { processDownloadedFiles } = require('../utils/postProcessor');
const logger = require('../utils/logger');

/**
 * Parses a PPSA code from a filename, e.g. "[DLPSGAME.COM]-PPSA26786.part01.rar" → "PPSA26786"
 */
function parsePpsaFromFilename(filename) {
  const m = filename.match(/PPSA\d+/i);
  return m ? m[0].toUpperCase() : null;
}

/**
 * ps5dl process <filepath> [--password <pw>]
 *
 * Manually runs the post-processing pipeline on a downloaded file:
 *   - .exfat           → mount/validate + rename + compress to .7z
 *   - .rar/.zip/.7z    → extract + rename + compress
 * PPSA is parsed from filename; title looked up from local library.
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

  // Detect exFAT
  const isExfat = ext === '.exfat';

  // Parse PPSA from filename
  const ppsa = parsePpsaFromFilename(filename);

  // Look up title from local library
  let title = 'Unknown Game';
  if (ppsa) {
    const localGames = loadLocalLibrary();
    const match = localGames.find(g => g.ppsa === ppsa);
    if (match) title = match.title;
  }

  const spinner = ora(`Processing "${filename}"...`).start();
  spinner.info(`PPSA: ${ppsa || 'unknown'}, Title: ${title}, exFAT: ${isExfat}`);

  try {
    const { registeredFiles, finalTitle, finalPpsa, finalVer } = await processDownloadedFiles({
      downloadedFiles: [{ filename, type: 'GAME' }],
      downloadDir,
      password: options.password || '',
      hostName: 'Manual',
      region: isExfat ? 'USA (exFAT)' : 'USA',
      initialTitle: title,
      initialPpsa: ppsa || 'Unknown',
    });

    logger.success(`Done: ${finalTitle} [${finalPpsa}][${finalVer}]`);
    if (registeredFiles && registeredFiles.length > 0) {
      registeredFiles.forEach(f => logger.info(`Registered: ${f.fileName}`));
    }
  } catch (err) {
    spinner.fail(`Processing failed: ${err.message}`);
    logger.error('Process command failed.', err);
    process.exit(1);
  }
}

module.exports = processCommand;
