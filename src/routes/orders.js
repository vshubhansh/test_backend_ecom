const { Router } = require('express');
const { validate } = require('../middleware/validate');
const { createOrderSchema } = require('../schemas/order-schemas');
const { createOrder } = require('../services/order-service');

const router = Router();

router.post('/', validate({ body: createOrderSchema }), async (req, res, next) => {
  try {
    const order = await createOrder(req.body);
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
