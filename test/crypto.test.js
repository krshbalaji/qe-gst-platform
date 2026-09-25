const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Set a throwaway key for this test process before requiring the module under test.
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const { encrypt, decrypt } = require('../lib/crypto');

test('encrypt/decrypt round-trips a plain value', () => {
  const plaintext = 'AAACA1234A';
  const ciphertext = encrypt(plaintext);
  assert.notEqual(ciphertext, plaintext);
  assert.equal(decrypt(ciphertext), plaintext);
});

test('encrypting the same value twice produces different ciphertext (random IV)', () => {
  const a = encrypt('same value');
  const b = encrypt('same value');
  assert.notEqual(a, b);
  assert.equal(decrypt(a), 'same value');
  assert.equal(decrypt(b), 'same value');
});

test('empty/null/undefined values encrypt to empty string and round-trip to empty', () => {
  assert.equal(encrypt(''), '');
  assert.equal(encrypt(null), '');
  assert.equal(encrypt(undefined), '');
  assert.equal(decrypt(''), '');
});

test('decrypt does not throw on a plain (unencrypted) legacy string -- returns it as-is', () => {
  assert.equal(decrypt('plain old bank details, never encrypted'), 'plain old bank details, never encrypted');
});

test('tampering with the ciphertext is detected (GCM auth tag) and fails closed, not open', () => {
  const ciphertext = encrypt('secret bank account 12345');
  const parts = ciphertext.split(':');
  parts[2] = parts[2].slice(0, -2) + (parts[2].slice(-2) === '00' ? '11' : '00'); // flip last byte
  const tampered = parts.join(':');
  const result = decrypt(tampered);
  assert.notEqual(result, 'secret bank account 12345');
});

test('getKey() rejects a missing ENCRYPTION_KEY at call time', () => {
  const original = process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY;
  try {
    assert.throws(() => encrypt('x'), /ENCRYPTION_KEY is not set/);
  } finally {
    process.env.ENCRYPTION_KEY = original;
  }
});
