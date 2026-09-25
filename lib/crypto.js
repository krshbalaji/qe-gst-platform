// Field-level encryption for the handful of genuinely sensitive fields we store
// (PAN, bank account details). GSTINs are deliberately NOT encrypted here -- they're
// printed on every invoice and shared with every customer, so they aren't secret the
// way a PAN or bank account number is; encrypting them would only complicate lookups
// without reducing real exposure.
//
// Requires a 32-byte key in ENCRYPTION_KEY (hex-encoded, i.e. 64 hex characters).
// Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Ciphertext is stored as "iv:authTag:ciphertext" (all hex), so it's a plain string
// wherever it's persisted -- no schema change needed to add/remove encryption later.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
      'and put it in your .env before storing any PAN/bank details.'
    );
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  }
  return key;
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return '';
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decrypt(stored) {
  if (!stored) return '';
  // Defensive: if this ever runs against plaintext left over from before encryption
  // was turned on (or ENCRYPTION_KEY was added late), don't crash the whole page --
  // just return it as-is rather than pretending it decrypted.
  const parts = String(stored).split(':');
  if (parts.length !== 3) return stored;
  try {
    const key = getKey();
    const [ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (e) {
    return '[unable to decrypt -- wrong or missing ENCRYPTION_KEY]';
  }
}

module.exports = { encrypt, decrypt };
