const { findGameInWebList } = require('../services/webScraper');
const { addDownloadedGame, loadDownloadedGames, removeDownloadedGame } = require('../services/downloadedDb');
const { removePendingForGame } = require('../services/pendingDb');
const { handlePending } = require('./pendingProcess');
const logger = require('../utils/logger');
const readline = require('readline');
const chalk = require('chalk');

/**
 * Handles the 'completed' CLI command.
 */
async function completedCommand(titleQuery, options = {}) {
  const isRemove = !!options.remove;

  // Batch-complete games queued for manual download via `download -i` (moved to `process --pending`).
  if (options.pending) {
    logger.info('Note: `completed --pending` has moved to `process --pending`. Running `process --pending`...');
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
    let targetPpsa = null;
    if (options.ppsa) {
      const raw = String(options.ppsa).trim();
      targetPpsa = /^\d{5}$/.test(raw) ? `PPSA${raw}` : raw.toUpperCase();
    }

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
              ppsa: targetPpsa || 'Unknown',
              password: '',
              source: 'Manual',
              region: 'Unknown'
            });
            logger.success(`Successfully marked as completed: "${titleQuery}"`);
            const removed = removePendingForGame({ title: titleQuery, ppsa: targetPpsa, titleQuery });
            if (removed.length > 0) {
              removed.forEach(r => logger.info(`Removed "${r.title}" from pending manual downloads.`));
            }
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
      const parsedPpsa = targetPpsa || (ppsaMatch ? ppsaMatch[0].toUpperCase() : 'Unknown');

      addDownloadedGame({
        title: game.title,
        fileName: 'Manual Entry',
        ppsa: parsedPpsa,
        password: '',
        source: 'Manual',
        region: 'Unknown'
      });
      logger.success(`Successfully marked as completed: "${game.title}" (PPSA: ${parsedPpsa})`);
      const removed = removePendingForGame({ title: game.title, ppsa: parsedPpsa, url: game.url, titleQuery });
      if (removed.length > 0) {
        removed.forEach(r => logger.info(`Removed "${r.title}" from pending manual downloads.`));
      }
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
          const parsedPpsa = targetPpsa || (ppsaMatch ? ppsaMatch[0].toUpperCase() : 'Unknown');
          
          addDownloadedGame({
            title: selected.title,
            fileName: 'Manual Entry',
            ppsa: parsedPpsa,
            password: '',
            source: 'Manual',
            region: 'Unknown'
          });
          logger.success(`Successfully marked as completed: "${selected.title}" (PPSA: ${parsedPpsa})`);
          const removed = removePendingForGame({ title: selected.title, ppsa: parsedPpsa, url: selected.url, titleQuery });
          if (removed.length > 0) {
            removed.forEach(r => logger.info(`Removed "${r.title}" from pending manual downloads.`));
          }
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
