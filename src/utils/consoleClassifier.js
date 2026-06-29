/**
 * Classifies a PlayStation title/serial ID into its console by ID prefix.
 *
 * dlpsgame.com's PS4 list mixes in PS1/PS2 emulation packages whose IDs use the
 * old disc serial prefixes (SLUS, SCPS, ...). Detecting the prefix lets us label
 * those entries as PS1/PS2 instead of treating them as PS4.
 *
 * PS1 prefixes are a strict subset of PS2 prefixes, so the shared retail/demo
 * prefixes can't be told apart by prefix alone — those map to the combined
 * 'ps1-2' label. Only PS2-exclusive prefixes (Korea retail/demo, the JP large
 * third-party SLPM band) resolve to a definite 'ps2'.
 */

const PREFIX_CONSOLE = {
  // PS5
  PPSA: 'ps5',
  // PS4
  CUSA: 'ps4', PCAS: 'ps4', PLAS: 'ps4', PCJS: 'ps4', PLJS: 'ps4',
  // PS2-exclusive
  SCKA: 'ps2', SLKA: 'ps2', SLPM: 'ps2', SCKD: 'ps2',
  // Shared PS1/PS2 retail
  SCPS: 'ps1-2', SLPS: 'ps1-2', SCUS: 'ps1-2', SLUS: 'ps1-2', SCES: 'ps1-2', SLES: 'ps1-2',
  // Shared PS1/PS2 demo / promo
  SCPD: 'ps1-2', SLPD: 'ps1-2', SCUD: 'ps1-2', SCED: 'ps1-2', SLED: 'ps1-2',
};

// Human-facing label per console key.
const CONSOLE_LABEL = {
  ps5: 'PS5',
  ps4: 'PS4',
  ps2: 'PS2',
  ps1: 'PS1',
  'ps1-2': 'PS1/2',
  saturn: 'SATURN',
  psp: 'PSP',
  jpn: 'JPN',
};

// Emulation packages repackaged for PS4 use arbitrary per-game vanity content
// IDs (LAUB00001, BOMB81070, NPEZ00366, ...) so they can't be matched by a fixed
// prefix. They're identified by "<system> to PS4" / "<system> emu" tags inside
// the subpage payload. Add a row here to support a new emulated system.
const EMU_TAGS = [
  { console: 'ps1',    regex: /\[\s*PSX\s*to\s*PS4\s*\]|PSX\s*to\s*PS4|PSX\s*emu/i },
  { console: 'ps2',    regex: /\[\s*PS2\s*to\s*PS4\s*\]|PS2\s*to\s*PS4|PS2\s*emu/i },
  { console: 'saturn', regex: /\[\s*SATURN\s*to\s*PS4\s*\]|SATURN\s*to\s*PS4|SATURN\s*emu/i },
  { console: 'psp',    regex: /\[\s*PSP\s*to\s*PS4\s*\]|PSP\s*to\s*PS4|PSP\s*emu/i },
];

/**
 * Returns the console key for an emulation-package tag found in text, or null.
 * e.g. "[SATURNtoPS4]" -> 'saturn', "Game PSP to PS4 (FPKG)" -> 'psp'.
 */
function detectEmuConsole(text) {
  if (!text) return null;
  for (const t of EMU_TAGS) {
    if (t.regex.test(text)) return t.console;
  }
  return null;
}

const KNOWN_PREFIXES = Object.keys(PREFIX_CONSOLE);

// Matches a known title ID like PPSA15706, CUSA12345, SLUS-21274, SCPS 10000.
const TITLE_ID_REGEX = new RegExp(`\\b(${KNOWN_PREFIXES.join('|')})[-\\s]?(\\d{3,5})\\b`, 'ig');

/**
 * Maps a 4-letter prefix to its console key, or null if unknown.
 */
function classifyPrefix(prefix) {
  if (!prefix) return null;
  return PREFIX_CONSOLE[prefix.toUpperCase()] || null;
}

/**
 * Classifies a full ID string (e.g. "SLUS-21274") by its leading prefix.
 * @returns {{prefix: string, console: string}|null}
 */
function classifyId(id) {
  if (!id) return null;
  const prefix = String(id).trim().slice(0, 4).toUpperCase();
  const console = classifyPrefix(prefix);
  return console ? { prefix, console } : null;
}

/**
 * Extracts the first known title ID from arbitrary text.
 *
 * When `preferConsole` is given, an ID whose console matches it wins over
 * earlier-occurring IDs — this keeps PS5 pages that also mention a PS4 CUSA
 * (backport notes) resolving to the PPSA ID.
 *
 * @param {string} text
 * @param {{preferConsole?: string}} [opts]
 * @returns {{id: string, prefix: string, console: string, raw: string}|null}
 */
function extractTitleId(text, opts = {}) {
  const all = extractAllTitleIds(text);
  if (all.length === 0) return null;
  if (opts.preferConsole) {
    const preferred = all.find(m => m.console === opts.preferConsole);
    if (preferred) return preferred;
  }
  return all[0];
}

/**
 * Extracts every known title ID from text, in order of appearance.
 * @returns {Array<{id: string, prefix: string, console: string, raw: string}>}
 */
function extractAllTitleIds(text) {
  if (!text) return [];
  const results = [];
  const re = new RegExp(TITLE_ID_REGEX.source, 'ig');
  let m;
  while ((m = re.exec(text)) !== null) {
    const prefix = m[1].toUpperCase();
    const id = `${prefix}${m[0].includes('-') ? '-' : ''}${m[2]}`;
    results.push({ id, prefix, console: PREFIX_CONSOLE[prefix], raw: m[0] });
  }
  return results;
}

/**
 * Returns the display label for a console key (e.g. 'ps1-2' -> 'PS1/2').
 */
function consoleLabel(consoleKey) {
  return CONSOLE_LABEL[consoleKey] || (consoleKey ? consoleKey.toUpperCase() : '');
}

module.exports = {
  PREFIX_CONSOLE,
  CONSOLE_LABEL,
  TITLE_ID_REGEX,
  EMU_TAGS,
  detectEmuConsole,
  classifyPrefix,
  classifyId,
  extractTitleId,
  extractAllTitleIds,
  consoleLabel,
};
