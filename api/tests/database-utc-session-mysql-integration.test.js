const test = require('node:test');
const assert = require('node:assert/strict');

// Simulates a MySQL server whose default time zone is not UTC: a first
// 'connection' listener sets +02:00, as the server default would.
test('CURRENT_TIMESTAMP rows compare correctly with UTC_TIMESTAMP() on a non-UTC server', {
  skip: !process.env.MYSQL_TEST_HOST,
  timeout: 60000,
}, async () => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Use a dedicated database ending in _test');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'ci-test-jwt-secret-for-utc-sessions';
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-test-encryption-key';
  const mysql = require('mysql2/promise');
  const { useUtcSessions } = require('../dist/src/services/database');
  const config = {
    host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER,
    password: process.env.MYSQL_TEST_PASSWORD, timezone: '+00:00', connectionLimit: 2,
  };
  function nonUtcServerPool() {
    const pool = mysql.createPool(config);
    pool.pool.on('connection', connection => connection.query("SET time_zone = '+02:00'", () => {}));
    return pool;
  }
  // One pool connection, because the probe uses a per-connection temporary table.
  async function probe(pool) {
    const connection = await pool.getConnection();
    try {
      const [[zone]] = await connection.query('SELECT @@session.time_zone AS zone');
      await connection.query(`CREATE TEMPORARY TABLE utc_session_probe (
        id INT PRIMARY KEY,
        available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
      try {
        await connection.query('INSERT INTO utc_session_probe (id) VALUES (1)');
        // The app's due-work pattern: rows created "now" are due now.
        const [[due]] = await connection.query('SELECT COUNT(*) AS total FROM utc_session_probe WHERE available_at <= UTC_TIMESTAMP()');
        const [[row]] = await connection.query('SELECT available_at, created_at FROM utc_session_probe WHERE id = 1');
        return { zone: zone.zone, due: Number(due.total), ...row };
      } finally {
        await connection.query('DROP TEMPORARY TABLE utc_session_probe');
      }
    } finally {
      connection.release();
    }
  }

  const unprotected = nonUtcServerPool();
  const protectedPool = useUtcSessions(nonUtcServerPool());
  try {
    // Control: without the hook the simulated server really is two hours ahead.
    const skewed = await probe(unprotected);
    assert.equal(skewed.zone, '+02:00');
    assert.equal(skewed.due, 0, 'Without a UTC session a new row is not due for two hours');
    assert.ok(skewed.available_at.getTime() - Date.now() > 110 * 60 * 1000);

    const fixed = await probe(protectedPool);
    assert.equal(fixed.zone, '+00:00');
    assert.equal(fixed.due, 1, 'A row created now is due now');
    for (const value of [fixed.available_at, fixed.created_at]) {
      assert.ok(Math.abs(value.getTime() - Date.now()) < 5 * 60 * 1000, `${value.toISOString()} must be close to the current UTC time`);
    }
    // Reused (acquired, not newly created) connections keep the UTC session.
    assert.equal((await probe(protectedPool)).zone, '+00:00');
  } finally {
    await unprotected.end();
    await protectedPool.end();
  }
});
