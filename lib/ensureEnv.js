const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_PATH = path.join(__dirname, '..', '.env');

/**
 * Loads .env if present. If it's missing entirely, generates one with fresh random
 * SESSION_SECRET and ENCRYPTION_KEY and writes it to disk -- this matters because
 * seed.js and server.js are separate processes; if each independently generated its
 * own throwaway key in memory (the old behavior), whatever seed.js encrypted with its
 * key would be undecryptable the moment server.js started with a different one.
 * Writing a real .env file the first time either process runs means both processes
 * (and every restart after) agree on the same secrets.
 */
function ensureEnv() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!fs.existsSync(ENV_PATH)) {
    if (isProd) {
      // Deliberately do NOT auto-write a file in production: container filesystems are
      // often ephemeral, and a fresh random key on every redeploy would silently make
      // previously-encrypted PAN/bank fields unrecoverable and invalidate all sessions.
      // Production secrets should come from the platform's real secret management
      // (env vars set outside this repo) -- server.js's boot check will fail loudly
      // and tell the operator exactly what to set if they're missing.
      return;
    }
    const sessionSecret = crypto.randomBytes(32).toString('hex');
    const encryptionKey = crypto.randomBytes(32).toString('hex');
    const contents =
      `# Auto-generated on first run. Keep this file private and out of version control.\n` +
      `SESSION_SECRET=${sessionSecret}\n` +
      `ENCRYPTION_KEY=${encryptionKey}\n` +
      `PORT=4000\n` +
      `NODE_ENV=development\n`;
    fs.writeFileSync(ENV_PATH, contents, { mode: 0o600 });
    console.warn(`[qe3] No .env found -- generated one with fresh secrets at ${ENV_PATH}. Back it up; if you lose it, encrypted PAN/bank fields become unrecoverable.`);
  }
  require('dotenv').config({ path: ENV_PATH });
}

module.exports = { ensureEnv, ENV_PATH };
