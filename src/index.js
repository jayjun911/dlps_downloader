#!/usr/bin/env node

require('dotenv').config();
const { program } = require('commander');
const listCommand = require('./commands/list');
const downloadCommand = require('./commands/download');
const openCommand = require('./commands/open');
const excludeCommand = require('./commands/exclude');
const completedCommand = require('./commands/completed');

program
  .name('dlps')
  .description('PS5 Downloader CLI Tool')
  .version('1.0.0');

program
  .command('list')
  .argument('[source]', 'Game source: all, local, dl/downloaded, web, tbd, excluded, ps1, ps2, ps12, other (defaults to all)', 'all')
  .argument('[query]', 'Search query for game title or game ID. If the first argument is not a known source, it is treated as the query (e.g. `list "metal gear"`)')
  .option('-l, --limit <number>', 'Limit the number of displayed results')
  .option('-r, --refresh', 'Force refresh the web game list cache')
  .description('List and search games from local database and web lists')
  .action((source, query, options) => {
    listCommand(source, query, options);
  });

program
  .command('download')
  .argument('[title|url]', 'Game title to download, or a direct file URL (1fichier.com, datanodes.to, vikingfile.com)')
  .option('-l, --limit <number>', 'Batch download first N games from TBD list')
  .option('-t, --type <string>', 'Download only specific file types (e.g. GAME, DLC, BACKPORT, UPDATE)')
  .option('-s, --section', 'Interactively select a section from the available list')
  .option('-c, --completed', 'Mark the game as completed/downloaded without downloading it')
  .option('-p, --password <string>', 'Override archive password (used when auto-detection fails)')
  .option('-o, --out <path>', 'Override the default download directory')
  .option('-f, --fallback', 'Allow non-exFAT sections as a fallback when an exFAT section exists (default: exFAT-exclusive)')
  .description('Download a game by title, a batch from the TBD list, or a direct file URL')
  .action((title, options) => {
    downloadCommand(title, options);
  });

program
  .command('open')
  .argument('<title>', 'Title of the game page to open in default browser')
  .description('Open the game download page in browser')
  .action((title) => {
    openCommand(title);
  });

program
  .command('exclude')
  .argument('[title]', 'Title of the game to exclude from download')
  .option('-r, --remove', 'Remove the game from the exclusion list')
  .description('Manage excluded games list (add, remove, or list exclusions)')
  .action((title, options) => {
    excludeCommand(title, options);
  });

program
  .command('completed')
  .argument('[title]', 'Title of the game to mark as completed')
  .option('-r, --remove', 'Remove the game from the completed list')
  .description('Manage completed games list (add, remove, or list completed games)')
  .action((title, options) => {
    completedCommand(title, options);
  });

program
  .command('dupe')
  .argument('[query]', 'Search query for games in TBD/Web list to check for duplicates')
  .description('Find and mark web games as duplicates of existing local/completed games')
  .action((query) => {
    const dupeCommand = require('./commands/dupe');
    dupeCommand(query);
  });

program
  .command('process')
  .argument('<filepath>', 'Path to a downloaded .exfat or archive file (.rar/.zip/.7z)')
  .option('-p, --password <string>', 'Archive password (if needed)')
  .description('Post-process a manually downloaded file: validate, rename, compress, register')
  .action((filepath, options) => {
    const processCommand = require('./commands/process');
    processCommand(filepath, options);
  });

program
  .command('scan')
  .argument('[name]', 'Game name to scan (partial match). Omit to scan the entire PS4 list.')
  .option('-l, --limit <number>', 'Scan only the top N games from the TBD list')
  .option('-d, --delay <ms>', 'Throttle: delay before each network fetch in ms (default 1500, jittered; 0 to disable)')
  .option('-r, --refresh', 'Force re-scrape subpages instead of using cached data')
  .description('Visit PS4-list subpages and label PS1/PS2 emulation packages, no download (PS4 only)')
  .action((name, options) => {
    const scanCommand = require('./commands/scan');
    scanCommand(name, options);
  });

program
  .command('set-platform')
  .argument('[platform]', 'Console platform to set as default (ps5, ps4, ps3, ps2, switch, wii, wiiu, 3ds, xbox-jtag, xbox-iso, psp, psvita, pc)')
  .description('Set or show the default game console platform')
  .action((platform) => {
    const setPlatformCommand = require('./commands/set-platform');
    setPlatformCommand(platform);
  });

program.parse(process.argv);
