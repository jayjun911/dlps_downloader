const { loadLocalLibrary } = require('../services/localLibrary');
const { loadDownloadedGames } = require('../services/downloadedDb');
const { getWebGameList } = require('../services/webScraper');
const { loadProgressSet } = require('../services/progressDb');
const logger = require('../utils/logger');
const chalk = require('chalk');

// Known source keywords. If the first positional argument isn't one of these,
// it is interpreted as a search query against the default 'all' source.
const KNOWN_SOURCES = new Set([
  'all', 'local', 'dl', 'downloaded', 'down', 'web', 'tbd', 'excluded', 'dupe',
  'ps1', 'ps2', 'ps12', 'ps1-2', 'ps1/2', 'saturn', 'psp', 'other', 'pending'
]);

// A downloaded entry created by the `dupe` command (source "Manual (Dupe)").
const isDupeEntry = (g) => !!(g && g.source && /dupe/i.test(g.source));

/**
 * Handles the 'list' CLI command.
 *
 * @param {string} source 'all', 'local', 'dl', 'web', 'tbd', ... or a search query
 * @param {string} query  search query (when source is also given)
 * @param {{limit?: string, refresh?: boolean}} options
 */
async function listCommand(source = 'all', query = '', options = {}) {
  // `list "metal gear"` — a single non-source argument is treated as the query.
  if (!query && source && !KNOWN_SOURCES.has(String(source).toLowerCase().trim())) {
    query = source;
    source = 'all';
  }

  try {
    const localGames = loadLocalLibrary();
    const downloadedGames = loadDownloadedGames();

    // Normalize source aliases to support 'dl', 'downloaded', 'down'
    let normalizedSource = String(source).toLowerCase().trim();
    if (normalizedSource === 'downloaded' || normalizedSource === 'down') {
      normalizedSource = 'dl';
    }
    
    if (['all', 'web', 'tbd'].includes(normalizedSource) && options.refresh) {
      logger.info('Refreshing web game list cache...');
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

    const { loadLabels, loadLabelMap } = require('../services/labelDb');
    const labelMap = loadLabelMap();

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
        status: isDupeEntry(g) ? 'dupe' : 'downloaded',
        normalizedTitle: g.normalizedTitle
      }));
    } else if (normalizedSource === 'dupe') {
      displayList = downloadedGames.filter(isDupeEntry).map(g => ({
        title: g.title,
        ppsa: g.ppsa || '',
        status: 'dupe',
        normalizedTitle: g.normalizedTitle
      }));
    } else if (normalizedSource === 'web') {
      const webList = await getWebGameList(!!options.refresh);
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
    } else if (normalizedSource === 'pending') {
      const { loadPending } = require('../services/pendingDb');
      displayList = loadPending().map(g => ({
        title: g.title,
        ppsa: g.ppsa || '',
        status: 'pending',
        normalizedTitle: g.normalizedTitle
      }));
    } else if (['ps1', 'ps2', 'ps12', 'ps1-2', 'ps1/2', 'saturn', 'psp', 'other'].includes(normalizedSource)) {
      // Console-label sources: games in the active list that belong to another
      // console (PS1/PS2 emulation packages), as detected during download.
      const targetConsole = (normalizedSource === 'ps12' || normalizedSource === 'ps1/2') ? 'ps1-2' : normalizedSource;
      displayList = loadLabels()
        .filter(l => normalizedSource === 'other' || l.console === targetConsole)
        .map(l => ({
          title: l.title,
          ppsa: l.gameId || '',
          status: l.console,
          normalizedTitle: l.normalizedTitle
        }));
    } else if (normalizedSource === 'tbd') {
      const webList = await getWebGameList(!!options.refresh);
      displayList = [];
      for (const g of webList) {
        // Labeled (non-active-console) games are not "to be downloaded".
        if (labelMap.has(g.normalizedTitle)) continue;
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
      const webList = await getWebGameList(!!options.refresh);
      const processedNormalized = new Set();

      // Process web list and check against local, downloaded, & excluded
      for (const wg of webList) {
        processedNormalized.add(wg.normalizedTitle);

        // A console label (PS1/PS2) takes precedence over the web/tbd status.
        const label = labelMap.get(wg.normalizedTitle);
        if (label) {
          displayList.push({
            title: wg.title,
            ppsa: label.gameId || '',
            status: label.console,
            normalizedTitle: wg.normalizedTitle
          });
          continue;
        }

        const matchInfo = getWebGameStatus(wg, localMap, dlMap, excludedSet, localPpsaMap, dlPpsaMap, progressSet);

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
            status = isDupeEntry(dg) ? 'dupe' : 'downloaded';
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
            status: isDupeEntry(dg) ? 'dupe' : 'downloaded',
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
      
      const { consoleLabel } = require('../utils/consoleClassifier');
      const CONSOLE_STATUSES = ['ps1', 'ps2', 'ps1-2', 'ps5', 'ps4', 'saturn', 'psp'];
      let statusStr;
      if (CONSOLE_STATUSES.includes(game.status)) {
        // Console labels (PS1/PS2 emulation packages mixed into the list).
        statusStr = chalk.cyan(`[${consoleLabel(game.status)}]`);
      } else {
        statusStr = `[${game.status}]`;
        if (game.status === 'local') statusStr = chalk.blue(statusStr);
        else if (game.status === 'downloaded') statusStr = chalk.green(statusStr);
        else if (game.status === 'dupe') statusStr = chalk.gray(statusStr);
        else if (game.status === 'tbd') statusStr = chalk.yellow(statusStr);
        else if (game.status === 'excluded') statusStr = chalk.red(statusStr);
        else if (game.status === 'pending') statusStr = chalk.magenta(statusStr);
        else if (game.status === 'progress') statusStr = chalk.magenta(statusStr);
        else statusStr = chalk.gray(statusStr);
      }

      console.log(`${chalk.gray(indexStr)} ${titleStr}  ${chalk.cyan(ppsaStr)}  ${statusStr}`);
    });

    console.log(chalk.gray(`\nTotal: ${displayList.length} games`));

  } catch (err) {
    logger.error('Failed to retrieve game list.', err);
  }
}

module.exports = listCommand;
