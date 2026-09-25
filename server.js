require('./lib/ensureEnv').ensureEnv();

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');

const { load, save, nextId, mutate } = require('./lib/store');
const { STATE_CODES, nameForCode } = require('./lib/stateCodes');
const { calcLine, sumTotals, isInterState, hsnDigitsRequired, computeItcSetOff, EINVOICE_AATO_THRESHOLD, EINVOICE_30DAY_WINDOW_THRESHOLD, round2 } = require('./lib/gst');
const { isValidGstin, hasValidStructure } = require('./lib/gstin');
const { generateMockIRN } = require('./lib/einvoice');
const { hashPassword, verifyPassword, requireLogin, requireWrite, requireOwner } = require('./lib/auth');
const { csrfMiddleware } = require('./lib/csrf');
const rateLimiter = require('./lib/rateLimiter');
const { AppError, ah } = require('./lib/errors');
const { toCsv, sendCsv } = require('./lib/csv');
const fieldCrypto = require('./lib/crypto');
const { recordAudit } = require('./lib/audit');
const { sendMail } = require('./lib/mailer');
const reports = require('./lib/reports');

const app = express();
const PORT = process.env.PORT || 4000;
const isProd = process.env.NODE_ENV === 'production';

// ------------------------------------------------------- BOOT VALIDATION ----
// ensureEnv() above either loaded a real .env (persisted, so seed.js and this
// process always agree on the same secrets) or -- in production, deliberately --
// left process.env untouched so the platform's real secret management is what
// counts. Either way, refuse to boot with something missing/insecure rather
// than silently limping along.
if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-only-change-me')) {
  console.error('FATAL: set a real SESSION_SECRET (via your platform\'s env/secret config) before running with NODE_ENV=production.');
  process.exit(1);
}
if (!process.env.ENCRYPTION_KEY) {
  if (isProd) {
    console.error('FATAL: set a real ENCRYPTION_KEY (via your platform\'s env/secret config) before running with NODE_ENV=production. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }
  // Reaching here in dev would mean ensureEnv()'s file write failed somehow; fall back
  // to an in-memory key so the process is still usable, loudly flagged as non-persistent.
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  console.warn('[qe3] ENCRYPTION_KEY still missing after ensureEnv() -- using a temporary in-memory key for this run only.');
}
if (!isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-only-change-me')) {
  console.warn('[qe3] Using the default SESSION_SECRET. Fine for local dev; set a real one via .env before deploying.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // needed for req.ip / secure cookies to work correctly behind a reverse proxy

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // inline style="" attributes are still used in views
      imgSrc: ["'self'", 'data:']              // e-invoice QR codes are rendered as data: URLs
    }
  }
}));
app.use(compression());
app.use(morgan(isProd ? 'combined' : 'dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd
  }
}));

// Make current user + a fresh db snapshot available to every request/view.
// IMPORTANT: this must run BEFORE csrfMiddleware. If CSRF verification fails,
// it calls next(err) which skips straight to the error handler -- if this
// locals-setting middleware ran after csrfMiddleware, the error page's nav
// partial would crash on undefined `path`/`currentUser`.
app.use((req, res, next) => {
  req.db = load();
  res.locals.currentUser = req.session.user || null;
  res.locals.STATE_CODES = STATE_CODES;
  res.locals.nameForCode = nameForCode;
  res.locals.path = req.path;
  next();
});

app.use(csrfMiddleware);

function currentCompanyId(req) {
  return req.session.user ? req.session.user.companyId : null;
}
function companyGstins(db, companyId) {
  return db.gstins.filter(g => g.companyId === companyId);
}
function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}
function requirePositiveNumber(value, fieldName) {
  const n = Number(value);
  if (!isFinite(n) || n < 0) throw new AppError(400, `${fieldName} must be a valid non-negative number.`);
  return n;
}
function auditFromReq(req, action, detail) {
  return { userId: req.session.user.id, userName: req.session.user.name, companyId: req.session.user.companyId, action, detail };
}

// ------------------------------------------------------------- HEALTH ----
app.get('/healthz', (req, res) => {
  try {
    load(); // confirms the data file is readable
    res.status(200).json({ status: 'ok' });
  } catch (e) {
    res.status(503).json({ status: 'error', message: e.message });
  }
});

// ---------------------------------------------------------------- AUTH ----
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/login', { error: null, reset: req.query.reset === '1' });
});

app.post('/login', ah(async (req, res) => {
  const { email, password } = req.body;
  const lock = rateLimiter.isLocked(req, email, 'login');
  if (lock.locked) {
    return res.status(429).render('auth/login', { error: `Too many failed attempts. Try again in about ${Math.ceil(lock.retryAfterSeconds / 60)} minute(s).`, reset: false });
  }

  const user = req.db.users.find(u => u.email.toLowerCase() === String(email || '').toLowerCase());
  const valid = user && user.active !== false && verifyPassword(password, user.salt, user.hash);
  if (!valid) {
    rateLimiter.recordFailure(req, email, 'login');
    return res.render('auth/login', { error: 'Invalid email or password.', reset: false });
  }
  rateLimiter.recordSuccess(req, email, 'login');
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, companyId: user.companyId };
    res.redirect('/');
  });
}));

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ------------------------------------------------------------- SIGNUP ----
app.get('/signup', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/signup', { error: null });
});

