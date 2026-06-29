const BasePlatform = require('./BasePlatform');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs');
const ora = require('ora');

const { 
  archiveContainsExfat, 
  extractRarArchive, 
  getGameInfoFromArchive, 
  compressFolderTo7z, 
  compressFileTo7z, 
  findShallowestEbootDir, 
  findWorkingPassword, 
  sanitizeFileName 
} = require('../services/unrarService');

const {
  isArchiveFile,
  checkIsSplitArchive,
  findMainArchiveFile,
  getUniqueFilePath,
  buildTypeTag,
  findFilesWithExt
} = require('../utils/postProcessor');

class PS5Platform extends BasePlatform {
  getName() {
    return 'PS5';
  }

  handleDownloadError(err, downloadedFiles, downloadDir, sectionRegion, downloadStarted) {
    const isExfatSection = (sectionRegion || '').toUpperCase().includes('EXFAT');

    if (err.isLinkDead) {
      if (isExfatSection && downloadStarted) {
        // Partial exFAT data was written before link died — rename and abort
        try {
          for (const f of fs.readdirSync(downloadDir)) {
            if (f.toLowerCase().endsWith('.exfat')) {
              const fp = path.join(downloadDir, f);
              const failedFp = fp.replace(/\.exfat$/i, '.failed');
              fs.renameSync(fp, failedFp);
              logger.warn(`Renamed failed exFAT: ${path.basename(failedFp)}`);
            }
          }
        } catch (e) {}
        const exfatErr = new Error(`exFAT download failed (region [${sectionRegion}]): ${err.message}`);
        exfatErr.isHandled = true;
        throw exfatErr;
      }
    } else if (isExfatSection && downloadStarted) {
      // exFAT download started but failed (non-link-dead error) — cleanup and abort
      try {
        for (const f of fs.readdirSync(downloadDir)) {
          if (f.toLowerCase().endsWith('.exfat')) {
            const fp = path.join(downloadDir, f);
            const failedFp = fp.replace(/\.exfat$/i, '.failed');
            fs.renameSync(fp, failedFp);
            logger.warn(`Renamed failed exFAT: ${path.basename(failedFp)}`);
          }
        }
      } catch (e) {}
      const exfatErr = new Error(`exFAT download failed (region [${sectionRegion}]): ${err.message}`);
      exfatErr.isHandled = true;
      throw exfatErr;
    }
  }

  cleanupPartialFiles(downloadedFiles, downloadDir, sectionRegion) {
    const isExfatSection = (sectionRegion || '').toUpperCase().includes('EXFAT');
    for (const fileItem of downloadedFiles) {
      const filePath = path.join(downloadDir, fileItem.filename);
      try {
        if (isExfatSection && fileItem.filename.toLowerCase().endsWith('.exfat')) {
          const failedPath = filePath.replace(/\.exfat$/i, '.failed');
          if (fs.existsSync(filePath)) {
            fs.renameSync(filePath, failedPath);
            logger.warn(`Renamed failed exFAT: ${path.basename(failedPath)}`);
          }
        } else {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }
      } catch (e) {
        // ignore cleanup error
      }
    }
  }

