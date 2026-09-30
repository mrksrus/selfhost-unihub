const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('the recovery release gate fails rather than skipping unavailable database checks', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(env)) if (key.startsWith('MYSQL_TEST_')) delete env[key];
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/test-recovery.cjs')], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires MYSQL_TEST_HOST/);
  assert.match(result.stderr, /No tests ran/);
});

test('recovery gate refuses populated test databases without modifying their data', { skip: !process.env.MYSQL_TEST_HOST }, async () => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/);
  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, database: process.env.MYSQL_TEST_DATABASE });
  let owned = false;
  try {
    const [tables] = await connection.query('SHOW TABLES');
    assert.equal(tables.length, 0, 'Use an empty disposable test database');
    await connection.query('CREATE TABLE recovery_gate_sentinel (value INT)');
    owned = true;
    await connection.query('INSERT INTO recovery_gate_sentinel VALUES (42)');
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/test-recovery.cjs')], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refuses a non-empty database/);
    const [rows] = await connection.query('SELECT value FROM recovery_gate_sentinel');
    assert.deepEqual(rows, [{ value: 42 }]);
  } finally {
    if (owned) await connection.query('DROP TABLE recovery_gate_sentinel');
    await connection.end();
  }
});
