const { findGameInWebList, getWebGameList } = require('../services/webScraper');
const { loadLocalLibrary } = require('../services/localLibrary');
const { loadDownloadedGames, addDownloadedGame } = require('../services/downloadedDb');
const { normalizeTitle } = require('../utils/titleNormalizer');
const logger = require('../utils/logger');
const readline = require('readline');
const chalk = require('chalk');

// Helper to ask interactive questions returning a Promise
function askQuestion(queryText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(queryText, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

// Word overlap similarity metric
function calculateSimilarity(title1, title2) {
  const norm1 = normalizeTitle(title1);
  const norm2 = normalizeTitle(title2);
  
  if (norm1 === norm2) return 1.0;

  // Split into words, lowercase and clean special characters
  const clean1 = title1.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
  const clean2 = title2.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
  
  const words1 = clean1.split(/\s+/).filter(w => w.length > 0);
  const words2 = clean2.split(/\s+/).filter(w => w.length > 0);
  
  if (words1.length === 0 || words2.length === 0) return 0;
  
  // Find intersection
  const set2 = new Set(words2);
  const intersection = words1.filter(w => set2.has(w));
  
  // Sorensen-Dice coefficient
  return (2 * intersection.length) / (words1.length + words2.length);
}

/**
 * Handles the 'dupe' CLI command.
 */
async function dupeCommand(query) {
  try {
    const localGames = loadLocalLibrary();
    const downloadedGames = loadDownloadedGames();
    const webGames = await getWebGameList();

    const { getWebGameStatus } = require('../utils/gameMatcher');

    // Map of normalized titles for fast lookup
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
    const excludedSet = new Set(loadExcludedGames().map(g => g.normalizedTitle));

    // Determine target web games to check
    let targetWebGames = [];
    if (query) {
      targetWebGames = await findGameInWebList(query);
      if (targetWebGames.length === 0) {
        logger.info(`No games matching "${query}" found in the web list.`);
        return;
      }
    } else {
      // Find all TBD web games
      targetWebGames = [];
      for (const g of webGames) {
        const matchInfo = getWebGameStatus(g, localMap, dlMap, excludedSet, localPpsaMap, dlPpsaMap, null);
        if (matchInfo.status === 'tbd') {
          targetWebGames.push(g);
        }
      }
      if (targetWebGames.length === 0) {
        logger.info('No TBD games remaining in the web list to check.');
        return;
      }
    }

    // Combine local and downloaded library games to suggest matching dupes
    const libraryPool = [];
    localGames.forEach(g => {
      libraryPool.push({
        title: g.title,
        ppsa: g.ppsa || 'Unknown',
        region: 'Local Library',
        source: 'Local'
      });
    });
    downloadedGames.forEach(g => {
      // Avoid adding duplicate entries from the pool itself if they match
      if (!libraryPool.some(p => p.title === g.title)) {
        libraryPool.push({
          title: g.title,
          ppsa: g.ppsa || 'Unknown',
          region: g.region || 'Unknown',
          source: 'Downloaded'
        });
      }
    });

    let processedCount = 0;

    for (const webGame of targetWebGames) {
      // Calculate similarity scores for all library pool games
      const suggestions = libraryPool
        .map(lib => ({
          ...lib,
          similarity: calculateSimilarity(webGame.title, lib.title)
        }))
        .filter(s => s.similarity >= 0.35) // Threshold for suggested similarity
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 5); // Present top 5 suggestions

      // Skip TBD games with no similar local games if we are doing automatic scan
      if (!query && suggestions.length === 0) {
        continue;
      }

      processedCount++;
      console.log(chalk.bold.yellow(`\n--------------------------------------------------`));
      console.log(`${chalk.bold('Web Game:')} "${webGame.title}"`);
      console.log(`${chalk.bold('Web URL:')} ${webGame.url}`);
      console.log(chalk.yellow(`--------------------------------------------------`));

      if (suggestions.length === 0) {
        console.log(chalk.gray('No similar games found in local library or completed list.'));
      } else {
        console.log(chalk.cyan('Similar games found in your local/completed library:'));
        suggestions.forEach((s, idx) => {
          const simPct = (s.similarity * 100).toFixed(0);
          console.log(`  [${idx + 1}] ${s.title} ${chalk.gray(`(PPSA: ${s.ppsa}, Source: ${s.source}, Similarity: ${simPct}%)`)}`);
        });
      }

      const exitOptionIndex = suggestions.length + 1;
      const skipOptionIndex = suggestions.length + 2;
      
      console.log(chalk.cyan(`  [${exitOptionIndex}] Exit/Cancel`));
      console.log(chalk.cyan(`  [${skipOptionIndex}] Skip this game`));

      const answer = await askQuestion(chalk.green(`\nSelect option (or press Enter to skip): `));
      
      if (answer === '' || parseInt(answer, 10) === skipOptionIndex) {
        console.log('Skipped.');
        continue;
      }

      const choice = parseInt(answer, 10);
      if (isNaN(choice) || choice === exitOptionIndex) {
        console.log('Exit command received. Stopping.');
        break;
      }

      if (choice > 0 && choice <= suggestions.length) {
        const selected = suggestions[choice - 1];
        // Parse PPSA from webGame url if possible, otherwise use local game's PPSA
        const ppsaMatch = webGame.url.match(/ppsa\d{5}/i);
        const parsedPpsa = ppsaMatch ? ppsaMatch[0].toUpperCase() : selected.ppsa;

        addDownloadedGame({
          title: webGame.title,
          fileName: 'Manual Entry (Dupe)',
          ppsa: parsedPpsa,
          password: '',
          source: 'Manual (Dupe)',
          region: selected.region
        });
        logger.success(`Marked "${webGame.title}" as duplicate of "${selected.title}" (PPSA: ${parsedPpsa})`);
      } else {
        console.log(chalk.red('Invalid selection. Skipped.'));
      }
    }

    if (processedCount === 0) {
      logger.info('No potential duplicate games found matching similarity threshold.');
    } else {
      logger.success('\nFinished processing duplicate suggestions.');
    }

  } catch (err) {
    logger.error('Failed to process duplicates.', err);
  }
}

module.exports = dupeCommand;
