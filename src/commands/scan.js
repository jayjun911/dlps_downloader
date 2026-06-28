const ora = require('ora');
const chalk = require('chalk');
const { getWebGameList, findGameInWebList, getGameSubpageData, isSubpageCached } = require('../services/webScraper');
const { getCurrentPlatformKey } = require('../services/platformConfig');
const { classifyId, consoleLabel } = require('../utils/consoleClassifier');
const { setLabel, removeLabel, getLabel, loadLabelMap } = require('../services/labelDb');
const { loadLocalLibrary } = require('../services/localLibrary');
const { loadDownloadedGames } = require('../services/downloadedDb');
const { loadProgressSet } = require('../services/progressDb');
const logger = require('../utils/logger');

/**
 * Builds the TBD (To Be Downloaded) list, optionally filtered by a query.
 * Mirrors the TBD logic in the download command; already-labeled entries are
 * excluded since they aren't PS4 downloads.
 */
async function buildTbdList(query) {
  let localGames = [];
  try {
    localGames = loadLocalLibrary();
  } catch (e) {
    // No local library for this platform yet — treat everything as not-local.
  }
  const downloadedGames = loadDownloadedGames();
  const webList = await getWebGameList();

  const { getWebGameStatus } = require('../utils/gameMatcher');
  const localMap = new Map(localGames.map(g => [g.normalizedTitle, g]));
  const dlMap = new Map(downloadedGames.map(g => [g.normalizedTitle, g]));

  const localPpsaMap = new Map();
  for (const g of localGames) if (g.ppsa) localPpsaMap.set(g.ppsa.toUpperCase(), g);
  const dlPpsaMap = new Map();
  for (const g of downloadedGames) if (g.ppsa) dlPpsaMap.set(g.ppsa.toUpperCase(), g);

  const { loadExcludedGames } = require('../services/excludedDb');
  const excludedSet = new Set(loadExcludedGames().map(g => g.normalizedTitle));
  const progressSet = loadProgressSet();
  const labelMap = loadLabelMap();

  const q = query ? query.toLowerCase() : null;
  const tbd = [];
  for (const g of webList) {
    if (labelMap.has(g.normalizedTitle)) continue;            // already labeled
    if (q && !g.title.toLowerCase().includes(q)) continue;
    const info = getWebGameStatus(g, localMap, dlMap, excludedSet, localPpsaMap, dlPpsaMap, progressSet);
    if (info.status === 'tbd') tbd.push(g);
  }
  return tbd;
}

/**
 * Handles the 'scan' CLI command (PS4 only).
 *
 * Visits the subpages of all games matching `query` (or the whole PS4 list when
 * omitted), classifies their game IDs, and records a PS1/PS2 label for any
 * entry that isn't a native PS4 title — without downloading anything.
 */
async function scanCommand(query, options = {}) {
  const active = getCurrentPlatformKey();
  if (active !== 'ps4') {
    logger.error(`'scan' is only available on the PS4 platform (current: ${active}).`);
    logger.info('Switch with: dlps set-platform ps4');
    return;
  }

  const limit = options.limit !== undefined ? parseInt(options.limit, 10) : null;
  if (limit !== null && (isNaN(limit) || limit <= 0)) {
    logger.error('Invalid limit value. Please specify a positive integer.');
    return;
  }

  // Safety-first throttle: pause ~baseDelay (with jitter) before each network
  // fetch so bursts don't trip Cloudflare/rate-limiting. Cache hits are instant.
  const baseDelay = options.delay !== undefined ? parseInt(options.delay, 10) : 1500;
  if (options.delay !== undefined && (isNaN(baseDelay) || baseDelay < 0)) {
    logger.error('Invalid delay value. Please specify milliseconds (>= 0).');
    return;
  }

  let games;
  try {
    if (limit !== null) {
      // Top N of the TBD list (optionally filtered by name).
      const tbd = await buildTbdList(query);
      if (tbd.length === 0) {
        logger.info('No TBD (To Be Downloaded) games to scan.');
        return;
      }
      games = tbd.slice(0, limit);
    } else if (query) {
      games = await findGameInWebList(query);
      if (games.length === 0) {
        logger.warn(`No games found matching: "${query}"`);
        return;
      }
    } else {
      games = await getWebGameList(!!options.refresh);
    }
  } catch (err) {
    logger.error('Failed to load the game list.', err);
    return;
  }

  const delayLabel = baseDelay > 0 ? `~${(baseDelay / 1000).toFixed(1)}s throttle` : 'no throttle';
  logger.info(`Scanning ${games.length} game(s) for non-PS4 (PS1/PS2) titles... [${delayLabel}]`);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // Jittered delay in [0.75x, 1.5x] of base to avoid a fixed-interval pattern.
  const jitter = (base) => Math.round(base * (0.75 + Math.random() * 0.75));

  let labeled = 0;
  let ps4Count = 0;
  let noId = 0;
  let failed = 0;
  let aborted = false;

  for (let i = 0; i < games.length; i++) {
    const g = games[i];

    // Throttle only before requests that will actually hit the network.
    const willHitNetwork = !!options.refresh || !isSubpageCached(g.slug);
    if (i > 0 && willHitNetwork && baseDelay > 0) {
      await sleep(jitter(baseDelay));
    }

    const spinner = ora(`[${i + 1}/${games.length}] ${g.title}`).start();
    try {
      const sections = await getGameSubpageData(g.slug, g.url, !!options.refresh);
      const detected = sections.map(s => classifyId(s.ppsa)).filter(Boolean);
      const hasPs4 = detected.some(d => d.console === 'ps4');

      if (!hasPs4 && detected.length > 0) {
        const other = detected[0];
        const idSection = sections.find(s => {
          const c = classifyId(s.ppsa);
          return c && c.console === other.console;
        });
        setLabel(g.title, other.console, idSection ? idSection.ppsa : '');
        labeled++;
        spinner.succeed(
          `${g.title} → ${chalk.cyan(`[${consoleLabel(other.console)}]`)}` +
          `${idSection ? ` ${chalk.gray(idSection.ppsa)}` : ''}`
        );
      } else if (hasPs4) {
        // Genuine PS4 title — clear any stale label from a previous scan.
        if (getLabel(g.normalizedTitle)) removeLabel(g.title);
        ps4Count++;
        spinner.stop();
      } else {
        noId++;
        spinner.stop();
      }
    } catch (err) {
      failed++;
      spinner.fail(`${g.title}: ${err.message}`);
      // Rate-limit / Cloudflare challenge → stop now to avoid escalating to a ban.
      if (/cloudflare|turnstile|challenge|\b429\b|too many requests/i.test(err.message)) {
        logger.warn('Rate-limit/Cloudflare challenge detected — stopping scan to avoid a ban.');
        logger.info('Wait a while, then re-run the same command to resume (labeled/cached games are skipped).');
        aborted = true;
        break;
      }
    }
  }

  const verb = aborted ? 'Scan stopped' : 'Scan complete';
  logger.success(
    `${verb} — ${chalk.cyan(labeled)} labeled (PS1/PS2), ` +
    `${ps4Count} PS4, ${noId} no-ID, ${failed} failed.`
  );
}

module.exports = scanCommand;