app.post('/signup', ah((req, res) => {
  const { tradeName, legalName, ownerName, email, password } = req.body;
  const lock = rateLimiter.isLocked(req, req.ip, 'signup');
  if (lock.locked) {
    return res.status(429).render('auth/signup', { error: 'Too many signups from this connection. Try again later.' });
  }
  if (!tradeName || !tradeName.trim() || !legalName || !legalName.trim() || !ownerName || !ownerName.trim()) {
    return res.status(400).render('auth/signup', { error: 'All fields are required.' });
  }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).render('auth/signup', { error: 'A valid email is required.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).render('auth/signup', { error: 'Password must be at least 8 characters.' });
  }
  const db = req.db;
  if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
    rateLimiter.recordFailure(req, req.ip, 'signup');
    return res.status(400).render('auth/signup', { error: 'A user with that email already exists.' });
  }

  const sessionUser = mutate(freshDb => {
    const companyId = nextId(freshDb, 'companies');
    freshDb.companies.push({
      id: companyId, legalName: legalName.trim(), tradeName: tradeName.trim(),
      pan: '', bankDetails: '', address: '', priorFyAato: 0
    });
    const { salt, hash } = hashPassword(password);
    const userId = nextId(freshDb, 'users');
    freshDb.users.push({ id: userId, name: ownerName.trim(), email: email.toLowerCase(), salt, hash, role: 'owner', companyId, active: true });
    recordAudit(freshDb, { userId, userName: ownerName.trim(), companyId, action: 'signup', detail: `New workspace "${tradeName.trim()}" created` });
    return { id: userId, name: ownerName.trim(), email: email.toLowerCase(), role: 'owner', companyId };
  });

  rateLimiter.recordSuccess(req, req.ip, 'signup');
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.user = sessionUser;
    res.redirect('/companies?welcome=1');
  });
}));

// --------------------------------------------------------- PASSWORD RESET ----
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

app.get('/forgot-password', (req, res) => {
  res.render('auth/forgot-password', { sent: false, error: null });
});

app.post('/forgot-password', ah(async (req, res) => {
  const { email } = req.body;
  const lock = rateLimiter.isLocked(req, email, 'password-reset');
  if (lock.locked) {
    return res.status(429).render('auth/forgot-password', { sent: false, error: 'Too many requests. Try again later.' });
  }
  rateLimiter.recordFailure(req, email, 'password-reset'); // count regardless of outcome -- avoids leaking which emails exist via timing/rate differences

  const db = req.db;
  const user = db.users.find(u => u.email.toLowerCase() === String(email || '').toLowerCase());
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    mutate(freshDb => {
      freshDb.passwordResets = freshDb.passwordResets.filter(r => r.userId !== user.id); // invalidate any older ones
      freshDb.passwordResets.push({ id: nextId(freshDb, 'passwordResets'), userId: user.id, token, expiresAt: Date.now() + RESET_TOKEN_TTL_MS, used: false });
    });
    const link = `${req.protocol}://${req.get('host')}/reset-password/${token}`;
    await sendMail({ to: user.email, subject: 'QE3 GST Platform — reset your password', text: `Reset your password: ${link}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.` });
  }
  // Same response whether or not the email exists -- don't let this endpoint be used to enumerate accounts.
  res.render('auth/forgot-password', { sent: true, error: null });
}));

app.get('/reset-password/:token', ah((req, res) => {
  const db = req.db;
  const rec = db.passwordResets.find(r => r.token === req.params.token);
  const valid = rec && !rec.used && rec.expiresAt > Date.now();
  res.render('auth/reset-password', { invalid: !valid, error: null, token: req.params.token });
}));

app.post('/reset-password/:token', ah((req, res) => {
  const { password } = req.body;
  const db = req.db;
  const rec = db.passwordResets.find(r => r.token === req.params.token);
  const valid = rec && !rec.used && rec.expiresAt > Date.now();
  if (!valid) return res.render('auth/reset-password', { invalid: true, error: null, token: req.params.token });
  if (!password || password.length < 8) {
    return res.render('auth/reset-password', { invalid: false, error: 'Password must be at least 8 characters.', token: req.params.token });
  }
  mutate(freshDb => {
    const freshRec = freshDb.passwordResets.find(r => r.id === rec.id);
    const user = freshDb.users.find(u => u.id === freshRec.userId);
    const { salt, hash } = hashPassword(password);
    user.salt = salt; user.hash = hash;
    freshRec.used = true;
    recordAudit(freshDb, { userId: user.id, userName: user.name, companyId: user.companyId, action: 'password-reset', detail: 'Password reset via emailed link' });
  });
  res.redirect('/login?reset=1');
}));

app.use((req, res, next) => {
  const publicPaths = ['/login', '/signup', '/forgot-password', '/healthz'];
  if (publicPaths.includes(req.path) || req.path.startsWith('/reset-password/')) return next();
  requireLogin(req, res, next);
});

// ------------------------------------------------------------ DASHBOARD ----
app.get('/', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const company = db.companies.find(c => c.id === companyId);
  const gstins = companyGstins(db, companyId);
  const period = currentPeriod();

  const invoices = reports.invoicesFor(db, { companyId });
  const fyStart = fyStartYear(new Date());
  const fyInvoices = invoices.filter(i => new Date(i.date) >= fyStart);
  const aatoThisFy = round2(fyInvoices.reduce((s, i) => s + i.totals.total, 0));
  const aato = round2((company.priorFyAato || 0) + aatoThisFy);

  const monthInvoices = invoices.filter(i => i.period === period);
  const outward = reports.buildGstr1Draft(db, { companyId, period }).totals;
  const purchaseThisMonth = db.purchaseInvoices.filter(p => p.companyId === companyId && p.period === period);
  const itcAvailable = {
    igst: round2(purchaseThisMonth.filter(p => p.itcEligible).reduce((s, p) => s + p.igst, 0)),
    cgst: round2(purchaseThisMonth.filter(p => p.itcEligible).reduce((s, p) => s + p.cgst, 0)),
    sgst: round2(purchaseThisMonth.filter(p => p.itcEligible).reduce((s, p) => s + p.sgst, 0))
  };
  const savedReturn = db.returnPeriods.find(r => r.companyId === companyId && r.period === period);
  const itcClaimed = savedReturn ? savedReturn.itcClaimed : itcAvailable;
  const netPayable = computeItcSetOff({ liability: outward, itcClaimed }).netPayable;

  res.render('dashboard', {
    company, gstins, period, aato,
    einvoiceRequired: aato >= EINVOICE_AATO_THRESHOLD,
    thirtyDayWindow: aato >= EINVOICE_30DAY_WINDOW_THRESHOLD,
    monthInvoiceCount: monthInvoices.length,
    taxLiability: outward,
    netPayableTotal: round2(netPayable.igst + netPayable.cgst + netPayable.sgst),
    itcAvailableTotal: round2(itcAvailable.igst + itcAvailable.cgst + itcAvailable.sgst),
    filedForPeriod: !!savedReturn,
    dueDates: complianceDueDates(period)
  });
}));

