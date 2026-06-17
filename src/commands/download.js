const { loadLocalLibrary } = require('../services/localLibrary');
const { loadDownloadedGames, addDownloadedGame } = require('../services/downloadedDb');
const { getWebGameList, findGameInWebList, getGameSubpageData } = require('../services/webScraper');
const { getBestDownloadLinks, getRegionPriority } = require('../services/linkExtractor');
const { download1fichier } = require('../services/fichierDownloader');
const { extractVersion } = require('../utils/versionParser');
const { convertToFfpfsc } = require('../services/converter');
const { isArchiveEncrypted, extractRarArchive, getGameInfoFromArchive, compressFolderToRar, findWorkingPassword } = require('../services/unrarService');
const logger = require('../utils/logger');
const open = require('open');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const ora = require('ora');
const chalk = require('chalk');

const FAIL_LOG_PATH = path.join(__dirname, '../../data/failed_downloads.json');

/**
 * Logs a download failure to failed_downloads.json.
 */
function logFailure(title, url, reason) {
  let failures = [];
  if (fs.existsSync(FAIL_LOG_PATH)) {
    try {
      failures = JSON.parse(fs.readFileSync(FAIL_LOG_PATH, 'utf-8'));
    } catch (e) {
      failures = [];
    }
  }
  failures.push({
    title,
    url,
    reason,
    timestamp: new Date().toISOString()
  });
  
  const dir = path.dirname(FAIL_LOG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(FAIL_LOG_PATH, JSON.stringify(failures, null, 2), 'utf-8');
}

/**
 * Detects the type of auxiliary file from its name (UNLOCK, DLC, BACK4xx, BACK7xx, UPDATE, etc.)
 */
function detectFileType(fileName) {
  const lower = fileName.toLowerCase();
  
  if (lower.includes('unlock')) {
    return 'UNLOCK';
  }
  
  if (lower.includes('dlc')) {
    return 'DLC';
  }
  

  
  if (lower.includes('backport')) {
    return 'BACK';
  }

  if (lower.includes('patch') || lower.includes('update')) {
    return 'UPDATE';
  }

  if (lower.includes('guide') || lower.includes('readme')) {
    return 'INSTALL_GUIDE';
  }
  
  return null;
}

/**
 * Returns a unique file path if file already exists.
 */
function getUniqueFilePath(dir, baseName, ext) {
  let filePath = path.join(dir, `${baseName}${ext}`);
  if (!fs.existsSync(filePath)) {
    return filePath;
  }
  let counter = 1;
  while (fs.existsSync(path.join(dir, `${baseName}_${counter}${ext}`))) {
    counter++;
  }
  return path.join(dir, `${baseName}_${counter}${ext}`);
}

/**
 * Performs download for a single game.
 */
async function downloadSingleGame(game, options = {}) {
  const spinner = ora(`Scraping subpage for "${game.title}"...`).start();
  try {
    const sections = await getGameSubpageData(game.slug, game.url);
    if (sections.length === 0) {
      throw new Error('No download sections found on game subpage.');
    }

    // Check if local library has PPSA
    const localGames = loadLocalLibrary();
    const localMatch = localGames.find(lg => lg.normalizedTitle === game.normalizedTitle);
    const targetPPSA = localMatch ? localMatch.ppsa : null;

    // Sort sections so we try the most preferred first:
    // 1. Matches targetPPSA (if targetPPSA is specified)
    // 2. Region priority order (KOR -> EXFAT -> USA -> EUR -> Other)
    sections.sort((a, b) => {
      if (targetPPSA) {
        const aMatch = a.ppsa === targetPPSA;
        const bMatch = b.ppsa === targetPPSA;
        if (aMatch && !bMatch) return -1;
        if (!aMatch && bMatch) return 1;
      }
      return getRegionPriority(a.region) - getRegionPriority(b.region);
    });

    let lastError = null;
    let success = false;
    let fallbackLinks = null;

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      let downloadedFiles = [];
      let downloadCompleted = false;
      
      const regionInfo = `region [${section.region}], PPSA [${section.ppsa}]`;
      spinner.text = `Trying option ${i + 1}/${sections.length}: ${regionInfo}...`;
      
      try {
        const bestLinks = await getBestDownloadLinks([section], null);
        
        // Filter bestLinks.urls based on targetType if specified
        const targetType = options.type ? options.type.toUpperCase() : null;
        if (targetType) {
          bestLinks.urls = bestLinks.urls.filter(url => {
            const info = bestLinks.urlInfo ? bestLinks.urlInfo.find(ui => ui.url === url) : null;
            const type = info ? info.type.toUpperCase() : 'GAME';
            return type === targetType;
          });
          
          if (bestLinks.urls.length === 0) {
            continue; // Try next section if this section has no links matching targetType
          }
        }

        spinner.info(`Matched Section: Region [${bestLinks.region}], PPSA [${bestLinks.ppsa || targetPPSA || 'Unknown'}], Host [${bestLinks.hostName}]`);
        if (targetType) {
          logger.info(`Filtering downloads for type "${targetType}" (${bestLinks.urls.length} files matched)`);
        }
        
        if (bestLinks.hostName === '1fichier') {
          const downloadDir = process.env.DOWNLOAD_DIR || path.join(__dirname, '../../downloads');
          const downloadUrls = bestLinks.urls.filter(url => !url.startsWith('text_guide:'));
          const textGuideUrls = bestLinks.urls.filter(url => url.startsWith('text_guide:'));
          
          const totalParts = downloadUrls.length;
          let partIdx = 1;
          
          for (const fileUrl of downloadUrls) {
            const partLabel = totalParts > 1 ? ` (Part ${partIdx}/${totalParts})` : '';
            
            // Resolve file type from urlInfo
            const info = bestLinks.urlInfo ? bestLinks.urlInfo.find(ui => ui.url === fileUrl) : null;
            const typeLabel = info ? ` [${info.type}]` : ' [GAME]';
            
            const partSpinner = ora(`Downloading${typeLabel} part ${partIdx}/${totalParts}...`).start();
            
            try {
              const result = await download1fichier(fileUrl, downloadDir, (progress) => {
                partSpinner.text = `Downloading${typeLabel}${partLabel}: ${progress.percent}% (${progress.receivedMB}MB / ${progress.totalMB}MB)`;
              });
              
              if (result.skipped) {
                partSpinner.succeed(`Already downloaded (skipped)${typeLabel} part ${partIdx}: ${result.filename}`);
              } else {
                partSpinner.succeed(`Downloaded${typeLabel} part ${partIdx}: ${result.filename}`);
              }
              const info = bestLinks.urlInfo ? bestLinks.urlInfo.find(ui => ui.url === fileUrl) : null;
              const type = info ? info.type : 'GAME';
              downloadedFiles.push({ filename: result.filename, type });
            } catch (downloadErr) {
              partSpinner.fail(`Failed to download${typeLabel} part ${partIdx}: ${downloadErr.message}`);
              logFailure(game.title, game.url, `Download${typeLabel} Part ${partIdx} failed: ${downloadErr.message}`);
              throw downloadErr;
            }
            partIdx++;
          }
          
          // Save text guides as files
          for (const tgUrl of textGuideUrls) {
            const guideText = tgUrl.slice('text_guide:'.length);
            const initialBase = `${game.title} [${bestLinks.ppsa || targetPPSA || 'Unknown'}][INSTALL_GUIDE]`;
            const guidePath = getUniqueFilePath(downloadDir, initialBase, '.txt');
            const actualFileName = path.basename(guidePath);
            try {
              fs.writeFileSync(guidePath, guideText, 'utf-8');
              logger.success(`Saved DLC installation guide to "${actualFileName}"`);
              downloadedFiles.push({ filename: actualFileName, type: 'INSTALL_GUIDE' });
            } catch (err) {
              logger.warn(`Failed to save guide file "${actualFileName}": ${err.message}`);
            }
          }
          
          logger.success(`Successfully completed download for "${game.title}"`);
          downloadCompleted = true;
  
          // ── Step 3: Automatically handle password check and extraction ──
          if (downloadedFiles.length > 0) {
            let finalTitle = game.title;
            let finalPpsa = bestLinks.ppsa || targetPPSA || 'Unknown';
            let finalVer = 'v01.00';
            
            // 1. Group files by type
            const fileGroups = {};
            for (const fileItem of downloadedFiles) {
              const file = fileItem.filename;
              const type = fileItem.type || 'GAME';
              const filePath = path.join(downloadDir, file);
              if (!fs.existsSync(filePath)) continue;

              if (!fileGroups[type]) {
                fileGroups[type] = [];
              }
              fileGroups[type].push(file);
            }

            // 2. Process GAME archives first to extract the correct title, ID, version from param.json
            const gameFiles = fileGroups['GAME'] || [];
            const gameArchives = gameFiles.filter(file => file.toLowerCase().endsWith('.rar') || file.toLowerCase().endsWith('.zip'));
            if (gameArchives.length > 0) {
              let mainFileName = gameArchives[0];
              if (gameArchives.length > 1) {
                const candidate = gameArchives.find(name => {
                  const lower = name.toLowerCase();
                  return (lower.endsWith('.rar') && !lower.match(/\.part[2-9]\d*\.rar$/) && !lower.match(/\.part0[2-9]\d*\.rar$/)) || 
                         (lower.endsWith('.zip') && !lower.match(/\.part[2-9]\d*\.zip$/) && !lower.match(/\.part0[2-9]\d*\.zip$/)) ||
                         lower.includes('part1.rar') || 
                         lower.includes('part01.rar') ||
                         lower.includes('part1.zip') ||
                         lower.includes('part01.zip');
                });
                if (candidate) {
                  mainFileName = candidate;
                }
              }
              const mainFilePath = path.join(downloadDir, mainFileName);
              const checkSpinner = ora(`Inspecting "${mainFileName}" internally...`).start();
              try {
                const gameInfo = await getGameInfoFromArchive(mainFilePath, bestLinks.password);
                finalPpsa = gameInfo.titleId;
                finalVer = gameInfo.version;
                finalTitle = gameInfo.titleName;
                checkSpinner.succeed(`Successfully read metadata from game archive.`);
              } catch (err) {
                checkSpinner.warn(`Failed to inspect main game archive for param.json: ${err.message}. Using fallback metadata.`);
              }
            }

            // Keep track of which files we renamed or repackaged to register them in downloaded.xml
            let registeredFiles = [];

            // 3. Process each group
            for (const [type, files] of Object.entries(fileGroups)) {
              const archives = files.filter(file => file.toLowerCase().endsWith('.rar') || file.toLowerCase().endsWith('.zip'));
              const extraFiles = files.filter(file => !file.toLowerCase().endsWith('.rar') && !file.toLowerCase().endsWith('.zip'));

              const isGame = type === 'GAME';
              const baseName = isGame ? `${finalTitle} [${finalPpsa}][${finalVer}]` : `${finalTitle} [${finalPpsa}][${type}]`;

              // Handle archives in this group (GAME, DLC, BACKPORT, etc.)
              if (archives.length > 0) {
                let mainFileName = archives[0];
                if (archives.length > 1) {
                  const candidate = archives.find(name => {
                    const lower = name.toLowerCase();
                    return (lower.endsWith('.rar') && !lower.match(/\.part[2-9]\d*\.rar$/) && !lower.match(/\.part0[2-9]\d*\.rar$/)) || 
                           (lower.endsWith('.zip') && !lower.match(/\.part[2-9]\d*\.zip$/) && !lower.match(/\.part0[2-9]\d*\.zip$/)) ||
                           lower.includes('part1.rar') || 
                           lower.includes('part01.rar') ||
                           lower.includes('part1.zip') ||
                           lower.includes('part01.zip');
                  });
                  if (candidate) {
                    mainFileName = candidate;
                  }
                }
                const mainFilePath = path.join(downloadDir, mainFileName);

                // Check if the archive is encrypted or split into multiple parts
                let encrypted = false;
                let workingPassword = '';
                try {
                  workingPassword = await findWorkingPassword(mainFilePath, bestLinks.password ? [bestLinks.password] : []);
                  encrypted = workingPassword !== '';
                } catch (e) {
                  // ignore
                }

                const isSplit = archives.length > 1;

                if (encrypted || isSplit) {
                  // Decrypt and extract to temporary folder, then repackage to single clean RAR
                  const extractSpinner = ora(`[${type}] "${mainFileName}" is encrypted or split. Extracting to temporary folder...`).start();
                  const outputFolderPath = path.join(downloadDir, baseName);
                  try {
                    await extractRarArchive(mainFilePath, outputFolderPath, workingPassword);
                    
                    if (!fs.existsSync(outputFolderPath) || fs.readdirSync(outputFolderPath).length === 0) {
                      throw new Error(`Extraction failed: Output folder was not created or is empty: ${outputFolderPath}`);
                    }
                    extractSpinner.succeed(`[${type}] Successfully extracted to folder: ${baseName}`);

                    // Clean up original downloaded archive files in this group
                    const deleteSpinner = ora(`[${type}] Cleaning up downloaded archives...`).start();
                    const basePattern = mainFileName.replace(/\.part[0-9]+\.rar$/i, '').replace(/\.part[0-9]+\.zip$/i, '').replace(/\.rar$/i, '').replace(/\.zip$/i, '');
                    for (const file of archives) {
                      if (file.toLowerCase().startsWith(basePattern.toLowerCase()) || file === mainFileName) {
                        try {
                          fs.unlinkSync(path.join(downloadDir, file));
                        } catch (e) {
                          // ignore
                        }
                      }
                    }
                    deleteSpinner.succeed(`[${type}] Cleaned up downloaded archive files.`);

                    // Compress back to a clean RAR
                    const compressSpinner = ora(`[${type}] Compressing back to password-free RAR: ${baseName}.rar...`).start();
                    const destRarPath = path.join(downloadDir, `${baseName}.rar`);
                    await compressFolderToRar(outputFolderPath, destRarPath);

                    if (!fs.existsSync(destRarPath) || fs.statSync(destRarPath).size === 0) {
                      throw new Error(`Compression failed: Output RAR file was not created or is empty: ${destRarPath}`);
                    }
                    compressSpinner.succeed(`[${type}] Successfully compressed to clean RAR: ${baseName}.rar`);
                    registeredFiles.push({ fileName: `${baseName}.rar`, type });

                    // Clean up temporary folder
                    try {
                      fs.rmSync(outputFolderPath, { recursive: true, force: true });
                    } catch (e) {
                      // ignore
                    }
                  } catch (extErr) {
                    extractSpinner.fail(`[${type}] Processing failed: ${extErr.message}`);
                    logFailure(game.title, game.url, `[${type}] Processing failed: ${extErr.message}`);
                    throw extErr;
                  }
                } else {
                  // Single unencrypted archive: just rename it to standard baseName + extension
                  const origExt = path.extname(mainFileName).toLowerCase();
                  const newFileName = `${baseName}${origExt}`;
                  const oldPath = path.join(downloadDir, mainFileName);
                  const newPath = path.join(downloadDir, newFileName);
                  try {
                    fs.renameSync(oldPath, newPath);
                    logger.success(`[${type}] Kept original archive and renamed to standard format: ${newFileName}`);
                    registeredFiles.push({ fileName: newFileName, type });
                  } catch (renameErr) {
                    logger.warn(`[${type}] Failed to rename archive: ${renameErr.message}`);
                    registeredFiles.push({ fileName: mainFileName, type });
                  }
                }
              }

              // Handle extra non-archive files in this group (like guides or PKG files)
              for (const file of extraFiles) {
                const oldPath = path.join(downloadDir, file);
                const ext = path.extname(file);
                const newPath = getUniqueFilePath(downloadDir, baseName, ext);
                const newFileName = path.basename(newPath);
                try {
                  fs.renameSync(oldPath, newPath);
                  logger.info(`Renamed auxiliary file "${file}" to "${newFileName}"`);
                  registeredFiles.push({ fileName: newFileName, type });
                } catch (renameErr) {
                  logger.warn(`Failed to rename auxiliary file "${file}": ${renameErr.message}`);
                  registeredFiles.push({ fileName: file, type });
                }
              }
            }

            // Register downloaded files in the downloaded.xml database
            // If the GAME group was downloaded, register the game file first
            const gameToRegister = registeredFiles.find(rf => rf.type === 'GAME');
            const otherToRegister = registeredFiles.filter(rf => rf.type !== 'GAME');

            if (gameToRegister) {
              addDownloadedGame({
                title: finalTitle,
                fileName: gameToRegister.fileName,
                ppsa: finalPpsa,
                password: '',
                source: '1fichier',
                region: bestLinks.region
              });
            }

            // If no GAME was downloaded, register the first auxiliary file instead
            if (!gameToRegister && otherToRegister.length > 0) {
              addDownloadedGame({
                title: finalTitle,
                fileName: otherToRegister[0].fileName,
                ppsa: finalPpsa,
                password: '',
                source: '1fichier',
                region: bestLinks.region
              });
            }
          }
          success = true;
          break; // Successfully handled the section, exit loop
        } else {
          // If this is the first non-1fichier fallback links candidate we see, save it
          if (!fallbackLinks) {
            fallbackLinks = bestLinks;
          }
          spinner.info(`1fichier link is not available for region [${section.region}] (best is ${bestLinks.hostName}). Saving as browser fallback candidate...`);
        }
      } catch (err) {
        lastError = err;
        // Clean up partial files downloaded in this attempt (only if download didn't complete)
        if (!downloadCompleted && downloadedFiles && downloadedFiles.length > 0) {
          const downloadDir = process.env.DOWNLOAD_DIR || path.join(__dirname, '../../downloads');
          for (const fileItem of downloadedFiles) {
            try {
              fs.unlinkSync(path.join(downloadDir, fileItem.filename));
            } catch (e) {
              // ignore delete error
            }
          }
        }
        
        if (downloadCompleted) {
          logger.error(`\nAttempt failed after download completion: ${err.message}. Aborting further region attempts.`);
          break; // Stop trying other regions since we already downloaded the archive
        } else {
          logger.warn(`\nAttempt failed for ${regionInfo}: ${err.message}. Trying next available option...`);
        }
      }
    }

    if (!success) {
      if (fallbackLinks) {
        spinner.warn(`1fichier link is not available in any region. Opening browser fallback for highest priority region [${fallbackLinks.region}] (${fallbackLinks.hostName})...`);
        for (const url of fallbackLinks.urls) {
          await open(url);
        }
        logFailure(game.title, game.url, `No 1fichier links. Host: ${fallbackLinks.hostName}. Opened browser fallback.`);
      } else {
        throw lastError || new Error('All download/conversion attempts failed.');
      }
    }

  } catch (err) {
    spinner.fail(`Download failed for "${game.title}": ${err.message}`);
    logFailure(game.title, game.url, err.message);
    throw err;
  }
}

