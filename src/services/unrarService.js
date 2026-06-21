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
const RAR_EXE_PATH = path.join(BIN_DIR, 'Rar.exe');

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

function get7zExtractorPath() {
  // 1. Check if 7z.exe is in PATH
  try {
    const where7z = execSync('where 7z', { stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
    if (where7z && fs.existsSync(where7z)) return { path: where7z, type: '7z' };
  } catch (e) {}

  // 2. Check if winrar.exe is in PATH
  try {
    const whereWinrar = execSync('where winrar', { stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
    if (whereWinrar && fs.existsSync(whereWinrar)) return { path: whereWinrar, type: 'winrar' };
  } catch (e) {}

  // 3. Check common installation paths
  const common7z = 'C:\\Program Files\\7-Zip\\7z.exe';
  if (fs.existsSync(common7z)) return { path: common7z, type: '7z' };

  const commonWinrar = 'C:\\Program Files\\WinRAR\\WinRAR.exe';
  if (fs.existsSync(commonWinrar)) return { path: commonWinrar, type: 'winrar' };

  const common7z86 = 'C:\\Program Files (x86)\\7-Zip\\7z.exe';
  if (fs.existsSync(common7z86)) return { path: common7z86, type: '7z' };

  return null;
}

/**
 * Checks if a RAR/ZIP/7z file is password protected by testing it without a password.
 * 
 * @param {string} rarFilePath Path to the RAR archive
 * @returns {Promise<boolean>} True if password protected, false otherwise
 */
async function isArchiveEncrypted(rarFilePath) {
  const isZip = rarFilePath.toLowerCase().endsWith('.zip');
  const is7z = rarFilePath.toLowerCase().endsWith('.7z');
  if (isZip) {
    try {
      const env = { ...process.env, ARCHIVE_PATH: rarFilePath };
      const psCmd = `powershell -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead($env:ARCHIVE_PATH); $zip.Dispose();"`;
      execSync(psCmd, { env, stdio: 'ignore' });
      return false;
    } catch (e) {
      return true;
    }
  }

  if (is7z) {
    const extTool = get7zExtractorPath();
    if (!extTool) return false;
    if (extTool.type === '7z') {
      try {
        execSync(`"${extTool.path}" t -y -p- "${rarFilePath}"`, { stdio: 'ignore' });
        return false;
      } catch (e) {
        return true;
      }
    } else if (extTool.type === 'winrar') {
      try {
        execSync(`"${extTool.path}" t -ibck -y -p- "${rarFilePath}"`, { stdio: 'ignore' });
        return false;
      } catch (e) {
        return true;
      }
    }
  }

  const unrarPath = await downloadUnrarIfNeeded();
  
  // Try to list files bare without a password (to check if headers are encrypted)
  let firstFile = '';
  try {
    const listOutput = execSync(`"${unrarPath}" lb -y -p- "${rarFilePath}"`, { stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf-8' });
    const lines = listOutput.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const fileLines = lines.filter(l => !l.endsWith('/') && !l.endsWith('\\') && l.includes('.'));
    if (fileLines.length > 0) {
      firstFile = fileLines[0];
    } else if (lines.length > 0) {
      firstFile = lines[0];
    }
  } catch (err) {
    // If listing fails, headers are encrypted -> password protected
    return true; 
  }

  if (firstFile) {
    try {
      // Test only the first file to check if file data is encrypted
      // Replace [ and ] with ? to avoid UnRAR interpreting them as wildcard character classes
      const cleanFile = firstFile.replace(/\[/g, '?').replace(/\]/g, '?');
      execSync(`"${unrarPath}" t -y -p- "${rarFilePath}" "${cleanFile}"`, { stdio: 'ignore' });
      return false; // Successful test of first file without password -> not encrypted
    } catch (err) {
      return true; // Test failed -> file data is encrypted
    }
  }

  return false;
}

/**
 * Extracts a RAR, ZIP or 7z archive to a destination directory.
 * 
 * @param {string} rarFilePath First part of the archive (.part1.rar, .rar, .zip, or .7z)
 * @param {string} destFolder Output directory for extraction
 * @param {string} password Archive password
 * @returns {Promise<void>}
 */
async function extractRarArchive(rarFilePath, destFolder, password, { skipEbootFlatten = false } = {}) {
  const isZip = rarFilePath.toLowerCase().endsWith('.zip');
  const is7z = rarFilePath.toLowerCase().endsWith('.7z');

  if (!fs.existsSync(destFolder)) {
    fs.mkdirSync(destFolder, { recursive: true });
  }

  if (isZip) {
    let extracted = false;
    if (password && fs.existsSync(RAR_EXE_PATH)) {
      try {
        const cmd = `"${RAR_EXE_PATH}" x -y -p"${password}" "${rarFilePath}" "${destFolder}\\"`;
        logger.info(`Executing Rar.exe for password-protected ZIP: ${cmd}`);
        execSync(cmd, { stdio: 'inherit' });
        extracted = true;
      } catch (err) {
        logger.warn(`Failed to extract password-protected ZIP using Rar.exe: ${err.message}`);
      }
    }

    if (!extracted) {
      const env = { ...process.env, ARCHIVE_PATH: rarFilePath, DEST_DIR: destFolder };
      const cmd = `powershell -Command "Expand-Archive -Path $env:ARCHIVE_PATH -DestinationPath $env:DEST_DIR -Force"`;
      logger.info(`Executing PowerShell Expand-Archive: ${cmd}`);
      execSync(cmd, { env, stdio: 'inherit' });
    }
  } else if (is7z) {
    const extTool = get7zExtractorPath();
    if (!extTool) {
      throw new Error('No 7-Zip or WinRAR installation found to extract .7z archive.');
    }
    const pwdArg = password ? `-p"${password}"` : '-p-';
    if (extTool.type === '7z') {
      const cmd = `"${extTool.path}" x -y ${pwdArg} -o"${destFolder}" "${rarFilePath}"`;
      logger.info(`Executing 7z: ${cmd}`);
      execSync(cmd, { stdio: 'inherit' });
    } else if (extTool.type === 'winrar') {
      const cmd = `"${extTool.path}" x -ibck -y ${pwdArg} "${rarFilePath}" "${destFolder}\\"`;
      logger.info(`Executing WinRAR: ${cmd}`);
      execSync(cmd, { stdio: 'inherit' });
    }
  } else {
    const unrarPath = await downloadUnrarIfNeeded();
    const pwdArg = password ? `-p"${password}"` : '-p-';
    const cmd = `"${unrarPath}" x -y ${pwdArg} "${rarFilePath}" "${destFolder}\\"`;
    logger.info(`Executing unrar: "${unrarPath}" x -y [pwd] "${rarFilePath}" "${destFolder}"`);
    execSync(cmd, { stdio: 'inherit' });
  }

  if (!skipEbootFlatten) {
    try {
      flattenFolderToEboot(destFolder);
    } catch (err) {
      logger.warn(`Failed to flatten folder structure to eboot.bin: ${err.message}`);
    }
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
    .replace(/:/g, ' - ') // Convert colon to hyphen with spaces
    .replace(/\s+/g, ' ') // Collapse double spaces if any
    .trim();

  return cleanName.replace(/[\\/*?"<>|]/g, '_').trim();
}

/**
 * Extracts param.json from archive and parses game metadata. Also detects encryption.
 * 
 * @param {string} rarFilePath 
 * @param {string} password 
 * @returns {Promise<{ titleName: string, titleId: string, version: string, encrypted: boolean, workingPassword: string }>}
 */
async function getGameInfoFromArchive(rarFilePath, password) {
  const isZip = rarFilePath.toLowerCase().endsWith('.zip');
  const is7z = rarFilePath.toLowerCase().endsWith('.7z');
  const tempDir = path.join(BIN_DIR, 'temp_param_' + Date.now());

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  let encrypted = false;
  let success = false;
  let workingPassword = '';

  if (isZip) {
    // Try 1: Extract *param.json from ZIP using PowerShell
    try {
      const paramJsonTempPath = path.join(tempDir, 'param.json');
      const env = { ...process.env, ARCHIVE_PATH: rarFilePath, OUT_PATH: paramJsonTempPath };
      const psCmd = `powershell -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead($env:ARCHIVE_PATH); $entry = $zip.Entries | Where-Object { $_.FullName -like '*param.json' } | Select-Object -First 1; if ($entry) { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $env:OUT_PATH, $true); }; $zip.Dispose();"`;
      execSync(psCmd, { env, stdio: 'ignore' });
      if (fs.existsSync(paramJsonTempPath)) {
        success = true;
      }
    } catch (err) {
      // Try 2: Extract *param.json using Rar.exe (if password protected)
      encrypted = true;
      if (fs.existsSync(RAR_EXE_PATH)) {
        const candidates = [];
        if (password) candidates.push(password);
        const fallbacks = ['www.DLPSGAME.COM', 'DLPSGAME.COM', 'www.dlpsgame.com', 'dlpsgame.com'];
        for (const fb of fallbacks) {
          if (!candidates.includes(fb)) candidates.push(fb);
        }
        for (const cand of candidates) {
          try {
            execSync(`"${RAR_EXE_PATH}" x -y -p"${cand}" "${rarFilePath}" "*param.json" "${tempDir}\\"`, { stdio: 'ignore' });
            success = true;
            workingPassword = cand;
            break;
          } catch (pwdErr) {
            // Try next password
          }
        }
      }
    }
  } else if (is7z) {
    const extTool = get7zExtractorPath();
    if (extTool) {
      const candidates = [];
      if (password) candidates.push(password);
      const fallbacks = ['www.DLPSGAME.COM', 'DLPSGAME.COM', 'www.dlpsgame.com', 'dlpsgame.com'];
      for (const fb of fallbacks) {
        if (!candidates.includes(fb)) candidates.push(fb);
      }

      encrypted = await isArchiveEncrypted(rarFilePath);
      const testCandidates = encrypted ? candidates : ['', ...candidates];

      for (const cand of testCandidates) {
        try {
          if (extTool.type === '7z') {
            const pwdArg = cand ? `-p"${cand}"` : '-p-';
            execSync(`"${extTool.path}" e -y ${pwdArg} -o"${tempDir}" "${rarFilePath}" "*param.json"`, { stdio: 'ignore' });
          } else if (extTool.type === 'winrar') {
            const pwdArg = cand ? `-p"${cand}"` : '-p-';
            execSync(`"${extTool.path}" e -ibck -y ${pwdArg} "${rarFilePath}" "*param.json" "${tempDir}\\"`, { stdio: 'ignore' });
          }
          if (findParamJson(tempDir)) {
            success = true;
            workingPassword = cand;
            encrypted = !!cand;
            break;
          }
        } catch (e) {}
      }
    }
  } else {
    const unrarPath = await downloadUnrarIfNeeded();

    // Step 1: List archive contents to find param.json's exact internal path.
    // UnRAR's * wildcard does not cross path separators, so "*param.json" fails to match
    // "sce_sys\param.json". We must find the exact path via lb then use "e" to extract it.
    const parseLbOutput = (out) => (out || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

    let fileList = [];
    try {
      fileList = parseLbOutput(execSync(`"${unrarPath}" lb -y -p- "${rarFilePath}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }));
    } catch (err) {
      // lb exits non-zero on warnings even when listing succeeds — use stdout if available
      fileList = parseLbOutput(err.stdout);
      if (fileList.length === 0) encrypted = true;
    }

    const candidates = [];
    if (password) candidates.push(password);
    const fallbacks = ['www.DLPSGAME.COM', 'DLPSGAME.COM', 'www.dlpsgame.com', 'dlpsgame.com'];
    for (const fb of fallbacks) {
      if (!candidates.includes(fb)) candidates.push(fb);
    }

    // If listing failed (headers encrypted), try with each candidate password
    if (encrypted && fileList.length === 0) {
      for (const cand of candidates) {
        try {
          fileList = parseLbOutput(execSync(`"${unrarPath}" lb -y -p"${cand}" "${rarFilePath}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }));
          if (fileList.length > 0) break;
        } catch (e) {
          fileList = parseLbOutput(e.stdout);
          if (fileList.length > 0) break;
        }
      }
    }

    // Find param.json's exact path inside the archive (match by filename only)
    const paramJsonInternal = fileList.find(l => path.basename(l).toLowerCase() === 'param.json');
    // Step 2: Extract param.json using "e" (flat extract — no path issues).
    // Try without password first, then each candidate.
    const extractCandidates = encrypted ? candidates : ['', ...candidates];
    for (const cand of extractCandidates) {
      const pwdArg = cand ? `-p"${cand}"` : '-p-';
      try {
        if (paramJsonInternal) {
          execSync(`"${unrarPath}" e -y ${pwdArg} "${rarFilePath}" "${paramJsonInternal}" "${tempDir}\\"`, { stdio: 'ignore' });
        } else {
          // Fallback if lb couldn't find param.json (unusual structure)
          execSync(`"${unrarPath}" x -y ${pwdArg} "${rarFilePath}" "*param.json" "${tempDir}\\"`, { stdio: 'ignore' });
        }
        if (findParamJson(tempDir)) {
          success = true;
          encrypted = !!cand;
          workingPassword = cand;
          break;
        }
        logger.warn(`[getGameInfo] pwd="${cand||'(none)'}" — extracted but param.json not in ${tempDir}`);
      } catch (err) {
        logger.warn(`[getGameInfo] pwd="${cand||'(none)'}" — extraction threw: ${err.message}`);
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

/**
 * Finds the working password for an archive from a list of candidates.
 * Returns empty string if the archive is not encrypted or if no password works.
 * 
 * @param {string} rarFilePath 
 * @param {Array<string>} passwordCandidates 
 * @returns {Promise<string>}
 */
async function findWorkingPassword(rarFilePath, passwordCandidates = []) {
  const isZip = rarFilePath.toLowerCase().endsWith('.zip');
  const is7z = rarFilePath.toLowerCase().endsWith('.7z');
  const candidates = [...passwordCandidates];
  const fallbacks = ['www.DLPSGAME.COM', 'DLPSGAME.COM', 'www.dlpsgame.com', 'dlpsgame.com'];
  for (const fb of fallbacks) {
    if (!candidates.includes(fb)) candidates.push(fb);
  }

  if (isZip) {
    if (fs.existsSync(RAR_EXE_PATH)) {
      for (const cand of candidates) {
        try {
          execSync(`"${RAR_EXE_PATH}" t -y -p"${cand}" "${rarFilePath}"`, { stdio: 'ignore' });
          return cand;
        } catch (e) {
          // ignore and try next
        }
      }
    }
    return '';
  }

  if (is7z) {
    const extTool = get7zExtractorPath();
    if (!extTool) return '';
    if (extTool.type === '7z') {
      try {
        execSync(`"${extTool.path}" t -y -p- "${rarFilePath}"`, { stdio: 'ignore' });
        return ''; // Succeeded with no password
      } catch (e) {}
      for (const cand of candidates) {
        try {
          execSync(`"${extTool.path}" t -y -p"${cand}" "${rarFilePath}"`, { stdio: 'ignore' });
          return cand;
        } catch (e) {}
      }
    } else if (extTool.type === 'winrar') {
      try {
        execSync(`"${extTool.path}" t -ibck -y -p- "${rarFilePath}"`, { stdio: 'ignore' });
        return '';
      } catch (e) {}
      for (const cand of candidates) {
        try {
          execSync(`"${extTool.path}" t -ibck -y -p"${cand}" "${rarFilePath}"`, { stdio: 'ignore' });
          return cand;
        } catch (e) {}
      }
    }
    return '';
  }

  const unrarPath = await downloadUnrarIfNeeded();

  // Step 1: List files without password to detect header encryption and find a test file.
  // Using "e" + exact file path avoids the * wildcard / path-separator issue in "t" / "x".
  const parseLbOut = (out) => (out || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

  let headersEncrypted = false;
  let fileList = [];
  try {
    fileList = parseLbOut(execSync(`"${unrarPath}" lb -y -p- "${rarFilePath}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }));
  } catch (err) {
    fileList = parseLbOut(err.stdout);
    if (fileList.length === 0) headersEncrypted = true;
  }

  // Prefer param.json (small) as test file; fall back to first regular file
  const testFile = fileList.find(l => path.basename(l).toLowerCase() === 'param.json')
    || fileList.find(l => !l.endsWith('/') && !l.endsWith('\\') && l.includes('.'))
    || fileList[0]
    || '';

  // Header-encrypted: a correct password lets lb list the archive
  if (headersEncrypted) {
    for (const cand of candidates) {
      try {
        const out = parseLbOut(execSync(`"${unrarPath}" lb -y -p"${cand}" "${rarFilePath}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }));
        if (out.length > 0) return cand;
      } catch (e) {
        if (parseLbOut(e.stdout).length > 0) return cand;
      }
    }
    return '';
  }

  // Data-encrypted (headers readable): verify by trying to extract the test file
  if (testFile) {
    const tempTestDir = path.join(BIN_DIR, 'temp_pwdtest_' + Date.now());
    try {
      fs.mkdirSync(tempTestDir, { recursive: true });

      // No password needed?
      try {
        execSync(`"${unrarPath}" e -y -p- "${rarFilePath}" "${testFile}" "${tempTestDir}\\"`, { stdio: 'ignore' });
        if (fs.readdirSync(tempTestDir).length > 0) return ''; // Not encrypted
      } catch (e) { /* data is encrypted */ }

      // Try each candidate
      for (const cand of candidates) {
        try {
          fs.readdirSync(tempTestDir).forEach(f => { try { fs.unlinkSync(path.join(tempTestDir, f)); } catch (e) {} });
          execSync(`"${unrarPath}" e -y -p"${cand}" "${rarFilePath}" "${testFile}" "${tempTestDir}\\"`, { stdio: 'ignore' });
          if (fs.readdirSync(tempTestDir).length > 0) return cand;
        } catch (e) { /* wrong password */ }
      }
    } finally {
      try { fs.rmSync(tempTestDir, { recursive: true, force: true }); } catch (e) {}
    }
  }

  return ''; // None worked
}

const BZ_EXE_PATH = 'C:\\Program Files\\Bandizip\\bz.exe';

/**
 * Compresses a folder to a 7z archive using Bandizip.
 *
 * @param {string} folderPath The folder containing files to compress
 * @param {string} dest7zPath The output 7z file path
 * @returns {Promise<void>}
 */
async function compressFolderTo7z(folderPath, dest7zPath) {
  if (!fs.existsSync(BZ_EXE_PATH)) {
    throw new Error(`Bandizip (bz.exe) not found at: ${BZ_EXE_PATH}`);
  }

  const cmd = `"${BZ_EXE_PATH}" a -r -fmt:7z -l:5 -y "${dest7zPath}" "${folderPath}\\*"`;
  logger.info(`Executing Bandizip: bz a -r -fmt:7z -l:5 -y "${path.basename(dest7zPath)}" "${path.basename(folderPath)}\\*"`);
  execSync(cmd, { stdio: 'inherit' });
}

/**
 * Compresses a single file to a 7z archive using Bandizip.
 *
 * @param {string} filePath Path to the file to compress
 * @param {string} dest7zPath Output 7z path
 * @returns {Promise<void>}
 */
async function compressFileTo7z(filePath, dest7zPath) {
  if (!fs.existsSync(BZ_EXE_PATH)) {
    throw new Error(`Bandizip (bz.exe) not found at: ${BZ_EXE_PATH}`);
  }

  const cmd = `"${BZ_EXE_PATH}" a -fmt:7z -l:5 -y "${dest7zPath}" "${filePath}"`;
  logger.info(`Executing Bandizip: bz a -fmt:7z -l:5 -y "${path.basename(dest7zPath)}" "${path.basename(filePath)}"`);
  execSync(cmd, { stdio: 'inherit' });
}

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

/**
 * Compresses a single file into a RAR archive.
 *
 * @param {string} filePath Path to the file to compress
 * @param {string} destRarPath Output RAR path
 * @returns {Promise<void>}
 */
async function compressFileToRar(filePath, destRarPath) {
  if (!fs.existsSync(RAR_EXE_PATH)) {
    throw new Error(`Rar.exe was not found in the bin directory at: ${RAR_EXE_PATH}`);
  }

  // -ep: store only filename (no leading path), -y: yes to all
  const cmd = `"${RAR_EXE_PATH}" a -ep -y "${destRarPath}" "${filePath}"`;
  logger.info(`Compressing file to RAR: "${filePath}" -> "${destRarPath}"`);
  execSync(cmd, { stdio: 'inherit' });
}

module.exports = {
  downloadUnrarIfNeeded,
  isArchiveEncrypted,
  extractRarArchive,
  getGameInfoFromArchive,
  compressFolderTo7z,
  compressFileTo7z,
  compressFolderToRar,
  compressFileToRar,
  findWorkingPassword,
  sanitizeFileName
};
