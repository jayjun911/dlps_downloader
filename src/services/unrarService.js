const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execSync } = require('child_process');
const ora = require('ora');
const logger = require('../utils/logger');

const BIN_DIR = path.join(__dirname, '../../bin');
const UNRAR_EXE_PATH = path.join(BIN_DIR, 'UnRAR.exe'); // Actual CLI executable
const SETUP_EXE_PATH = path.join(BIN_DIR, 'unrar_setup.exe');
const DOWNLOAD_URL = 'https://www.rarlab.com/rar/unrarw64.exe';

/**
 * Downloads the official standalone unrarw64.exe from RARLab,
 * extracts the actual command-line UnRAR.exe silently, and cleans up the installer.
 */
async function downloadUnrarIfNeeded() {
  // Check if actual CLI executable already exists
  if (fs.existsSync(UNRAR_EXE_PATH)) {
    return UNRAR_EXE_PATH;
  }

  // Delete the old unrar.exe installer if it exists in the bin folder
  const oldInstallerPath = path.join(BIN_DIR, 'unrar.exe');
  if (fs.existsSync(oldInstallerPath)) {
    try {
      fs.unlinkSync(oldInstallerPath);
    } catch (e) {
      // ignore unlink error
    }
  }

  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  const spinner = ora('Downloading official UnRAR installer from RARLab...').start();
  try {
    const response = await axios({
      method: 'get',
      url: DOWNLOAD_URL,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    // Write the setup installer
    fs.writeFileSync(SETUP_EXE_PATH, response.data);
    spinner.text = 'Extracting UnRAR CLI utility silently...';

    // Run installer silently (-s), assume yes on all queries (-y), and extract to bin folder (-d"bin")
    execSync(`"${SETUP_EXE_PATH}" -s -y -d"${BIN_DIR}"`, { stdio: 'ignore' });

    // Clean up setup installer
    try {
      fs.unlinkSync(SETUP_EXE_PATH);
    } catch (e) {
      // ignore cleanup error
    }

    // Verify extraction succeeded
    if (fs.existsSync(UNRAR_EXE_PATH)) {
      spinner.succeed('Successfully set up UnRAR command-line utility.');
      return UNRAR_EXE_PATH;
    }

    // Check lowercase file just in case
    const lowercasePath = path.join(BIN_DIR, 'unrar.exe');
    if (fs.existsSync(lowercasePath)) {
      fs.renameSync(lowercasePath, UNRAR_EXE_PATH);
      spinner.succeed('Successfully set up UnRAR command-line utility.');
      return UNRAR_EXE_PATH;
    }

    // Otherwise list bin and look for it case-insensitively
    const files = fs.readdirSync(BIN_DIR);
    const unrarFile = files.find(f => f.toLowerCase() === 'unrar.exe');
    if (unrarFile) {
      const foundPath = path.join(BIN_DIR, unrarFile);
      if (foundPath !== UNRAR_EXE_PATH) {
        fs.renameSync(foundPath, UNRAR_EXE_PATH);
      }
      spinner.succeed('Successfully set up UnRAR command-line utility.');
      return UNRAR_EXE_PATH;
    }

    throw new Error('UnRAR.exe was not found in the extracted directory.');
  } catch (err) {
    spinner.fail(`Failed to set up UnRAR utility: ${err.message}`);
    throw new Error(`Could not set up UnRAR utility. Please download manually and place at: ${UNRAR_EXE_PATH}`);
  }
}

/**
 * Checks if a RAR file is password protected by testing it without a password.
 * 
 * @param {string} rarFilePath Path to the RAR archive
 * @returns {Promise<boolean>} True if password protected, false otherwise
 */
async function isArchiveEncrypted(rarFilePath) {
  const unrarPath = await downloadUnrarIfNeeded();
  try {
    // Run test command with empty/no password (-p-)
    // If it requires a password, it will exit with code 3 (or throw error)
    execSync(`"${unrarPath}" t -p- "${rarFilePath}"`, { stdio: 'ignore' });
    return false; // Successful test with no password means it is NOT encrypted
  } catch (err) {
    // Failure typically means password required or headers locked
    return true; 
  }
}

/**
 * Extracts a RAR archive to a destination directory.
 * 
 * @param {string} rarFilePath First part of the RAR archive (.part1.rar or .rar)
 * @param {string} destFolder Output directory for extraction
 * @param {string} password Archive password
 * @returns {Promise<void>}
 */
async function extractRarArchive(rarFilePath, destFolder, password) {
  const unrarPath = await downloadUnrarIfNeeded();

  if (!fs.existsSync(destFolder)) {
    fs.mkdirSync(destFolder, { recursive: true });
  }

  const pwdArg = password ? `-p"${password}"` : '-p-';
  // 'x' extracts with full paths, '-y' assumes Yes on queries (overwrite)
  const cmd = `"${unrarPath}" x -y ${pwdArg} "${rarFilePath}" "${destFolder}\\"`;

  logger.info(`Executing unrar: "${unrarPath}" x -y [pwd] "${rarFilePath}" "${destFolder}"`);
  
  execSync(cmd, { stdio: 'inherit' });

  // Automatically flatten the folder structure so that the folder containing eboot.bin is at the root
  try {
    flattenFolderToEboot(destFolder);
  } catch (err) {
    logger.warn(`Failed to flatten folder structure to eboot.bin: ${err.message}`);
  }
}

/**
 * Searches recursively for a folder containing 'eboot.bin' (case-insensitive).
 */
function findEbootDir(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const found = findEbootDir(fullPath);
      if (found) return found;
    } else if (file.toLowerCase() === 'eboot.bin') {
      return dir;
    }
  }
  return null;
}

