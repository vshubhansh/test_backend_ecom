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

function orderPayload(overrides = {}) {
  return {
    customer_id: 'cust-create-1',
    payment_mode: 'UPI',
    payment_status: 'COMPLETE',
    items: [{ item_id: 1, quantity: 2 }],
    ...overrides,
  };
}

describe('POST /order — happy path', () => {
  test('creates a single-item order with server-computed order_value', async () => {
    const before = await getInventoryQuantity(1);

    const res = await request(app).post('/order').send(orderPayload());

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.order_value).toBeCloseTo(1299.0 * 2, 2);
    expect(res.body.items).toHaveLength(1);

    const after = await getInventoryQuantity(1);
    expect(after).toBe(before - 2);

    const history = await getStatusHistory(res.body.id);
    expect(history).toEqual([{ from_status: 'NEW', to_status: 'PENDING', changed_by: 'CUSTOMER' }]);
  });

  test('creates a multi-item order', async () => {
    const res = await request(app)
      .post('/order')
      .send(
        orderPayload({
          items: [
            { item_id: 1, quantity: 1 },
            { item_id: 2, quantity: 1 },
          ],
        })
      );

    expect(res.status).toBe(201);
    expect(res.body.order_value).toBeCloseTo(1299.0 + 6499.0, 2);
    expect(res.body.items).toHaveLength(2);
  });
});

describe('POST /order — validation (400)', () => {
  test('rejects a missing required field', async () => {
    const payload = orderPayload();
    delete payload.payment_mode;

    const res = await request(app).post('/order').send(payload);
    expect(res.status).toBe(400);
  });

  test('rejects an empty items array', async () => {
    const res = await request(app).post('/order').send(orderPayload({ items: [] }));
    expect(res.status).toBe(400);
  });

  test('rejects an over-cap quantity', async () => {
    const res = await request(app)
      .post('/order')
      .send(orderPayload({ items: [{ item_id: 1, quantity: 10001 }] }));
    expect(res.status).toBe(400);
  });

  test('rejects a mismatched expected_order_value', async () => {
    const res = await request(app).post('/order').send(orderPayload({ expected_order_value: 1.0 }));
    expect(res.status).toBe(400);
  });
});

describe('POST /order — unknown item (404)', () => {
  test('rejects an unknown item_id', async () => {
    const res = await request(app)
      .post('/order')
      .send(orderPayload({ items: [{ item_id: 999999, quantity: 1 }] }));

    expect(res.status).toBe(404);
    expect(res.body.details.unknown_item_ids).toEqual([999999]);
  });
});

describe('POST /order — insufficient inventory (409)', () => {
  test('rejects an order for the sold-out item', async () => {
    const res = await request(app)
      .post('/order')
      .send(orderPayload({ items: [{ item_id: 6, quantity: 1 }] }));

    expect(res.status).toBe(409);
  });
});

describe('POST /order — concurrent create race on the last unit', () => {
  test('exactly one concurrent order wins the last unit of item 5', async () => {
    const requests = Array.from({ length: 5 }, (_, i) =>
      request(app)
        .post('/order')
        .send(orderPayload({ customer_id: `cust-race-${i}`, items: [{ item_id: 5, quantity: 1 }] }))
    );

    const results = await Promise.all(requests);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    expect(await getInventoryQuantity(5)).toBe(0);
  });
});
