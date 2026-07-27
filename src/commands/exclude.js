const { findGameInWebList } = require('../services/webScraper');
const { addExcludedGame, removeExcludedGame, loadExcludedGames } = require('../services/excludedDb');
const logger = require('../utils/logger');
const readline = require('readline');
const chalk = require('chalk');

/**
 * Handles the 'exclude' CLI command.
 * 
 * @param {string} titleQuery 
 * @param {{remove: boolean}} options 
 */
async function excludeCommand(titleQuery, options = {}) {
  const isRemove = !!options.remove;

  // If no query is provided, print the list of currently excluded games
  if (!titleQuery) {
    const excludedList = loadExcludedGames();
    if (excludedList.length === 0) {
      logger.info('No games are currently excluded.');
      return;
    }
    console.log(chalk.yellow(`\nCurrently excluded games (${excludedList.length}):`));
    excludedList.forEach((g, idx) => {
      console.log(`  [${String(idx + 1).padStart(3, '0')}] ${g.title} ${chalk.gray(`(Excluded on: ${g.excludedAt})`)}`);
    });
    return;
  }

  try {
    // Case 1: Removing from exclusions
    if (isRemove) {
      const excludedList = loadExcludedGames();
      const queryLower = titleQuery.toLowerCase();
      const matches = excludedList.filter(g => 
        g.title.toLowerCase().includes(queryLower)
      );

      if (matches.length === 0) {
        logger.warn(`No excluded games found matching: "${titleQuery}"`);
        return;
      }

      if (matches.length === 1) {
        const game = matches[0];
        removeExcludedGame(game.title);
        logger.success(`Successfully removed from exclusions: "${game.title}"`);
        return;
      }

      // Multiple matches inside the exclusion list
      console.log(chalk.yellow(`\nMultiple excluded games match your query "${titleQuery}":`));
      matches.forEach((game, idx) => {
        console.log(`  [${idx + 1}] ${game.title}`);
      });

      await new Promise((resolve) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });

        rl.question(chalk.cyan('\nSelect a game number to remove from exclusions (or press Enter to cancel): '), (answer) => {
          rl.close();
          const num = parseInt(answer.trim(), 10);
          if (num > 0 && num <= matches.length) {
            const selected = matches[num - 1];
            removeExcludedGame(selected.title);
            logger.success(`Successfully removed from exclusions: "${selected.title}"`);
          } else {
            logger.info('Cancelled.');
          }
          resolve();
        });
      });
      return;
    }

    // Case 2: Adding to exclusions (standard behavior)
    const matches = await findGameInWebList(titleQuery);
    
    if (matches.length === 0) {
      // If not found in the web list, ask if the user wants to exclude this exact string anyway
      await new Promise((resolve) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });

        rl.question(chalk.yellow(`No games matching "${titleQuery}" found in the web list. Exclude this exact title anyway? (y/N): `), (answer) => {
          rl.close();
          if (answer.trim().toLowerCase() === 'y') {
            addExcludedGame(titleQuery);
            logger.success(`Successfully added to exclusions: "${titleQuery}"`);
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
      const added = addExcludedGame(game.title);
      if (added) {
        logger.success(`Successfully added to exclusions: "${game.title}"`);
      } else {
        logger.info(`"${game.title}" is already excluded.`);
      }
      return;
    }

    // Multiple matches in the web list
    console.log(chalk.yellow(`\nMultiple games match your query "${titleQuery}":`));
    matches.forEach((game, idx) => {
      console.log(`  [${idx + 1}] ${game.title} (${game.url})`);
    });

    await new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      rl.question(chalk.cyan('\nSelect a game number to exclude (or press Enter to cancel): '), (answer) => {
        rl.close();
        const num = parseInt(answer.trim(), 10);
        if (num > 0 && num <= matches.length) {
          const selected = matches[num - 1];
          const added = addExcludedGame(selected.title);
          if (added) {
            logger.success(`Successfully added to exclusions: "${selected.title}"`);
          } else {
            logger.info(`"${selected.title}" is already excluded.`);
          }
        } else {
          logger.info('Cancelled.');
        }
        resolve();
      });
    });

  } catch (err) {
    logger.error('Failed to update exclusions.', err);
  }
}

module.exports = excludeCommand;
