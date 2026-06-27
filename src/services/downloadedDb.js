const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { normalizeTitle } = require('../utils/titleNormalizer');
const { platformDataPath } = require('./platformConfig');

// Per-platform downloaded library, e.g. data/downloaded-ps5.xml
const DB_PATH = platformDataPath('downloaded', 'xml');

/**
 * Loads the list of successfully downloaded games from downloaded.xml.
 * 
 * @returns {Array<{title: string, fileName: string, ppsa: string, password: string, downloadedAt: string, source: string, region: string, normalizedTitle: string}>}
 */
function loadDownloadedGames() {
  if (!fs.existsSync(DB_PATH)) {
    return [];
  }

  try {
    const xmlData = fs.readFileSync(DB_PATH, 'utf-8');
    const parser = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) => ['Game'].includes(name)
    });
    const jsonObj = parser.parse(xmlData);
    const games = jsonObj.Downloaded?.Game || [];
    
    return games.map(g => ({
      title: g.Title || '',
      fileName: g.FileName || '',
      ppsa: g.PPSA || '',
      password: g.Password || '',
      downloadedAt: g.DownloadedAt || '',
      source: g.Source || '',
      region: g.Region || '',
      normalizedTitle: normalizeTitle(g.Title || '')
    }));
  } catch (err) {
    return [];
  }
}

/**
 * Escapes special XML characters.
 */
function escapeXml(unsafe) {
  if (!unsafe) return '';
  return unsafe.toString().replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/**
 * Saves the given downloaded games list to downloaded.xml.
 */
function saveDownloadedGames(games) {
  let xml = '<?xml version="1.0" standalone="yes"?>\n<Downloaded>\n';
  for (const g of games) {
    xml += '  <Game>\n';
    xml += `    <Title>${escapeXml(g.title)}</Title>\n`;
    xml += `    <FileName>${escapeXml(g.fileName)}</FileName>\n`;
    xml += `    <PPSA>${escapeXml(g.ppsa)}</PPSA>\n`;
    xml += `    <Password>${escapeXml(g.password)}</Password>\n`;
    xml += `    <DownloadedAt>${escapeXml(g.downloadedAt)}</DownloadedAt>\n`;
    xml += `    <Source>${escapeXml(g.source)}</Source>\n`;
    xml += `    <Region>${escapeXml(g.region)}</Region>\n`;
    xml += '  </Game>\n';
  }
  xml += '</Downloaded>\n';
  
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DB_PATH, xml, 'utf-8');
}

/**
 * Adds a new game entry to downloaded.xml.
 */
function addDownloadedGame({ title, fileName, ppsa, password, source, region }) {
  const games = loadDownloadedGames();
  
  let existingGame = null;
  const exists = games.some(g => {
    if (normalizeTitle(g.title) === normalizeTitle(title)) {
      return true;
    }
    if (source === 'Manual' || source === 'Manual (Dupe)') {
      return false;
    }
    if (ppsa && ppsa !== 'Unknown' && g.ppsa && g.ppsa !== 'Unknown') {
      if (g.ppsa === ppsa && g.region === region) {
        existingGame = g;
        return true;
      }
    }
    return false;
  });
  if (exists) {
    if (existingGame && normalizeTitle(existingGame.title) !== normalizeTitle(title)) {
      existingGame.title = title;
      saveDownloadedGames(games);
    }
    return;
  }

  games.push({
    title,
    fileName,
    ppsa,
    password,
    downloadedAt: new Date().toISOString(),
    source,
    region
  });

  saveDownloadedGames(games);
}

module.exports = {
  loadDownloadedGames,
  addDownloadedGame
};