function fyStartYear(d) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // FY starts April
  return new Date(`${y}-04-01`);
}
function complianceDueDates(period) {
  const [y, m] = period.split('-').map(Number);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  const nextMonth = `${ny}-${String(nm).padStart(2, '0')}`;
  return [
    { label: `GSTR-1 for ${period}`, due: `${nextMonth}-11` },
    { label: `GSTR-3B for ${period}`, due: `${nextMonth}-20` }
  ];
}

app.post('/company/aato', requireWrite, ah((req, res) => {
  mutate(db => {
    const company = db.companies.find(c => c.id === currentCompanyId(req));
    company.priorFyAato = requirePositiveNumber(req.body.priorFyAato || 0, 'Prior-FY AATO');
  });
  res.redirect('/');
}));

// ---------------------------------------------------------- COMPANIES ----
app.get('/companies', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const company = db.companies.find(c => c.id === companyId);
  const gstins = companyGstins(db, companyId);
  const decrypted = { ...company, pan: fieldCrypto.decrypt(company.pan), bankDetails: fieldCrypto.decrypt(company.bankDetails) };
  res.render('companies/index', { company: decrypted, gstins, welcome: req.query.welcome === '1' });
}));

app.post('/companies/update', requireWrite, ah((req, res) => {
  if (!req.body.legalName || !req.body.legalName.trim()) throw new AppError(400, 'Legal name is required.');
  if (req.body.pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(req.body.pan.trim().toUpperCase())) {
    throw new AppError(400, 'PAN format looks invalid (expected 10 characters, e.g. AAACA1234A).');
  }
  mutate(db => {
    const company = db.companies.find(c => c.id === currentCompanyId(req));
    Object.assign(company, {
      legalName: req.body.legalName.trim(), tradeName: req.body.tradeName,
      pan: fieldCrypto.encrypt((req.body.pan || '').trim().toUpperCase()),
      address: req.body.address,
      bankDetails: fieldCrypto.encrypt(req.body.bankDetails || '')
    });
    recordAudit(db, auditFromReq(req, 'company-profile-updated', ''));
  });
  res.redirect('/companies');
}));

app.get('/gstins/new', (req, res) => {
  res.render('gstins/new', { error: null });
});

app.post('/gstins', requireWrite, ah((req, res) => {
  const companyId = currentCompanyId(req);
  const { stateCode, scheme } = req.body;
  const gstin = (req.body.gstin || '').trim().toUpperCase();
  if (!hasValidStructure(gstin)) {
    return res.render('gstins/new', { error: 'GSTIN must be 15 characters in the standard format (2-digit state code + PAN + entity code + Z + check digit).' });
  }
  if (!isValidGstin(gstin)) {
    return res.render('gstins/new', { error: "That GSTIN's check digit doesn't match -- please double-check it for typos (this catches most data-entry mistakes)." });
  }
  mutate(db => {
    const id = nextId(db, 'gstins');
    db.gstins.push({ id, companyId, gstin, stateCode, scheme, invoiceSeries: { INV: 0, CN: 0, DN: 0 } });
    recordAudit(db, auditFromReq(req, 'gstin-added', gstin));
  });
  res.redirect('/companies');
}));

// ------------------------------------------------------------- MASTERS ----
app.get('/masters/parties', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const type = req.query.type === 'vendor' ? 'vendor' : 'customer';
  const q = (req.query.q || '').trim().toLowerCase();
  const showInactive = req.query.showInactive === 'on';
  const parties = db.parties.filter(p =>
    p.companyId === companyId && p.type === type &&
    (showInactive || p.active !== false) &&
    (!q || p.name.toLowerCase().includes(q))
  );
  res.render('masters/parties', { parties, type, q: req.query.q || '', showInactive });
}));

function validatePartyGstin(gstinRaw) {
  const gstin = (gstinRaw || '').trim().toUpperCase();
  if (!gstin) return { gstin: '' };
  if (!hasValidStructure(gstin)) throw new AppError(400, 'GSTIN format looks invalid (expected the standard 15-character format).');
  if (!isValidGstin(gstin)) throw new AppError(400, "That GSTIN's check digit doesn't match -- please double-check it for typos.");
  return { gstin };
}

app.post('/masters/parties', requireWrite, ah((req, res) => {
  const { type, name, address, stateCode, isRegistered } = req.body;
  if (!name || !name.trim()) throw new AppError(400, 'Name is required.');
  const { gstin } = validatePartyGstin(req.body.gstin);
  const companyId = currentCompanyId(req);
  mutate(db => {
    const id = nextId(db, 'parties');
    db.parties.push({
      id, companyId, type, name: name.trim(), active: true,
      gstin, address,
      stateCode,
      isRegistered: isRegistered === 'on' || !!gstin
    });
  });
  res.redirect(`/masters/parties?type=${type}`);
}));

app.get('/masters/parties/:id/edit', ah((req, res) => {
  const db = req.db;
  const party = db.parties.find(p => p.id === Number(req.params.id) && p.companyId === currentCompanyId(req));
  if (!party) throw new AppError(404, 'Party not found.');
  res.render('masters/party-edit', { party });
}));

app.post('/masters/parties/:id', requireWrite, ah((req, res) => {
  const { name, address, stateCode, isRegistered } = req.body;
  if (!name || !name.trim()) throw new AppError(400, 'Name is required.');
  const { gstin } = validatePartyGstin(req.body.gstin);
  let type = 'customer';
  mutate(db => {
    const party = db.parties.find(p => p.id === Number(req.params.id) && p.companyId === currentCompanyId(req));
    if (!party) throw new AppError(404, 'Party not found.');
    Object.assign(party, { name: name.trim(), gstin, address, stateCode, isRegistered: isRegistered === 'on' || !!gstin });
    type = party.type;
  });
  res.redirect(`/masters/parties?type=${type}`);
}));

