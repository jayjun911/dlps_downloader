const { findGameInWebList } = require('../services/webScraper');
const { setLabel, removeLabel, loadLabels } = require('../services/labelDb');
const logger = require('../utils/logger');
const readline = require('readline');
const chalk = require('chalk');

const VALID_CONSOLES = ['ps1', 'ps2', 'ps1-2', 'ps1/2', 'ps12', 'saturn', 'psp', 'other'];

/**
 * Handles the 'type' (label) CLI command.
 */
async function typeCommand(titleQuery, consoleType, options = {}) {
  const isRemove = !!options.remove;

  // If no query is provided, print the list of currently labeled games
  if (!titleQuery) {
    const labels = loadLabels();
    if (labels.length === 0) {
      logger.info('No games have custom types/labels.');
      return;
    }
    console.log(chalk.cyan(`\nCurrently manually typed games (${labels.length}):`));
    labels.forEach((l, idx) => {
      console.log(`  [${String(idx + 1).padStart(3, '0')}] ${l.title} ${chalk.green(`(${l.console})`)}`);
    });
    return;
  }

  try {
    // Case 1: Removing a label
    if (isRemove) {
      const labels = loadLabels();
      const queryLower = titleQuery.toLowerCase();
      const matches = labels.filter(l => l.title.toLowerCase().includes(queryLower));

      if (matches.length === 0) {
        logger.warn(`No manually typed games found matching: "${titleQuery}"`);
        return;
      }

      if (matches.length === 1) {
        removeLabel(matches[0].title);
        logger.success(`Successfully removed type for: "${matches[0].title}"`);
        return;
      }

      console.log(chalk.yellow(`\nMultiple typed games match your query "${titleQuery}":`));
      matches.forEach((l, idx) => {
        console.log(`  [${idx + 1}] ${l.title} (${l.console})`);
      });

      await new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(chalk.cyan('\nSelect a game number to remove its type (or press Enter to cancel): '), (answer) => {
          rl.close();
          const num = parseInt(answer.trim(), 10);
          if (num > 0 && num <= matches.length) {
            const selected = matches[num - 1];
            removeLabel(selected.title);
            logger.success(`Successfully removed type for: "${selected.title}"`);
          } else {
            logger.info('Cancelled.');
          }
          resolve();
        });
      });
      return;
    }

    // Case 2: Adding/Updating a label
    if (!consoleType) {
      logger.error('You must specify a console type. e.g. dlps type "game name" ps2');
      logger.info(`Valid types: ${VALID_CONSOLES.join(', ')}`);
      return;
    }

    const typeLower = consoleType.toLowerCase();
    if (!VALID_CONSOLES.includes(typeLower)) {
      logger.error(`Invalid console type: "${consoleType}"`);
      logger.info(`Valid types: ${VALID_CONSOLES.join(', ')}`);
      return;
    }
    const finalConsole = (typeLower === 'ps12' || typeLower === 'ps1/2') ? 'ps1-2' : typeLower;

    const matches = await findGameInWebList(titleQuery);

    if (matches.length === 0) {
      await new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(chalk.yellow(`No games matching "${titleQuery}" found in the web list. Apply type to this exact string anyway? (y/N): `), (answer) => {
          rl.close();
          if (answer.trim().toLowerCase() === 'y') {
            setLabel(titleQuery, finalConsole, '');
            logger.success(`Successfully set type for: "${titleQuery}" to ${finalConsole}`);
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
      setLabel(game.title, finalConsole, game.id || '');
      logger.success(`Successfully set type for: "${game.title}" to ${finalConsole}`);
      return;
    }

    console.log(chalk.yellow(`\nMultiple games match your query "${titleQuery}":`));
    matches.forEach((game, idx) => {
      console.log(`  [${idx + 1}] ${game.title} (${game.url})`);
    });

    await new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(chalk.cyan('\nSelect a game number to type (or press Enter to cancel): '), (answer) => {
        rl.close();
        const num = parseInt(answer.trim(), 10);
        if (num > 0 && num <= matches.length) {
          const selected = matches[num - 1];
          setLabel(selected.title, finalConsole, selected.id || '');
          logger.success(`Successfully set type for: "${selected.title}" to ${finalConsole}`);
        } else {
          logger.info('Cancelled.');
        }
        resolve();
      });
    });

  } catch (err) {
    logger.error('Failed to set type.', err);
  }
}

module.exports = typeCommand;
