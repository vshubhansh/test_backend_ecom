// zod schemas for the /order domain. Numbers are never coerced from strings —
// the body is JSON, so a stringly-typed quantity ("2") is a client bug, not
// something to silently accept.
const { z } = require('zod');

// quantity/items caps keep order_value inside DECIMAL(12,2) — an absurd
// quantity should be a 400, not a DB out-of-range error surfacing as a 500.
const orderItemSchema = z.object({
  item_id: z.number().int().positive(),
  quantity: z.number().int().positive().max(10000),
});

const createOrderSchema = z.object({
  customer_id: z.string().trim().min(1).max(64),
  payment_mode: z.enum(['COD', 'UPI', 'CC', 'DEBIT_CARD', 'WALLET']),
  payment_status: z.enum(['COMPLETE', 'PENDING']),
  items: z.array(orderItemSchema).min(1, 'items must be a non-empty array').max(100),
  expected_order_value: z.number().nonnegative().optional(),
  // Reserved for future use — accepted and validated, never read by the service.
  discount: z.number().optional(),
});

const orderIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// Defaults: no page/offset given -> page 1, page size 20 (offset=0, limit=20),
// per execution-plan.md §3 / README §5.
const listOrdersQuerySchema = z.object({
  order_status: z.enum(['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED']).optional(),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

module.exports = { createOrderSchema, orderItemSchema, orderIdParamSchema, listOrdersQuerySchema };