app.post('/masters/parties/:id/toggle-active', requireWrite, ah((req, res) => {
  let type = 'customer';
  mutate(db => {
    const party = db.parties.find(p => p.id === Number(req.params.id) && p.companyId === currentCompanyId(req));
    if (!party) throw new AppError(404, 'Party not found.');
    party.active = party.active === false ? true : false;
    type = party.type;
  });
  res.redirect(`/masters/parties?type=${type}`);
}));

app.get('/masters/products', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const q = (req.query.q || '').trim().toLowerCase();
  const showInactive = req.query.showInactive === 'on';
  const products = db.products.filter(p =>
    p.companyId === companyId &&
    (showInactive || p.active !== false) &&
    (!q || p.description.toLowerCase().includes(q))
  );
  const presets = db.gstPresets.filter(p => p.companyId === companyId);
  res.render('masters/products', { products, presets, q: req.query.q || '', showInactive });
}));

app.post('/masters/products', requireWrite, ah((req, res) => {
  const { description, hsnSac, unit, rate, defaultPresetLabel } = req.body;
  if (!description || !description.trim()) throw new AppError(400, 'Description is required.');
  if (!hsnSac || !hsnSac.trim()) throw new AppError(400, 'HSN/SAC code is required.');
  const rateNum = requirePositiveNumber(rate, 'Rate');
  const companyId = currentCompanyId(req);
  mutate(db => {
    const id = nextId(db, 'products');
    db.products.push({ id, companyId, active: true, description: description.trim(), hsnSac: hsnSac.trim(), unit, rate: rateNum, defaultPresetLabel });
  });
  res.redirect('/masters/products');
}));

app.get('/masters/products/:id/edit', ah((req, res) => {
  const db = req.db;
  const product = db.products.find(p => p.id === Number(req.params.id) && p.companyId === currentCompanyId(req));
  if (!product) throw new AppError(404, 'Product not found.');
  const presets = db.gstPresets.filter(p => p.companyId === currentCompanyId(req));
  res.render('masters/product-edit', { product, presets });
}));

app.post('/masters/products/:id', requireWrite, ah((req, res) => {
  const { description, hsnSac, unit, rate, defaultPresetLabel } = req.body;
  if (!description || !description.trim()) throw new AppError(400, 'Description is required.');
  const rateNum = requirePositiveNumber(rate, 'Rate');
  mutate(db => {
    const product = db.products.find(p => p.id === Number(req.params.id) && p.companyId === currentCompanyId(req));
    if (!product) throw new AppError(404, 'Product not found.');
    Object.assign(product, { description: description.trim(), hsnSac, unit, rate: rateNum, defaultPresetLabel });
  });
  res.redirect('/masters/products');
}));

app.post('/masters/products/:id/toggle-active', requireWrite, ah((req, res) => {
  mutate(db => {
    const product = db.products.find(p => p.id === Number(req.params.id) && p.companyId === currentCompanyId(req));
    if (!product) throw new AppError(404, 'Product not found.');
    product.active = product.active === false ? true : false;
  });
  res.redirect('/masters/products');
}));

app.get('/masters/presets', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const presets = db.gstPresets.filter(p => p.companyId === companyId);
  res.render('masters/presets', { presets });
}));

app.post('/masters/presets', requireWrite, ah((req, res) => {
  const { label, scheme, rate } = req.body;
  if (!label || !label.trim()) throw new AppError(400, 'Label is required.');
  const rateNum = requirePositiveNumber(rate, 'Rate');
  const companyId = currentCompanyId(req);
  mutate(db => {
    const id = nextId(db, 'gstPresets');
    db.gstPresets.push({ id, companyId, label: label.trim(), scheme, rate: rateNum });
  });
  res.redirect('/masters/presets');
}));

// ------------------------------------------------------------ API (form data for invoice builder) ----
app.get('/api/context', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  res.json({
    gstins: companyGstins(db, companyId),
    customers: db.parties.filter(p => p.companyId === companyId && p.type === 'customer' && p.active !== false),
    products: db.products.filter(p => p.companyId === companyId && p.active !== false),
    presets: db.gstPresets.filter(p => p.companyId === companyId),
    stateCodes: STATE_CODES
  });
}));

// ----------------------------------------------------------- INVOICES ----
app.get('/invoices', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const { period, gstinId } = req.query;
  const allRows = reports.buildSalesRegister(db, { companyId, period, gstinId });
  const page = reports.paginate(allRows, req.query.page, 25);
  const totals = page.rows.reduce((a, r) => ({
    taxableValue: round2(a.taxableValue + r.taxableValue),
    tax: round2(a.tax + r.cgst + r.sgst + r.igst),
    total: round2(a.total + r.total)
  }), { taxableValue: 0, tax: 0, total: 0 });
  res.render('invoices/index', { page, totals, period: period || '', gstinId: gstinId || '', gstins: companyGstins(db, companyId) });
}));

app.get('/invoices/export.csv', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const { period, gstinId } = req.query;
  const rows = reports.buildSalesRegister(db, { companyId, period, gstinId });
  const csv = toCsv(rows, [
    { key: 'invoiceNo', label: 'Invoice No' }, { key: 'date', label: 'Date' }, { key: 'type', label: 'Type' },
    { key: 'partyName', label: 'Party' }, { key: 'taxableValue', label: 'Taxable Value' },
    { key: 'cgst', label: 'CGST' }, { key: 'sgst', label: 'SGST' }, { key: 'igst', label: 'IGST' },
    { key: 'total', label: 'Total' }, { key: 'status', label: 'Status' }
  ]);
  sendCsv(res, `sales-register_${period || 'all'}.csv`, csv);
}));

