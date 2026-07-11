# Execution Plan — Order Processing System

This document is the working execution plan for the take-home assignment. It records the
locked design decisions, the API contract, the schema, and the step-by-step build order.
Each step lists its scope, files, and acceptance criteria. The README carries the narrative
version of this (why decisions were made); this file is the engineering checklist.

---

## 1. Locked design decisions

| Area | Decision | Reason |
|---|---|---|
| Runtime | Node.js + Express | Familiar, minimal, fits assignment scope |
| Database | MySQL 8.4 via `mysql2/promise`, **no ORM** | Deliberate simplicity; all queries parameterised via `pool.execute()` (prepared statements) |
| Pool | Singleton, `connectionLimit: 15`, `waitForConnections: true`, `queueLimit: 0`, `enableKeepAlive: true`, `keepAliveInitialDelay: 10000`, `maxIdle`/`idleTimeout` below MySQL `wait_timeout`, `namedPlaceholders: true` | Avoid stale sockets in containers; bounded concurrency; readable parameterised SQL |
| Schema scope | Implement `items`, `inventory`, `orders`, `order_items`, `order_status_history` only. Customers/sellers/addresses stay as README future-scope ERD; `customer_id` is a plain column on `orders` | Keep the implementation focused on the assignment's core: order lifecycle |
| Pricing | Server-authoritative: prices come from `items`; `order_value` computed server-side; client totals validated, 400 on mismatch | Never trust the client with money |
| Concurrency | Atomic conditional inventory decrement; compare-and-swap (CAS) status updates; inventory restored on cancel in the same transaction | Eliminates TOCTOU (time-of-check to time-of-use) races between concurrent orders, cancel, and the worker |
| Status codes | 409 Conflict for state-based rejections (insufficient inventory, cancel on non-PENDING, invalid transition); 400 for validation; 404 for missing order | 403 is authorization semantics — wrong for state conflicts |
| List default | No filter → all orders **except CANCELLED**; `?order_status=CANCELLED` retrieves cancelled; `limit`/`offset` pagination | Assignment enumerates only the 4 live statuses; cancelled orders are opt-in |
| Worker | In-process `setInterval` every 5 min, single set-based UPDATE + history rows, overlap guard. BullMQ + Redis approach documented in comments/README, not implemented | Right-sized for a single-node take-home; production path documented |
| Testing | Jest + Supertest against the dockerized MySQL | Integration tests exercise the real SQL, transactions, and race guards |

## 2. State machine (strict single-step)

```
PENDING(0) ──▶ PROCESSING(1) ──▶ SHIPPED(2) ──▶ DELIVERED(3)
    │
    └──▶ CANCELLED(99)   [only from PENDING, only via the cancel endpoint]
```

Rules:
- Transitions advance **exactly one step** (ordinal `n` → `n+1`). No skips, no backwards moves.
- `CANCELLED` is reachable only from `PENDING`, and only through `PATCH /order/:id/cancel`.
  `PATCH /order/:id/status` rejects `CANCELLED` (and `PENDING`) as a target.
- Every transition writes an `order_status_history` row.
- All transitions are enforced atomically in the `UPDATE`'s `WHERE` clause (CAS on the
  expected current status) — never read-then-write.

`changed_by` values: `SYSTEM` (worker), `CUSTOMER` (order create and cancel endpoint), `ADMIN` (status API
default). The field can be extended in future to carry a `customer_id` / actor id — e.g. to
distinguish "customer cancelled the order" from "customer asked support to cancel it".

## 3. API contract

| # | Method & path | Request | Success | Errors |
|---|---|---|---|---|
| 1 | `POST /order` | `customer_id`, `payment_mode` (COD/UPI/CC/DEBIT_CARD/WALLET), `payment_status` (COMPLETE/PENDING), `items: [{item_id, quantity}]`, optional `expected_order_value` (validated, not trusted), optional `discount` (reserved for future use) | `201` with created order (id, status=PENDING, server-computed `order_value`) | `400` validation / price mismatch; `404` unknown item; `409` insufficient inventory |
| 2 | `GET /order` | Query: `order_status?` (PENDING/PROCESSING/SHIPPED/DELIVERED/CANCELLED), `limit?` (default 20), `offset?` (default 0) | `200` list: order id, order date, item names + quantities, order value, status, payment status; no filter excludes CANCELLED | `400` invalid status/pagination values |
| 3 | `GET /order/:id` | — | `200`: order id, items `[{item_id, name, quantity, item_price, shipment_number}]`, order value, status, payment mode, payment status, timestamps | `404` not found |
| 4 | `PATCH /order/:id/cancel` | — | `200` order with status=CANCELLED; inventory restored | `404` not found; `409` not in PENDING |
| 5 | `PATCH /order/:id/status` | `{ "status": "PROCESSING" \| "SHIPPED" \| "DELIVERED" }` | `200` updated order | `400` invalid/disallowed status value; `404` not found; `409` not the single-step successor of current status |
| — | `GET /health` | — | `200` `{ status: "ok", db: "up" }` | `503` if DB unreachable |

