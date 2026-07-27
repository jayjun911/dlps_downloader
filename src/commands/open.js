const { findGameInWebList } = require('../services/webScraper');
const { addPending } = require('../services/pendingDb');
const logger = require('../utils/logger');
const open = require('open');
const readline = require('readline');
const chalk = require('chalk');

/**
 * Helper to resolve the game's PPSA and add it to the pending queue.
 */
async function handleInteractiveOpen(selected) {
  let bestKnownPpsa = 'Unknown';
  try {
    const { loadLocalLibrary } = require('../services/localLibrary');
    const localGames = loadLocalLibrary();
    const localMatch = localGames.find(lg => lg.normalizedTitle === selected.normalizedTitle);
    if (localMatch && localMatch.ppsa) {
      bestKnownPpsa = localMatch.ppsa;
    } else {
      const { getGameSubpageData } = require('../services/webScraper');
      const { sections } = await getGameSubpageData(selected.slug, selected.url);
      if (sections && sections.length > 0) {
        bestKnownPpsa = (sections.find(s => s.ppsa) || {}).ppsa || 'Unknown';
      }
    }
  } catch (err) {
    // ignore scraping/local-loading errors since we are opening it in browser anyway
  }
  addPending({ title: selected.title, url: selected.url, ppsa: bestKnownPpsa });
  logger.success(`Added "${selected.title}" to pending manual downloads.`);
}

/**
 * Handles the 'open' CLI command.
 * 
 * @param {string} titleQuery 
 * @param {object} options
 */
async function openCommand(titleQuery, options = {}) {
  if (!titleQuery) {
    logger.error('Please specify a game title. Example: dlps open "Cyberpunk 2077"');
    return;
  }

  try {
    const matches = await findGameInWebList(titleQuery);
    
    if (matches.length === 0) {
      logger.warn(`No games found matching: "${titleQuery}"`);
      return;
    }

    if (matches.length === 1) {
      const selected = matches[0];
      logger.info(`Opening: "${selected.title}" (${selected.url})`);
      await open(selected.url);
      await handleInteractiveOpen(selected);
      return;
    }

    // Multiple matches, prompt user selection
    console.log(chalk.yellow(`\nMultiple games match your query "${titleQuery}":`));
    matches.forEach((game, idx) => {
      console.log(`  [${idx + 1}] ${game.title} (${game.url})`);
    });
    
    await new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      rl.question(chalk.cyan('\nSelect a game number to open (or press Enter to cancel): '), async (answer) => {
        rl.close();
        const num = parseInt(answer.trim(), 10);
        if (num > 0 && num <= matches.length) {
          const selected = matches[num - 1];
          logger.info(`Opening: "${selected.title}" (${selected.url})`);
          await open(selected.url);
          await handleInteractiveOpen(selected);
        } else {
          logger.info('Cancelled.');
        }
        resolve();
      });
    });

  } catch (err) {
    logger.error('Failed to open game page.', err);
  }
}

module.exports = openCommand;
