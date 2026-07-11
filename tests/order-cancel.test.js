const request = require('supertest');
const app = require('../src/app');
const { pool } = require('../src/db/pool');
const { resetDatabase, getInventoryQuantity, getStatusHistory } = require('./helpers/db');

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await pool.end();
});

async function createOrder(customerId, itemId = 1, quantity = 1) {
  const res = await request(app)
    .post('/order')
    .send({
      customer_id: customerId,
      payment_mode: 'UPI',
      payment_status: 'COMPLETE',
      items: [{ item_id: itemId, quantity }],
    });
  return res.body;
}

describe('PATCH /order/:id/cancel', () => {
  test('cancels a PENDING order and restores inventory', async () => {
    const before = await getInventoryQuantity(1);
    const order = await createOrder('cust-cancel-1', 1, 3);
    expect(await getInventoryQuantity(1)).toBe(before - 3);

    const res = await request(app).patch(`/order/${order.id}/cancel`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(await getInventoryQuantity(1)).toBe(before);

    const history = await getStatusHistory(order.id);
    expect(history).toContainEqual({
      from_status: 'PENDING',
      to_status: 'CANCELLED',
      changed_by: 'CUSTOMER',
    });
  });

  test('rejects cancelling an already-cancelled order with 409', async () => {
    const order = await createOrder('cust-cancel-2');
    await request(app).patch(`/order/${order.id}/cancel`);

    const res = await request(app).patch(`/order/${order.id}/cancel`);

    expect(res.status).toBe(409);
    expect(res.body.details.status).toBe('CANCELLED');
  });

  test('unknown id returns 404', async () => {
    const res = await request(app).patch('/order/999999/cancel');
    expect(res.status).toBe(404);
  });
});
