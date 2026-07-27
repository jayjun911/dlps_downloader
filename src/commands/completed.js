const { findGameInWebList } = require('../services/webScraper');
const { addDownloadedGame, loadDownloadedGames, removeDownloadedGame } = require('../services/downloadedDb');
const { loadPending, removePending } = require('../services/pendingDb');
const { loadLabelMap } = require('../services/labelDb');
const { platformDataPath } = require('../services/platformConfig');
const logger = require('../utils/logger');
const readline = require('readline');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');

/**
 * Resolves the active download directory (mirrors download command).
 */
function getDownloadDir() {
  return process.env.DOWNLOAD_DIR || path.join(__dirname, '../../downloads');
}

/**
 * Returns a Set of lowercased entry names in the download directory (shallow).
 */
function listDownloadDirNames() {
  const dir = getDownloadDir();
  try {
    return fs.readdirSync(dir).map(n => n.toLowerCase());
  } catch (e) {
    return [];
  }
}

/**
 * A pending game counts as downloaded when a GAME-type file for its PPSA is
 * present in the download dir. GAME files carry the "[Game]" tag in their name
 * (the user's renamer convention); DLC/UPDATE/PATCH files don't.
 */
function findGameFile(names, ppsa, title) {
  const { normalizeTitle } = require('../utils/titleNormalizer');
  const ppsaId = (ppsa && ppsa !== 'Unknown') ? ppsa.toLowerCase() : null;
  const normTitle = title ? normalizeTitle(title) : null;

  return names.find(n => {
    const lower = n.toLowerCase();

    // Only count files that have been successfully processed and tagged as a game
    if (!lower.includes('[game]')) return false;

    // 1. Match PPSA code in filename if PPSA is known (e.g. PPSA16265 or ppsa16265)
    if (ppsaId && lower.includes(ppsaId)) return true;

    // 2. Match normalized title in filename if title is known
    if (normTitle && normTitle.length > 3) {
      const cleanName = lower.replace(/[^a-z0-9]/g, '');
      if (cleanName.includes(normTitle)) return true;
    }

    return false;
  }) || null;
}

/**
 * Resolves the game title using multiple fallback mechanisms:
 * 1. Pending queue item matching PPSA
 * 2. Pending queue item matching title in original filename
 * 3. Downloaded DB (downloaded-ps5.xml) matching PPSA
 * 4. Local library (PS5.xml) matching PPSA
 * 5. Web game list matching PPSA
 * 6. Cleaned title extracted from original archive filename
 */
async function resolveGameTitle(ppsaKey, mainFileName, pending = []) {
  const { normalizeTitle } = require('../utils/titleNormalizer');

  // 1. Pending queue item by PPSA
  if (Array.isArray(pending) && pending.length > 0) {
    const pendingMatch = pending.find(p => p.ppsa && p.ppsa.toUpperCase() === ppsaKey);
    if (pendingMatch && pendingMatch.title && pendingMatch.title.toLowerCase() !== 'unknown') {
      return pendingMatch.title;
    }
  }

  // 2. Pending queue item by title match in filename
  if (mainFileName && Array.isArray(pending) && pending.length > 0) {
    const mainLower = mainFileName.toLowerCase();
    const pendingTitleMatch = pending.find(p => {
      if (!p.title) return false;
      const norm = normalizeTitle(p.title);
      return norm && norm.length > 3 && mainLower.includes(norm);
    });
    if (pendingTitleMatch && pendingTitleMatch.title) {
      return pendingTitleMatch.title;
    }
  }

  // 3. Downloaded Database (downloaded-ps5.xml)
  try {
    const downloadedGames = loadDownloadedGames();
    const dlMatch = downloadedGames.find(g => g.ppsa && g.ppsa.toUpperCase() === ppsaKey && g.title && g.title.toLowerCase() !== 'unknown');
    if (dlMatch) return dlMatch.title;
  } catch (e) {}

  // 4. Local Library (PS5.xml)
  try {
    const { loadLocalLibrary } = require('../services/localLibrary');
    const localGames = loadLocalLibrary();
    const localMatch = localGames.find(lg => lg.ppsa && lg.ppsa.toUpperCase() === ppsaKey && lg.title && lg.title.toLowerCase() !== 'unknown');
    if (localMatch) return localMatch.title;
  } catch (e) {}

  // 5. Web Game List
  try {
    const { getWebGameList } = require('../services/webScraper');
    const webList = await getWebGameList();
    const webMatch = webList.find(w => w.url && w.url.toUpperCase().includes(ppsaKey));
    if (webMatch && webMatch.title) return webMatch.title;
  } catch (e) {}

  // 6. Extract clean title from original filename
  if (mainFileName) {
    let clean = mainFileName
      .replace(/^unknown\s*/i, '')
      .replace(/PPSA\d+/gi, '')
      .replace(/\[v[0-9.]+\]/gi, '')
      .replace(/\[game\]/gi, '')
      .replace(/\[.*?\]/g, '')
      .replace(/\.part[0-9]+\.(rar|zip|7z)$/i, '')
      .replace(/\.(rar|zip|7z|r\d{2}|z\d{2})$/i, '')
      .replace(/[-_.]+/g, ' ')
      .trim();
    if (clean && clean.toLowerCase() !== 'unknown') {
      return clean;
    }
  }

  return 'Unknown';
}

