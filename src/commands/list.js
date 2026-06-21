const { loadLocalLibrary } = require('../services/localLibrary');
const { loadDownloadedGames } = require('../services/downloadedDb');
const { getWebGameList } = require('../services/webScraper');
const { loadProgressSet } = require('../services/progressDb');
const logger = require('../utils/logger');
const chalk = require('chalk');

/**
 * Handles the 'list' CLI command.
 * 
 * @param {string} source 'all', 'local', 'dl', 'web', 'tbd'
 * @param {{name: string}} options
 */
async function listCommand(source = 'all', options = {}) {
  const query = options.name || '';
  
  try {
    const localGames = loadLocalLibrary();
    const downloadedGames = loadDownloadedGames();
    
    // Normalize source aliases to support 'dl', 'downloaded', 'down'
    let normalizedSource = String(source).toLowerCase().trim();
    if (normalizedSource === 'downloaded' || normalizedSource === 'down') {
      normalizedSource = 'dl';
    }
    
    const { getWebGameStatus } = require('../utils/gameMatcher');
    const progressSet = loadProgressSet();

    // Maps of normalized titles for fast lookup
    const localMap = new Map(localGames.map(g => [g.normalizedTitle, g]));
    const dlMap = new Map(downloadedGames.map(g => [g.normalizedTitle, g]));
    
    // Maps of PPSAs for fallback lookup
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

    let displayList = [];

    if (normalizedSource === 'local') {
      displayList = localGames.map(g => ({
        title: g.title,
        ppsa: g.ppsa || '',
        status: 'local',
        normalizedTitle: g.normalizedTitle
      }));
    } else if (normalizedSource === 'dl') {
      displayList = downloadedGames.map(g => ({
        title: g.title,
        ppsa: g.ppsa || '',
        status: 'downloaded',
        normalizedTitle: g.normalizedTitle
      }));
    } else if (normalizedSource === 'web') {
      const webList = await getWebGameList();
      displayList = webList.map(g => ({
        title: g.title,
        ppsa: '',
        status: 'web',
        normalizedTitle: g.normalizedTitle
      }));
    } else if (normalizedSource === 'excluded') {
      displayList = excludedGames.map(g => ({
        title: g.title,
        ppsa: '',
        status: 'excluded',
        normalizedTitle: g.normalizedTitle
      }));
    } else if (normalizedSource === 'tbd') {
      const webList = await getWebGameList();
      displayList = [];
      for (const g of webList) {
        const matchInfo = getWebGameStatus(g, localMap, dlMap, excludedSet, localPpsaMap, dlPpsaMap, progressSet);
        if (matchInfo.status === 'tbd') {
          displayList.push({
            title: g.title,
            ppsa: '',
            status: 'tbd',
            normalizedTitle: g.normalizedTitle
          });
        }
      }
    } else if (normalizedSource === 'all') {
      const webList = await getWebGameList();
      const processedNormalized = new Set();

      // Process web list and check against local, downloaded, & excluded
      for (const wg of webList) {
        processedNormalized.add(wg.normalizedTitle);
        
        const matchInfo = getWebGameStatus(wg, localMap, dlMap, excludedSet, localPpsaMap, dlPpsaMap);
        
        displayList.push({
          title: wg.title,
          ppsa: matchInfo.ppsa,
          status: matchInfo.status,
          normalizedTitle: wg.normalizedTitle
        });
      }

      // Add local games that are not in web list
      for (const lg of localGames) {
        if (!processedNormalized.has(lg.normalizedTitle)) {
          let status = 'local';
          let ppsa = lg.ppsa || '';
          
          if (dlMap.has(lg.normalizedTitle)) {
            const dg = dlMap.get(lg.normalizedTitle);
            ppsa = dg.ppsa || ppsa;
            status = 'downloaded';
          }
          
          displayList.push({
            title: lg.title,
            ppsa,
            status,
            normalizedTitle: lg.normalizedTitle
          });
          processedNormalized.add(lg.normalizedTitle);
        }
      }

      // Add downloaded games that are not in web or local lists
      for (const dg of downloadedGames) {
        if (!processedNormalized.has(dg.normalizedTitle)) {
          displayList.push({
            title: dg.title,
            ppsa: dg.ppsa || '',
            status: 'downloaded',
            normalizedTitle: dg.normalizedTitle
          });
          processedNormalized.add(dg.normalizedTitle);
        }
      }
    } else {
      logger.error(`Unknown list source: ${source}`);
      return;
    }

    // Apply name query filter if provided
    if (query) {
      const lowerQuery = query.toLowerCase();
      displayList = displayList.filter(g => 
        g.title.toLowerCase().includes(lowerQuery) || 
        g.ppsa.toLowerCase().includes(lowerQuery)
      );
    }

    // Apply limit filter if provided
    if (options.limit) {
      const limitVal = parseInt(options.limit, 10);
      if (!isNaN(limitVal) && limitVal > 0) {
        displayList = displayList.slice(0, limitVal);
      }
    }

    if (displayList.length === 0) {
      logger.info('No games found matching the criteria.');
      return;
    }

    // Format list for console output
    displayList.forEach((game, idx) => {
      const indexStr = `[${String(idx + 1).padStart(3, '0')}]`;
      const titleStr = game.title.padEnd(50, ' ').substring(0, 50);
      const ppsaStr = (game.ppsa || '').padEnd(10, ' ');
      
      let statusStr = `[${game.status}]`;
      if (game.status === 'local') statusStr = chalk.blue(statusStr);
      else if (game.status === 'downloaded') statusStr = chalk.green(statusStr);
      else if (game.status === 'tbd') statusStr = chalk.yellow(statusStr);
      else if (game.status === 'excluded') statusStr = chalk.red(statusStr);
      else if (game.status === 'progress') statusStr = chalk.magenta(statusStr);
      else statusStr = chalk.gray(statusStr);

      console.log(`${chalk.gray(indexStr)} ${titleStr}  ${chalk.cyan(ppsaStr)}  ${statusStr}`);
    });

    console.log(chalk.gray(`\nTotal: ${displayList.length} games`));

  } catch (err) {
    logger.error('Failed to retrieve game list.', err);
  }
}

module.exports = listCommand;
