const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const TMP_PATH = DB_PATH + '.tmp';

const EMPTY_DB = {
  companies: [],
  gstins: [],
  parties: [],
  products: [],
  gstPresets: [],
  invoices: [],
  purchaseInvoices: [],
  gstr2b: [],
  returnPeriods: [],
  users: [],
  auditLog: [],
  passwordResets: [],
  _counters: {}
};

function ensureFile() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY_DB, null, 2));
  }
}

function load() {
  ensureFile();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  const db = JSON.parse(raw);
  for (const key of Object.keys(EMPTY_DB)) {
    if (!(key in db)) db[key] = Array.isArray(EMPTY_DB[key]) ? [] : EMPTY_DB[key];
  }
  return db;
}

/**
 * Atomic write: write to a temp file, fsync, then rename over the real file.
 * A rename on the same filesystem is atomic on POSIX, so a crash mid-write can
 * never leave data/db.json half-written/corrupted -- the reader either sees the
 * old file or the fully-written new one, never a partial one.
 */
function save(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const fd = fs.openSync(TMP_PATH, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(db, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(TMP_PATH, DB_PATH);
}

function nextId(db, collection) {
  db._counters[collection] = (db._counters[collection] || 0) + 1;
  return db._counters[collection];
}

/**
 * Load-mutate-save in one synchronous call. Because Node runs JS on a single
 * thread and this whole function contains no `await`, no other request can be
 * interleaved between the load and the save -- so this is safe against
 * concurrent writes without needing an external lock.
 *
 * IMPORTANT: if a route needs to do async work (e.g. an API call) as part of a
 * write, do the async work FIRST, then call mutate() with a purely synchronous
 * function that only applies the already-computed result. Never hold a load()
 * result across an `await` and save() it afterwards -- that's the classic
 * lost-update race that the old e-invoice route had.
 */
function mutate(fn) {
  const db = load();
  const result = fn(db);
  save(db);
  return result;
}

module.exports = { load, save, nextId, mutate, DB_PATH };