/**
 * Processes archives in downloadDir for PS5 platform when running completed --pending.
 * Searches for 7z/rar archives with PPSA numbers (e.g. PPSANNNNN), checks if password-protected or
 * split (r01, r02, part1, etc.), unpacks and recompresses them to 7z, and renames them to standard format.
 */
async function processPendingArchivesPS5(downloadDir, pending = [], passwordOption = '') {
  const { getCurrentPlatformKey } = require('../services/platformConfig');
  if (getCurrentPlatformKey() !== 'ps5') return;

  const ora = require('ora');
  const {
    extractRarArchive,
    getGameInfoFromArchive,
    compressFolderTo7z,
    findShallowestEbootDir,
    findWorkingPassword,
    sanitizeFileName
  } = require('../services/unrarService');

  const {
    isArchiveFile,
    checkIsSplitArchive,
    findMainArchiveFile,
    getUniqueFilePath
  } = require('../utils/postProcessor');

  const { extractPPSA } = require('../utils/ppsaParser');
  const { normalizeTitle } = require('../utils/titleNormalizer');

  if (!fs.existsSync(downloadDir)) return;

  let dirFiles = [];
  try {
    dirFiles = fs.readdirSync(downloadDir);
  } catch (e) {
    return;
  }

  // Only process files that belong to pending entries.
  // For each pending entry, find matching files by PPSA or title.
  const pendingWithPpsa = pending.filter(p => p.ppsa && p.ppsa !== 'Unknown');
  if (pendingWithPpsa.length === 0) return;

  let processedCount = 0;

  for (const pendingEntry of pendingWithPpsa) {
    const ppsaKey = pendingEntry.ppsa.toUpperCase();
    const normPendingTitle = normalizeTitle(pendingEntry.title);

    // Find files matching this pending entry's PPSA or title
    const matchedFiles = dirFiles.filter(file => {
      const filePpsa = extractPPSA(file);
      if (filePpsa && filePpsa.toUpperCase() === ppsaKey) return true;

      // Title match only if no PPSA in filename and title is long enough
      if (!filePpsa && normPendingTitle && normPendingTitle.length > 5) {
        const normFile = normalizeTitle(file);
        if (normFile.includes(normPendingTitle)) return true;
      }
      return false;
    });

    if (matchedFiles.length === 0) continue;

    // Categorize matched files
    const exfatFiles = matchedFiles.filter(f => f.toLowerCase().endsWith('.exfat'));
    const ffpkgFiles = matchedFiles.filter(f => f.toLowerCase().endsWith('.ffpkg'));
    const archiveFiles = matchedFiles.filter(isArchiveFile);

    let finalTitle = pendingEntry.title;
    let finalPpsa = ppsaKey;
    let finalVer = 'v01.00';
    let workingPassword = passwordOption || '';

    const mainFileName = findMainArchiveFile(archiveFiles) || matchedFiles[0];
    const mainFilePath = mainFileName ? path.join(downloadDir, mainFileName) : null;

    // Try to read internal metadata from archive
    if (mainFilePath && isArchiveFile(mainFileName)) {
      try {
        const gameInfo = await getGameInfoFromArchive(mainFilePath, passwordOption);
        if (gameInfo.titleId && gameInfo.titleId !== 'Unknown') finalPpsa = gameInfo.titleId;
        if (gameInfo.titleName && gameInfo.titleName !== 'Unknown') finalTitle = gameInfo.titleName;
        if (gameInfo.version) finalVer = gameInfo.version;
        if (gameInfo.workingPassword) workingPassword = gameInfo.workingPassword;
      } catch (e) {
        try {
          const foundPwd = await findWorkingPassword(mainFilePath, passwordOption ? [passwordOption] : []);
          if (foundPwd) workingPassword = foundPwd;
        } catch (pwdErr) {}
      }
    }

    const baseNameLabel = `${sanitizeFileName(finalTitle)} [${finalPpsa}][${finalVer}] [Game]`;
    processedCount++;

    // Rename exfat files
    for (const exf of exfatFiles) {
      const srcPath = path.join(downloadDir, exf);
      const destPath = path.join(downloadDir, `${baseNameLabel}.exfat`);
      if (srcPath !== destPath && !fs.existsSync(destPath)) {
        try {
          fs.renameSync(srcPath, destPath);
          logger.success(`[PS5] Renamed exfat: ${path.basename(destPath)}`);
        } catch (e) {}
      }
    }

    // Rename ffpkg files
    for (const ff of ffpkgFiles) {
      const srcPath = path.join(downloadDir, ff);
      const destPath = path.join(downloadDir, `${baseNameLabel}.ffpkg`);
      if (srcPath !== destPath && !fs.existsSync(destPath)) {
        try {
          fs.renameSync(srcPath, destPath);
          logger.success(`[PS5] Renamed ffpkg: ${path.basename(destPath)}`);
        } catch (e) {}
      }
    }

    // Process archives (rar, split, encrypted, single 7z)
    if (archiveFiles.length > 0 && mainFileName) {
      const isSplit = checkIsSplitArchive(archiveFiles) || archiveFiles.length > 1;
      const isEncrypted = workingPassword !== '';
      const isRar = archiveFiles.some(f => f.toLowerCase().includes('.rar') || /\.r\d{2}$/i.test(f));
      const isNotSingle7z = isRar || isSplit || isEncrypted || !mainFileName.toLowerCase().endsWith('.7z');

      if (isNotSingle7z) {
        logger.info(`[PS5] Found matching ${ppsaKey}, ${finalTitle}`);
        const processSpinner = ora(`[PS5] Extracting & recompressing ${ppsaKey} (${archiveFiles.length} file(s))...`).start();
        const outputFolderPath = path.join(downloadDir, `temp_extract_${ppsaKey}_${Date.now()}`);

        try {
          await extractRarArchive(mainFilePath, outputFolderPath, workingPassword, (text) => {
            processSpinner.text = `[PS5] [Extracting] ${ppsaKey} - ${text}`;
          });

          if (!fs.existsSync(outputFolderPath) || fs.readdirSync(outputFolderPath).length === 0) {
            throw new Error(`Extraction output folder is empty: ${outputFolderPath}`);
          }

          for (const file of archiveFiles) {
            try { fs.unlinkSync(path.join(downloadDir, file)); } catch (unlinkErr) {}
          }

          const dest7zPath = getUniqueFilePath(downloadDir, baseNameLabel, '.7z');
          const compressRoot = findShallowestEbootDir(outputFolderPath) || outputFolderPath;

          await compressFolderTo7z(compressRoot, dest7zPath, (text) => {
            processSpinner.text = `[PS5] [Compressing] ${ppsaKey} - ${text}`;
          });

          if (!fs.existsSync(dest7zPath) || fs.statSync(dest7zPath).size === 0) {
            throw new Error(`Recompressed 7z is empty: ${dest7zPath}`);
          }

          try { fs.rmSync(outputFolderPath, { recursive: true, force: true }); } catch (rmErr) {}

          processSpinner.succeed(`[PS5] Processed and recompressed to: ${path.basename(dest7zPath)}`);
        } catch (err) {
          processSpinner.fail(`[PS5] Processing failed for ${ppsaKey}: ${err.message}`);
          try { if (fs.existsSync(outputFolderPath)) fs.rmSync(outputFolderPath, { recursive: true, force: true }); } catch (e) {}
        }
      } else {
        // Single unencrypted .7z — just rename
        const dest7zPath = path.join(downloadDir, `${baseNameLabel}.7z`);
        if (mainFilePath !== dest7zPath && !fs.existsSync(dest7zPath)) {
          try {
            fs.renameSync(mainFilePath, dest7zPath);
            logger.success(`[PS5] Renamed archive: ${path.basename(dest7zPath)}`);
          } catch (renameErr) {
            logger.warn(`[PS5] Could not rename archive: ${renameErr.message}`);
          }
        }
      }
    }
  }

  if (processedCount > 0) {
    logger.info(`[PS5] Processed ${processedCount} pending game(s) in download directory.`);
  }
}

