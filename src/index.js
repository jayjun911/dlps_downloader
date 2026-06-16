#!/usr/bin/env node

require('dotenv').config();
const { program } = require('commander');
const listCommand = require('./commands/list');
const downloadCommand = require('./commands/download');
const openCommand = require('./commands/open');
const excludeCommand = require('./commands/exclude');

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

program.parse(process.argv);
