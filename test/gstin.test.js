const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidGstin, hasValidStructure, withCheckDigit, computeCheckDigit } = require('../lib/gstin');

test('withCheckDigit produces a GSTIN that validates', () => {
  const gstin = withCheckDigit('33AAACA1234A1Z');
  assert.equal(gstin.length, 15);
  assert.equal(isValidGstin(gstin), true);
});

test('isValidGstin rejects a single flipped digit (catches typos)', () => {
  const good = withCheckDigit('33AAACA1234A1Z');
  const bad = '34' + good.slice(2); // flip the state code digit only
  assert.equal(isValidGstin(bad), false);
});

test('isValidGstin rejects a transposed pair (common data-entry error)', () => {
  const good = withCheckDigit('27AAPFU0930F1Z');
  const chars = good.split('');
  [chars[6], chars[7]] = [chars[7], chars[6]]; // swap two adjacent PAN digits
  const transposed = chars.join('');
  if (transposed !== good) {
    assert.equal(isValidGstin(transposed), false);
  }
});

test('hasValidStructure enforces the 15-char shape independent of checksum', () => {
  assert.equal(hasValidStructure('33AAACA1234A1ZR'), true);
  assert.equal(hasValidStructure('too-short'), false);
  assert.equal(hasValidStructure('33aaaca1234a1zr'), false); // lowercase not allowed
});

test('computeCheckDigit throws on a prefix that is not exactly 14 characters', () => {
  assert.throws(() => computeCheckDigit('short'));
});

test('every demo GSTIN shipped in the seed data is checksum-valid', () => {
  const demoGstins = [
    '33AAACA1234A1ZR', '29AAACA1234A1ZG', '33BBPCM5678K1ZO',
    '29AAFFN2345L1ZZ', '27AAGCK7890M1ZP', '33AACFC4567N1Z8', '33AADFT8901P1ZS'
  ];
  for (const g of demoGstins) {
    assert.equal(isValidGstin(g), true, `${g} should be checksum-valid`);
  }
});