app.get('/invoices/new', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const gstins = companyGstins(db, companyId);
  if (!gstins.length) throw new AppError(400, 'Add a GSTIN under Companies before creating invoices.');

  let prefill = null;
  const againstId = Number(req.query.against);
  if (againstId) {
    const source = db.invoices.find(i => i.id === againstId && i.companyId === companyId);
    if (source) {
      prefill = {
        sourceInvoiceNo: source.invoiceNo,
        gstinId: source.gstinId,
        type: 'credit_note',
        partyId: source.partyId,
        placeOfSupplyStateCode: source.placeOfSupplyStateCode,
        lineItems: source.lineItems.map(li => ({
          description: li.description, hsnSac: li.hsnSac, unit: li.unit,
          qty: li.qty, rate: li.rate, presetId: li.presetId
        }))
      };
    }
  }
  res.render('invoices/new', { gstins, today: new Date().toISOString().slice(0, 10), prefill });
}));

app.post('/invoices', requireWrite, ah((req, res) => {
  const companyId = currentCompanyId(req);
  const body = req.body;
  const db = req.db;
  const gstin = db.gstins.find(g => g.id === Number(body.gstinId) && g.companyId === companyId);
  if (!gstin) throw new AppError(400, 'Invalid GSTIN selection.');

  let party = db.parties.find(p => p.id === Number(body.partyId) && p.companyId === companyId);
  if (body.partyId && !party) throw new AppError(400, 'Invalid customer selection.');
  const placeOfSupplyStateCode = body.placeOfSupplyStateCode || (party ? party.stateCode : gstin.stateCode);
  const interState = isInterState(gstin.stateCode, placeOfSupplyStateCode);

  const descriptions = [].concat(body.description || []);
  const hsnSacs = [].concat(body.hsnSac || []);
  const units = [].concat(body.unit || []);
  const qtys = [].concat(body.qty || []);
  const rates = [].concat(body.rate || []);
  const presetIds = [].concat(body.presetId || []);

  const lineItems = [];
  for (let i = 0; i < descriptions.length; i++) {
    if (!descriptions[i]) continue;
    const qty = Number(qtys[i]);
    const rate = Number(rates[i]);
    if (!isFinite(qty) || qty <= 0) throw new AppError(400, `Line ${i + 1}: quantity must be a positive number.`);
    if (!isFinite(rate) || rate < 0) throw new AppError(400, `Line ${i + 1}: rate must be a non-negative number.`);
    const preset = db.gstPresets.find(p => p.id === Number(presetIds[i]) && p.companyId === companyId);
    const calc = calcLine({ qty, rate, preset, interState });
    lineItems.push({
      description: descriptions[i], hsnSac: hsnSacs[i], unit: units[i],
      qty, rate,
      presetId: preset ? preset.id : null, presetLabel: preset ? preset.label : '',
      cgstRate: (!interState && preset && preset.scheme === 'regular') ? preset.rate / 2 : 0,
      sgstRate: (!interState && preset && preset.scheme === 'regular') ? preset.rate / 2 : 0,
      igstRate: (interState && preset && preset.scheme === 'regular') ? preset.rate : 0,
      ...calc
    });
  }
  if (!lineItems.length) throw new AppError(400, 'At least one line item is required.');

  const series = body.type === 'credit_note' ? 'CN' : body.type === 'debit_note' ? 'DN' : 'INV';
  const totals = sumTotals(lineItems);
  const dateStr = body.date || new Date().toISOString().slice(0, 10);

  const newId = mutate(freshDb => {
    const freshGstin = freshDb.gstins.find(g => g.id === gstin.id);
    freshGstin.invoiceSeries[series] = (freshGstin.invoiceSeries[series] || 0) + 1;
    const invoiceNo = `${series}-${String(freshGstin.invoiceSeries[series]).padStart(4, '0')}`;
    const id = nextId(freshDb, 'invoices');
    freshDb.invoices.push({
      id, companyId, gstinId: freshGstin.id, invoiceNo, series,
      type: body.type || 'tax_invoice',
      date: dateStr, period: dateStr.slice(0, 7),
      partyId: party ? party.id : null,
      placeOfSupplyStateCode, interState,
      reverseCharge: body.reverseCharge === 'on',
      lineItems, totals, einvoice: null, status: 'finalized'
    });
    return id;
  });
  res.redirect(`/invoices/${newId}`);
}));

app.get('/invoices/:id', ah((req, res) => {
  const db = req.db;
  const invoice = db.invoices.find(i => i.id === Number(req.params.id) && i.companyId === currentCompanyId(req));
  if (!invoice) throw new AppError(404, 'Invoice not found.');
  const gstin = db.gstins.find(g => g.id === invoice.gstinId);
  const company = db.companies.find(c => c.id === invoice.companyId);
  const party = db.parties.find(p => p.id === invoice.partyId);
  const aato = round2((company.priorFyAato || 0) + reports.invoicesFor(db, { companyId: company.id }).reduce((s, i) => s + i.totals.total, 0));
  res.render('invoices/view', {
    invoice, gstin, party,
    company: { ...company, bankDetails: fieldCrypto.decrypt(company.bankDetails) },
    hsnRequired: hsnDigitsRequired(aato),
    einvoiceApplicable: aato >= EINVOICE_AATO_THRESHOLD
  });
}));

