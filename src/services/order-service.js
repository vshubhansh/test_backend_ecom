const { withTransaction } = require('../db/pool');
const { notFound, badRequest, conflict } = require('../errors');

/**
 * Creates an order: server-authoritative pricing, atomic conditional inventory
 * decrement (no SELECT-then-check — see docs/plan/execution-plan.md §5.1), and
 * a full order/order_items/order_status_history write, all in one transaction.
 */
async function createOrder({ customer_id, payment_mode, payment_status, items, expected_order_value }) {
  return withTransaction(async (conn) => {
    // Merge duplicate item_id lines so shortfall checks and order_items stay
    // correct without special-casing repeated ids.
    const merged = new Map();
    for (const { item_id, quantity } of items) {
      merged.set(item_id, (merged.get(item_id) || 0) + quantity);
    }
    const itemIds = [...merged.keys()];

    const idParams = {};
    const idPlaceholders = itemIds
      .map((id, i) => {
        idParams[`id${i}`] = id;
        return `:id${i}`;
      })
      .join(', ');
    const [rows] = await conn.execute(
      `SELECT id, name, price FROM items WHERE id IN (${idPlaceholders})`,
      idParams
    );

    const priceById = new Map(rows.map((r) => [r.id, { price: r.price, name: r.name }]));
    const missingIds = itemIds.filter((id) => !priceById.has(id));
    if (missingIds.length > 0) {
      throw notFound('One or more items were not found', { unknown_item_ids: missingIds });
    }

    // Sum in integer cents to avoid float-sum drift when comparing against
    // expected_order_value or persisting order_value.
    let totalCents = 0;
    const lines = [];
    for (const [item_id, quantity] of merged) {
      const { price, name } = priceById.get(item_id);
      totalCents += Math.round(price * 100) * quantity;
      lines.push({ item_id, quantity, price, name });
    }
    const orderValue = totalCents / 100;

    if (expected_order_value !== undefined) {
      const expectedCents = Math.round(expected_order_value * 100);
      if (expectedCents !== totalCents) {
        throw badRequest('expected_order_value does not match the computed order value', {
          expected: expected_order_value,
          computed: orderValue,
        });
      }
    }

    // Sorted ascending by item_id: when two concurrent orders touch
    // overlapping items, updating rows in a consistent order avoids InnoDB
    // lock-ordering deadlocks.
    const sortedLines = [...lines].sort((a, b) => a.item_id - b.item_id);
    for (const { item_id, quantity } of sortedLines) {
      const [result] = await conn.execute(
        'UPDATE inventory SET quantity = quantity - :qty WHERE item_id = :itemId AND quantity >= :qty',
        { qty: quantity, itemId: item_id }
      );
      if (result.affectedRows === 0) {
        throw conflict('Insufficient inventory for one or more items', {
          item_id,
          requested: quantity,
        });
      }
    }

    const orderDate = new Date();
    const [orderResult] = await conn.execute(
      `INSERT INTO orders (customer_id, status, order_value, payment_mode, payment_status, order_date)
       VALUES (:customerId, 'PENDING', :orderValue, :paymentMode, :paymentStatus, :orderDate)`,
      {
        customerId: customer_id,
        orderValue,
        paymentMode: payment_mode,
        paymentStatus: payment_status,
        orderDate,
      }
    );
    const orderId = orderResult.insertId;

    const itemValuesSql = lines
      .map((_, i) => `(:orderId, :itemId${i}, :quantity${i}, :itemPrice${i})`)
      .join(', ');
    const itemParams = { orderId };
    lines.forEach((line, i) => {
      itemParams[`itemId${i}`] = line.item_id;
      itemParams[`quantity${i}`] = line.quantity;
      itemParams[`itemPrice${i}`] = line.price;
    });
    await conn.execute(
      `INSERT INTO order_items (order_id, item_id, quantity, item_price) VALUES ${itemValuesSql}`,
      itemParams
    );

    // changed_by='CUSTOMER': the request that creates an order is the
    // customer's own action, same convention as the cancel endpoint.
    // from_status='NEW': a sentinel outside orders.status's vocabulary —
    // there is no prior state for a brand-new order.
    await conn.execute(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by)
       VALUES (:orderId, 'NEW', 'PENDING', 'CUSTOMER')`,
      { orderId }
    );

    return {
      id: orderId,
      customer_id,
      status: 'PENDING',
      order_value: orderValue,
      payment_mode,
      payment_status,
      order_date: orderDate,
      items: lines.map((l) => ({
        item_id: l.item_id,
        name: l.name,
        quantity: l.quantity,
        item_price: l.price,
        shipment_number: null,
      })),
    };
  });
}

module.exports = { createOrder };
