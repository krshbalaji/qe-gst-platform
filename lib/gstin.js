// GSTIN structure: 2-digit state code + 10-char PAN + 1 entity code + 'Z' (fixed) + 1 check digit.
// The check digit uses the standard alternating-weight mod-36 algorithm published for GSTIN
// (the same family as ISO 7064 MOD 36). This catches typos/transpositions that a pure regex
// would let through -- important once real GSTINs from real customers are being keyed in.

const CODE_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MOD = 36;

const STRUCTURE_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function computeCheckDigit(first14) {
  if (first14.length !== 14) throw new Error('GSTIN prefix for checksum must be exactly 14 characters');
  let factor = 1;
  let total = 0;
  for (const ch of first14) {
    const digit = CODE_CHARS.indexOf(ch);
    if (digit === -1) throw new Error(`Invalid character '${ch}' in GSTIN`);
    let codePoint = factor * digit;
    factor = factor === 1 ? 2 : 1;
    codePoint = Math.floor(codePoint / MOD) + (codePoint % MOD);
    total += codePoint;
  }
  const checksumDigit = (MOD - (total % MOD)) % MOD;
  return CODE_CHARS[checksumDigit];
}

/** Structural shape only (2-digit state, PAN pattern, entity code, fixed 'Z'). */
function hasValidStructure(gstin) {
  return typeof gstin === 'string' && STRUCTURE_RE.test(gstin);
}

/** Structure AND checksum. This is what should gate real data entry. */
function isValidGstin(gstin) {
  if (!hasValidStructure(gstin)) return false;
  return computeCheckDigit(gstin.slice(0, 14)) === gstin[14];
}

/** Given a valid 14-character prefix, returns the full 15-character GSTIN with a correct check digit. */
function withCheckDigit(first14) {
  return first14 + computeCheckDigit(first14);
}

module.exports = { isValidGstin, hasValidStructure, computeCheckDigit, withCheckDigit };
