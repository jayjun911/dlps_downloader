const path = require('path');
const ora = require('ora');
const chalk = require('chalk');
const open = require('open');
const { downloadFromDatanodes } = require('../services/datanodesDownloader');
const { download1fichier } = require('../services/fichierDownloader');
const { processDownloadedFiles } = require('../utils/postProcessor');
const logger = require('../utils/logger');

function detectService(url) {
  if (/1fichier\.com/i.test(url)) return '1fichier';
  if (/datanodes\.to/i.test(url)) return 'datanodes';
  if (/mediafire\.com/i.test(url)) return 'mediafire';
  if (/vikingfile\.com|vik1ngfile\.site/i.test(url)) return 'vikingfile';
  return null;
}

async function urldownCommand(url, options = {}) {
  if (!url) {
    logger.error('Usage: dlps urldown <url>');
    logger.info('Supported: 1fichier.com, datanodes.to, mediafire.com, vikingfile.com');
    return;
  }

  const service = detectService(url);

  if (service === 'vikingfile') {
    logger.warn('vikingfile.com uses Cloudflare Turnstile — automated download is blocked.');
    logger.info('Opening in your browser. Download manually from there.');
    logger.info(`URL: ${url}`);
    await open(url);
    return;
  }

  if (!service) {
    logger.error(`Unsupported URL: ${url}`);
    logger.info('Supported: 1fichier.com, datanodes.to, mediafire.com, vikingfile.com');
    return;
  }

  const downloadDir = options.out || process.env.DOWNLOAD_DIR || path.join(__dirname, '../../downloads');
  const spinner = ora('Starting download...').start();
  let downloadResult;

  try {
    if (service === 'datanodes') {
      downloadResult = await downloadFromDatanodes(url, downloadDir,
        (downloaded, total) => {
          const mb = (downloaded / 1024 / 1024).toFixed(1);
          if (total > 0) {
            const pct = Math.floor((downloaded / total) * 100);
            const totalMb = (total / 1024 / 1024).toFixed(1);
            spinner.text = `Downloading ${mb} / ${totalMb} MB (${pct}%)`;
          } else {
            spinner.text = `Downloading ${mb} MB...`;
          }
        },
        (status) => { spinner.text = status; }
      );
    } else if (service === 'mediafire') {
      const { downloadFromMediafire } = require('../services/mediafireDownloader');
      downloadResult = await downloadFromMediafire(url, downloadDir,
        (downloaded, total) => {
          const mb = (downloaded / 1024 / 1024).toFixed(1);
          if (total > 0) {
            const pct = Math.floor((downloaded / total) * 100);
            const totalMb = (total / 1024 / 1024).toFixed(1);
            spinner.text = `Downloading ${mb} / ${totalMb} MB (${pct}%)`;
          } else {
            spinner.text = `Downloading ${mb} MB...`;
          }
        },
        (status) => { spinner.text = status; }
      );
    } else {
      downloadResult = await download1fichier(url, downloadDir, (progress) => {
        spinner.text = `Downloading ${progress.percent}% (${progress.receivedMB}MB / ${progress.totalMB}MB)`;
      });
    }

    if (downloadResult.skipped) {
      spinner.succeed(chalk.green(`Already downloaded: ${downloadResult.filename}`));
    } else {
      const sizeMb = (downloadResult.size / 1024 / 1024).toFixed(1);
      spinner.succeed(chalk.green(`Downloaded: ${downloadResult.filename} (${sizeMb} MB)`));
    }
  } catch (err) {
    spinner.fail(`Download failed: ${err.message}`);
    return;
  }

  // Post-process: inspect archive, remove password, rename to standard format, register
  const hostName = service === 'datanodes' ? 'Datanodes' : (service === 'mediafire' ? 'Mediafire' : '1fichier');
  const downloadedFiles = [{ filename: downloadResult.filename, type: 'GAME' }];

  try {
    const { finalTitle, finalPpsa, finalVer } = await processDownloadedFiles({
      downloadedFiles,
      downloadDir,
      password: options.password || '',
      hostName,
      region: 'Direct URL',
      initialTitle: path.basename(downloadResult.filename, path.extname(downloadResult.filename)),
      initialPpsa: 'Unknown'
    });
    logger.success(`Done: ${finalTitle} [${finalPpsa}] ${finalVer}`);
  } catch (err) {
    if (err.isUserError) {
      logger.error(err.message);
    } else {
      logger.error(`Post-processing failed: ${err.message}`);
    }
  }
}

module.exports = urldownCommand;
