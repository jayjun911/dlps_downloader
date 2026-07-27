/**
 * Extracts PPSA code from a given filename or text.
 * Example: "Black Myth - Wukong [PPSA23226][v1.10].rar" -> "PPSA23226"
 * 
 * @param {string} fileName 
 * @returns {string|null} normalized PPSA code or null
 */
function extractPPSA(fileName) {
  if (!fileName) return null;
  const match = fileName.match(/PPSA[-_]?\d+/i);
  return match ? match[0].replace(/[-_]/g, '').toUpperCase() : null;
}

module.exports = {
  extractPPSA
};
