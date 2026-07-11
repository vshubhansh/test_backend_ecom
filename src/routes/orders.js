const { Router } = require('express');
const { validate } = require('../middleware/validate');
const { createOrderSchema, orderIdParamSchema, listOrdersQuerySchema } = require('../schemas/order-schemas');
const { createOrder, getOrderById, listOrders, cancelOrder } = require('../services/order-service');

const router = Router();

router.post('/', validate({ body: createOrderSchema }), async (req, res, next) => {
  try {
    const order = await createOrder(req.body);
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});

router.get('/', validate({ query: listOrdersQuerySchema }), async (req, res, next) => {
  try {
    const orders = await listOrders(req.query);
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', validate({ params: orderIdParamSchema }), async (req, res, next) => {
  try {
    const order = await getOrderById(req.params.id);
    res.json(order);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/cancel', validate({ params: orderIdParamSchema }), async (req, res, next) => {
  try {
    const order = await cancelOrder(req.params.id);
    res.json(order);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