/**
 * Handles the 'download' CLI command.
 * 
 * @param {string} titleQuery 
 * @param {{limit: string}} options 
 */
async function downloadCommand(titleQuery, options = {}) {
  const limit = options.limit ? parseInt(options.limit, 10) : null;

  try {
    if (limit !== null) {
      if (isNaN(limit) || limit <= 0) {
        logger.error('Invalid limit value. Please specify a positive integer.');
        return;
      }

      // TBD list download
      const localGames = loadLocalLibrary();
      const downloadedGames = loadDownloadedGames();
      const webList = await getWebGameList();

      const localMap = new Map(localGames.map(g => [g.normalizedTitle, g]));
      const dlMap = new Map(downloadedGames.map(g => [g.normalizedTitle, g]));

      const { loadExcludedGames } = require('../services/excludedDb');
      const excludedGames = loadExcludedGames();
      const excludedSet = new Set(excludedGames.map(g => g.normalizedTitle));

      const tbdList = webList.filter(g => 
        !localMap.has(g.normalizedTitle) && 
        !dlMap.has(g.normalizedTitle) && 
        !excludedSet.has(g.normalizedTitle)
      );

      if (tbdList.length === 0) {
        logger.info('No TBD (To Be Downloaded) games found.');
        return;
      }

      const count = Math.min(limit, tbdList.length);
      logger.info(`Starting batch download of ${count} games sequentially...`);

      for (let i = 0; i < count; i++) {
        const game = tbdList[i];
        console.log(chalk.bold.magenta(`\n=== Batch [${i + 1}/${count}]: ${game.title} ===`));
        try {
          await downloadSingleGame(game, options);
        } catch (e) {
          logger.error(`Skipping batch item "${game.title}" due to error.`);
        }
      }
      logger.success('\nBatch download job finished.');
      return;
    }

    if (!titleQuery) {
      logger.error('Please specify a game title to download. Example: ps5dl download "3D MiniGolf"');
      return;
    }

    // Single game query matching
    const matches = await findGameInWebList(titleQuery);
    if (matches.length === 0) {
      logger.warn(`No games found matching: "${titleQuery}"`);
      
      // Propose suggestions
      const webList = await getWebGameList();
      const normalizedQuery = titleQuery.toLowerCase();
      const suggestions = webList
        .filter(g => g.title.toLowerCase().includes(normalizedQuery))
        .slice(0, 3);
      
      if (suggestions.length > 0) {
        console.log(chalk.cyan('Did you mean one of these?'));
        suggestions.forEach(s => console.log(` - ${s.title}`));
      }
      return;
    }

    if (matches.length === 1) {
      await downloadSingleGame(matches[0], options);
      return;
    }

    // Multiple matches, prompt selection
    console.log(chalk.yellow(`\nMultiple games match your query "${titleQuery}":`));
    matches.forEach((game, idx) => {
      console.log(`  [${idx + 1}] ${game.title} (${game.url})`);
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(chalk.cyan('\nSelect a game number to download (or press Enter to cancel): '), async (answer) => {
      rl.close();
      const num = parseInt(answer.trim(), 10);
      if (num > 0 && num <= matches.length) {
        await downloadSingleGame(matches[num - 1], options);
      } else {
        logger.info('Cancelled.');
      }
    });

  } catch (err) {
    logger.error('Download command failed.', err);
  }
}

module.exports = downloadCommand;