// NOTE on this route's write pattern: the mock IRN/QR generation below is async
// (await), so we deliberately do NOT hold the request-scoped `req.db` snapshot
// across that await and save it afterwards -- that would silently lose any
// write made by another request during the await (classic lost-update race).
// Instead we compute the e-invoice result first, then apply it via mutate(),
// which does a fresh synchronous load-mutate-save with no await inside it.
app.post('/invoices/:id/einvoice', requireWrite, ah(async (req, res) => {
  const db = req.db;
  const invoice = db.invoices.find(i => i.id === Number(req.params.id) && i.companyId === currentCompanyId(req));
  if (!invoice) throw new AppError(404, 'Invoice not found.');
  if (invoice.status === 'cancelled') throw new AppError(400, 'This document is cancelled.');
  const gstin = db.gstins.find(g => g.id === invoice.gstinId);
  const company = db.companies.find(c => c.id === invoice.companyId);
  const party = db.parties.find(p => p.id === invoice.partyId) || { name: 'Unregistered', gstin: '', address: '', stateCode: invoice.placeOfSupplyStateCode };

  const einvoiceResult = await generateMockIRN({ invoice, gstin, supplier: company, party });

  mutate(freshDb => {
    const freshInvoice = freshDb.invoices.find(i => i.id === invoice.id);
    if (freshInvoice) freshInvoice.einvoice = einvoiceResult;
    recordAudit(freshDb, auditFromReq(req, 'einvoice-generated', `${invoice.invoiceNo} -> IRN ${einvoiceResult.irn.slice(0, 12)}...`));
  });
  res.redirect(`/invoices/${invoice.id}`);
}));

app.post('/invoices/:id/einvoice/cancel', requireWrite, ah((req, res) => {
  mutate(db => {
    const invoice = db.invoices.find(i => i.id === Number(req.params.id) && i.companyId === currentCompanyId(req));
    if (invoice && invoice.einvoice) {
      invoice.einvoice.cancelled = true;
      invoice.einvoice.cancelledAt = new Date().toISOString();
      invoice.einvoice.status = 'cancelled';
      recordAudit(db, auditFromReq(req, 'einvoice-cancelled', invoice.invoiceNo));
    }
  });
  res.redirect(`/invoices/${req.params.id}`);
}));

app.post('/invoices/:id/cancel', requireWrite, ah((req, res) => {
  mutate(db => {
    const invoice = db.invoices.find(i => i.id === Number(req.params.id) && i.companyId === currentCompanyId(req));
    if (!invoice) throw new AppError(404, 'Invoice not found.');
    invoice.status = 'cancelled';
    invoice.cancelReason = (req.body.reason || '').slice(0, 500);
    invoice.cancelledAt = new Date().toISOString();
    recordAudit(db, auditFromReq(req, 'invoice-cancelled', `${invoice.invoiceNo}: ${invoice.cancelReason}`));
  });
  res.redirect(`/invoices/${req.params.id}`);
}));

// -------------------------------------------------------------- GSTR-1 ----
app.get('/gstr1', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const period = req.query.period || currentPeriod();
  const gstinId = req.query.gstinId || '';
  const draft = reports.buildGstr1Draft(db, { companyId, gstinId, period });
  res.render('gstr1/index', { draft, period, gstinId, gstins: companyGstins(db, companyId) });
}));

app.get('/gstr1/export.json', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const period = req.query.period || currentPeriod();
  const gstinId = req.query.gstinId || '';
  const draft = reports.buildGstr1Draft(db, { companyId, gstinId, period });
  res.setHeader('Content-Disposition', `attachment; filename="GSTR1_${period}.json"`);
  res.json({ period, gstinId: gstinId || 'all', generatedAt: new Date().toISOString(), ...draft });
}));

// -------------------------------------------------------------- GSTR-3B ----
app.get('/gstr3b', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const period = req.query.period || currentPeriod();
  const gstinId = req.query.gstinId || '';
  const outward = reports.buildGstr1Draft(db, { companyId, gstinId, period }).totals;
  const purchases = db.purchaseInvoices.filter(p => p.companyId === companyId && p.period === period && (!gstinId));
  const itcAvailable = {
    igst: round2(purchases.filter(p => p.itcEligible).reduce((s, p) => s + p.igst, 0)),
    cgst: round2(purchases.filter(p => p.itcEligible).reduce((s, p) => s + p.cgst, 0)),
    sgst: round2(purchases.filter(p => p.itcEligible).reduce((s, p) => s + p.sgst, 0))
  };
  const saved = db.returnPeriods.find(r => r.companyId === companyId && r.period === period);
  const locked = !!(saved && saved.locked);
  res.render('gstr3b/index', { outward, itcAvailable, period, gstinId, gstins: companyGstins(db, companyId), saved, locked });
}));

app.get('/gstr3b/export.csv', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const period = req.query.period || currentPeriod();
  const outward = reports.buildGstr1Draft(db, { companyId, period }).totals;
  const purchases = db.purchaseInvoices.filter(p => p.companyId === companyId && p.period === period);
  const itcAvailable = {
    igst: round2(purchases.filter(p => p.itcEligible).reduce((s, p) => s + p.igst, 0)),
    cgst: round2(purchases.filter(p => p.itcEligible).reduce((s, p) => s + p.cgst, 0)),
    sgst: round2(purchases.filter(p => p.itcEligible).reduce((s, p) => s + p.sgst, 0))
  };
  const saved = db.returnPeriods.find(r => r.companyId === companyId && r.period === period);
  const itcClaimed = saved ? saved.itcClaimed : itcAvailable;
  const { netPayable, itcClosingBalance } = computeItcSetOff({ liability: outward, itcClaimed });
  const rows = [
    { label: 'Outward taxable value', igst: '', cgst: '', sgst: '', total: outward.taxableValue },
    { label: 'Outward tax liability', igst: outward.igst, cgst: outward.cgst, sgst: outward.sgst, total: round2(outward.igst + outward.cgst + outward.sgst) },
    { label: 'ITC available', igst: itcAvailable.igst, cgst: itcAvailable.cgst, sgst: itcAvailable.sgst, total: round2(itcAvailable.igst + itcAvailable.cgst + itcAvailable.sgst) },
    { label: 'ITC claimed', igst: itcClaimed.igst, cgst: itcClaimed.cgst, sgst: itcClaimed.sgst, total: round2(Number(itcClaimed.igst) + Number(itcClaimed.cgst) + Number(itcClaimed.sgst)) },
    { label: 'Net payable in cash', igst: netPayable.igst, cgst: netPayable.cgst, sgst: netPayable.sgst, total: round2(netPayable.igst + netPayable.cgst + netPayable.sgst) },
    { label: 'Closing ITC balance', igst: itcClosingBalance.igst, cgst: itcClosingBalance.cgst, sgst: itcClosingBalance.sgst, total: round2(itcClosingBalance.igst + itcClosingBalance.cgst + itcClosingBalance.sgst) }
  ];
  const csv = toCsv(rows, [{ key: 'label', label: '' }, { key: 'igst', label: 'IGST' }, { key: 'cgst', label: 'CGST' }, { key: 'sgst', label: 'SGST' }, { key: 'total', label: 'Total' }]);
  sendCsv(res, `GSTR3B_${period}.csv`, csv);
}));