Notes:
- Cancel uses `PATCH` (not `DELETE`) because the record is retained; only the status changes.
- `payment_status = PENDING` is the COD case.

## 4. Schema (DDL sketch)

All tables carry `created_at DATETIME DEFAULT CURRENT_TIMESTAMP` and
`updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`.

```sql
items(
  id BIGINT PK AUTO_INCREMENT,
  name VARCHAR NOT NULL,
  category VARCHAR,
  brand VARCHAR,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,          -- current catalog price (server-authoritative)
  seller_id BIGINT NULL                  -- FK once sellers table exists (future scope)
)

inventory(
  item_id BIGINT PK, FK -> items(id),
  quantity INT NOT NULL CHECK (quantity >= 0)
)

orders(
  id BIGINT PK AUTO_INCREMENT,
  customer_id VARCHAR NOT NULL,          -- plain column; FK -> customers in future scope
  status ENUM('PENDING','PROCESSING','SHIPPED','DELIVERED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  order_value DECIMAL(12,2) NOT NULL,    -- server-computed
  payment_mode ENUM('COD','UPI','CC','DEBIT_CARD','WALLET') NOT NULL,
  payment_status ENUM('COMPLETE','PENDING') NOT NULL,
  order_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_orders_status (status),
  INDEX idx_orders_customer (customer_id)
)

order_items(
  id BIGINT PK AUTO_INCREMENT,
  order_id BIGINT FK -> orders(id),
  item_id BIGINT FK -> items(id),
  quantity INT NOT NULL,
  item_price DECIMAL(10,2) NOT NULL,     -- price snapshot at order time
  shipment_number VARCHAR NULL,          -- shipping is out of scope; nullable placeholder
  INDEX idx_order_items_order (order_id)
)

order_status_history(
  id BIGINT PK AUTO_INCREMENT,
  order_id BIGINT FK -> orders(id),
  from_status VARCHAR NOT NULL,
  to_status VARCHAR NOT NULL,
  changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  changed_by VARCHAR NOT NULL            -- SYSTEM | CUSTOMER | ADMIN; extensible to actor id
)
```

Seed data: a handful of items with inventory so the API is exercisable immediately after
`docker compose up`.

## 5. Concurrency design (the load-bearing part)

1. **Create order** (single transaction):
   - Look up item prices (`SELECT ... WHERE id IN (?)`), 404 on unknown item.
   - For each line: `UPDATE inventory SET quantity = quantity - :qty WHERE item_id = :id AND quantity >= :qty`.
     If `affectedRows = 0` → rollback → `409`. No SELECT-then-check (TOCTOU/time-of-check-to-time-of-use-safe).
   - Insert `orders` (PENDING), `order_items` (with price snapshots), history row (`NEW → PENDING`).
2. **Cancel** (single transaction):
   - `UPDATE orders SET status='CANCELLED' WHERE id = :id AND status='PENDING'`.
     `affectedRows = 0` → distinguish 404 vs 409 with a follow-up existence check.
   - Restore inventory (`quantity = quantity + qty` per line), insert history row.
3. **Status update** (single transaction):
   - `UPDATE orders SET status = :next WHERE id = :id AND status = :expected_current`
     where `:expected_current` is the sole valid predecessor. CAS makes the worker/cancel
     race benign — whichever UPDATE lands first wins, the other returns 0 rows → 409.
4. **Worker**: one set-based statement inside a transaction —
   capture affected order ids (`SELECT id ... WHERE status='PENDING' FOR UPDATE` then
   `UPDATE`), bulk-insert history rows. Overlap guard: skip a tick if the previous one is
   still running.

