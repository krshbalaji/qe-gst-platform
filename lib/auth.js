const crypto = require('crypto');

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
}

// Roles, from broadest to narrowest access
const ROLES = ['owner', 'accountant', 'ca', 'viewer'];
const CAN_WRITE = new Set(['owner', 'accountant']); // ca & viewer are read-only

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireWrite(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (!CAN_WRITE.has(req.session.user.role)) {
    return res.status(403).render('error', { title: 'Not allowed', message: 'Your role (' + req.session.user.role + ') has read-only access. Ask an Owner or Accountant to make this change.' });
  }
  next();
}

function requireOwner(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'owner') {
    return res.status(403).render('error', { title: 'Not allowed', message: 'Only the Owner role can manage users and account-level settings.' });
  }
  next();
}

module.exports = { hashPassword, verifyPassword, ROLES, CAN_WRITE, requireLogin, requireWrite, requireOwner };
