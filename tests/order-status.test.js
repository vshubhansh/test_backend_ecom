const request = require('supertest');
const app = require('../src/app');
const { pool } = require('../src/db/pool');
const { resetDatabase } = require('./helpers/db');

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await pool.end();
});

async function createOrder(customerId) {
  const res = await request(app)
    .post('/order')
    .send({
      customer_id: customerId,
      payment_mode: 'UPI',
      payment_status: 'COMPLETE',
      items: [{ item_id: 1, quantity: 1 }],
    });
  return res.body;
}

describe('PATCH /order/:id/status', () => {
  test('accepts the strict single-step chain PENDING -> PROCESSING -> SHIPPED -> DELIVERED', async () => {
    const order = await createOrder('cust-status-1');

    const toProcessing = await request(app).patch(`/order/${order.id}/status`).send({ status: 'PROCESSING' });
    expect(toProcessing.status).toBe(200);
    expect(toProcessing.body.status).toBe('PROCESSING');

    const toShipped = await request(app).patch(`/order/${order.id}/status`).send({ status: 'SHIPPED' });
    expect(toShipped.status).toBe(200);
    expect(toShipped.body.status).toBe('SHIPPED');

    const toDelivered = await request(app).patch(`/order/${order.id}/status`).send({ status: 'DELIVERED' });
    expect(toDelivered.status).toBe(200);
    expect(toDelivered.body.status).toBe('DELIVERED');
  });

  test('rejects a skip transition (PENDING -> SHIPPED) with 409', async () => {
    const order = await createOrder('cust-status-2');

    const res = await request(app).patch(`/order/${order.id}/status`).send({ status: 'SHIPPED' });

    expect(res.status).toBe(409);
  });

  test('rejects a backwards transition (SHIPPED -> PROCESSING) with 409', async () => {
    const order = await createOrder('cust-status-3');
    await request(app).patch(`/order/${order.id}/status`).send({ status: 'PROCESSING' });
    await request(app).patch(`/order/${order.id}/status`).send({ status: 'SHIPPED' });

    const res = await request(app).patch(`/order/${order.id}/status`).send({ status: 'PROCESSING' });

    expect(res.status).toBe(409);
  });

  test.each(['CANCELLED', 'PENDING'])('rejects disallowed target status %s with 400', async (status) => {
    const order = await createOrder('cust-status-4');

    const res = await request(app).patch(`/order/${order.id}/status`).send({ status });

    expect(res.status).toBe(400);
  });

  test('unknown id returns 404', async () => {
    const res = await request(app).patch('/order/999999/status').send({ status: 'PROCESSING' });
    expect(res.status).toBe(404);
  });
});
