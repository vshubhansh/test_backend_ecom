-- Order Processing System — schema + seed data
-- Runs once via /docker-entrypoint-initdb.d/ on an empty MySQL data dir.
-- To re-run: docker compose down -v && docker compose up

CREATE DATABASE IF NOT EXISTS ecom
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE ecom;

-- ---------------------------------------------------------------------------
-- items: catalog. Price here is server-authoritative — order pricing is always
-- computed from this table, never taken from the client.
-- ---------------------------------------------------------------------------
CREATE TABLE items (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(255)    NOT NULL,
  category    VARCHAR(100)    NULL,
  brand       VARCHAR(100)    NULL,
  description TEXT            NULL,
  price       DECIMAL(10, 2)  NOT NULL,
  -- Becomes a real FK when the sellers table lands (future scope).
  seller_id   BIGINT UNSIGNED NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE = InnoDB;

-- ---------------------------------------------------------------------------
-- inventory: stock per item. Decremented atomically on order creation
-- (UPDATE ... WHERE quantity >= ?), restored on cancel. The CHECK is a last
-- line of defense; the application never relies on it.
-- ---------------------------------------------------------------------------
CREATE TABLE inventory (
  item_id    BIGINT UNSIGNED NOT NULL,
  quantity   INT             NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (item_id),
  CONSTRAINT fk_inventory_item FOREIGN KEY (item_id) REFERENCES items (id),
  CONSTRAINT chk_inventory_quantity CHECK (quantity >= 0)
) ENGINE = InnoDB;

-- ---------------------------------------------------------------------------
-- orders: one row per order. Status transitions are strict single-step
-- (PENDING -> PROCESSING -> SHIPPED -> DELIVERED); CANCELLED only from PENDING
-- via the cancel endpoint. All transitions enforced with CAS-style UPDATEs.
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Plain column for now; FK -> customers(id) in future scope.
  customer_id    VARCHAR(64)     NOT NULL,
  status         ENUM ('PENDING','PROCESSING','SHIPPED','DELIVERED','CANCELLED')
                                 NOT NULL DEFAULT 'PENDING',
  -- Server-computed from items.price * quantity; never trusted from the client.
  order_value    DECIMAL(12, 2)  NOT NULL,
  payment_mode   ENUM ('COD','UPI','CC','DEBIT_CARD','WALLET') NOT NULL,
  -- PENDING payment_status is the cash-on-delivery case.
  payment_status ENUM ('COMPLETE','PENDING') NOT NULL,
  order_date     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_orders_status (status),
  INDEX idx_orders_customer (customer_id)
) ENGINE = InnoDB;

-- ---------------------------------------------------------------------------
-- order_items: line items. item_price snapshots the catalog price at order
-- time so later price changes don't rewrite order history.
-- ---------------------------------------------------------------------------
CREATE TABLE order_items (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id        BIGINT UNSIGNED NOT NULL,
  item_id         BIGINT UNSIGNED NOT NULL,
  quantity        INT             NOT NULL,
  item_price      DECIMAL(10, 2)  NOT NULL,
  -- Shipping is a separate service (out of scope); placeholder kept nullable.
  shipment_number VARCHAR(64)     NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_order_items_order (order_id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT fk_order_items_item FOREIGN KEY (item_id) REFERENCES items (id),
  CONSTRAINT chk_order_items_quantity CHECK (quantity > 0)
) ENGINE = InnoDB;

-- ---------------------------------------------------------------------------
-- order_status_history: audit trail for every status transition.
-- changed_by is SYSTEM (worker) | CUSTOMER (order create + cancel) | ADMIN (status
-- API default). The field can be extended to carry a customer/actor id in
-- future — e.g. to distinguish "customer cancelled the order" from "customer
-- asked support to cancel the order".
-- ---------------------------------------------------------------------------
CREATE TABLE order_status_history (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id    BIGINT UNSIGNED NOT NULL,
  from_status VARCHAR(20)     NOT NULL,
  to_status   VARCHAR(20)     NOT NULL,
  changed_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  changed_by  VARCHAR(32)     NOT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_order_status_history_order (order_id),
  CONSTRAINT fk_order_status_history_order FOREIGN KEY (order_id) REFERENCES orders (id)
) ENGINE = InnoDB;

-- ---------------------------------------------------------------------------
-- Seed data. Shaped deliberately for tests and demos:
--   - items 1-4: normally stocked
--   - item 5 ("Last Unit Lamp"): quantity 1  -> concurrent-order race demo
--   - item 6 ("Sold Out Speaker"): quantity 0 -> guaranteed 409 demo
-- ---------------------------------------------------------------------------
INSERT INTO items (id, name, category, brand, description, price) VALUES
  (1, 'Wireless Mouse',      'Electronics', 'Logitech',  'Ergonomic 2.4GHz wireless mouse',        1299.00),
  (2, 'Mechanical Keyboard', 'Electronics', 'Keychron',  '75% hot-swappable mechanical keyboard',   6499.00),
  (3, 'Running Shoes',       'Footwear',    'Asics',     'Neutral cushioned road running shoes',    7999.00),
  (4, 'Steel Water Bottle',  'Home',        'Milton',    '1L insulated stainless steel bottle',      899.00),
  (5, 'Last Unit Lamp',      'Home',        'Philips',   'Desk lamp — seeded with a single unit',   2499.00),
  (6, 'Sold Out Speaker',    'Electronics', 'JBL',       'Bluetooth speaker — seeded out of stock', 4999.00);

INSERT INTO inventory (item_id, quantity) VALUES
  (1, 100),
  (2, 50),
  (3, 40),
  (4, 25),
  (5, 1),
  (6, 0);
