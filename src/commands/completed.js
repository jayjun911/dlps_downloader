const { findGameInWebList } = require('../services/webScraper');
const { addDownloadedGame, loadDownloadedGames } = require('../services/downloadedDb');
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
function findGameFile(names, ppsa) {
  if (!ppsa || ppsa === 'Unknown') return null;
  const id = ppsa.toLowerCase();
  return names.find(n => n.includes(id) && n.includes('[game]')) || null;
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
async function handlePending() {
  let pending = loadPending();
  if (pending.length === 0) {
    logger.info('No pending manual downloads. (Run `dlps download -l N -i` first.)');
    return;
  }

  // Drop entries that are no longer TBD — resolved elsewhere since being queued
  // (auto-labeled as another console/JPN, or already marked completed). Clean
  // them out of the queue so only genuine manual candidates remain.
  const labelMap = loadLabelMap();
  const completedSet = new Set(loadDownloadedGames().map(g => g.normalizedTitle));
  const stale = pending.filter(p => labelMap.has(p.normalizedTitle) || completedSet.has(p.normalizedTitle));
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
    file: findGameFile(names, p.ppsa),
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

// Per-platform downloaded library, e.g. data/downloaded-ps5.xml
const DB_PATH = platformDataPath('downloaded', 'xml');

/**
 * Removes a game entry from downloaded.xml by title.
 */
function removeDownloadedGame(title) {
  const games = loadDownloadedGames();
  const { normalizeTitle } = require('../utils/titleNormalizer');
  const targetNorm = normalizeTitle(title);
  
  // Re-save list excluding matching titles
  let xml = '<?xml version="1.0" standalone="yes"?>\n<Downloaded>\n';
  
  const escapeXmlLocal = (unsafe) => {
    if (!unsafe) return '';
    return unsafe.toString().replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
        default: return c;
      }
    });
  };

  let removedCount = 0;
  for (const g of games) {
    if (normalizeTitle(g.title) === targetNorm) {
      removedCount++;
      continue;
    }
    xml += '  <Game>\n';
    xml += `    <Title>${escapeXmlLocal(g.title)}</Title>\n`;
    xml += `    <FileName>${escapeXmlLocal(g.fileName)}</FileName>\n`;
    xml += `    <PPSA>${escapeXmlLocal(g.ppsa)}</PPSA>\n`;
    xml += `    <Password>${escapeXmlLocal(g.password)}</Password>\n`;
    xml += `    <DownloadedAt>${escapeXmlLocal(g.downloadedAt)}</DownloadedAt>\n`;
    xml += `    <Source>${escapeXmlLocal(g.source)}</Source>\n`;
    xml += `    <Region>${escapeXmlLocal(g.region)}</Region>\n`;
    xml += '  </Game>\n';
  }
  xml += '</Downloaded>\n';
  
  fs.writeFileSync(DB_PATH, xml, 'utf-8');
  return removedCount > 0;
}

/**
 * Handles the 'completed' CLI command.
 */
async function completedCommand(titleQuery, options = {}) {
  const isRemove = !!options.remove;

  // Batch-complete games queued for manual download via `download -i`.
  if (options.pending) {
    return handlePending();
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
      });
      return;
    }

    // Case 2: Adding to completed list (standard behavior)
    const matches = await findGameInWebList(titleQuery);
    
    if (matches.length === 0) {
      // Ask if the user wants to mark this exact title as completed anyway
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
    });

  } catch (err) {
    logger.error('Failed to update completed games list.', err);
  }
}

module.exports = completedCommand;
