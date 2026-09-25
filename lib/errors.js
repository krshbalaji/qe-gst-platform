class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Wraps a route handler so a thrown error or a rejected Promise both land on
// next(err) instead of crashing the process or hanging the request forever.
// Use this on EVERY route (sync ones included -- Promise.resolve() on a
// synchronous return value is a no-op, so it's always safe to wrap).
function ah(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { AppError, ah };
