const path = require('path');
const fs = require('fs');
const ora = require('ora');
const { archiveContainsExfat, extractRarArchive, getGameInfoFromArchive, compressFolderTo7z, compressFileTo7z, findWorkingPassword, sanitizeFileName } = require('../services/unrarService');
const { addDownloadedGame } = require('../services/downloadedDb');
const logger = require('./logger');

// ── File-type helpers ──────────────────────────────────────────────────────────

function isArchiveFile(file) {
  const lower = file.toLowerCase();
  return lower.endsWith('.rar') || lower.endsWith('.zip') || lower.endsWith('.7z') ||
         /\.r\d{2}$/.test(lower) || /\.z\d{2}$/.test(lower);
}

function checkIsSplitArchive(archiveFiles) {
  if (archiveFiles.length <= 1) return false;
  for (const file of archiveFiles) {
    const lower = file.toLowerCase();
    if (lower.match(/\.part[0-9]+\.(rar|zip|7z|r\d{2}|z\d{2})$/) ||
        /\.r\d{2}$/.test(lower) || /\.z\d{2}$/.test(lower)) return true;
  }
  return false;
}

function findMainArchiveFile(archiveFiles) {
  if (archiveFiles.length === 0) return null;
  const candidate = archiveFiles.find(name => {
    const lower = name.toLowerCase();
    return (lower.endsWith('.rar') && !lower.match(/\.part[2-9]\d*\.rar$/) && !lower.match(/\.part0[2-9]\d*\.rar$/)) ||
           (lower.endsWith('.zip') && !lower.match(/\.part[2-9]\d*\.zip$/) && !lower.match(/\.part0[2-9]\d*\.zip$/)) ||
           (lower.endsWith('.7z')  && !lower.match(/\.part[2-9]\d*\.7z$/)  && !lower.match(/\.part0[2-9]\d*\.7z$/))  ||
           lower.includes('part1.rar') || lower.includes('part01.rar') ||
           lower.includes('part1.zip') || lower.includes('part01.zip') ||
           lower.includes('part1.7z')  || lower.includes('part01.7z');
  });
  return candidate || archiveFiles[0];
}

function getUniqueFilePath(dir, baseName, ext, currentFilePath = null) {
  let filePath = path.join(dir, `${baseName}${ext}`);
  if (!fs.existsSync(filePath)) return filePath;
  if (currentFilePath && path.resolve(filePath) === path.resolve(currentFilePath)) return filePath;
  let counter = 1;
  while (fs.existsSync(path.join(dir, `${baseName}_${counter}${ext}`))) {
    const checkPath = path.join(dir, `${baseName}_${counter}${ext}`);
    if (currentFilePath && path.resolve(checkPath) === path.resolve(currentFilePath)) return checkPath;
    counter++;
  }
  return path.join(dir, `${baseName}_${counter}${ext}`);
}

// ── exFAT helpers ─────────────────────────────────────────────────────────────