  async postProcess(params) {
    const { downloadedFiles, downloadDir, password, hostName, region, initialTitle, initialPpsa, initialVer } = params;
    
    let finalTitle = initialTitle;
    let finalPpsa  = initialPpsa;
    let finalVer   = initialVer || 'v01.00';
    let isExfatRegion = (region || '').toUpperCase().includes('EXFAT');
    
    const fileGroups = {};
    const groupBackportFw = {};
    for (const fileItem of downloadedFiles) {
      const type = fileItem.type || 'GAME';
      const filePath = path.join(downloadDir, fileItem.filename);
      if (!fs.existsSync(filePath)) continue;
      if (!fileGroups[type]) fileGroups[type] = [];
      fileGroups[type].push(fileItem.filename);
      if (fileItem.backportFw != null) groupBackportFw[type] = fileItem.backportFw;
    }

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

    let gameKnownPassword;
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
          gameKnownPassword = gameInfo.workingPassword || '';
          checkSpinner.succeed(`Read metadata: ${finalTitle} [${finalPpsa}] ${finalVer}`);
        } catch (err) {
          checkSpinner.warn(`Failed to read param.json: ${err.message}. Using fallback metadata.`);
        }
      }
    }

    const registeredFiles = [];

    // Generic archive processor specific to PS5 (always recompresses to .7z)
    const processArchiveSet = async (archiveSet, groupType, baseNameLabel, knownPassword) => {
      const mainFileName = findMainArchiveFile(archiveSet);
      if (!mainFileName) return;
      const mainFilePath = path.join(downloadDir, mainFileName);

      let workingPassword = '';
      if (knownPassword !== undefined) {
        workingPassword = knownPassword;
      } else {
        try {
          workingPassword = await findWorkingPassword(mainFilePath, password ? [password] : []);
        } catch (e) { /* ignore */ }
      }

      const isSplit    = checkIsSplitArchive(archiveSet);
      const encrypted  = workingPassword !== '';
      const forceExtract = encrypted || isSplit || groupType === 'DLC';

      if (forceExtract) {
        const extractSpinner = ora(`[${groupType}] Extracting "${mainFileName}"...`).start();
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

          if (groupType === 'DLC') {
            logger.success(`[${groupType}] Extracted DLC package(s) to folder: ${baseNameLabel}`);
            registeredFiles.push({ fileName: baseNameLabel, type: groupType });
          } else {
            const dest7zPath   = path.join(downloadDir, `${baseNameLabel}.7z`);
            const compressSpinner = ora(`[${groupType}] Recompressing to ${baseNameLabel}.7z...`).start();
            const compressRoot = findShallowestEbootDir(outputFolderPath) || outputFolderPath;
            await compressFolderTo7z(compressRoot, dest7zPath);
            if (!fs.existsSync(dest7zPath) || fs.statSync(dest7zPath).size === 0) {
              throw new Error(`Recompressed 7z is empty: ${dest7zPath}`);
            }
            compressSpinner.succeed(`[${groupType}] Recompressed: ${baseNameLabel}.7z`);
            registeredFiles.push({ fileName: `${baseNameLabel}.7z`, type: groupType });
            try { fs.rmSync(outputFolderPath, { recursive: true, force: true }); } catch (e) { /* ignore */ }
          }
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

    for (const type of Object.keys(fileGroups)) {
      if (type === 'INSTALL_GUIDE') {
        for (const file of fileGroups[type]) {
          registeredFiles.push({ fileName: file, type });
        }
        continue;
      }

      const files = fileGroups[type];
      const isGame = type === 'GAME';
      const archives = files.filter(isArchiveFile);
      const extraFiles = files.filter(f => !isArchiveFile(f));
      const ffpkgFiles = extraFiles.filter(f => f.toLowerCase().endsWith('.ffpkg'));

      if (isGame && ffpkgFiles.length > 0) {
        for (const ff of ffpkgFiles) {
          const { registeredFile, metadata } = await this.processFfpkg({
            filename: ff, type, downloadDir,
            initialTitle: finalTitle, initialPpsa: finalPpsa, initialVer: finalVer
          });
          if (metadata) {
            if (metadata.titleId)   finalPpsa  = metadata.titleId;
            if (metadata.titleName) finalTitle = metadata.titleName;
            if (metadata.version)   finalVer   = metadata.version;
          }
          if (registeredFile) registeredFiles.push(registeredFile);
        }
      }

      if (isGame && isExfatRegion) {
        if (archives.length > 0) {
          const { registeredFile, metadata } = await this.processExfatArchive({
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
          const { registeredFile, metadata } = await this.processRawExfat({
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
        continue;
      }

      const baseName = isGame
        ? `${sanitizeFileName(finalTitle)} [${finalPpsa}][${finalVer}]`
        : `${sanitizeFileName(finalTitle)} [${finalPpsa}][${buildTypeTag(type, groupBackportFw[type])}]`;

      if (archives.length > 0) {
        if (checkIsSplitArchive(archives) || isGame) {
          await processArchiveSet(archives, type, baseName, isGame ? gameKnownPassword : undefined);
        } else {
          for (let idx = 0; idx < archives.length; idx++) {
            const fileBaseName = archives.length > 1 ? `${baseName}_${idx + 1}` : baseName;
            await processArchiveSet([archives[idx]], type, fileBaseName);
          }
        }
      }

      for (const file of extraFiles) {
        if (file.toLowerCase().endsWith('.ffpkg')) continue; // handled above

        const ext    = path.extname(file).toLowerCase();
        const isText = ['.txt', '.pdf', '.jpg', '.jpeg', '.png', '.md', '.htm', '.html'].includes(ext);
        const isPkg  = ext === '.pkg';

        if (isGame && !isText && !isPkg) {
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
          let targetDir = downloadDir;
          let finalFileName = null;
          
          if (type === 'DLC') {
            targetDir = path.join(downloadDir, baseName);
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
            const uniquePath = getUniqueFilePath(targetDir, path.parse(file).name, ext, currentPath);
            finalFileName = path.basename(uniquePath);
          } else {
            const uniquePath = getUniqueFilePath(targetDir, baseName, ext, currentPath);
            finalFileName = path.basename(uniquePath);
          }
          
          const newPath = path.join(targetDir, finalFileName);
          
          try {
            if (path.resolve(currentPath) !== path.resolve(newPath)) {
              fs.renameSync(currentPath, newPath);
              logger.info(`Moved/Renamed: ${file} → ${type === 'DLC' ? baseName + '/' : ''}${finalFileName}`);
            }
            if (type === 'DLC') {
              if (!registeredFiles.find(r => r.fileName === baseName && r.type === type)) {
                registeredFiles.push({ fileName: baseName, type });
              }
            } else {
              registeredFiles.push({ fileName: finalFileName, type });
            }
          } catch (renameErr) {
            logger.warn(`Rename failed for "${file}": ${renameErr.message}`);
            registeredFiles.push({ fileName: file, type });
          }
        }
      }
    }
    
    return registeredFiles;
  }

  // --- Internals ---
  
  findExfatInFolder(folderPath) {
    try {
      for (const entry of fs.readdirSync(folderPath)) {
        const full = path.join(folderPath, entry);
        if (entry.toLowerCase().endsWith('.exfat')) return full;
        try {
          if (fs.statSync(full).isDirectory()) {
            const found = this.findExfatInFolder(full);
            if (found) return found;
          }
        } catch (e) {}
      }
    } catch (e) {}
    return null;
  }

  async processExfatArchive({ archiveSet, type, downloadDir, password, initialTitle, initialPpsa, initialVer }) {
    const mainFileName = findMainArchiveFile(archiveSet);
    if (!mainFileName) return {};
    const mainFilePath = path.join(downloadDir, mainFileName);

    const pwdSpinner = ora(`[${type}] Checking encryption...`).start();
    let workingPassword = '';
    try {
      workingPassword = await findWorkingPassword(mainFilePath, password ? [password] : []);
    } catch (e) { }
    const encrypted = workingPassword !== '';
    if (encrypted) pwdSpinner.succeed(`[${type}] Encrypted — password found`);
    else pwdSpinner.succeed(`[${type}] Not encrypted`);

    const tempFolder = path.join(downloadDir, path.basename(mainFileName, path.extname(mainFileName)));
    const extractSpinner = ora(`[${type}] Extracting exFAT archive${encrypted ? ' (encrypted)' : ''}...`).start();
    try {
      await extractRarArchive(mainFilePath, tempFolder, workingPassword);
      if (!fs.existsSync(tempFolder) || fs.readdirSync(tempFolder).length === 0) {
        throw new Error('Extraction output is empty');
      }
      extractSpinner.succeed(`[${type}] Extracted`);
    } catch (extErr) {
      extractSpinner.fail(`[${type}] Extraction failed: ${extErr.message}`);
      if (fs.existsSync(tempFolder)) fs.rmSync(tempFolder, { recursive: true, force: true });
      throw extErr;
    }

    const exfatPath = this.findExfatInFolder(tempFolder);
    if (!exfatPath) {
      fs.rmSync(tempFolder, { recursive: true, force: true });
      throw new Error(`No .exfat file found inside extracted archive "${mainFileName}"`);
    }

    const { mountValidateAndExtractParam } = require('../services/osfmountService');
    const mountSpinner = ora(`[${type}] Mounting exFAT for validation and metadata...`).start();
    let metadata = null;

    try {
      const result = await mountValidateAndExtractParam(exfatPath, (s) => { mountSpinner.text = `[${type}] ${s}`; });
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
        const metaStr = metadata ? `${metadata.titleName} [${metadata.titleId}] ${metadata.version}` : '(no param.json)';
        mountSpinner.succeed(`[${type}] Validated — ${metaStr}`);
      }
    } catch (mountErr) {
      if (mountErr.isExfatValidationError) throw mountErr;
      mountSpinner.warn(`[${type}] Validation error (continuing): ${mountErr.message}`);
    }

    const realTitle = (metadata && metadata.titleName) || initialTitle;
    const realPpsa  = (metadata && metadata.titleId)   || initialPpsa;
    const realVer   = (metadata && metadata.version)   || initialVer;
    const baseName  = `${sanitizeFileName(realTitle)} [${realPpsa}][${realVer}]`;

    let registeredFile;
    if (encrypted) {
      const renamedExfat = path.join(tempFolder, `${baseName}.exfat`);
      if (path.resolve(exfatPath) !== path.resolve(renamedExfat)) fs.renameSync(exfatPath, renamedExfat);

      const dest7zPath = path.join(downloadDir, `${baseName}.7z`);
      const compressSpinner = ora(`[${type}] Compressing to ${baseName}.7z...`).start();
      try {
        await compressFileTo7z(renamedExfat, dest7zPath);
        if (!fs.existsSync(dest7zPath) || fs.statSync(dest7zPath).size === 0) throw new Error('Output 7z is empty');
        compressSpinner.succeed(`[${type}] Compressed: ${baseName}.7z`);
        registeredFile = { fileName: `${baseName}.7z`, type };
      } catch (compErr) {
        compressSpinner.fail(`[${type}] Compression failed: ${compErr.message}`);
        fs.rmSync(tempFolder, { recursive: true, force: true });
        throw compErr;
      }
      for (const f of archiveSet) try { fs.unlinkSync(path.join(downloadDir, f)); } catch (e) {}
      try { fs.rmSync(tempFolder, { recursive: true, force: true }); } catch (e) {}
    } else {
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

  async processRawExfat({ filename, type, downloadDir, initialTitle, initialPpsa, initialVer }) {
    const currentPath = path.join(downloadDir, filename);
    const { mountValidateAndExtractParam } = require('../services/osfmountService');
    const mountSpinner = ora(`[${type}] Mounting exFAT "${filename}" for validation and metadata...`).start();
    let metadata = null;
    try {
      const result = await mountValidateAndExtractParam(currentPath, (s) => { mountSpinner.text = `[${type}] ${s}`; });
      metadata = result.metadata;
      if (result.skipped) {
        mountSpinner.warn(`[${type}] OSFMount not available — skipped validation`);
      } else if (!result.valid) {
        mountSpinner.fail(`[${type}] exFAT validation failed: ${result.message}`);
        const err = new Error('exFAT validation failed: filesystem errors detected');
        err.isExfatValidationError = true;
        throw err;
      } else {
        const metaStr = metadata ? `${metadata.titleName} [${metadata.titleId}] ${metadata.version}` : '(no param.json)';
        mountSpinner.succeed(`[${type}] Validated — ${metaStr}`);
      }
    } catch (mountErr) {
      if (mountErr.isExfatValidationError) throw mountErr;
      mountSpinner.warn(`[${type}] Validation error (continuing): ${mountErr.message}`);
    }
    const realTitle = (metadata && metadata.titleName) || initialTitle;
    const realPpsa  = (metadata && metadata.titleId)   || initialPpsa;
    const realVer   = (metadata && metadata.version)   || initialVer;
    const baseName  = `${sanitizeFileName(realTitle)} [${realPpsa}][${realVer}]`;
    const renamedPath = getUniqueFilePath(downloadDir, baseName, '.exfat', currentPath);
    try {
      if (path.resolve(currentPath) !== path.resolve(renamedPath)) fs.renameSync(currentPath, renamedPath);
    } catch (e) {
      logger.warn(`[${type}] Rename failed: ${e.message}`);
    }
    const dest7zPath = path.join(downloadDir, `${baseName}.7z`);
    const compressSpinner = ora(`[${type}] Compressing to ${baseName}.7z...`).start();
    try {
      await compressFileTo7z(renamedPath, dest7zPath);
      if (!fs.existsSync(dest7zPath) || fs.statSync(dest7zPath).size === 0) throw new Error('Output 7z is empty');
      compressSpinner.succeed(`[${type}] Compressed: ${baseName}.7z`);
      return { registeredFile: { fileName: `${baseName}.7z`, type }, metadata };
    } catch (compErr) {
      compressSpinner.fail(`[${type}] Compression failed: ${compErr.message}. Keeping .exfat.`);
      return { registeredFile: { fileName: path.basename(renamedPath), type }, metadata };
    }
  }

  async processFfpkg({ filename, type, downloadDir, initialTitle, initialPpsa, initialVer }) {
    const currentPath = path.join(downloadDir, filename);
    const { readFfpkgParam } = require('../services/ufs2Reader');
    const spinner = ora(`[${type}] Validating .ffpkg "${filename}" (UFS2) and reading param.json...`).start();
    let metadata = null;
    const result = readFfpkgParam(currentPath);
    metadata = result.metadata;
    if (result.valid) {
      const metaStr = metadata ? `${metadata.titleName} [${metadata.titleId}] ${metadata.version}` : '(no param.json)';
      spinner.succeed(`[${type}] Validated — ${metaStr}`);
    } else if (result.fsValid) {
      spinner.stop();
      logger.warn(`[${type}] Valid PS5 game image, but couldn't read param.json (non-standard .ffpkg layout) — naming from filename`);
    } else {
      spinner.fail(`[${type}] .ffpkg validation failed: ${result.message}`);
      const err = new Error(`.ffpkg validation failed: ${result.message}`);
      err.isFfpkgValidationError = true;
      throw err;
    }
    const realTitle = (metadata && metadata.titleName) || initialTitle;
    const realPpsa  = (metadata && metadata.titleId)   || initialPpsa;
    const realVer   = (metadata && metadata.version)   || initialVer;
    const baseName  = `${sanitizeFileName(realTitle)} [${realPpsa}][${realVer}]`;
    const renamedPath = getUniqueFilePath(downloadDir, baseName, '.ffpkg', currentPath);
    try {
      if (path.resolve(currentPath) !== path.resolve(renamedPath)) fs.renameSync(currentPath, renamedPath);
    } catch (e) {
      logger.warn(`[${type}] Rename failed: ${e.message}`);
    }
    const dest7zPath = path.join(downloadDir, `${baseName}.7z`);
    const compressSpinner = ora(`[${type}] Compressing to ${baseName}.7z...`).start();
    try {
      await compressFileTo7z(renamedPath, dest7zPath);
      if (!fs.existsSync(dest7zPath) || fs.statSync(dest7zPath).size === 0) throw new Error('Output 7z is empty');
      compressSpinner.succeed(`[${type}] Compressed: ${baseName}.7z`);
      return { registeredFile: { fileName: `${baseName}.7z`, type }, metadata };
    } catch (compErr) {
      compressSpinner.fail(`[${type}] Compression failed: ${compErr.message}. Keeping .ffpkg.`);
      return { registeredFile: { fileName: path.basename(renamedPath), type }, metadata };
    }
  }
}

module.exports = PS5Platform;