/**
 * Flattens the extracted folder structure so that the folder containing eboot.bin is promoted to the root.
 */
function flattenFolderToEboot(destFolder) {
  const ebootDir = findEbootDir(destFolder);
  if (!ebootDir) {
    logger.warn(`eboot.bin was not found in the extracted files of: ${destFolder}`);
    return;
  }

  // If eboot.bin is already in the root destFolder, no flattening is needed
  if (path.resolve(ebootDir) === path.resolve(destFolder)) {
    logger.info(`eboot.bin is already at the root of ${destFolder}`);
    return;
  }

  logger.info(`Promoting folder containing eboot.bin to root: ${ebootDir}`);

  // Find the top-level child of destFolder that we need to delete later
  const relative = path.relative(destFolder, ebootDir);
  const topLevelName = relative.split(/[\\/]/)[0];
  const topLevelPath = path.join(destFolder, topLevelName);

  // Move all contents of ebootDir directly to destFolder
  const items = fs.readdirSync(ebootDir);
  for (const item of items) {
    const srcPath = path.join(ebootDir, item);
    const destPath = path.join(destFolder, item);
    
    // Skip if it's the top level parent folder we are moving from (safety check)
    if (path.resolve(srcPath) === path.resolve(topLevelPath)) {
      continue;
    }
    
    fs.renameSync(srcPath, destPath);
  }

  // Delete the old nested structure (which is now empty)
  fs.rmSync(topLevelPath, { recursive: true, force: true });
  logger.success(`Successfully flattened folder structure for: ${destFolder}`);
}

/**
 * Helper recursively searching for param.json inside a directory.
 */
function findParamJson(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const found = findParamJson(fullPath);
      if (found) return found;
    } else if (file.toLowerCase() === 'param.json') {
      return fullPath;
    }
  }
  return null;
}

/**
 * Sanitizes a title name so that it is safe to use as a Windows file/folder name.
 */
