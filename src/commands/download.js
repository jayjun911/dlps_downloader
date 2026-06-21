const { loadLocalLibrary } = require('../services/localLibrary');
const { loadDownloadedGames } = require('../services/downloadedDb');
const { getWebGameList, findGameInWebList, getGameSubpageData } = require('../services/webScraper');
const { getBestDownloadLinks, getRegionPriority } = require('../services/linkExtractor');
const { download1fichier } = require('../services/fichierDownloader');
const { downloadFromDatanodes } = require('../services/datanodesDownloader');
const { extractVersion } = require('../utils/versionParser');
const { processDownloadedFiles, getUniqueFilePath } = require('../utils/postProcessor');
const { loadProgressSet, markProgress, clearProgress } = require('../services/progressDb');
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

    // --section: interactively pick a section
    if (options.section) {
      spinner.stop();
      console.log(`\nAvailable sections for "${game.title}":`);
      sections.forEach((s, i) => console.log(`  [${i + 1}] ${s.ppsa} – ${s.region}`));
      const answer = await new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`\nSelect section (1-${sections.length}): `, ans => { rl.close(); resolve(ans.trim()); });
      });
      const idx = parseInt(answer, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= sections.length) {
        logger.warn(`Invalid selection "${answer}". Aborting.`);
        return;
      }
      const chosen = sections[idx];
      sections.length = 0;
      sections.push(chosen);
      logger.info(`Selected: ${chosen.ppsa} – ${chosen.region}`);
      spinner.start(`Downloading "${game.title}"...`);
    } else {
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

      // --exfat: if any section is exFAT, restrict to exFAT-only sections
      if (options.exfat) {
        const exfatSections = sections.filter(s => /exfat/i.test(s.region));
        if (exfatSections.length > 0) {
          sections.length = 0;
          exfatSections.forEach(s => sections.push(s));
          logger.info(`--exfat: restricting to ${sections.length} exFAT section(s)`);
        } else {
          logger.warn(`--exfat: no exFAT sections found, proceeding with all sections`);
        }
      }
    }

    let lastError = null;
    let success = false;
    let fallbackLinks = null;

    // List all available sections upfront
    spinner.stop();
    logger.info(`Found ${sections.length} section(s) for "${game.title}":`);
    sections.forEach((s, i) => logger.info(`  [${i + 1}] ${s.ppsa} – ${s.region}`));

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      let downloadedFiles = [];
      let downloadCompleted = false;

      const regionInfo = `region [${section.region}], PPSA [${section.ppsa}]`;

      // Inner loop: retry same section with next-best host when a link is dead
      const skipHosts = [];
      let sectionDone = false;
      while (!sectionDone) {
      logger.info(`Analyzing [${i + 1}/${sections.length}]: ${section.ppsa} – ${section.region}`);
      spinner.start();

      let currentHostName = null;
      try {
        const bestLinks = await getBestDownloadLinks([section], null, { skipHosts });
        currentHostName = bestLinks.hostName;
        
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
        
        if (bestLinks.hostName === '1fichier' || bestLinks.hostName === 'Datanodes') {
          const downloadDir = options.out || process.env.DOWNLOAD_DIR || path.join(__dirname, '../../downloads');
          const downloadUrls = bestLinks.urls.filter(url => !url.startsWith('text_guide:'));
          const textGuideUrls = bestLinks.urls.filter(url => url.startsWith('text_guide:'));

          const totalParts = downloadUrls.length;
          const useFdm = !!(process.env.DOWNLOAD_MANAGER || '').trim();

          if (useFdm) {
            // ── FDM mode: queue all parts simultaneously, wait concurrently ──
            const { downloadAllWithFdm } = require('../services/fdmDownloader');
            const fdmSpinner = ora(`[FDM] Queuing ${totalParts} file(s)...`).start();
            try {
              const fdmResults = await downloadAllWithFdm(
                downloadUrls,
                downloadDir,
                (status) => { fdmSpinner.text = `[FDM] ${status}`; },
                bestLinks.hostName === '1fichier'
              );
              const skippedCount = fdmResults.filter(r => r.skipped).length;
              const dlCount = fdmResults.length - skippedCount;
              fdmSpinner.succeed(
                `[FDM] Done — ${dlCount} downloaded, ${skippedCount} skipped` +
                ` (${fdmResults.map(r => r.filename).join(', ')})`
              );
              for (const r of fdmResults) {
                const ui = bestLinks.urlInfo ? bestLinks.urlInfo.find(u => u.url === r.fileUrl) : null;
                downloadedFiles.push({ filename: r.filename, type: ui ? ui.type : 'GAME' });
              }
            } catch (fdmErr) {
              fdmSpinner.fail(`[FDM] Download failed: ${fdmErr.message}`);
              logFailure(game.title, game.url, `FDM download failed: ${fdmErr.message}`);
              throw fdmErr;
            }
          } else {
            // ── Built-in streamer: sequential per-part ───────────────────────
            let partIdx = 1;
            for (const fileUrl of downloadUrls) {
              const partLabel = totalParts > 1 ? ` (Part ${partIdx}/${totalParts})` : '';
              const info = bestLinks.urlInfo ? bestLinks.urlInfo.find(ui => ui.url === fileUrl) : null;
              const typeLabel = info ? ` [${info.type}]` : ' [GAME]';
              const partSpinner = ora(`Downloading${typeLabel} part ${partIdx}/${totalParts}...`).start();

              try {
                let result;
                if (bestLinks.hostName === 'Datanodes') {
                  result = await downloadFromDatanodes(fileUrl, downloadDir,
                    (downloaded, total) => {
                      const mb = (downloaded / 1024 / 1024).toFixed(1);
                      if (total > 0) {
                        const pct = Math.floor((downloaded / total) * 100);
                        const totalMb = (total / 1024 / 1024).toFixed(1);
                        partSpinner.text = `Downloading${typeLabel}${partLabel}: ${pct}% (${mb}MB / ${totalMb}MB)`;
                      } else {
                        partSpinner.text = `Downloading${typeLabel}${partLabel}: ${mb}MB...`;
                      }
                    },
                    (status) => { partSpinner.text = status; }
                  );
                } else {
                  result = await download1fichier(fileUrl, downloadDir, (progress) => {
                    partSpinner.text = `Downloading${typeLabel}${partLabel}: ${progress.percent}% (${progress.receivedMB}MB / ${progress.totalMB}MB)`;
                  });
                }

                if (result.skipped) {
                  partSpinner.succeed(`Already downloaded (skipped)${typeLabel} part ${partIdx}: ${result.filename}`);
                } else {
                  partSpinner.succeed(`Downloaded${typeLabel} part ${partIdx}: ${result.filename}`);
                }
                const type = info ? info.type : 'GAME';
                downloadedFiles.push({ filename: result.filename, type });
              } catch (downloadErr) {
                partSpinner.fail(`Failed to download${typeLabel} part ${partIdx}: ${downloadErr.message}`);
                logFailure(game.title, game.url, `Download${typeLabel} Part ${partIdx} failed: ${downloadErr.message}`);
                throw downloadErr;
              }
              partIdx++;
            }
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
  
          // ── Step 3: Password removal, extraction, rename, register ──
          if (downloadedFiles.length > 0) {
            await processDownloadedFiles({
              downloadedFiles,
              downloadDir,
              password: options.password || bestLinks.password,
              hostName: bestLinks.hostName,
              region: bestLinks.region,
              initialTitle: game.title,
              initialPpsa: bestLinks.ppsa || targetPPSA || 'Unknown'
            });
          }
          success = true;
          sectionDone = true;
          break; // Successfully handled the section, exit loop
        } else {
          // If this is the first non-auto-downloadable fallback candidate we see, save it
          if (!fallbackLinks) {
            fallbackLinks = bestLinks;
          }
          spinner.info(`No auto-downloadable host for region [${section.region}] (best available: ${bestLinks.hostName}). Saving as browser fallback...`);
          sectionDone = true;
        }
      } catch (err) {
        lastError = err;
        const isExfatSection = section.region.toUpperCase().includes('EXFAT');
        const downloadDir = options.out || process.env.DOWNLOAD_DIR || path.join(__dirname, '../../downloads');

        // Clean up partial files (or rename .exfat to .failed for exFAT sections)
        if (!downloadCompleted && downloadedFiles && downloadedFiles.length > 0) {
          for (const fileItem of downloadedFiles) {
            const filePath = path.join(downloadDir, fileItem.filename);
            try {
              if (isExfatSection && fileItem.filename.toLowerCase().endsWith('.exfat')) {
                const failedPath = filePath.replace(/\.exfat$/i, '.failed');
                if (fs.existsSync(filePath)) {
                  fs.renameSync(filePath, failedPath);
                  logger.warn(`Renamed failed exFAT: ${path.basename(failedPath)}`);
                }
              } else {
                fs.unlinkSync(filePath);
              }
            } catch (e) {
              // ignore cleanup error
            }
          }
        }

        // Also scan downloadDir for any .exfat files left by the downloader (e.g. partial writes)
        if (isExfatSection && fs.existsSync(downloadDir)) {
          try {
            for (const f of fs.readdirSync(downloadDir)) {
              if (f.toLowerCase().endsWith('.exfat')) {
                const fp = path.join(downloadDir, f);
                const failedFp = fp.replace(/\.exfat$/i, '.failed');
                fs.renameSync(fp, failedFp);
                logger.warn(`Renamed failed exFAT: ${path.basename(failedFp)}`);
              }
            }
          } catch (e) {}

          // exFAT failure: do NOT try other sections — skip this game entirely
          sectionDone = true;
          const exfatErr = new Error(`exFAT download failed (${regionInfo}): ${err.message}`);
          throw exfatErr;
        }

        if (downloadCompleted) {
          logger.error(`\nAttempt failed after download completion: ${err.message}. Aborting further region attempts.`);
          sectionDone = true;
          break;
        } else if (err.isLinkDead && currentHostName) {
          // Link is dead — skip this host and retry the same section with the next best host
          skipHosts.push(currentHostName);
          logger.warn(`\n[${regionInfo}] ${currentHostName} link is dead. Trying next available host...`);
          downloadedFiles = [];
          // continue inner while loop
        } else {
          logger.warn(`\nAttempt failed for ${regionInfo}: ${err.message}. Trying next available option...`);
          sectionDone = true;
        }
      }
      } // end inner while (!sectionDone)
      if (success) break;
    }

    if (!success) {
      if (fallbackLinks) {
        spinner.warn(`No auto-downloadable host found in any region. Opening browser fallback for [${fallbackLinks.region}] (${fallbackLinks.hostName})...`);
        for (const url of fallbackLinks.urls) {
          await open(url);
        }
        logFailure(game.title, game.url, `No 1fichier links. Host: ${fallbackLinks.hostName}. Opened browser fallback.`);
      } else {
        throw lastError || new Error('All download/conversion attempts failed.');
      }
    }

  } catch (err) {
    if (!err.isUserError) {
      spinner.fail(`Download failed for "${game.title}": ${err.message}`);
      logFailure(game.title, game.url, err.message);
    }
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

      const { getWebGameStatus } = require('../utils/gameMatcher');

      const localMap = new Map(localGames.map(g => [g.normalizedTitle, g]));
      const dlMap = new Map(downloadedGames.map(g => [g.normalizedTitle, g]));

      const localPpsaMap = new Map();
      for (const g of localGames) {
        if (g.ppsa) localPpsaMap.set(g.ppsa.toUpperCase(), g);
      }
      const dlPpsaMap = new Map();
      for (const g of downloadedGames) {
        if (g.ppsa) dlPpsaMap.set(g.ppsa.toUpperCase(), g);
      }

      const { loadExcludedGames } = require('../services/excludedDb');
      const excludedGames = loadExcludedGames();
      const excludedSet = new Set(excludedGames.map(g => g.normalizedTitle));

      const progressSet = loadProgressSet();
      const tbdList = [];
      for (const g of webList) {
        const matchInfo = getWebGameStatus(g, localMap, dlMap, excludedSet, localPpsaMap, dlPpsaMap, progressSet);
        if (matchInfo.status === 'tbd') {
          tbdList.push(g);
        }
      }

      if (tbdList.length === 0) {
        logger.info('No TBD (To Be Downloaded) games found.');
        return;
      }

      const count = Math.min(limit, tbdList.length);
      const useFdmBatch = !!(process.env.DOWNLOAD_MANAGER || '').trim();
      const maxConcurrentGames = useFdmBatch
        ? parseInt(process.env.DOWNLOADER_PARALLEL_GAME_PARSING || '1', 10)
        : 1;
      const modeLabel = useFdmBatch ? `FDM, up to ${maxConcurrentGames} games concurrent` : 'sequential';
      logger.info(`Starting batch download of ${count} games [${modeLabel}]...`);

      // Rolling window: as soon as one game finishes, the next starts immediately
      let nextIdx = 0;
      let active = 0;
      await new Promise((resolveAll) => {
        function startNext() {
          while (active < maxConcurrentGames && nextIdx < count) {
            const game = tbdList[nextIdx];
            const slotNum = nextIdx + 1;
            nextIdx++;
            active++;
            console.log(chalk.bold.magenta(`\n=== [${slotNum}/${count}] Starting: ${game.title} ===`));
            markProgress(game.normalizedTitle);
            downloadSingleGame(game, options)
              .catch(e => { logger.error(`Skipping "${game.title}": ${e.message}`); })
              .finally(() => {
                clearProgress(game.normalizedTitle);
                active--;
                if (active === 0 && nextIdx >= count) {
                  resolveAll();
                } else {
                  startNext();
                }
              });
          }
        }
        startNext();
      });
      logger.success('\nBatch download job finished.');
      return;
    }

    if (options.completed) {
      if (!titleQuery) {
        logger.error('Please specify a game title to mark as completed. Example: ps5dl download "3D MiniGolf" --completed');
        return;
      }
      const completedCommand = require('./completed');
      await completedCommand(titleQuery, options);
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
    if (err.isUserError) {
      logger.error(err.message);
    } else {
      logger.error('Download command failed.', err);
    }
  }
}

module.exports = downloadCommand;
