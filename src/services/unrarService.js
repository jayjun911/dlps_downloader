const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { deriveVersionFromParam, deriveTitleNameFromParam } = require('../utils/versionParser');

const BIN_DIR = path.join(__dirname, '../../bin');
const BZ_EXE_PATH = 'C:\\Program Files\\Bandizip\\bz.exe';

// `bz l` prints one row per archived entry. Games with thousands of files (e.g.
// per-animation assets) produce listings well over execSync's 1 MB default
// maxBuffer; overflowing throws ENOBUFS, which the listing helpers catch and
// silently treat as "listing failed", derailing param.json discovery. Give the
// listing calls plenty of headroom.
const LIST_MAXBUFFER = 256 * 1024 * 1024;

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

const PASSWORD_FALLBACKS = [
  'www.DLPSGAME.COM', 'DLPSGAME.COM', 'www.dlpsgame.com', 'dlpsgame.com', '[DLPSGAME.COM]',
  'www.DLPGAME.COM', 'DLPGAME.COM', '[DLPGAME.COM]', 'www.dlpgame.com', 'dlpgame.com'
];

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
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: LIST_MAXBUFFER
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
async function extractRarArchive(rarFilePath, destFolder, password, onProgress) {
  const bz = requireBz();

  if (!fs.existsSync(destFolder)) {
    fs.mkdirSync(destFolder, { recursive: true });
  }

  const args = ['x', '-y'];
  if (password) args.push(`-p:${password}`);
  args.push(`-o:${destFolder}`);
  args.push(rarFilePath);

  return new Promise((resolve, reject) => {
    const child = spawn(bz, args, { shell: false });
    
    let stderrOut = '';
    
    child.stdout.on('data', (data) => {
      if (onProgress) {
        const text = data.toString().trim();
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.includes('Extracting')) {
            onProgress(line.trim());
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      stderrOut += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`bz extraction failed: ${stderrOut.trim() || 'Code ' + code}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Lists an archive with optional password and returns the internal path of param.json, or null.
 */
function findParamPathInArchive(bz, archivePath, pwd) {
  const pwdFlag = pwd ? `-p:${pwd}` : '';
  try {
    const output = execSync(
      `"${bz}" l ${pwdFlag} "${archivePath}"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: LIST_MAXBUFFER }
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
            `"${bz}" ${cmd} -y ${pwd} -o:"${tempDir}" "${rarFilePath}" "${target}"`,
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
    const version = deriveVersionFromParam(param);

    let titleName = deriveTitleNameFromParam(param);
    if (!titleName) titleName = 'Unknown';

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}

    return {
      titleName: sanitizeFileName(titleName),
      titleId,
      version,
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

// Returns the shallowest directory under `root` that directly contains an
// eboot.bin (case-insensitive), or null if none is found. Read-only — it never
// moves, deletes, or otherwise touches the tree; it only reports a path. Handing
// that path to the compressor strips meaningless wrapper folders above the game
// while keeping everything at and below the game's top level intact (encrypted
// files, the decrypted/ subfolder, etc.). Breadth-first so the topmost eboot
// wins, never a deeper duplicate.
function findShallowestEbootDir(root) {
  if (!fs.existsSync(root)) return null;
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { continue; }
    const subDirs = [];
    for (const ent of entries) {
      if (ent.isDirectory()) {
        subDirs.push(path.join(dir, ent.name));
      } else if (ent.name.toLowerCase() === 'eboot.bin') {
        return dir; // shallowest match wins
      }
    }
    queue.push(...subDirs);
  }
  return null;
}

async function compressFolderTo7z(folderPath, dest7zPath, onProgress) {
  const bz = requireBz();
  const tmpPath = dest7zPath.replace(/\.7z$/i, '.compressing');
  const args = ['a', '-r', '-fmt:7z', '-l:5', '-y', tmpPath, `${folderPath}\\*`];
  
  return new Promise((resolve, reject) => {
    const child = spawn(bz, args, { shell: false });
    let stderrOut = '';

    child.stdout.on('data', (data) => {
      if (onProgress) {
        const text = data.toString().trim();
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.includes('Compressing')) {
            onProgress(line.trim());
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      stderrOut += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`bz compression failed: ${stderrOut.trim() || 'Code ' + code}`));
      } else {
        try { fs.renameSync(tmpPath, dest7zPath); } catch (e) {}
        resolve();
      }
    });
  });
}

async function compressFileTo7z(filePath, dest7zPath, onProgress) {
  const bz = requireBz();
  const tmpPath = dest7zPath.replace(/\.7z$/i, '.compressing');
  const args = ['a', '-fmt:7z', '-l:5', '-y', tmpPath, filePath];
  
  return new Promise((resolve, reject) => {
    const child = spawn(bz, args, { shell: false });
    let stderrOut = '';

    child.stdout.on('data', (data) => {
      if (onProgress) {
        const text = data.toString().trim();
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.includes('Compressing')) {
            onProgress(line.trim());
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      stderrOut += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`bz compression failed: ${stderrOut.trim() || 'Code ' + code}`));
      } else {
        try { fs.renameSync(tmpPath, dest7zPath); } catch (e) {}
        resolve();
      }
    });
  });
}

module.exports = {
  archiveContainsExfat,
  isArchiveEncrypted,
  extractRarArchive,
  getGameInfoFromArchive,
  compressFolderTo7z,
  compressFileTo7z,
  findShallowestEbootDir,
  findWorkingPassword,
  sanitizeFileName
};
