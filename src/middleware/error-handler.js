const { ZodError } = require('zod');
const { AppError } = require('../errors');

// Unmatched routes → 404 JSON instead of Express's default HTML page.
function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
}

// Centralized error mapping — the only place HTTP status codes meet errors.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    const body = { error: err.message };
    if (err.details !== undefined) body.details = err.details;
    return res.status(err.statusCode).json(body);
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.flatten().fieldErrors,
    });
  }

  // express.json() throws a SyntaxError with a status for malformed bodies.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }

  // Unknown failure: log the real error, never leak it to the client.
  console.error('[error]', err);
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { errorHandler, notFoundHandler };