/**
 * Parses a number-selection string like "3 5" or "1-4, 7" into a 0-based index Set.
 */
function parseSelection(input, max) {
  const picked = new Set();
  for (const tok of input.split(/[\s,]+/).filter(Boolean)) {
    const range = tok.match(/^(\d+)-(\d+)$/);
    if (range) {
      let a = parseInt(range[1], 10), b = parseInt(range[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let n = a; n <= b; n++) if (n >= 1 && n <= max) picked.add(n - 1);
    } else if (/^\d+$/.test(tok)) {
      const n = parseInt(tok, 10);
      if (n >= 1 && n <= max) picked.add(n - 1);
    }
  }
  return picked;
}

/**
 * Batch-marks pending manual downloads (download -i) as completed.
 * Auto-detects which ones have their GAME file present, then lets the user add
 * any stragglers by number before committing.
 */
async function handlePending(options = {}) {
  let pending = loadPending();
  if (pending.length === 0) {
    logger.info('No pending manual downloads. (Run `dlps download -l N -i` first.)');
    return;
  }

  // For PS5 platform, post-process (rename/recompress) any matching archives
  // in download directory BEFORE pruning stale entries — this ensures files
  // get renamed even if they were already marked completed in a previous run.
  await processPendingArchivesPS5(getDownloadDir(), pending, options.password || '');

  // Drop entries that are no longer TBD — resolved elsewhere since being queued
  // (auto-labeled as another console/JPN, already completed, or excluded). Clean
  // them out of the queue so only genuine manual candidates remain.
  const labelMap = loadLabelMap();
  const completedSet = new Set(loadDownloadedGames().map(g => g.normalizedTitle));
  const { loadExcludedGames } = require('../services/excludedDb');
  const excludedSet = new Set(loadExcludedGames().map(g => g.normalizedTitle));
  const stale = pending.filter(p =>
    labelMap.has(p.normalizedTitle) || completedSet.has(p.normalizedTitle) || excludedSet.has(p.normalizedTitle)
  );
  if (stale.length > 0) {
    removePending(stale.map(p => p.normalizedTitle));
    pending = pending.filter(p => !stale.some(s => s.normalizedTitle === p.normalizedTitle));
    logger.info(`Removed ${stale.length} already-resolved game(s) from the pending queue.`);
  }
  if (pending.length === 0) {
    logger.info('No pending manual downloads remaining.');
    return;
  }

  const names = listDownloadDirNames();
  const rows = pending.map(p => ({
    entry: p,
    file: findGameFile(names, p.ppsa, p.title),
  }));

  console.log(chalk.cyan(`\nPending manual downloads (${rows.length}):`));
  rows.forEach((r, idx) => {
    const mark = r.file ? chalk.green('✓') : chalk.gray('·');
    const ppsa = chalk.gray(`[${r.entry.ppsa}]`);
    const found = r.file ? chalk.green(' (file found)') : '';
    console.log(`  ${mark} [${String(idx + 1).padStart(2, '0')}] ${r.entry.title} ${ppsa}${found}`);
  });

  const detectedCount = rows.filter(r => r.file).length;
  console.log(
    chalk.gray(`\n✓ = GAME file found in ${getDownloadDir()} (auto-selected: ${detectedCount}).`)
  );

  const answer = await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      chalk.cyan('Add any extra numbers to mark completed (e.g. "3 5"), or press Enter to confirm: '),
      ans => { rl.close(); resolve(ans.trim()); }
    );
  });

  const selected = new Set(rows.map((r, i) => (r.file ? i : -1)).filter(i => i >= 0));
  for (const i of parseSelection(answer, rows.length)) selected.add(i);

  if (selected.size === 0) {
    logger.info('Nothing selected. No changes made.');
    return;
  }

  const doneTitles = [];
  for (const i of selected) {
    const { entry, file } = rows[i];
    addDownloadedGame({
      title: entry.title,
      fileName: file ? file : 'Manual Entry',
      ppsa: entry.ppsa || 'Unknown',
      password: '',
      source: 'Manual',
      region: 'Unknown',
    });
    doneTitles.push(entry.normalizedTitle);
    logger.success(`Marked completed: "${entry.title}" (${entry.ppsa})`);
  }

  removePending(doneTitles);
  const remaining = pending.length - doneTitles.length;
  logger.info(`${doneTitles.length} marked completed. ${remaining} still pending.`);
}


