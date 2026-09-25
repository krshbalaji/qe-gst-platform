// Simple in-memory brute-force guard for login. Good enough for a single-process
// deployment; swap for a Redis-backed limiter if you ever run more than one
// instance behind a load balancer.
const attempts = new Map(); // key -> { count, firstAttemptAt, lockedUntil }

const WINDOW_MS = 15 * 60 * 1000;   // count failures within a 15-minute window
const MAX_ATTEMPTS = 5;              // ...before locking out
const LOCKOUT_MS = 5 * 60 * 1000;    // ...for 5 minutes

function keyFor(req, identifier, action) {
  return `${action}|${req.ip}|${String(identifier || '').toLowerCase()}`;
}

function isLocked(req, identifier, action = 'login') {
  const rec = attempts.get(keyFor(req, identifier, action));
  if (!rec) return { locked: false };
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return { locked: true, retryAfterSeconds: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  }
  return { locked: false };
}

function recordFailure(req, identifier, action = 'login') {
  const key = keyFor(req, identifier, action);
  const now = Date.now();
  let rec = attempts.get(key);
  if (!rec || now - rec.firstAttemptAt > WINDOW_MS) {
    rec = { count: 0, firstAttemptAt: now, lockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
    rec.count = 0;
    rec.firstAttemptAt = now;
  }
  attempts.set(key, rec);
}

function recordSuccess(req, identifier, action = 'login') {
  attempts.delete(keyFor(req, identifier, action));
}

// Periodically forget stale entries so this Map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of attempts) {
    if (now - rec.firstAttemptAt > WINDOW_MS && (!rec.lockedUntil || rec.lockedUntil < now)) {
      attempts.delete(key);
    }
  }
}, 10 * 60 * 1000).unref();

module.exports = { isLocked, recordFailure, recordSuccess };
