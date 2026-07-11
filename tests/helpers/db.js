// Test-only DB helpers. Tests share the same `ecom` database the app uses
// (see docs/plan/execution-plan.md Step 8 design note — a real production
// setup would point tests at a separate staging DB; here the two share one
// database because the ecom_app user's grants are scoped to `ecom` only and
// splitting it out is not worth the extra infra for a take-home).
const { pool } = require('../../src/db/pool');

// Mirrors the seed block at the bottom of db/init.sql.
const SEED_INVENTORY = { 1: 100, 2: 50, 3: 40, 4: 25, 5: 1, 6: 0 };

/**
 * Resets all order-related state to a pristine baseline: deletes every order
 * (and its history/line items) and restores inventory to the seeded
 * quantities. Leaves `items` untouched. FK-safe delete order: history ->
 * order_items -> orders.
 */
async function resetDatabase() {
  await pool.query('DELETE FROM order_status_history');
  await pool.query('DELETE FROM order_items');
  await pool.query('DELETE FROM orders');

  for (const [itemId, quantity] of Object.entries(SEED_INVENTORY)) {
    await pool.execute('UPDATE inventory SET quantity = :quantity WHERE item_id = :itemId', {
      quantity,
      itemId,
    });
  }
}

async function getInventoryQuantity(itemId) {
  const [rows] = await pool.execute('SELECT quantity FROM inventory WHERE item_id = :itemId', {
    itemId,
  });
  return rows[0].quantity;
}

async function getStatusHistory(orderId) {
  const [rows] = await pool.execute(
    'SELECT from_status, to_status, changed_by FROM order_status_history WHERE order_id = :orderId ORDER BY id ASC',
    { orderId }
  );
  return rows;
}

module.exports = { SEED_INVENTORY, resetDatabase, getInventoryQuantity, getStatusHistory };
