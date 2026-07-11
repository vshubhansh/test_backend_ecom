const { pool, withTransaction } = require('../db/pool');
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

// Shared by getOrderById and cancelOrder: both run the same order+items JOIN
// and shape the result identically.
const ORDER_WITH_ITEMS_SQL = `
  SELECT o.id, o.customer_id, o.status, o.order_value, o.payment_mode, o.payment_status,
         o.order_date, o.created_at, o.updated_at,
         oi.item_id, i.name, oi.quantity, oi.item_price, oi.shipment_number
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  JOIN items i ON i.id = oi.item_id
  WHERE o.id = :id
  ORDER BY oi.id ASC
`;

function mapOrderRows(rows) {
  const first = rows[0];
  return {
    id: first.id,
    customer_id: first.customer_id,
    status: first.status,
    order_value: first.order_value,
    payment_mode: first.payment_mode,
    payment_status: first.payment_status,
    order_date: first.order_date,
    created_at: first.created_at,
    updated_at: first.updated_at,
    items: rows.map((r) => ({
      item_id: r.item_id,
      name: r.name,
      quantity: r.quantity,
      item_price: r.item_price,
      shipment_number: r.shipment_number,
    })),
  };
}

/**
 * Fetches one order with its line items via a single JOIN — no read-then-read
 * per item, per execution-plan.md §6 Step 4's "no N+1" acceptance criterion.
 */
async function getOrderById(id) {
  const [rows] = await pool.execute(ORDER_WITH_ITEMS_SQL, { id });

  if (rows.length === 0) {
    throw notFound('Order not found', { id });
  }

  return mapOrderRows(rows);
}

/**
 * Cancels a PENDING order: CAS status flip, inventory restore, and history
 * row, all in one transaction — mirrors createOrder's approach (§5.2 of
 * docs/plan/execution-plan.md). A cancel/worker race resolves cleanly:
 * whichever UPDATE lands first wins, the other affects 0 rows and becomes 409.
 */
async function cancelOrder(id) {
  return withTransaction(async (conn) => {
    const [result] = await conn.execute(
      "UPDATE orders SET status = 'CANCELLED' WHERE id = :id AND status = 'PENDING'",
      { id }
    );

    if (result.affectedRows === 0) {
      const [existing] = await conn.execute('SELECT status FROM orders WHERE id = :id', { id });
      if (existing.length === 0) {
        throw notFound('Order not found', { id });
      }
      throw conflict('Order is not PENDING and cannot be cancelled', {
        id,
        status: existing[0].status,
      });
    }

    // Ascending item_id: same lock-ordering convention createOrder uses for
    // its decrements, to avoid InnoDB deadlocks with concurrent orders.
    const [itemRows] = await conn.execute(
      'SELECT item_id, quantity FROM order_items WHERE order_id = :id ORDER BY item_id ASC',
      { id }
    );

    for (const { item_id, quantity } of itemRows) {
      const [restore] = await conn.execute(
        'UPDATE inventory SET quantity = quantity + :qty WHERE item_id = :itemId',
        { qty: quantity, itemId: item_id }
      );
      if (restore.affectedRows === 0) {
        // createOrder decremented this row, so it must exist; a miss means the
        // inventory table lost a row and the restore must not be half-applied.
        throw new Error(`Inventory row missing for item ${item_id} while cancelling order ${id}`);
      }
    }

    await conn.execute(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by)
       VALUES (:id, 'PENDING', 'CANCELLED', 'CUSTOMER')`,
      { id }
    );

    const [rows] = await conn.execute(ORDER_WITH_ITEMS_SQL, { id });
    return mapOrderRows(rows);
  });
}

/**
 * Lists orders with status filter + pagination. Two queries total regardless
 * of page size: one page of orders, one batched items lookup keyed by the
 * page's order ids — avoids an N+1 per-order items query.
 */
async function listOrders({ order_status, limit, offset }) {
  const statusClause = order_status ? 'status = :status' : "status != 'CANCELLED'";
  // pool.query, not .execute: MySQL server-side prepared statements reject
  // placeholders in LIMIT/OFFSET (ER_WRONG_ARGUMENTS). query() still binds
  // params safely (mysql2 escapes them client-side) — limit/offset are
  // already validated as integers by listOrdersQuerySchema.
  const [orderRows] = await pool.query(
    `SELECT id, customer_id, status, order_value, payment_mode, payment_status, order_date
     FROM orders
     WHERE ${statusClause}
     ORDER BY order_date DESC, id DESC
     LIMIT :limit OFFSET :offset`,
    { status: order_status, limit, offset }
  );

  if (orderRows.length === 0) {
    return [];
  }

  const orderIds = orderRows.map((o) => o.id);
  const idParams = {};
  const idPlaceholders = orderIds
    .map((id, i) => {
      idParams[`id${i}`] = id;
      return `:id${i}`;
    })
    .join(', ');
  const [itemRows] = await pool.execute(
    `SELECT oi.order_id, oi.item_id, i.name, oi.quantity
     FROM order_items oi
     JOIN items i ON i.id = oi.item_id
     WHERE oi.order_id IN (${idPlaceholders})`,
    idParams
  );

  const itemsByOrderId = new Map();
  for (const row of itemRows) {
    if (!itemsByOrderId.has(row.order_id)) itemsByOrderId.set(row.order_id, []);
    itemsByOrderId.get(row.order_id).push({
      item_id: row.item_id,
      name: row.name,
      quantity: row.quantity,
    });
  }

  return orderRows.map((o) => ({
    id: o.id,
    customer_id: o.customer_id,
    status: o.status,
    order_value: o.order_value,
    payment_mode: o.payment_mode,
    payment_status: o.payment_status,
    order_date: o.order_date,
    items: itemsByOrderId.get(o.id) || [],
  }));
}

module.exports = { createOrder, getOrderById, listOrders, cancelOrder };
