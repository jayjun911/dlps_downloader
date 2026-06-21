#!/usr/bin/env node

require('dotenv').config();
const { program } = require('commander');
const listCommand = require('./commands/list');
const downloadCommand = require('./commands/download');
const openCommand = require('./commands/open');
const excludeCommand = require('./commands/exclude');
const completedCommand = require('./commands/completed');

program
  .name('ps5dl')
  .description('PS5 Downloader CLI Tool')
  .version('1.0.0');

program
  .command('list')
  .argument('[source]', 'Game source to display: all, local, dl/downloaded, web, tbd, excluded', 'all')
  .option('-n, --name <query>', 'Search query for game title or PPSA code')
  .option('-l, --limit <number>', 'Limit the number of displayed results')
  .description('List and search games from local database and web lists')
  .action((source, options) => {
    listCommand(source, options);
  });

program
  .command('download')
  .argument('[title]', 'Title of the game to download')
  .option('-l, --limit <number>', 'Batch download first N games from TBD list')
  .option('-t, --type <string>', 'Download only specific file types (e.g. GAME, DLC, BACKPORT, UPDATE)')
  .option('-s, --section', 'Interactively select a section from the available list')
  .option('-c, --completed', 'Mark the game as completed/downloaded without downloading it')
  .option('-p, --password <string>', 'Override archive password (used when auto-detection fails)')
  .option('-o, --out <path>', 'Override the default download directory')
  .option('-e, --exfat', 'If an exFAT section exists, use it exclusively (no fallback to non-exFAT)')
  .description('Download a specific game or a batch of games from TBD list')
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
  .command('urldown')
  .argument('<url>', '1fichier.com, datanodes.to, or vikingfile.com file URL')
  .option('-p, --password <string>', 'Archive password (if auto-detection fails)')
  .description('Download directly from a file URL and post-process (rename, unpack, register)')
  .action((url, options) => {
    const urldownCommand = require('./commands/urldown');
    urldownCommand(url, options);
  });

program.parse(process.argv);
