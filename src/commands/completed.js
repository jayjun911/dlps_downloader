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
    findParamJson,
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

    // Find files and folders matching this pending entry's PPSA or title
    const matchedItems = dirFiles.filter(item => {
      const fullPath = path.join(downloadDir, item);
      let isDir = false;
      try { isDir = fs.statSync(fullPath).isDirectory(); } catch (e) {}

      if (isDir) {
        if (item.startsWith('.')) return false;

        const itemPpsa = extractPPSA(item);
        if (itemPpsa && itemPpsa.toUpperCase() === ppsaKey) return true;

        const paramFile = findParamJson(fullPath);
        if (paramFile) {
          try {
            const rawParam = fs.readFileSync(paramFile, 'utf-8');
            const parsedParam = JSON.parse(rawParam);
            if (parsedParam.titleId && parsedParam.titleId.toUpperCase() === ppsaKey) {
              return true;
            }
          } catch (e) {}
        }

        if (normPendingTitle && normPendingTitle.length > 5) {
          const normItem = normalizeTitle(item);
          if (normItem.includes(normPendingTitle)) return true;
        }
        return false;
      }

      const filePpsa = extractPPSA(item);
      if (filePpsa && filePpsa.toUpperCase() === ppsaKey) return true;

      if (!filePpsa && normPendingTitle && normPendingTitle.length > 5) {
        const normFile = normalizeTitle(item);
        if (normFile.includes(normPendingTitle)) return true;
      }
      return false;
    });

    if (matchedItems.length === 0) continue;

    const matchedFolders = matchedItems.filter(f => {
      try { return fs.statSync(path.join(downloadDir, f)).isDirectory(); } catch (e) { return false; }
    });

    const matchedFiles = matchedItems.filter(f => {
      try { return !fs.statSync(path.join(downloadDir, f)).isDirectory(); } catch (e) { return false; }
    });

    const exfatFiles = matchedFiles.filter(f => f.toLowerCase().endsWith('.exfat'));
    const ffpkgFiles = matchedFiles.filter(f => f.toLowerCase().endsWith('.ffpkg'));
    const archiveFiles = matchedFiles.filter(isArchiveFile);

    let finalTitle = pendingEntry.title;
    let finalPpsa = ppsaKey;
    let finalVer = 'v01.00';
    let workingPassword = passwordOption || '';

    // Process matching uncompressed folders
    for (const folderName of matchedFolders) {
      const folderPath = path.join(downloadDir, folderName);
      let folderTitle = finalTitle;
      let folderPpsa = finalPpsa;
      let folderVer = finalVer;

      const paramPath = findParamJson(folderPath);
      if (paramPath) {
        try {
          const rawParam = fs.readFileSync(paramPath, 'utf-8');
          const parsedParam = JSON.parse(rawParam);
          const { deriveVersionFromParam, deriveTitleNameFromParam } = require('../utils/versionParser');
          if (parsedParam.titleId && parsedParam.titleId !== 'Unknown') folderPpsa = parsedParam.titleId;
          const parsedTitle = deriveTitleNameFromParam(parsedParam);
          if (parsedTitle) folderTitle = sanitizeFileName(parsedTitle);
          folderVer = deriveVersionFromParam(parsedParam);
        } catch (e) {}
      }

      const folderBaseNameLabel = `${sanitizeFileName(folderTitle)} [${folderPpsa}][${folderVer}] [Game]`;
      const dest7zPath = getUniqueFilePath(downloadDir, folderBaseNameLabel, '.7z');
      const compressRoot = findShallowestEbootDir(folderPath) || folderPath;

      logger.info(`[PS5] Found matching uncompressed folder "${folderName}" for ${folderPpsa}`);
      const compressSpinner = ora(`[PS5] Compressing folder to ${path.basename(dest7zPath)}...`).start();

      try {
        await compressFolderTo7z(compressRoot, dest7zPath, (text) => {
          compressSpinner.text = `[PS5] [Compressing] ${folderPpsa} - ${text}`;
        });

        if (!fs.existsSync(dest7zPath) || fs.statSync(dest7zPath).size === 0) {
          throw new Error(`Compressed 7z is empty: ${dest7zPath}`);
        }

        try {
          fs.rmSync(folderPath, { recursive: true, force: true });
        } catch (rmErr) {
          logger.warn(`[PS5] Could not remove original folder: ${rmErr.message}`);
        }

        compressSpinner.succeed(`[PS5] Processed and compressed folder to: ${path.basename(dest7zPath)}`);
        processedCount++;
        finalTitle = folderTitle;
        finalPpsa = folderPpsa;
        finalVer = folderVer;
      } catch (err) {
        compressSpinner.fail(`[PS5] Folder compression failed for ${folderName}: ${err.message}`);
      }
    }

    const mainFileName = findMainArchiveFile(matchedFiles) || matchedFiles[0];
    const mainFilePath = mainFileName ? path.join(downloadDir, mainFileName) : null;

    // Try to read internal metadata from archive
    if (mainFilePath && isArchiveFile(mainFileName)) {
      const inspectSpinner = ora(`[PS5] Inspecting archive metadata (${ppsaKey})...`).start();
      try {
        const gameInfo = await getGameInfoFromArchive(mainFilePath, passwordOption, (statusText) => {
          inspectSpinner.text = `[PS5] Inspecting archive metadata (${ppsaKey}) - ${statusText}`;
        });
        if (gameInfo.titleId && gameInfo.titleId !== 'Unknown') finalPpsa = gameInfo.titleId;
        if (gameInfo.titleName && gameInfo.titleName !== 'Unknown') finalTitle = gameInfo.titleName;
        if (gameInfo.version) finalVer = gameInfo.version;
        if (gameInfo.workingPassword) workingPassword = gameInfo.workingPassword;
        inspectSpinner.succeed(`[PS5] Read archive metadata (${ppsaKey}): ${finalTitle} [${finalVer}]`);
      } catch (e) {
        inspectSpinner.text = `[PS5] Searching password for ${ppsaKey}...`;
        try {
          const foundPwd = await findWorkingPassword(mainFilePath, passwordOption ? [passwordOption] : [], (statusText) => {
            inspectSpinner.text = `[PS5] Searching password (${ppsaKey}) - ${statusText}`;
          });
          if (foundPwd) workingPassword = foundPwd;
          inspectSpinner.stop();
        } catch (pwdErr) {
          inspectSpinner.stop();
        }
      }
    }

    // Mount and validate exfat files via OSFMount
    for (const exf of exfatFiles) {
      const srcPath = path.join(downloadDir, exf);
      const exfatSpinner = ora(`[PS5] Mounting & validating exFAT: ${exf}...`).start();
      try {
        const { mountValidateAndExtractParam } = require('../services/osfmountService');
        const { valid, metadata, message, skipped } = await mountValidateAndExtractParam(srcPath, (statusText) => {
          exfatSpinner.text = `[PS5] ${statusText}`;
        });

        if (metadata) {
          if (metadata.titleId && metadata.titleId !== 'Unknown') finalPpsa = metadata.titleId;
          if (metadata.titleName && metadata.titleName !== 'Unknown') finalTitle = metadata.titleName;
          if (metadata.version) finalVer = metadata.version;
        }

        if (!valid && !skipped) {
          exfatSpinner.warn(`[PS5] exFAT chkdsk validation failed: ${message || 'errors found'}`);
        } else if (skipped) {
          exfatSpinner.info(`[PS5] Skipped exFAT mounting (OSFMount not installed).`);
        } else {
          exfatSpinner.succeed(`[PS5] exFAT mounted & validated clean (${finalTitle} [${finalPpsa}][${finalVer}])`);
        }
      } catch (err) {
        exfatSpinner.fail(`[PS5] exFAT mount/validation failed: ${err.message}`);
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
 * Fetches available PPSA codes for a pending game from its web URL.
 */
async function getAvailablePpsasForPending(pendingEntry) {
  if (!pendingEntry.url) return [];
  try {
    const { extractGameSections } = require('../services/webScraper');
    const sections = await extractGameSections(pendingEntry.url);
    if (!Array.isArray(sections)) return [];
    const ppsaList = [];
    const seen = new Set();
    for (const sec of sections) {
      if (sec.ppsa && !seen.has(sec.ppsa.toUpperCase())) {
        seen.add(sec.ppsa.toUpperCase());
        ppsaList.push({ ppsa: sec.ppsa.toUpperCase(), region: sec.region || 'Unknown' });
      }
    }
    return ppsaList;
  } catch (e) {
    return [];
  }
}

/**
 * Parses user input for selecting entries with optional PPSA overrides or sub-PPSA selection.
 * Examples: "1 2", "2:PPSA15646", "2 15646", "2.2", "1-3"
 */
function parseSelectionWithPpsa(input, rows, ppsaMap) {
  const result = new Map(); // rowIndex -> customPpsa (or null if keep entry.ppsa)
  if (!input) return result;

  const tokens = input.split(/[\s,]+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // Pattern 1: "2:PPSA12345" or "2=PPSA12345" or "2:12345"
    const explicitMatch = tok.match(/^(\d+)[:=](PPSA\d{5}|\d{5})$/i);
    if (explicitMatch) {
      const rowIdx = parseInt(explicitMatch[1], 10) - 1;
      let ppsa = explicitMatch[2].toUpperCase();
      if (/^\d{5}$/.test(ppsa)) ppsa = `PPSA${ppsa}`;
      if (rowIdx >= 0 && rowIdx < rows.length) {
        result.set(rowIdx, ppsa);
      }
      continue;
    }

    // Pattern 2: "2.1" or "2-1" where available PPSAs exist for row 2
    const subMatch = tok.match(/^(\d+)[.-](\d+)$/);
    if (subMatch) {
      const rowIdx = parseInt(subMatch[1], 10) - 1;
      const subIdx = parseInt(subMatch[2], 10) - 1;
      if (rowIdx >= 0 && rowIdx < rows.length) {
        const available = ppsaMap.get(rows[rowIdx].entry.normalizedTitle);
        if (available && available[subIdx]) {
          result.set(rowIdx, available[subIdx].ppsa);
        } else {
          // Range fallback e.g. "1-3"
          let a = parseInt(subMatch[1], 10), b = parseInt(subMatch[2], 10);
          if (a > b) [a, b] = [b, a];
          for (let n = a; n <= b; n++) {
            if (n >= 1 && n <= rows.length) result.set(n - 1, null);
          }
        }
      }
      continue;
    }

    // Pattern 3: "2" followed by "PPSA12345" or "12345" as next token
    if (/^\d+$/.test(tok) && i + 1 < tokens.length && /^(PPSA\d{5}|\d{5})$/i.test(tokens[i + 1])) {
      const rowIdx = parseInt(tok, 10) - 1;
      let ppsa = tokens[i + 1].toUpperCase();
      if (/^\d{5}$/.test(ppsa)) ppsa = `PPSA${ppsa}`;
      if (rowIdx >= 0 && rowIdx < rows.length) {
        result.set(rowIdx, ppsa);
      }
      i++; // skip next token
      continue;
    }

    // Pattern 4: Simple number "1"
    if (/^\d+$/.test(tok)) {
      const rowIdx = parseInt(tok, 10) - 1;
      if (rowIdx >= 0 && rowIdx < rows.length) {
        if (!result.has(rowIdx)) result.set(rowIdx, null);
      }
      continue;
    }
  }

  return result;
}

/**
 * Batch-marks pending manual downloads (download -i) as completed.
 * Auto-detects which ones have their GAME file present, lists available PPSAs,
 * and allows user to pick entries or specify custom PPSAs before committing.
 */
async function handlePending(titleQuery = '', options = {}) {
  let pending = loadPending();
  if (pending.length === 0) {
    logger.info('No pending manual downloads. (Run `dlps download -l N -i` first.)');
    return;
  }

  // Parse and normalize PPSA if provided
  let targetPpsa = null;
  if (options.ppsa) {
    const raw = String(options.ppsa).trim();
    if (/^\d{5}$/.test(raw)) {
      targetPpsa = `PPSA${raw}`;
    } else {
      targetPpsa = raw.toUpperCase();
    }
  }

  // Filter or update pending queue based on targetPpsa or titleQuery
  if (targetPpsa || titleQuery) {
    const { normalizeTitle } = require('../utils/titleNormalizer');
    const { savePending } = require('../services/pendingDb');
    const queryNorm = titleQuery ? normalizeTitle(titleQuery) : '';

    let matched = pending.filter(p => {
      if (targetPpsa && p.ppsa && p.ppsa.toUpperCase() === targetPpsa) return true;
      if (queryNorm && p.normalizedTitle && p.normalizedTitle.includes(queryNorm)) return true;
      return false;
    });

    if (matched.length > 0) {
      if (targetPpsa) {
        let updated = false;
        for (const item of matched) {
          if (item.ppsa !== targetPpsa) {
            item.ppsa = targetPpsa;
            updated = true;
          }
        }
        if (updated) {
          savePending(pending);
          logger.info(`Updated PPSA to ${targetPpsa} for matching pending entry.`);
        }
      }
      pending = matched;
    } else if (targetPpsa) {
      let targetItem = null;
      if (titleQuery) {
        targetItem = pending.find(p => p.normalizedTitle && p.normalizedTitle.includes(normalizeTitle(titleQuery)));
      }
      if (!targetItem) {
        targetItem = pending.find(p => !p.ppsa || p.ppsa === 'Unknown');
      }
      if (!targetItem && pending.length === 1) {
        targetItem = pending[0];
      }

      if (targetItem) {
        targetItem.ppsa = targetPpsa;
        savePending(pending);
        logger.info(`Assigned PPSA ${targetPpsa} to pending game: "${targetItem.title}"`);
        pending = [targetItem];
      } else {
        logger.warn(`No pending games found matching PPSA: ${targetPpsa}`);
        return;
      }
    } else if (titleQuery) {
      logger.warn(`No pending games found matching title: "${titleQuery}"`);
      return;
    }
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

  // Fetch available PPSAs for pending items from web pages (if available)
  const ppsaMap = new Map();
  const fetchPromises = pending.map(async p => {
    const list = await getAvailablePpsasForPending(p);
    if (list.length > 0) {
      ppsaMap.set(p.normalizedTitle, list);
    }
  });
  await Promise.allSettled(fetchPromises);

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

    const available = ppsaMap.get(r.entry.normalizedTitle);
    if (available && available.length > 0) {
      const subList = available.map((item, subIdx) => `[${subIdx + 1}] ${item.ppsa} (${item.region})`).join('  ');
      console.log(chalk.gray(`      └─ Available PPSAs: ${subList}`));
    }
  });

  const detectedCount = rows.filter(r => r.file).length;
  console.log(
    chalk.gray(`\n✓ = GAME file found in ${getDownloadDir()} (auto-selected: ${detectedCount}).`)
  );

  const answer = await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      chalk.cyan('Add extra numbers to mark completed (e.g. "3", "2:PPSA15646", or "2.2"), or press Enter to confirm: '),
      ans => { rl.close(); resolve(ans.trim()); }
    );
  });

  const selectedMap = new Map(); // rowIndex -> customPpsa
  rows.forEach((r, i) => {
    if (r.file || ((targetPpsa || titleQuery) && rows.length === 1)) {
      selectedMap.set(i, targetPpsa || r.entry.ppsa || 'Unknown');
    }
  });

  const userSelections = parseSelectionWithPpsa(answer, rows, ppsaMap);
  for (const [rIdx, customPpsa] of userSelections.entries()) {
    selectedMap.set(rIdx, customPpsa || targetPpsa || rows[rIdx].entry.ppsa || 'Unknown');
  }

  if (selectedMap.size === 0) {
    logger.info('Nothing selected. No changes made.');
    return;
  }

  const doneTitles = [];
  for (const [i, finalPpsa] of selectedMap.entries()) {
    const { entry, file } = rows[i];
    addDownloadedGame({
      title: entry.title,
      fileName: file ? file : 'Manual Entry',
      ppsa: finalPpsa || entry.ppsa || 'Unknown',
      password: '',
      source: 'Manual',
      region: 'Unknown',
    });
    doneTitles.push(entry.normalizedTitle);
    logger.success(`Marked completed: "${entry.title}" (${finalPpsa})`);
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
    return handlePending(titleQuery, options);
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
