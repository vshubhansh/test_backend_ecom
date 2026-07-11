// Single source of truth for runtime configuration. dotenv is loaded here,
// once — every other module imports this instead of touching process.env.
require('dotenv').config();

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const config = Object.freeze({
  port: toInt(process.env.PORT, 3005),
  db: Object.freeze({
    host: process.env.DB_HOST || '127.0.0.1',
    port: toInt(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'ecom_app',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ecom',
    poolLimit: toInt(process.env.DB_POOL_LIMIT, 15),
  }),
  // Background worker tick (Step 7). 5 minutes by default.
  workerIntervalMs: toInt(process.env.WORKER_INTERVAL_MS, 5 * 60 * 1000),
});

module.exports = config;