app.post('/gstr3b', requireWrite, ah((req, res) => {
  const companyId = currentCompanyId(req);
  const { period, itcClaimedIgst, itcClaimedCgst, itcClaimedSgst, lock } = req.body;
  if (!period) throw new AppError(400, 'Period is required.');
  const itcClaimed = {
    igst: requirePositiveNumber(itcClaimedIgst || 0, 'ITC claimed (IGST)'),
    cgst: requirePositiveNumber(itcClaimedCgst || 0, 'ITC claimed (CGST)'),
    sgst: requirePositiveNumber(itcClaimedSgst || 0, 'ITC claimed (SGST)')
  };
  mutate(db => {
    let rec = db.returnPeriods.find(r => r.companyId === companyId && r.period === period);
    if (rec && rec.locked) throw new AppError(400, `GSTR-3B for ${period} is already locked.`);
    if (!rec) {
      rec = { id: nextId(db, 'returnPeriods'), companyId, period, itcClaimed, locked: false };
      db.returnPeriods.push(rec);
    } else {
      rec.itcClaimed = itcClaimed;
    }
    if (lock === 'on') {
      rec.locked = true;
      recordAudit(db, auditFromReq(req, 'gstr3b-locked', period));
    } else {
      recordAudit(db, auditFromReq(req, 'gstr3b-saved', period));
    }
  });
  res.redirect(`/gstr3b?period=${period}`);
}));

// --------------------------------------------------------- RECONCILIATION ----
app.get('/reconciliation', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const period = req.query.period || currentPeriod();
  const gstinId = req.query.gstinId || '';
  const einvoiceRecon = reports.buildEinvoiceReconciliation(db, { companyId, gstinId, period });
  const purchaseRecon = reports.buildPurchaseReconciliation(db, { companyId, period });
  res.render('reconciliation/index', { einvoiceRecon, purchaseRecon, period, gstinId, gstins: companyGstins(db, companyId) });
}));

app.post('/reconciliation/generate-2b', requireWrite, ah((req, res) => {
  const companyId = currentCompanyId(req);
  const period = req.body.period || currentPeriod();
  mutate(db => {
    db.gstr2b = db.gstr2b.filter(g => !(g.companyId === companyId && g.period === period));
    const purchases = db.purchaseInvoices.filter(p => p.companyId === companyId && p.period === period);

    purchases.forEach((p, idx) => {
      if (idx === 0 && purchases.length > 1) return; // simulate "missing in GSTR-2B" for the first entry
      const vendor = db.parties.find(v => v.id === p.vendorId);
      let total = p.total;
      if (idx === 1) total = round2(total + 250); // simulate a value mismatch
      db.gstr2b.push({
        id: nextId(db, 'gstr2b'), companyId, period,
        invoiceNo: p.invoiceNo, vendorName: vendor ? vendor.name : '(unknown)',
        total
      });
    });
    db.gstr2b.push({ id: nextId(db, 'gstr2b'), companyId, period, invoiceNo: 'UNBOOKED-9001', vendorName: 'Unbooked Vendor Pvt Ltd', total: 11800 });
  });
  res.redirect(`/reconciliation?period=${period}`);
}));

app.get('/masters/purchases', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const purchases = db.purchaseInvoices.filter(p => p.companyId === companyId);
  const vendors = db.parties.filter(p => p.companyId === companyId && p.type === 'vendor' && p.active !== false);
  res.render('masters/purchases', { purchases, vendors, vendorName: (id) => (db.parties.find(v => v.id === id) || {}).name });
}));

app.get('/masters/purchases/export.csv', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const purchases = db.purchaseInvoices.filter(p => p.companyId === companyId).map(p => ({
    ...p, vendorName: (db.parties.find(v => v.id === p.vendorId) || {}).name || '(unknown)'
  }));
  const csv = toCsv(purchases, [
    { key: 'vendorName', label: 'Vendor' }, { key: 'invoiceNo', label: 'Invoice No' }, { key: 'date', label: 'Date' },
    { key: 'taxableValue', label: 'Taxable Value' }, { key: 'cgst', label: 'CGST' }, { key: 'sgst', label: 'SGST' },
    { key: 'igst', label: 'IGST' }, { key: 'total', label: 'Total' }, { key: 'itcEligible', label: 'ITC Eligible' }
  ]);
  sendCsv(res, 'purchase-register.csv', csv);
}));

app.post('/masters/purchases', requireWrite, ah((req, res) => {
  const { vendorId, invoiceNo, date, taxableValue, rate, interState, itcEligible } = req.body;
  if (!invoiceNo || !invoiceNo.trim()) throw new AppError(400, 'Vendor invoice number is required.');
  if (!date) throw new AppError(400, 'Date is required.');
  const tv = requirePositiveNumber(taxableValue, 'Taxable value');
  const r = requirePositiveNumber(rate || 0, 'GST rate');
  const companyId = currentCompanyId(req);
  const vendor = req.db.parties.find(v => v.id === Number(vendorId) && v.companyId === companyId && v.type === 'vendor');
  if (!vendor) throw new AppError(400, 'Invalid vendor selection.');
  mutate(db => {
    let cgst = 0, sgst = 0, igst = 0;
    if (interState === 'on') igst = round2(tv * r / 100);
    else { cgst = round2(tv * r / 2 / 100); sgst = cgst; }
    const id = nextId(db, 'purchaseInvoices');
    db.purchaseInvoices.push({
      id, companyId, vendorId: vendor.id, invoiceNo: invoiceNo.trim(), date, period: date.slice(0, 7),
      taxableValue: tv, cgst, sgst, igst, total: round2(tv + cgst + sgst + igst),
      itcEligible: itcEligible === 'on'
    });
  });
  res.redirect('/masters/purchases');
}));

