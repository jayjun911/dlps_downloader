const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../utils/logger'); // used by flattenFolderToEboot

const BIN_DIR = path.join(__dirname, '../../bin');
const BZ_EXE_PATH = 'C:\\Program Files\\Bandizip\\bz.exe';

function sanitizeFileName(name) {
  let cleanName = name
    .replace(/[®™©]/g, '')
    .replace(/\((c|tm|r)\)/gi, '')
    .replace(/:/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleanName.replace(/[\\/*?"<>|]/g, '_').trim();
}

function findParamJson(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      const found = findParamJson(fullPath);
      if (found) return found;
    } else if (file.toLowerCase() === 'param.json') {
      return fullPath;
    }
  }
  return null;
}

function requireBz() {
  if (!fs.existsSync(BZ_EXE_PATH)) {
    throw new Error(`Bandizip (bz.exe) not found at: ${BZ_EXE_PATH}`);
  }
  return BZ_EXE_PATH;
}

const PASSWORD_FALLBACKS = ['www.DLPSGAME.COM', 'DLPSGAME.COM', 'www.dlpsgame.com', 'dlpsgame.com'];

function buildCandidates(password) {
  const candidates = password ? [password] : [];
  for (const fb of PASSWORD_FALLBACKS) {
    if (!candidates.includes(fb)) candidates.push(fb);
  }
  return candidates;
}

/**
 * Returns true if the archive contains a .exfat file (fast listing, no extraction).
 */
function archiveContainsExfat(archivePath) {
  try {
    const output = execSync(`"${BZ_EXE_PATH}" l "${archivePath}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore']
    });
    return output.toLowerCase().includes('.exfat');
  } catch (e) {
    return false;
  }
}

/**
 * Checks if an archive is password protected.
 */
async function isArchiveEncrypted(filePath) {
  const bz = requireBz();
  try {
    execSync(`"${bz}" t -y "${filePath}"`, { stdio: 'ignore' });
    return false;
  } catch (e) {
    return true;
  }
}

/**
 * Extracts any archive (RAR/ZIP/7z) to a destination directory using Bandizip.
 */
async function extractRarArchive(rarFilePath, destFolder, password, { skipEbootFlatten = false } = {}) {
  const bz = requireBz();

  if (!fs.existsSync(destFolder)) {
    fs.mkdirSync(destFolder, { recursive: true });
  }

  const pwd = password ? `-p:${password}` : '';
  const cmd = `"${bz}" x -y ${pwd} -o:"${destFolder}" "${rarFilePath}"`.replace(/\s+/g, ' ').trim();
  execSync(cmd, { stdio: 'ignore' });

  if (!skipEbootFlatten) {
    try {
      flattenFolderToEboot(destFolder);
    } catch (err) {
      logger.warn(`Failed to flatten folder structure to eboot.bin: ${err.message}`);
    }
  }
}

/**
 * Lists an archive with optional password and returns the internal path of param.json, or null.
 */
function findParamPathInArchive(bz, archivePath, pwd) {
  const pwdFlag = pwd ? `-p:${pwd}` : '';
  try {
    const output = execSync(
      `"${bz}" l ${pwdFlag} "${archivePath}"`.replace(/\s+/g, ' ').trim(),
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    // bz l rows: "YYYY-MM-DD HH:MM:SS Attr Size CompSize Name"
    // Size/CompSize are plain integers; the Name (which may contain spaces or
    // backslashes) is everything after the CompSize column.
    const rowRe = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+\d+\s+\d+\s+(.+)$/;
    for (const line of output.split(/\r?\n/)) {
      const m = line.match(rowRe);
      if (!m) continue;
      const name = m[1].trim();
      if (name && path.basename(name).toLowerCase() === 'param.json') {
        return name;
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Extracts param.json from an archive and parses game metadata.
 */
async function getGameInfoFromArchive(rarFilePath, password) {
  const bz = requireBz();
  const tempDir = path.join(BIN_DIR, 'temp_param_' + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });

  const candidates = buildCandidates(password);

  // Step 1: find param.json's exact internal path via listing
  let paramInternalPath = findParamPathInArchive(bz, rarFilePath, '');
  let workingPassword = '';
  let encryptedFlag = false;

  if (!paramInternalPath) {
    // Listing failed — archive may be encrypted; try each password candidate
    encryptedFlag = true;
    for (const cand of candidates) {
      paramInternalPath = findParamPathInArchive(bz, rarFilePath, cand);
      if (paramInternalPath) {
        workingPassword = cand;
        break;
      }
    }
  }

  // Step 2: build list of paths to try, from most specific to broadest
  const pathsToTry = paramInternalPath
    ? [paramInternalPath, 'sce_sys/param.json', 'sce_sys\\param.json', '*param.json']
    : ['sce_sys/param.json', 'sce_sys\\param.json', '*param.json'];

  const testCandidates = encryptedFlag ? (workingPassword ? [workingPassword] : candidates) : ['', ...candidates];

  let success = false;

  outer:
  for (const cand of testCandidates) {
    const pwd = cand ? `-p:${cand}` : '';
    for (const target of pathsToTry) {
      for (const cmd of ['e', 'x']) {
        try {
          execSync(
            `"${bz}" ${cmd} -y ${pwd} -o:"${tempDir}" "${rarFilePath}" "${target}"`.replace(/\s+/g, ' ').trim(),
            { stdio: 'ignore' }
          );
          if (findParamJson(tempDir)) {
            workingPassword = cand;
            encryptedFlag = !!cand;
            success = true;
            break outer;
          }
        } catch (e) { /* try next */ }
      }
    }
  }

  if (!success) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    throw new Error('Failed to extract param.json from archive (incorrect password or corrupted archive).');
  }

  const paramPath = findParamJson(tempDir);
  if (!paramPath) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
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
    if (!titleName) titleName = 'Unknown';

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}

    return {
      titleName: sanitizeFileName(titleName),
      titleId,
      version: version.startsWith('v') ? version : `v${version}`,
      encrypted: encryptedFlag,
      workingPassword
    };
  } catch (parseErr) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    throw new Error(`Failed to parse param.json: ${parseErr.message}`);
  }
}

/**
 * Finds the working password for an archive.
 * Returns empty string if the archive is not encrypted or no password works.
 */
async function findWorkingPassword(rarFilePath, passwordCandidates = []) {
  const bz = requireBz();
  const candidates = buildCandidates(passwordCandidates[0] || '');
  for (const c of passwordCandidates.slice(1)) {
    if (!candidates.includes(c)) candidates.unshift(c);
  }

  try {
    execSync(`"${bz}" t -y "${rarFilePath}"`, { stdio: 'ignore' });
    return '';
  } catch (e) {}

  for (const cand of candidates) {
    try {
      execSync(`"${bz}" t -y -p:${cand} "${rarFilePath}"`, { stdio: 'ignore' });
      return cand;
    } catch (e) { /* try next */ }
  }

  return '';
}

function findEbootDir(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const file of fs.readdirSync(dir)) {
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

function flattenFolderToEboot(destFolder) {
  const ebootDir = findEbootDir(destFolder);
  if (!ebootDir) {
    logger.warn(`eboot.bin was not found in the extracted files of: ${destFolder}`);
    return;
  }

  if (path.resolve(ebootDir) === path.resolve(destFolder)) {
    logger.info(`eboot.bin is already at the root of ${destFolder}`);
    return;
  }

  logger.info(`Promoting folder containing eboot.bin to root: ${ebootDir}`);

  const relative = path.relative(destFolder, ebootDir);
  const topLevelName = relative.split(/[\\/]/)[0];
  const topLevelPath = path.join(destFolder, topLevelName);

  for (const item of fs.readdirSync(ebootDir)) {
    const srcPath = path.join(ebootDir, item);
    const destPath = path.join(destFolder, item);
    if (path.resolve(srcPath) === path.resolve(topLevelPath)) continue;
    fs.renameSync(srcPath, destPath);
  }

  fs.rmSync(topLevelPath, { recursive: true, force: true });
  logger.success(`Successfully flattened folder structure for: ${destFolder}`);
}

async function compressFolderTo7z(folderPath, dest7zPath) {
  const bz = requireBz();
  const tmpPath = dest7zPath.replace(/\.7z$/i, '.compressing');
  const cmd = `"${bz}" a -r -fmt:7z -l:5 -y "${tmpPath}" "${folderPath}\\*"`;
  execSync(cmd, { stdio: 'ignore' });
  fs.renameSync(tmpPath, dest7zPath);
}

async function compressFileTo7z(filePath, dest7zPath) {
  const bz = requireBz();
  const tmpPath = dest7zPath.replace(/\.7z$/i, '.compressing');
  const cmd = `"${bz}" a -fmt:7z -l:5 -y "${tmpPath}" "${filePath}"`;
  execSync(cmd, { stdio: 'ignore' });
  fs.renameSync(tmpPath, dest7zPath);
}

module.exports = {
  archiveContainsExfat,
  isArchiveEncrypted,
  extractRarArchive,
  getGameInfoFromArchive,
  compressFolderTo7z,
  compressFileTo7z,
  findWorkingPassword,
  sanitizeFileName
};
