const request = require('supertest');
const app = require('../src/app');
const { pool } = require('../src/db/pool');
const { promotePendingOrders, runWorkerTick } = require('../src/workers/order-status-worker');
const { resetDatabase, getStatusHistory } = require('./helpers/db');

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

describe('promotePendingOrders (direct tick, no timers)', () => {
  test('promotes every PENDING order to PROCESSING and writes history rows', async () => {
    const first = await createOrder('cust-worker-1');
    const second = await createOrder('cust-worker-2');

    const result = await promotePendingOrders();

    expect(result.promotedCount).toBe(2);
    expect(result.orderIds.sort()).toEqual([first.id, second.id].sort());

    for (const order of [first, second]) {
      const detail = await request(app).get(`/order/${order.id}`);
      expect(detail.body.status).toBe('PROCESSING');

      const history = await getStatusHistory(order.id);
      expect(history).toContainEqual({
        from_status: 'PENDING',
        to_status: 'PROCESSING',
        changed_by: 'SYSTEM',
      });
    }
  });

  test('a tick with zero PENDING orders is a no-op', async () => {
    const result = await promotePendingOrders();
    expect(result).toEqual({ promotedCount: 0, orderIds: [] });
  });
});

describe('runWorkerTick overlap guard', () => {
  test('a second tick fired before the first resolves is skipped', async () => {
    const order = await createOrder('cust-worker-3');

    const [firstResult, secondResult] = await Promise.all([runWorkerTick(), runWorkerTick()]);

    const results = [firstResult, secondResult];
    const skipped = results.filter((r) => r.skipped === true);
    const ran = results.filter((r) => r.skipped !== true);

    expect(skipped).toHaveLength(1);
    expect(ran).toHaveLength(1);
    expect(ran[0].promotedCount).toBe(1);

    const detail = await request(app).get(`/order/${order.id}`);
    expect(detail.body.status).toBe('PROCESSING');
  });
});
