import type { RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// Sign-in attempt budgets in login_attempts (0.30) on the disposable MariaDB:
// a new limiter (a restarted process) still sees the spent budget, parallel
// requests never get more than it, a refund frees one place, an ended window
// starts again, identities are stored hashed, the hourly clean-up deletes
// only ended windows, and the real sign-in answers 429 from the database.
test('login limits: budgets survive a restart, hold under concurrency, refund, expire and are cleaned up', { skip: !process.env.MYSQL_TEST_HOST, timeout: 120000 }, async (t) => {
  const pool = await withTestDatabase(t);
  const { createLoginLimiter, pruneLoginAttempts, consumeAuthAttempt } = require('../dist/src/security/login-limits') as typeof import('../src/security/login-limits');
  const start = Date.now();
  let now = new Date(start);
  const clock = { now: () => now };

  const first = createLoginLimiter(clock);
  for (let index = 0; index < 10; index++) assert.equal(await first.consume('password', 'user-one', 10, 600000), null);
  assert.equal(await first.consume('password', 'user-one', 10, 600000), 600, 'the eleventh attempt waits for the window');
  assert.equal(await first.consume('password', 'user-two', 10, 600000), null, 'another account has its own budget');
  const restarted = createLoginLimiter(clock);
  assert.equal(await restarted.consume('password', 'user-one', 10, 600000), 600, 'a restarted process still refuses');
  assert.equal(await restarted.consume('secondFactor', 'user-one', 10, 600000), null, 'another scope is separate');

  // Twenty-five at once: ten are admitted, whatever order they commit in.
  const burst = await Promise.all(Array.from({ length: 25 }, () => restarted.consume('reauth', 'admin', 10, 600000)));
  assert.equal(burst.filter(wait => wait === null).length, 10);
  await restarted.refund('reauth', 'admin');
  assert.equal(await restarted.consume('reauth', 'admin', 10, 600000), null, 'a refund frees one place');
  assert.notEqual(await restarted.consume('reauth', 'admin', 10, 600000), null);

  now = new Date(start + 600001);
  assert.equal(await restarted.consume('password', 'user-one', 10, 600000), null, 'an ended window starts again');

  const rows = (await pool.query<RowDataPacket[]>('SELECT scope, identity_hash, attempts FROM login_attempts'))[0];
  assert.ok(rows.length >= 4);
  assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.identity_hash) && !['user-one', 'user-two', 'admin'].includes(row.identity_hash)), 'identities are hashed');

  // An attempt made two hours ago in a one-minute window has ended; the clean-up removes it alone.
  now = new Date(start - 2 * 3600000);
  assert.equal(await createLoginLimiter(clock).consume('ip', '192.0.2.10', 60, 60000), null);
  const before = Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM login_attempts'))[0][0].count);
  assert.equal(await pruneLoginAttempts(), 1);
  assert.equal(Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM login_attempts'))[0][0].count), before - 1);

  // The real sign-in: ten wrong passwords for an account, then 429 with Retry-After, also with the right one.
  const email = 'limits@example.test';
  const password = 'login-limits-fixture-password';
  await pool.execute('INSERT INTO users (id, email, password_hash, full_name, email_verified) VALUES (?, ?, ?, ?, TRUE)',
    [crypto.randomUUID(), email, await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 10), 'Limits']);
  const api = await startTestApi(t);
  const client = api.client();
  for (let index = 0; index < 10; index++) {
    assert.equal((await client.request('POST', '/api/auth/signin', { email, password: 'wrong-password-guess' })).status, 401);
  }
  const limited = await client.request('POST', '/api/auth/signin', { email, password });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 500);
  // Kept in the database: the process's own limiter (a fresh one after a restart) answers the same.
  assert.ok(await consumeAuthAttempt('password', (await pool.query<RowDataPacket[]>('SELECT id FROM users WHERE email = ?', [email]))[0][0].id) !== null);
});
