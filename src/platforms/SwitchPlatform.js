const BasePlatform = require('./BasePlatform');
const logger = require('../utils/logger');

class SwitchPlatform extends BasePlatform {
  getName() {
    return 'Switch';
  }

  async postProcess(params) {
    const { downloadedFiles, downloadDir, type, baseName } = params;
    
    // Placeholder logic for Switch
    logger.info(`[Switch] Post processing ${downloadedFiles.length} file(s)...`);
    
    const registeredFiles = [];
    
    for (const fileItem of downloadedFiles) {
      registeredFiles.push({ fileName: fileItem.filename, type: fileItem.type, backportFw: fileItem.backportFw });
    }
    
    return registeredFiles;
  }
}

module.exports = SwitchPlatform;
