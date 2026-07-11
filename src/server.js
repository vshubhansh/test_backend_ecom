const app = require('./app');
const config = require('./config');
const { pool } = require('./db/pool');

const server = app.listen(config.port, () => {
  console.log(`Order processing system listening on :${config.port}`);
});

// Graceful shutdown: stop accepting connections, drain the pool, exit.
// Without this, `docker compose down` waits for the 10s SIGKILL timeout.
async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    try {
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
