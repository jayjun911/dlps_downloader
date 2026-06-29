const BasePlatform = require('./BasePlatform');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs');
const ora = require('ora');

const { 
  extractRarArchive, 
  getGameInfoFromArchive, 
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

class PS4Platform extends BasePlatform {
  getName() {
    return 'PS4';
  }

  async postProcess(params) {
    const { downloadedFiles, downloadDir, password, initialTitle, initialPpsa, initialVer } = params;
    
    let finalTitle = initialTitle;
    let finalPpsa  = initialPpsa;
    let finalVer   = initialVer || 'v01.00';
    
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

    let gameKnownPassword;
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

    const registeredFiles = [];

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

      // For PS4, we ALWAYS extract archives so we can get the raw .pkg files
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
          const pkgFiles = findFilesWithExt(outputFolderPath, '.pkg');
          if (pkgFiles.length > 0) {
            for (let idx = 0; idx < pkgFiles.length; idx++) {
              const pkgPath = pkgFiles[idx];
              const newPkgName = pkgFiles.length === 1 ? `${baseNameLabel}.pkg` : `${baseNameLabel}_${idx + 1}.pkg`;
              const newPkgPath = getUniqueFilePath(downloadDir, path.parse(newPkgName).name, '.pkg');
              fs.renameSync(pkgPath, newPkgPath);
              registeredFiles.push({ fileName: path.basename(newPkgPath), type: groupType });
              logger.success(`[${groupType}] Extracted package: ${path.basename(newPkgPath)}`);
            }
          } else {
             logger.warn(`[${groupType}] No .pkg files found after extraction. Keeping extracted folder.`);
          }
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
        const ext    = path.extname(file).toLowerCase();
        
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
    
    return registeredFiles;
  }
}

module.exports = PS4Platform;
