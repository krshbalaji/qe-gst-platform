const crypto = require('crypto');

function ensureToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

/**
 * Attaches res.locals.csrfToken for every request (so any view can render the
 * hidden field), and rejects any POST/PUT/PATCH/DELETE whose body token
 * doesn't match the one tied to this session. No exemptions: express-session
 * already issues a session (and therefore a token) on the very first GET of
 * any page -- including /login and /signup -- because writing
 * req.session.csrfToken counts as "session modified" even with
 * saveUninitialized:false, so the token is always present on the form by the
 * time the user submits it.
 */
function csrfMiddleware(req, res, next) {
  res.locals.csrfToken = ensureToken(req);
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (mutating) {
    const supplied = req.body && req.body._csrf;
    if (!supplied || supplied !== req.session.csrfToken) {
      const err = new Error('This form has expired or the request looks forged (CSRF check failed). Go back and try again.');
      err.status = 403;
      return next(err);
    }
  }
  next();
}

module.exports = { csrfMiddleware, ensureToken };
