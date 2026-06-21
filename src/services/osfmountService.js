const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

function getOsfMountPath() {
  return process.env.OSFMOUNT_PATH || 'C:\\Program Files\\OSFMount\\OSFMount.exe';
}

function findFreeDriveLetter() {
  // fs.existsSync('V:\\') returns false when the drive is not mounted — no wmic needed
  for (let c = 'V'.charCodeAt(0); c >= 'D'.charCodeAt(0); c--) {
    const letter = String.fromCharCode(c) + ':';
    if (!fs.existsSync(letter + '\\')) return letter;
  }
  throw new Error('No free drive letter available for OSFMount');
}

function dismount(osfPath, driveLetter) {
  try {
    execSync(`"${osfPath}" -d -m ${driveLetter}`, {
      stdio: ['pipe', 'pipe', 'ignore'], timeout: 15000, windowsHide: true
    });
  } catch (e) {
    // Retry with force dismount if regular dismount fails (volume may still be locked)
    try {
      execSync(`"${osfPath}" -D -m ${driveLetter}`, {
        stdio: ['pipe', 'pipe', 'ignore'], timeout: 15000, windowsHide: true
      });
    } catch (e2) {
      logger.warn(`OSFMount dismount (${driveLetter}) failed: ${e2.message}`);
    }
  }
}

function parseParamJson(driveLetter) {
  try {
    const paramPath = path.join(driveLetter + '\\', 'sce_sys', 'param.json');
    const raw = fs.readFileSync(paramPath, 'utf-8');
    const json = JSON.parse(raw);

    const defLang = (json.localizedParameters && json.localizedParameters.defaultLanguage) || 'en-US';
    // Try defaultLanguage first, then en-US, then any available locale
    const locParams = json.localizedParameters || {};
    const locale = locParams[defLang] || locParams['en-US'] || Object.values(locParams).find(v => v && v.titleName) || {};

    return {
      titleId: (json.titleId || '').trim(),
      titleName: (locale.titleName || '').trim(),
      version: json.applicationVersion ? `v${json.applicationVersion}` : 'v01.00'
    };
  } catch (e) {
    return null;
  }
}

function runChkdsk(driveLetter) {
  let output = '';
  try {
    output = execSync(`chkdsk ${driveLetter}`, {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000
    });
  } catch (chkErr) {
    // chkdsk exits non-zero on read-only mounts even when the filesystem is clean
    // (can't update the "last run" timestamp). Judge by output text, not exit code.
    output = ((chkErr.stdout || '') + (chkErr.stderr || '')).trim() || chkErr.message;
  }

  const valid = output.toLowerCase().includes('found no problems');

  if (!valid) logger.warn(`chkdsk full output:\n${output}`);

  const summary = output.split(/\r?\n/).filter(l => l.trim()).join(' | ');
  return { valid, message: summary };
}

/**
 * Mounts an exFAT disk image read-only via OSFMount, reads sce_sys/param.json
 * for real game metadata, and runs chkdsk for filesystem validation.
 *
 * Returns { valid, metadata, message, skipped }
 *   metadata: { titleId, titleName, version } or null if param.json unreadable
 *   skipped: true when OSFMount is not installed (treat as valid, no metadata)
 *
 * Throws only when OSFMount is installed but mounting itself fails.
 */
async function mountValidateAndExtractParam(exfatFilePath, onStatus) {
  const osfPath = getOsfMountPath();

  if (!fs.existsSync(osfPath)) {
    logger.warn(`OSFMount not found at: ${osfPath} — skipping validation.`);
    return { valid: true, skipped: true, metadata: null, message: '' };
  }

  let driveLetter;
  try {
    driveLetter = findFreeDriveLetter();
  } catch (e) {
    logger.warn(`No free drive letter for OSFMount — skipping validation.`);
    return { valid: true, skipped: true, metadata: null, message: '' };
  }

  if (onStatus) onStatus(`Mounting exFAT at ${driveLetter} (read-only)...`);

  try {
    execSync(
      `"${osfPath}" -a -t file -f "${exfatFilePath}" -m ${driveLetter} -o ro`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000, windowsHide: true }
    );
  } catch (err) {
    const errOut = (err.stdout || '') + (err.stderr || '');
    throw new Error(`OSFMount mount failed: ${errOut.trim() || err.message}`);
  }

  // Give Windows time to register the volume before accessing it
  await new Promise(r => setTimeout(r, 2000));

  // ── Read param.json ────────────────────────────────────────────────────────
  if (onStatus) onStatus(`Reading sce_sys/param.json from ${driveLetter}...`);
  const metadata = parseParamJson(driveLetter);
  if (!metadata) logger.warn(`param.json not found or unreadable on ${driveLetter}`);

  // ── chkdsk ────────────────────────────────────────────────────────────────
  if (onStatus) onStatus(`Running chkdsk ${driveLetter}...`);
  const { valid, message } = runChkdsk(driveLetter);

  dismount(osfPath, driveLetter);

  return { valid, metadata, message, skipped: false };
}

/**
 * Thin wrapper — validates only (no metadata needed).
 * Returns { valid, message, skipped }.
 */
async function validateExfat(exfatFilePath, onStatus) {
  const { valid, message, skipped } = await mountValidateAndExtractParam(exfatFilePath, onStatus);
  return { valid, message, skipped };
}

module.exports = { mountValidateAndExtractParam, validateExfat };
