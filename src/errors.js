// Typed application errors. Services throw these (semantics), the error
// middleware maps them to HTTP responses — no res.status() calls in services.
class AppError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

const badRequest = (message, details) => new AppError(400, message, details);
const notFound = (message, details) => new AppError(404, message, details);
const conflict = (message, details) => new AppError(409, message, details);
const serviceUnavailable = (message, details) => new AppError(503, message, details);

module.exports = { AppError, badRequest, notFound, conflict, serviceUnavailable };
