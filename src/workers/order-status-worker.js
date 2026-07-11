// Background worker: promotes PENDING orders to PROCESSING every
// `config.workerIntervalMs` (5 min default). See execution-plan.md §5.4.
//
// Production note: this in-process setInterval is single-node only — with
// multiple app instances it would run once per instance. The production path
// is a BullMQ + Redis repeatable job (distributed-lock-backed scheduling,
// plus retries/backoff/dead-lettering); full design and trade-off writeup in
// README §6 "Background worker". CAS-style UPDATEs here mean duplicate runs
// are harmless even before that migration.
const { withTransaction } = require('../db/pool');
const config = require('../config');

let intervalHandle = null; // set by start(), cleared by stop()
let isTickRunning = false; // in-process overlap guard
let inFlightTick = null; // promise of the currently-running tick, awaited by stop()

/**
 * Single set-based promotion of every PENDING order to PROCESSING, plus the
 * matching order_status_history rows, in one transaction. Exported standalone
 * (no interval/guard) so it can be invoked directly — e.g. by tests.
 */
async function promotePendingOrders() {
  return withTransaction(async (conn) => {
    // FOR UPDATE locks and snapshots exactly which ids this tick owns before
    // mutating anything — the set-based UPDATE below is scoped to this list,
    // never a bare WHERE status='PENDING'.
    const [rows] = await conn.execute(
      "SELECT id FROM orders WHERE status = 'PENDING' ORDER BY id FOR UPDATE"
    );

    if (rows.length === 0) {
      return { promotedCount: 0, orderIds: [] };
    }

    const ids = rows.map((r) => r.id);
    const idParams = {};
    const idPlaceholders = ids
      .map((id, i) => {
        idParams[`id${i}`] = id;
        return `:id${i}`;
      })
      .join(', ');

    // AND status = 'PENDING' is defense in depth on top of the FOR UPDATE
    // lock already held on these exact rows.
    const [updateResult] = await conn.execute(
      `UPDATE orders SET status = 'PROCESSING'
       WHERE id IN (${idPlaceholders}) AND status = 'PENDING'`,
      idParams
    );
    if (updateResult.affectedRows !== ids.length) {
      console.error(
        `order-status-worker: expected to promote ${ids.length} order(s), affected ${updateResult.affectedRows}`
      );
    }

    const historyValuesSql = ids
      .map((_, i) => `(:id${i}, 'PENDING', 'PROCESSING', 'SYSTEM')`)
      .join(', ');
    await conn.execute(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by)
       VALUES ${historyValuesSql}`,
      idParams
    );

    return { promotedCount: ids.length, orderIds: ids };
  });
}

/**
 * Overlap-guarded wrapper around promotePendingOrders() — what the interval
 * calls. Never rejects: a failed tick logs and the next tick retries.
 */
async function runWorkerTick() {
  if (isTickRunning) {
    console.log('order-status-worker: previous tick still running, skipping this tick');
    return { skipped: true };
  }

  isTickRunning = true;
  inFlightTick = promotePendingOrders()
    .then((result) => {
      console.log(`order-status-worker: promoted ${result.promotedCount} order(s) to PROCESSING`);
      return result;
    })
    .catch((err) => {
      console.error('order-status-worker: tick failed', err);
      return { skipped: false, error: err };
    })
    .finally(() => {
      isTickRunning = false;
      inFlightTick = null;
    });

  return inFlightTick;
}

/** Arms the interval. Idempotent — a second call while running is a no-op. */
function start() {
  if (intervalHandle) {
    console.log('order-status-worker: start() called but already running, ignoring');
    return;
  }
  intervalHandle = setInterval(() => {
    runWorkerTick();
  }, config.workerIntervalMs);
  console.log(`order-status-worker: started, interval ${config.workerIntervalMs}ms`);
}

/**
 * Stops scheduling new ticks and waits for any in-flight tick to finish, so
 * callers (server.js shutdown) can safely close the pool right after.
 */
async function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (inFlightTick) {
    await inFlightTick;
  }
}

module.exports = { start, stop, runWorkerTick, promotePendingOrders };
