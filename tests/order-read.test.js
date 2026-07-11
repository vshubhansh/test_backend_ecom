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

async function createOrder(customerId, itemId = 1) {
  const res = await request(app)
    .post('/order')
    .send({
      customer_id: customerId,
      payment_mode: 'UPI',
      payment_status: 'COMPLETE',
      items: [{ item_id: itemId, quantity: 1 }],
    });
  return res.body;
}

describe('GET /order', () => {
  test('default (no filter) excludes CANCELLED orders', async () => {
    const live = await createOrder('cust-list-1');
    const cancelled = await createOrder('cust-list-2');
    await request(app).patch(`/order/${cancelled.id}/cancel`);

    const res = await request(app).get('/order');

    expect(res.status).toBe(200);
    const ids = res.body.map((o) => o.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(cancelled.id);
  });

  test('?order_status=CANCELLED returns only cancelled orders', async () => {
    const live = await createOrder('cust-list-3');
    const cancelled = await createOrder('cust-list-4');
    await request(app).patch(`/order/${cancelled.id}/cancel`);

    const res = await request(app).get('/order').query({ order_status: 'CANCELLED' });

    expect(res.status).toBe(200);
    const ids = res.body.map((o) => o.id);
    expect(ids).toContain(cancelled.id);
    expect(ids).not.toContain(live.id);
  });

  test('limit/offset produce non-overlapping pages', async () => {
    const first = await createOrder('cust-page-1');
    const second = await createOrder('cust-page-2');
    const third = await createOrder('cust-page-3');

    const page1 = await request(app).get('/order').query({ limit: 1, offset: 0 });
    const page2 = await request(app).get('/order').query({ limit: 1, offset: 1 });

    // Default ordering is order_date DESC, id DESC -> most recently created first.
    expect(page1.body).toHaveLength(1);
    expect(page2.body).toHaveLength(1);
    expect(page1.body[0].id).toBe(third.id);
    expect(page2.body[0].id).toBe(second.id);
    expect(page1.body[0].id).not.toBe(page2.body[0].id);
    void first;
  });

  test('?order_status=bogus is rejected with 400', async () => {
    const res = await request(app).get('/order').query({ order_status: 'bogus' });
    expect(res.status).toBe(400);
  });
});

describe('GET /order/:id', () => {
  test('returns full item detail', async () => {
    const created = await createOrder('cust-detail-1');

    const res = await request(app).get(`/order/${created.id}`);

    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      item_id: 1,
      quantity: 1,
      shipment_number: null,
    });
    expect(res.body.items[0].item_price).toBeDefined();
  });

  test('unknown id returns 404', async () => {
    const res = await request(app).get('/order/999999');
    expect(res.status).toBe(404);
  });

  test('non-numeric id returns 400', async () => {
    const res = await request(app).get('/order/abc');
    expect(res.status).toBe(400);
  });
});