Alternative considered and documented (not implemented): pessimistic / distributed locking
with HTTP 423 + client retry. Verdict: CAS retained for row-level transitions;
`SELECT ... FOR UPDATE` where read-modify-write is unavoidable; distributed locks reserved
for cross-service critical sections and multi-instance worker single-flight (future BullMQ).
Full trade-off analysis in README §4.

## 6. Steps

### Step 0 — Plan docs + README draft ✅ (this step)
- **Files**: `docs/plan/execution-plan.md` (this file), `README.md` (first draft).
- **Accept**: plan covers all steps with scope + acceptance criteria; README has the agreed
  progressive structure and seeded AI-usage log.

### Step 1 — Schema + infra ✅
- **Files**: `db/init.sql`, `docker-compose.yml`, `.env.example`, `package.json`, `.dockerignore`, `Dockerfile`.
- **Scope**: 5 tables per §4 with indexes and seed data; MySQL 8.4 service with `init.sql`
  mounted; node app service; healthcheck-gated startup ordering.
- **Accept**: `docker compose up` yields a MySQL with the schema + seeds; `mysql` CLI can
  query seeded items.

### Step 2 — App skeleton ✅
- **Files**: `src/server.js`, `src/app.js`, `src/config.js`, `src/db/pool.js`,
  `src/middleware/error-handler.js`, validation setup (zod or joi).
- **Scope**: Express bootstrap; pool singleton exactly per §1; centralized error middleware
  mapping typed errors → status codes; `GET /health` with a `SELECT 1` DB probe.
- **Accept**: `GET /health` returns 200 with DB up; app boots clean in Docker.

### Step 3 — POST /order ✅
- **Files**: `src/routes/orders.js`, `src/services/order-service.js` (or equivalent split).
- **Scope**: §5.1 flow. Server-side pricing, atomic decrements, 201/400/404/409 per contract.
- **Accept**: manual curl of happy path + shortfall path behaves per contract; order,
  order_items, and history rows present.

### Step 4 — Read endpoints ✅
- **Scope**: `GET /order` (filter, CANCELLED-exclusion default, `limit`/`offset`),
  `GET /order/:id` with items array. Single JOIN-based queries; no N+1.
- **Accept**: list shapes and filter/pagination semantics per contract; 404 on unknown id.

### Step 5 — PATCH /order/:id/cancel
- **Scope**: §5.2 flow, `changed_by='CUSTOMER'`.
- **Accept**: cancel on PENDING succeeds and restores inventory; cancel on any other status
  → 409; unknown id → 404.

### Step 6 — PATCH /order/:id/status
- **Scope**: §5.3 flow, `changed_by='ADMIN'` (code comment on future actor-id extension);
  rejects CANCELLED/PENDING targets with 400, non-successor targets with 409.
- **Accept**: PENDING→PROCESSING→SHIPPED→DELIVERED each succeed stepwise; skip (PENDING→SHIPPED),
  backwards (SHIPPED→PROCESSING), and CANCELLED-via-this-endpoint all rejected.

### Step 7 — Worker
- **Files**: `src/workers/order-status-worker.js`.
- **Scope**: §5.4. Interval configurable via env (5 min default; seconds in tests).
  BullMQ + Redis production design documented in a comment block and in the README.
- **Accept**: PENDING orders flip to PROCESSING within one tick with history rows;
  overlapping ticks don't double-run.

### Step 8 — Tests
- **Files**: `tests/*.test.js`, `jest.config.js`, test DB setup/teardown helpers.
- **Cases**: create happy path; insufficient inventory 409; **concurrent create race on the
  last unit** (exactly one succeeds); cancel on PENDING incl. inventory restore; cancel
  rejection 409; stepwise transitions accepted; skip/backwards rejected; worker transition
  + history rows; list filter/pagination semantics.
- **Accept**: `npm test` green against dockerized MySQL.

### Step 9 — README finalization
- **Scope**: fill run instructions, finalize AI-usage log, verify ERD/state diagrams render,
  future-scope section complete.
- **Accept**: a reviewer can clone → `docker compose up` → exercise every endpoint from the
  README alone.

## 7. Out of scope (documented in README)

- Customers, addresses, sellers as real tables (ERD provided as future scope)
- Shipping and invoice generation (separate services)
- Authentication / authorization and a real actor model
- Payments processing (only mode/status fields captured)
- UI
- BullMQ + Redis queue (designed, documented, not implemented)
