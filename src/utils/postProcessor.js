const path = require('path');
const fs = require('fs');

// ── File-type helpers ──────────────────────────────────────────────────────────

/**
 * Detects the type of auxiliary file from its name (UNLOCK, DLC, BACK4xx, BACK7xx, UPDATE, etc.)
 */
function detectFileType(fileName) {
  const lower = fileName.toLowerCase();
  
  if (lower.includes('unlock')) {
    return 'UNLOCK';
  }
  
  if (lower.includes('dlc')) {
    return 'DLC';
  }
  
  if (lower.includes('backport')) {
    return 'BACK';
  }

  if (lower.includes('patch') || lower.includes('update')) {
    return 'UPDATE';
  }

  if (lower.includes('guide') || lower.includes('readme')) {
    return 'INSTALL_GUIDE';
  }
  
  return null;
}

// Builds the filename type tag. Backports are tagged with their target firmware
// (e.g. [BACK4XX] for a 4.xx backport) when that version is known; otherwise the
// generic [BACKPORT] is used. All other types use their name verbatim.
function buildTypeTag(type, backportFw) {
  if (type === 'BACKPORT' && backportFw != null) return `BACK${backportFw}XX`;
  return type;
}

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

function findFilesWithExt(dir, ext) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      results = results.concat(findFilesWithExt(filePath, ext));
    } else if (file.toLowerCase().endsWith(ext.toLowerCase())) {
      results.push(filePath);
    }
  }
  return results;
}

module.exports = {
  detectFileType,
  buildTypeTag,
  isArchiveFile,
  checkIsSplitArchive,
  findMainArchiveFile,
  getUniqueFilePath,
  findFilesWithExt
};
