const { Router } = require('express');
const { pool } = require('../db/pool');

const router = Router();

router.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch (err) {
    console.error('[health] DB probe failed:', err.message);
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

module.exports = router;