function findExfatInFolder(folderPath) {
  try {
    for (const entry of fs.readdirSync(folderPath)) {
      const full = path.join(folderPath, entry);
      if (entry.toLowerCase().endsWith('.exfat')) return full;
      try {
        if (fs.statSync(full).isDirectory()) {
          const found = findExfatInFolder(full);
          if (found) return found;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return null;
}

/**
 * Handles exFAT-region GAME archives:
 *   - Detects encryption, extracts archive to temp folder
 *   - Mounts the .exfat inside, validates via chkdsk, reads param.json
 *   - If encrypted:     compress extracted .exfat → .7z, delete archives + temp
 *   - If not encrypted: delete temp, rename original archive to standard name
 *
 * Returns { registeredFile: {fileName, type}, metadata: {titleId, titleName, version} }
 */
async function processExfatArchive({ archiveSet, type, downloadDir, password, initialTitle, initialPpsa, initialVer }) {
  const mainFileName = findMainArchiveFile(archiveSet);
  if (!mainFileName) return {};
  const mainFilePath = path.join(downloadDir, mainFileName);

  // 1. Detect working password
  const pwdSpinner = ora(`[${type}] Checking encryption...`).start();
  let workingPassword = '';
  try {
    workingPassword = await findWorkingPassword(mainFilePath, password ? [password] : []);
  } catch (e) { /* no password needed */ }
  const encrypted = workingPassword !== '';
  if (encrypted) {
    pwdSpinner.succeed(`[${type}] Encrypted — password found`);
  } else {
    pwdSpinner.succeed(`[${type}] Not encrypted`);
  }

  // 2. Extract archive to a named folder beside the source file
  const tempFolder = path.join(downloadDir, path.basename(mainFileName, path.extname(mainFileName)));
  const extractSpinner = ora(`[${type}] Extracting exFAT archive${encrypted ? ' (encrypted)' : ''}...`).start();
  try {
    await extractRarArchive(mainFilePath, tempFolder, workingPassword, { skipEbootFlatten: true });
    if (!fs.existsSync(tempFolder) || fs.readdirSync(tempFolder).length === 0) {
      throw new Error('Extraction output is empty');
    }
    extractSpinner.succeed(`[${type}] Extracted`);
  } catch (extErr) {
    extractSpinner.fail(`[${type}] Extraction failed: ${extErr.message}`);
    if (fs.existsSync(tempFolder)) fs.rmSync(tempFolder, { recursive: true, force: true });
    throw extErr;
  }

  // 3. Find .exfat in extracted output
  const exfatPath = findExfatInFolder(tempFolder);
  if (!exfatPath) {
    fs.rmSync(tempFolder, { recursive: true, force: true });
    throw new Error(`No .exfat file found inside extracted archive "${mainFileName}"`);
  }

  // 4. Mount → chkdsk + param.json
  const { mountValidateAndExtractParam } = require('../services/osfmountService');
  const mountSpinner = ora(`[${type}] Mounting exFAT for validation and metadata...`).start();
  let metadata = null;

  try {
    const result = await mountValidateAndExtractParam(exfatPath, (s) => {
      mountSpinner.text = `[${type}] ${s}`;
    });
    metadata = result.metadata;

    if (result.skipped) {
      mountSpinner.warn(`[${type}] OSFMount not available — skipped validation`);
    } else if (!result.valid) {
      mountSpinner.fail(`[${type}] exFAT validation failed: ${result.message}`);
      fs.rmSync(tempFolder, { recursive: true, force: true });
      const err = new Error('exFAT validation failed: filesystem errors detected');
      err.isExfatValidationError = true;
      throw err;
    } else {
      const metaStr = metadata
        ? `${metadata.titleName} [${metadata.titleId}] ${metadata.version}`
        : '(no param.json)';
      mountSpinner.succeed(`[${type}] Validated — ${metaStr}`);
    }
  } catch (mountErr) {
    if (mountErr.isExfatValidationError) throw mountErr;
    mountSpinner.warn(`[${type}] Validation error (continuing): ${mountErr.message}`);
  }

  // 5. Compute final names from param.json (fall back to initial values)
  const realTitle = (metadata && metadata.titleName) || initialTitle;
  const realPpsa  = (metadata && metadata.titleId)   || initialPpsa;
  const realVer   = (metadata && metadata.version)   || initialVer;
  const baseName  = `${sanitizeFileName(realTitle)} [${realPpsa}][${realVer}]`;

  let registeredFile;

  if (encrypted) {
    // 6a. Encrypted: rename extracted .exfat → compress to .7z → cleanup
    const renamedExfat = path.join(tempFolder, `${baseName}.exfat`);
    if (path.resolve(exfatPath) !== path.resolve(renamedExfat)) {
      fs.renameSync(exfatPath, renamedExfat);
    }

    const dest7zPath = path.join(downloadDir, `${baseName}.7z`);
    const compressSpinner = ora(`[${type}] Compressing to ${baseName}.7z...`).start();
    try {
      await compressFileTo7z(renamedExfat, dest7zPath);
      if (!fs.existsSync(dest7zPath) || fs.statSync(dest7zPath).size === 0) {
        throw new Error('Output 7z is empty');
      }
      compressSpinner.succeed(`[${type}] Compressed: ${baseName}.7z`);
      registeredFile = { fileName: `${baseName}.7z`, type };
    } catch (compErr) {
      compressSpinner.fail(`[${type}] Compression failed: ${compErr.message}`);
      fs.rmSync(tempFolder, { recursive: true, force: true });
      throw compErr;
    }

    // Delete original archives
    for (const f of archiveSet) {
      try { fs.unlinkSync(path.join(downloadDir, f)); } catch (e) {}
    }
    // Delete temp folder (contains the renamed .exfat)
    try { fs.rmSync(tempFolder, { recursive: true, force: true }); } catch (e) {}

  } else {
    // 6b. Not encrypted: delete temp, rename original archive to standard name
    try { fs.rmSync(tempFolder, { recursive: true, force: true }); } catch (e) {}

    const origExt     = path.extname(mainFileName).toLowerCase();
    const newFileName = `${baseName}${origExt}`;
    try {
      fs.renameSync(mainFilePath, path.join(downloadDir, newFileName));
      logger.success(`[${type}] Renamed: ${newFileName}`);
      registeredFile = { fileName: newFileName, type };
    } catch (renameErr) {
      logger.warn(`[${type}] Rename failed: ${renameErr.message}`);
      registeredFile = { fileName: mainFileName, type };
    }
  }

  return { registeredFile, metadata };
}

/**
 * Handles a raw .exfat file in an exFAT-region GAME download:
 *   - Mounts → chkdsk + param.json
 *   - Renames .exfat to standard name using real metadata
 *   - Compresses to .7z (source .exfat deleted after)
 *
 * Returns { registeredFile, metadata }
 */
async function processRawExfat({ filename, type, downloadDir, initialTitle, initialPpsa, initialVer }) {
  const currentPath = path.join(downloadDir, filename);
  const { mountValidateAndExtractParam } = require('../services/osfmountService');

  const mountSpinner = ora(`[${type}] Mounting exFAT "${filename}" for validation and metadata...`).start();
  let metadata = null;

  try {
    const result = await mountValidateAndExtractParam(currentPath, (s) => {
      mountSpinner.text = `[${type}] ${s}`;
    });
    metadata = result.metadata;

    if (result.skipped) {
      mountSpinner.warn(`[${type}] OSFMount not available — skipped validation`);
    } else if (!result.valid) {
      mountSpinner.fail(`[${type}] exFAT validation failed: ${result.message}`);
      const err = new Error('exFAT validation failed: filesystem errors detected');
      err.isExfatValidationError = true;
      throw err;
    } else {
      const metaStr = metadata
        ? `${metadata.titleName} [${metadata.titleId}] ${metadata.version}`
        : '(no param.json)';
      mountSpinner.succeed(`[${type}] Validated — ${metaStr}`);
    }
  } catch (mountErr) {
    if (mountErr.isExfatValidationError) throw mountErr;
    mountSpinner.warn(`[${type}] Validation error (continuing): ${mountErr.message}`);
  }

  // Compute final names
  const realTitle = (metadata && metadata.titleName) || initialTitle;
  const realPpsa  = (metadata && metadata.titleId)   || initialPpsa;
  const realVer   = (metadata && metadata.version)   || initialVer;
  const baseName  = `${sanitizeFileName(realTitle)} [${realPpsa}][${realVer}]`;

  // Rename .exfat to standard name
  const renamedPath = getUniqueFilePath(downloadDir, baseName, '.exfat', currentPath);
  try {
    if (path.resolve(currentPath) !== path.resolve(renamedPath)) {
      fs.renameSync(currentPath, renamedPath);
    }
  } catch (e) {
    logger.warn(`[${type}] Rename failed: ${e.message}`);
  }

  // Compress to .7z
  const dest7zPath = path.join(downloadDir, `${baseName}.7z`);
  const compressSpinner = ora(`[${type}] Compressing to ${baseName}.7z...`).start();
  try {
    await compressFileTo7z(renamedPath, dest7zPath);
    if (!fs.existsSync(dest7zPath) || fs.statSync(dest7zPath).size === 0) {
      throw new Error('Output 7z is empty');
    }
    compressSpinner.succeed(`[${type}] Compressed: ${baseName}.7z`);
    return { registeredFile: { fileName: `${baseName}.7z`, type }, metadata };
  } catch (compErr) {
    compressSpinner.fail(`[${type}] Compression failed: ${compErr.message}. Keeping .exfat.`);
    return { registeredFile: { fileName: path.basename(renamedPath), type }, metadata };
  }
}

// ── Main post-processor ────────────────────────────────────────────────────────

/**
 * Post-processes downloaded files:
 *   1. Reads param.json for real title / PPSA / version
 *   2. Removes passwords / unpacks splits, recompresses clean
 *   3. Renames to standard `Title [PPSA][vXX.XX]` format
 *   4. Registers in downloaded.xml
 *
 * For exFAT-region GAME files, uses OSFMount to mount the .exfat image,
 * validate via chkdsk, and extract param.json for real metadata.
 */
async function processDownloadedFiles({
  downloadedFiles,
  downloadDir,
  password = '',
  hostName = 'Unknown',
  region = 'Unknown',
  initialTitle = 'Unknown Game',
  initialPpsa = 'Unknown'
}) {
  let finalTitle = initialTitle;
  let finalPpsa  = initialPpsa;
  let finalVer   = 'v01.00';

  let isExfatRegion = (region || '').toUpperCase().includes('EXFAT');

  // Group files by type
  const fileGroups = {};
  for (const fileItem of downloadedFiles) {
    const type = fileItem.type || 'GAME';
    const filePath = path.join(downloadDir, fileItem.filename);
    if (!fs.existsSync(filePath)) continue;
    if (!fileGroups[type]) fileGroups[type] = [];
    fileGroups[type].push(fileItem.filename);
  }

  // Auto-detect exFAT: if a GAME archive contains a .exfat file inside, treat as exFAT region
  if (!isExfatRegion) {
    const gameArchives = (fileGroups['GAME'] || []).filter(isArchiveFile);
    if (gameArchives.length > 0) {
      const mainArchive = findMainArchiveFile(gameArchives);
      if (mainArchive) {
        const detectSpinner = ora(`Checking archive contents...`).start();
        const hasExfat = archiveContainsExfat(path.join(downloadDir, mainArchive));
        if (hasExfat) {
          isExfatRegion = true;
          detectSpinner.succeed(`Detected exFAT image inside archive — switching to exFAT pipeline`);
        } else {
          detectSpinner.stop();
        }
      }
    }
  }

  // For non-exFAT regions, read metadata from the GAME archive before processing
  if (!isExfatRegion) {
    const gameArchives = (fileGroups['GAME'] || []).filter(isArchiveFile);
    if (gameArchives.length > 0) {
      const mainFilePath = path.join(downloadDir, findMainArchiveFile(gameArchives));
      const checkSpinner = ora(`Inspecting "${path.basename(mainFilePath)}" internally...`).start();
      try {
        const gameInfo = await getGameInfoFromArchive(mainFilePath, password);
        finalPpsa  = gameInfo.titleId;
        finalVer   = gameInfo.version;
        finalTitle = gameInfo.titleName;
        checkSpinner.succeed(`Read metadata: ${finalTitle} [${finalPpsa}] ${finalVer}`);
      } catch (err) {
        checkSpinner.warn(`Failed to read param.json: ${err.message}. Using fallback metadata.`);
      }
    }
  }

  const registeredFiles = [];

  // ── Generic archive processor (non-exFAT path) ────────────────────────────
  const processArchiveSet = async (archiveSet, groupType, baseNameLabel) => {
    const mainFileName = findMainArchiveFile(archiveSet);
    if (!mainFileName) return;
    const mainFilePath = path.join(downloadDir, mainFileName);

    let workingPassword = '';
    try {
      workingPassword = await findWorkingPassword(mainFilePath, password ? [password] : []);
    } catch (e) { /* ignore */ }

    const isSplit    = checkIsSplitArchive(archiveSet);
    const encrypted  = workingPassword !== '';

    if (encrypted || isSplit) {
      const extractSpinner = ora(`[${groupType}] Extracting "${mainFileName}" (encrypted/split)...`).start();
      const outputFolderPath = path.join(downloadDir, baseNameLabel);
      try {
        await extractRarArchive(mainFilePath, outputFolderPath, workingPassword);
        if (!fs.existsSync(outputFolderPath) || fs.readdirSync(outputFolderPath).length === 0) {
          throw new Error(`Extraction output folder is empty: ${outputFolderPath}`);
        }
        extractSpinner.succeed(`[${groupType}] Extracted to: ${baseNameLabel}`);

        const deleteSpinner = ora(`[${groupType}] Cleaning up downloaded archives...`).start();
        const basePattern = mainFileName.replace(/\.part[0-9]+\.(rar|zip|7z)$/i, '').replace(/\.(rar|zip|7z)$/i, '');
        for (const file of archiveSet) {
          if (file.toLowerCase().startsWith(basePattern.toLowerCase()) || file === mainFileName) {
            try { fs.unlinkSync(path.join(downloadDir, file)); } catch (e) { /* ignore */ }
          }
        }
        deleteSpinner.succeed(`[${groupType}] Cleaned up.`);

        const dest7zPath   = path.join(downloadDir, `${baseNameLabel}.7z`);
        const compressSpinner = ora(`[${groupType}] Recompressing to ${baseNameLabel}.7z...`).start();
        await compressFolderTo7z(outputFolderPath, dest7zPath);
        if (!fs.existsSync(dest7zPath) || fs.statSync(dest7zPath).size === 0) {
          throw new Error(`Recompressed 7z is empty: ${dest7zPath}`);
        }
        compressSpinner.succeed(`[${groupType}] Recompressed: ${baseNameLabel}.7z`);
        registeredFiles.push({ fileName: `${baseNameLabel}.7z`, type: groupType });

        try { fs.rmSync(outputFolderPath, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      } catch (extErr) {
        const isPasswordError = extErr.status === 11;
        const userMsg = isPasswordError
          ? (workingPassword ? `Incorrect archive password: "${workingPassword}".` : `Archive is password-protected. Try: --password <pwd>`)
          : extErr.message;
        extractSpinner.fail(`[${groupType}] ${userMsg}`);
        const cleanErr = new Error(userMsg);
        cleanErr.isUserError = true;
        throw cleanErr;
      }
    } else {
      const origExt     = path.extname(mainFileName).toLowerCase();
      const newFileName = `${baseNameLabel}${origExt}`;
      try {
        fs.renameSync(path.join(downloadDir, mainFileName), path.join(downloadDir, newFileName));
        logger.success(`[${groupType}] Renamed to: ${newFileName}`);
        registeredFiles.push({ fileName: newFileName, type: groupType });
      } catch (renameErr) {
        logger.warn(`[${groupType}] Rename failed: ${renameErr.message}`);
        registeredFiles.push({ fileName: mainFileName, type: groupType });
      }
    }
  };

  // ── Process each file type group ──────────────────────────────────────────
  for (const [type, files] of Object.entries(fileGroups)) {
    const archives   = files.filter(isArchiveFile);
    const extraFiles = files.filter(f => !isArchiveFile(f));
    const isGame     = type === 'GAME';

    // ── exFAT region GAME: dedicated pipeline ─────────────────────────────
    if (isGame && isExfatRegion) {
      if (archives.length > 0) {
        const { registeredFile, metadata } = await processExfatArchive({
          archiveSet: archives, type, downloadDir, password,
          initialTitle: finalTitle, initialPpsa: finalPpsa, initialVer: finalVer
        });
        if (metadata) {
          if (metadata.titleId)   finalPpsa  = metadata.titleId;
          if (metadata.titleName) finalTitle = metadata.titleName;
          if (metadata.version)   finalVer   = metadata.version;
        }
        if (registeredFile) registeredFiles.push(registeredFile);
      }

      const rawExfats = extraFiles.filter(f => f.toLowerCase().endsWith('.exfat'));
      for (const rawFile of rawExfats) {
        const { registeredFile, metadata } = await processRawExfat({
          filename: rawFile, type, downloadDir,
          initialTitle: finalTitle, initialPpsa: finalPpsa, initialVer: finalVer
        });
        if (metadata) {
          if (metadata.titleId)   finalPpsa  = metadata.titleId;
          if (metadata.titleName) finalTitle = metadata.titleName;
          if (metadata.version)   finalVer   = metadata.version;
        }
        if (registeredFile) registeredFiles.push(registeredFile);
      }

      continue; // skip generic processing for this group
    }

    // ── Standard processing ───────────────────────────────────────────────
    const baseName = isGame
      ? `${sanitizeFileName(finalTitle)} [${finalPpsa}][${finalVer}]`
      : `${sanitizeFileName(finalTitle)} [${finalPpsa}][${type}]`;

    if (archives.length > 0) {
      if (checkIsSplitArchive(archives) || isGame) {
        await processArchiveSet(archives, type, baseName);
      } else {
        for (let idx = 0; idx < archives.length; idx++) {
          const fileBaseName = archives.length > 1 ? `${baseName}_${idx + 1}` : baseName;
          await processArchiveSet([archives[idx]], type, fileBaseName);
        }
      }
    }

    for (const file of extraFiles) {
      const ext    = path.extname(file).toLowerCase();
      const isText = ['.txt', '.pdf', '.jpg', '.jpeg', '.png', '.md', '.htm', '.html'].includes(ext);

      if (isGame && !isText) {
        const dest7zPath     = path.join(downloadDir, `${baseName}.7z`);
        const compressSpinner = ora(`[${type}] Renaming and compressing "${file}" to 7z...`).start();
        const currentPath    = path.join(downloadDir, file);
        const renamedPath    = path.join(downloadDir, `${baseName}${ext}`);
        let actualRenamedPath = renamedPath;

        try {
          if (path.resolve(currentPath) !== path.resolve(renamedPath)) {
            actualRenamedPath = getUniqueFilePath(downloadDir, baseName, ext, currentPath);
            fs.renameSync(currentPath, actualRenamedPath);
          }

          // Non-exFAT-region raw .exfat: validate only (no metadata extraction needed here)
          if (ext === '.exfat') {
            const { validateExfat } = require('../services/osfmountService');
            compressSpinner.text = `[${type}] Validating exFAT filesystem...`;
            const { valid, message, skipped } = await validateExfat(actualRenamedPath, (s) => {
              compressSpinner.text = `[${type}] ${s}`;
            });
            if (skipped) {
              compressSpinner.text = `[${type}] Compressing "${path.basename(actualRenamedPath)}" to 7z...`;
            } else if (!valid) {
              const valErr = new Error(`exFAT validation failed: filesystem errors detected`);
              valErr.isExfatValidationError = true;
              throw valErr;
            } else {
              logger.success(`[${type}] exFAT validation passed`);
              compressSpinner.text = `[${type}] Compressing "${path.basename(actualRenamedPath)}" to 7z...`;
            }
          }

          await compressFileTo7z(actualRenamedPath, dest7zPath);
          if (!fs.existsSync(dest7zPath) || fs.statSync(dest7zPath).size === 0) {
            throw new Error('Output 7z is empty.');
          }
          compressSpinner.succeed(`[${type}] Renamed and compressed to: ${baseName}.7z`);
          registeredFiles.push({ fileName: `${baseName}.7z`, type });
        } catch (compErr) {
          if (compErr.isExfatValidationError) {
            compressSpinner.fail(`[${type}] exFAT validation failed — filesystem errors detected`);
            throw compErr;
          }
          compressSpinner.fail(`[${type}] Processing failed: ${compErr.message}. Keeping original file.`);
          registeredFiles.push({ fileName: path.basename(actualRenamedPath), type });
        }
      } else {
        const currentPath = path.join(downloadDir, file);
        const newPath     = getUniqueFilePath(downloadDir, baseName, ext, currentPath);
        const newFileName = path.basename(newPath);
        try {
          if (path.resolve(currentPath) !== path.resolve(newPath)) {
            fs.renameSync(currentPath, newPath);
            logger.info(`Renamed: ${file} → ${newFileName}`);
          }
          registeredFiles.push({ fileName: newFileName, type });
        } catch (renameErr) {
          logger.warn(`Rename failed for "${file}": ${renameErr.message}`);
          registeredFiles.push({ fileName: file, type });
        }
      }
    }
  }

  // ── Register in downloaded.xml ────────────────────────────────────────────
  const titleToRegister = (initialTitle && initialTitle !== 'Unknown Game') ? initialTitle : finalTitle;
  const gameToRegister  = registeredFiles.find(rf => rf.type === 'GAME');
  const otherToRegister = registeredFiles.filter(rf => rf.type !== 'GAME');

  if (gameToRegister) {
    addDownloadedGame({ title: titleToRegister, fileName: gameToRegister.fileName, ppsa: finalPpsa, password: '', source: hostName, region });
  } else if (otherToRegister.length > 0) {
    addDownloadedGame({ title: titleToRegister, fileName: otherToRegister[0].fileName, ppsa: finalPpsa, password: '', source: hostName, region });
  }

  return { registeredFiles, finalTitle, finalPpsa, finalVer };
}

module.exports = { processDownloadedFiles, getUniqueFilePath, isArchiveFile, checkIsSplitArchive, findMainArchiveFile };
