/**
 * Validation middleware factory. Routes declare zod schemas per request part:
 *
 *   router.post('/', validate({ body: createOrderSchema }), handler)
 *
 * Parsed (and coerced) values replace the originals, so handlers always see
 * clean, typed input. ZodErrors fall through to the error handler → 400.
 */
function validate({ body, query, params } = {}) {
  return (req, res, next) => {
    try {
      if (body) req.body = body.parse(req.body);
      if (query) req.query = query.parse(req.query);
      if (params) req.params = params.parse(req.params);
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { validate };
