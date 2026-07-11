// Connection pool singleton. Node's module cache guarantees a single pool
// instance per process — every import shares these 15 connections.
const mysql = require('mysql2/promise');
const config = require('../config');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,

  // Bounded concurrency: at most 15 connections; extra requests queue
  // (queueLimit 0 = unbounded queue) instead of failing fast.
  connectionLimit: config.db.poolLimit,
  waitForConnections: true,
  queueLimit: 0,

  // TCP keep-alive so idle sockets in the container network don't go stale.
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,

  // Retire idle connections well below MySQL's wait_timeout (default 28800s)
  // so the pool never hands out a socket the server has already closed.
  maxIdle: 10,
  idleTimeout: 60000,

  // Readable parameterised SQL (:name) — everything goes through prepared
  // statements, never string interpolation.
  namedPlaceholders: true,
  // DECIMAL columns (order_value, item_price) come back as JS numbers.
  decimalNumbers: true,
});

/**
 * Runs `fn(conn)` inside a transaction on a dedicated connection.
 * Commits on success, rolls back on any throw, always releases.
 */
async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, withTransaction };