// ------------------------------------------------------------- REPORTS ----
app.get('/reports/party-wise', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const { period, gstinId } = req.query;
  const rows = reports.buildPartyWise(db, { companyId, period, gstinId });
  res.render('reports/party-wise', { rows, period: period || '', gstinId: gstinId || '', gstins: companyGstins(db, companyId) });
}));

app.get('/reports/party-wise/export.csv', ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const { period, gstinId } = req.query;
  const rows = reports.buildPartyWise(db, { companyId, period, gstinId });
  const csv = toCsv(rows, [
    { key: 'partyName', label: 'Party' }, { key: 'gstin', label: 'GSTIN' }, { key: 'invoiceCount', label: 'Invoices' },
    { key: 'taxableValue', label: 'Taxable Value' }, { key: 'tax', label: 'Tax' }, { key: 'total', label: 'Total' }
  ]);
  sendCsv(res, `party-wise_${period || 'all'}.csv`, csv);
}));

// ---------------------------------------------------------------- USERS ----
app.get('/users', requireOwner, ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const users = db.users.filter(u => u.companyId === companyId);
  res.render('users/index', { users, error: null });
}));

app.post('/users', requireOwner, ah((req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !name.trim()) throw new AppError(400, 'Name is required.');
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError(400, 'A valid email is required.');
  if (!password || password.length < 6) throw new AppError(400, 'Password must be at least 6 characters.');
  if (!['owner', 'accountant', 'ca', 'viewer'].includes(role)) throw new AppError(400, 'Invalid role.');
  const companyId = currentCompanyId(req);

  const db = req.db;
  if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).render('users/index', {
      users: db.users.filter(u => u.companyId === companyId),
      error: 'A user with that email already exists.'
    });
  }
  mutate(freshDb => {
    const { salt, hash } = hashPassword(password);
    const id = nextId(freshDb, 'users');
    freshDb.users.push({ id, name: name.trim(), email: email.toLowerCase(), salt, hash, role, companyId, active: true });
    recordAudit(freshDb, auditFromReq(req, 'user-created', `${email.toLowerCase()} (${role})`));
  });
  res.redirect('/users');
}));

app.post('/users/:id/toggle-active', requireOwner, ah((req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.session.user.id) throw new AppError(400, "You can't deactivate your own account.");
  mutate(db => {
    const user = db.users.find(u => u.id === targetId && u.companyId === currentCompanyId(req));
    if (!user) throw new AppError(404, 'User not found.');
    user.active = user.active === false ? true : false;
    recordAudit(db, auditFromReq(req, user.active ? 'user-reactivated' : 'user-deactivated', user.email));
  });
  res.redirect('/users');
}));

// --------------------------------------------------------------- AUDIT ----
app.get('/audit', requireOwner, ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  const entries = (db.auditLog || [])
    .filter(e => e.companyId === companyId)
    .slice()
    .reverse()
    .slice(0, 500);
  res.render('audit/index', { entries });
}));

// -------------------------------------------------------------- BACKUP ----
app.get('/settings/backup', requireOwner, (req, res) => {
  res.render('settings/backup');
});

app.get('/settings/backup/download', requireOwner, ah((req, res) => {
  const db = req.db;
  const companyId = currentCompanyId(req);
  // Scope every collection to this tenant. This used to dump the entire multi-tenant
  // file (every company's data) -- fixed here because a backup endpoint is exactly the
  // kind of route where a missed companyId filter turns into a cross-tenant data leak.
  const scoped = {
    exportedAt: new Date().toISOString(),
    company: db.companies.find(c => c.id === companyId),
    gstins: db.gstins.filter(g => g.companyId === companyId),
    parties: db.parties.filter(p => p.companyId === companyId),
    products: db.products.filter(p => p.companyId === companyId),
    gstPresets: db.gstPresets.filter(p => p.companyId === companyId),
    invoices: db.invoices.filter(i => i.companyId === companyId),
    purchaseInvoices: db.purchaseInvoices.filter(p => p.companyId === companyId),
    gstr2b: db.gstr2b.filter(g => g.companyId === companyId),
    returnPeriods: db.returnPeriods.filter(r => r.companyId === companyId),
    users: db.users.filter(u => u.companyId === companyId).map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active })) // never export password hashes/salts
  };
  mutate(freshDb => recordAudit(freshDb, auditFromReq(req, 'backup-downloaded', '')));
  res.setHeader('Content-Disposition', `attachment; filename="qe3-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(scoped);
}));

// ------------------------------------------------------------------ 404 ----
app.use((req, res, next) => {
  next(new AppError(404, `No page found at ${req.path}`));
});

// ------------------------------------------------------- ERROR HANDLER ----
// Centralized so no route ever needs to worry about leaking a stack trace or
// hanging on an unhandled rejection -- ah() above funnels every error here.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).render('error', {
    title: status === 404 ? 'Not found' : status === 403 ? 'Not allowed' : 'Something went wrong',
    message: (status < 500 || !isProd) ? err.message : 'An unexpected error occurred. Please try again.'
  });
});

const server = app.listen(PORT, () => {
  console.log(`QE3 GST Platform running at http://localhost:${PORT}`);
});

// Graceful shutdown: stop accepting new connections, let in-flight requests finish,
// then exit. Matters once this runs under a process manager / orchestrator that sends
// SIGTERM on deploy or scale-down -- without this, requests get cut off mid-response.
function shutdown(signal) {
  console.log(`[qe3] ${signal} received, shutting down...`);
  server.close(() => {
    console.log('[qe3] closed out remaining connections.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[qe3] forcing shutdown after 10s timeout.');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