function sanitizeFileName(name) {
  // Remove special symbols like ®, ™, © and text patterns like (c), (tm), (r) case-insensitively
  let cleanName = name
    .replace(/[®™©]/g, '')
    .replace(/\((c|tm|r)\)/gi, '')
    .replace(/\s+/g, ' ') // Collapse double spaces if any
    .trim();

  return cleanName.replace(/[\\/:*?"<>|]/g, '_').trim();
}

/**
 * Extracts param.json from archive and parses game metadata. Also detects encryption.
 * 
 * @param {string} rarFilePath 
 * @param {string} password 
 * @returns {Promise<{ titleName: string, titleId: string, version: string, encrypted: boolean, workingPassword: string }>}
 */
async function getGameInfoFromArchive(rarFilePath, password) {
  const unrarPath = await downloadUnrarIfNeeded();
  const tempDir = path.join(BIN_DIR, 'temp_param_' + Date.now());

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  let encrypted = false;
  let success = false;
  let workingPassword = '';

  // Try 1: Extract *param.json without a password
  try {
    execSync(`"${unrarPath}" x -y -p- "${rarFilePath}" "*param.json" "${tempDir}\\"`, { stdio: 'ignore' });
    success = true;
  } catch (err) {
    // Try 2: Extract *param.json with password candidate list
    encrypted = true;
    const candidates = [];
    if (password) {
      candidates.push(password);
    }
    const fallbacks = ['DLPSGAME.COM', 'dlpsgame.com'];
    for (const fb of fallbacks) {
      if (!candidates.includes(fb)) {
        candidates.push(fb);
      }
    }

    for (const cand of candidates) {
      try {
        execSync(`"${unrarPath}" x -y -p"${cand}" "${rarFilePath}" "*param.json" "${tempDir}\\"`, { stdio: 'ignore' });
        success = true;
        workingPassword = cand;
        break; // Successfully extracted using this password!
      } catch (pwdErr) {
        // Try next candidate
      }
    }
  }

  if (!success) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
    throw new Error('Failed to extract param.json from archive (incorrect password or corrupted archive).');
  }

  const paramPath = findParamJson(tempDir);
  if (!paramPath) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
    throw new Error('param.json was not found inside the archive structure.');
  }

  try {
    const content = fs.readFileSync(paramPath, 'utf-8');
    const param = JSON.parse(content);

    const titleId = param.titleId || 'Unknown';
    const version = param.masterVersion || '1.00';

    let titleName = '';
    if (param.localizedParameters) {
      const defaultLang = param.localizedParameters.defaultLanguage || 'en-US';
      if (param.localizedParameters[defaultLang]) {
        titleName = param.localizedParameters[defaultLang].titleName;
      }
      if (!titleName) {
        for (const key of Object.keys(param.localizedParameters)) {
          if (param.localizedParameters[key] && param.localizedParameters[key].titleName) {
            titleName = param.localizedParameters[key].titleName;
            break;
          }
        }
      }
    }

    if (!titleName) {
      titleName = 'Unknown';
    }

    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}

    return {
      titleName: sanitizeFileName(titleName),
      titleId,
      version: version.startsWith('v') ? version : `v${version}`,
      encrypted,
      workingPassword
    };
  } catch (parseErr) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
    throw new Error(`Failed to parse param.json: ${parseErr.message}`);
  }
}

const RAR_EXE_PATH = path.join(BIN_DIR, 'Rar.exe');

/**
 * Compresses a folder back to a RAR archive.
 * 
 * @param {string} folderPath The folder containing files to compress
 * @param {string} destRarPath The output RAR file path
 * @returns {Promise<void>}
 */
async function compressFolderToRar(folderPath, destRarPath) {
  if (!fs.existsSync(RAR_EXE_PATH)) {
    throw new Error(`Rar.exe was not found in the bin directory at: ${RAR_EXE_PATH}`);
  }

  // 'a' adds to archive, '-r' recurses, '-ep1' excludes base folder, '-y' answers Yes
  const cmd = `"${RAR_EXE_PATH}" a -r -ep1 -y "${destRarPath}" "${folderPath}\\"`;
  
  logger.info(`Executing rar: "${RAR_EXE_PATH}" a -r -ep1 -y "${destRarPath}" "${folderPath}"`);
  
  execSync(cmd, { stdio: 'inherit' });
}

module.exports = {
  downloadUnrarIfNeeded,
  isArchiveEncrypted,
  extractRarArchive,
  getGameInfoFromArchive,
  compressFolderToRar
};
