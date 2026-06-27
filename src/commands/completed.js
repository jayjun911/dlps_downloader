const { findGameInWebList } = require('../services/webScraper');
const { addDownloadedGame, loadDownloadedGames } = require('../services/downloadedDb');
const { platformDataPath } = require('../services/platformConfig');
const logger = require('../utils/logger');
const readline = require('readline');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');

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