/**
 * Handles the 'completed' CLI command.
 */
async function completedCommand(titleQuery, options = {}) {
  const isRemove = !!options.remove;

  // Batch-complete games queued for manual download via `download -i`.
  if (options.pending) {
    return handlePending(options);
  }

  // If no query is provided, print the list of currently completed games
  if (!titleQuery) {
    const completedList = loadDownloadedGames();
    if (completedList.length === 0) {
      logger.info('No games are currently marked as completed.');
      return;
    }
    console.log(chalk.green(`\nCurrently completed games (${completedList.length}):`));
    completedList.forEach((g, idx) => {
      console.log(`  [${String(idx + 1).padStart(3, '0')}] ${g.title} ${chalk.gray(`(PPSA: ${g.ppsa}, Region: ${g.region})`)}`);
    });
    return;
  }

  try {
    // Case 1: Removing from completed list
    if (isRemove) {
      const completedList = loadDownloadedGames();
      const queryLower = titleQuery.toLowerCase();
      const matches = completedList.filter(g => 
        g.title.toLowerCase().includes(queryLower)
      );

      if (matches.length === 0) {
        logger.warn(`No completed games found matching: "${titleQuery}"`);
        return;
      }

      if (matches.length === 1) {
        const game = matches[0];
        removeDownloadedGame(game.title);
        logger.success(`Successfully removed from completed list: "${game.title}"`);
        return;
      }

      // Multiple matches
      console.log(chalk.yellow(`\nMultiple completed games match your query "${titleQuery}":`));
      matches.forEach((game, idx) => {
        console.log(`  [${idx + 1}] ${game.title}`);
      });

      await new Promise((resolve) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });

        rl.question(chalk.cyan('\nSelect a game number to remove from completed list (or press Enter to cancel): '), (answer) => {
          rl.close();
          const num = parseInt(answer.trim(), 10);
          if (num > 0 && num <= matches.length) {
            const selected = matches[num - 1];
            removeDownloadedGame(selected.title);
            logger.success(`Successfully removed from completed list: "${selected.title}"`);
          } else {
            logger.info('Cancelled.');
          }
          resolve();
        });
      });
      return;
    }

    // Case 2: Adding to completed list (standard behavior)
    const matches = await findGameInWebList(titleQuery);
    
    if (matches.length === 0) {
      // Ask if the user wants to mark this exact title as completed anyway
      await new Promise((resolve) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });

        rl.question(chalk.yellow(`No games matching "${titleQuery}" found in the web list. Mark this exact title as completed anyway? (y/N): `), (answer) => {
          rl.close();
          if (answer.trim().toLowerCase() === 'y') {
            addDownloadedGame({
              title: titleQuery,
              fileName: 'Manual Entry',
              ppsa: 'Unknown',
              password: '',
              source: 'Manual',
              region: 'Unknown'
            });
            logger.success(`Successfully marked as completed: "${titleQuery}"`);
          } else {
            logger.info('Cancelled.');
          }
          resolve();
        });
      });
      return;
    }

    if (matches.length === 1) {
      const game = matches[0];
      // Try to parse PPSA from slug or URL if possible
      const ppsaMatch = game.url.match(/ppsa\d{5}/i);
      const parsedPpsa = ppsaMatch ? ppsaMatch[0].toUpperCase() : 'Unknown';

      addDownloadedGame({
        title: game.title,
        fileName: 'Manual Entry',
        ppsa: parsedPpsa,
        password: '',
        source: 'Manual',
        region: 'Unknown'
      });
      logger.success(`Successfully marked as completed: "${game.title}" (PPSA: ${parsedPpsa})`);
      return;
    }

    // Multiple matches
    console.log(chalk.yellow(`\nMultiple games match your query "${titleQuery}":`));
    matches.forEach((game, idx) => {
      console.log(`  [${idx + 1}] ${game.title} (${game.url})`);
    });

    await new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      rl.question(chalk.cyan('\nSelect a game number to mark as completed (or press Enter to cancel): '), (answer) => {
        rl.close();
        const num = parseInt(answer.trim(), 10);
        if (num > 0 && num <= matches.length) {
          const selected = matches[num - 1];
          const ppsaMatch = selected.url.match(/ppsa\d{5}/i);
          const parsedPpsa = ppsaMatch ? ppsaMatch[0].toUpperCase() : 'Unknown';
          
          addDownloadedGame({
            title: selected.title,
            fileName: 'Manual Entry',
            ppsa: parsedPpsa,
            password: '',
            source: 'Manual',
            region: 'Unknown'
          });
          logger.success(`Successfully marked as completed: "${selected.title}" (PPSA: ${parsedPpsa})`);
        } else {
          logger.info('Cancelled.');
        }
        resolve();
      });
    });

  } catch (err) {
    logger.error('Failed to update completed games list.', err);
  }
}

module.exports = completedCommand;
