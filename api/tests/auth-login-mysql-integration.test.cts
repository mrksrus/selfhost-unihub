import type { FixtureValue, With } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = (require('node:crypto') as typeof import('node:crypto'));

process.env.ENCRYPTION_KEY ||= 'auth-integration-encryption-key';
process.env.JWT_SECRET ||= 'auth-integration-jwt-key';

function response() {
  const headers = new Map();
  return { headers, setHeader(key: FixtureValue, value: FixtureValue) { headers.set(key, value); }, getHeader(key: FixtureValue) { return headers.get(key); } };
}
function otp() {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = crypto.createHmac('sha1', Buffer.from('48656c6c6f21deadbeef', 'hex')).update(counter).digest();
  return String((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}

test('MySQL login isolation, valid 2FA sessions, recovery reuse, replay and transaction rollback', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 30000,
}, async t => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/);
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  const bcrypt = require('bcryptjs');
  const { setDb } = require('../dist/src/state') as typeof import('../src/state');
  const { encrypt } = require('../dist/src/security/encryption') as typeof import('../src/security/encryption');
  const { verifyToken } = require('../dist/src/auth') as typeof import('../src/auth');
  const routes = require('../dist/src/routes/auth') as typeof import('../src/routes/auth');
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, database: process.env.MYSQL_TEST_DATABASE, connectionLimit: 4 });
  const created: FixtureValue[] = [];
  t.after(async () => {
    for (const name of created.reverse()) await pool.execute(`DROP TABLE ${name}`);
    setDb(null); await pool.end();
  });
  const [existing] = await pool.query<RowDataPacket[]>('SHOW TABLES');
  assert.equal(existing.length, 0, 'This integration fixture requires an empty disposable test database');
  for (const [name, ddl] of [
    ['users', `id CHAR(36) PRIMARY KEY, email VARCHAR(255) UNIQUE, password_hash TEXT, full_name TEXT, avatar_url TEXT, role VARCHAR(20), timezone VARCHAR(80), is_active BOOLEAN, two_factor_enabled BOOLEAN DEFAULT FALSE, encrypted_two_factor_secret TEXT, two_factor_recovery_codes JSON`],
    ['sessions', `id INT AUTO_INCREMENT PRIMARY KEY, user_id CHAR(36), token VARCHAR(512) NOT NULL UNIQUE, expires_at DATETIME, FOREIGN KEY (user_id) REFERENCES users(id)`],
    ['two_factor_challenges', `id CHAR(36) PRIMARY KEY, user_id CHAR(36), token_hash CHAR(64) UNIQUE, expires_at DATETIME, ip_address VARCHAR(64), user_agent TEXT, FOREIGN KEY (user_id) REFERENCES users(id)`],
  ] as const) { await pool.execute(`CREATE TABLE ${name} (${ddl}) ENGINE=InnoDB`); created.push(name); }
  setDb(pool);
  const [one, two, three, four] = Array.from({ length: 4 }, () => crypto.randomUUID());
  const password = 'integration-correct-password';
  const hash = await bcrypt.hash(password, 4);
  const recoveryCode = 'ABCDE-12345';
  for (const [id, email, has2fa] of [[one, 'one@example.test', false], [two, 'two@example.test', false], [three, 'three@example.test', true], [four, 'four@example.test', true]] as const) {
    await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash,role,is_active,two_factor_enabled,encrypted_two_factor_secret,two_factor_recovery_codes) VALUES (?,?,?,\'user\',TRUE,?,?,?)',
      [id, email, hash, has2fa, has2fa ? encrypt('JBSWY3DPEHPK3PXP') : null, has2fa ? JSON.stringify([await bcrypt.hash(recoveryCode, 4)]) : null]);
  }
  const req = { headers: {}, socket: { remoteAddress: '192.0.2.1' } };
  const signin = (email: FixtureValue, pass = password) => routes['POST /api/auth/signin'](req as FixtureValue, null, { email, password: pass }, response() as FixtureValue);
  // A correct login to user two never clears failed guesses against user one.
  for (let index = 0; index < 10; index++) {
    assert.equal(((await signin(index % 2 ? 'ONE@example.test' : 'one@example.test', 'incorrect'))! as FixtureValue).status, 401);
    if (index < 3) assert.equal(((await signin('two@example.test'))! as FixtureValue).user.id, two);
  }
  assert.equal(((await signin('one@example.test'))! as FixtureValue).status, 429);
  assert.equal(((await signin('two@example.test'))! as FixtureValue).user.id, two, 'Same proxy/IP must not lock another account');

  async function challenge() {
    const result = await signin('three@example.test');
    assert.equal((result! as FixtureValue).requires2fa, true);
    return (result! as FixtureValue).challengeToken;
  }
  const token = await challenge();
  const res = response();
  const verified = await routes['POST /api/auth/2fa/login'](req as FixtureValue, null, { challenge_token: token, code: otp() } as FixtureValue, res as FixtureValue);
  assert.equal((verified as With<typeof verified, 'user'>).user.id, three);
  const cookies = res.headers.get('Set-Cookie').map((value: FixtureValue) => value.split(';')[0]).join('; ');
  assert.equal(await verifyToken({ headers: { cookie: cookies } } as FixtureValue), three, 'Issued session authenticates the actual user');
  assert.equal(((await routes['POST /api/auth/2fa/login'](req as FixtureValue, null, { challenge_token: token, code: otp() } as FixtureValue, response() as FixtureValue)) as FixtureValue).status, 401);

  const recoveryToken = await challenge();
  const recovered = await routes['POST /api/auth/2fa/login'](req as FixtureValue, null, { challenge_token: recoveryToken, code: recoveryCode } as FixtureValue, response() as FixtureValue);
  assert.equal((recovered as With<typeof recovered, 'user'>).user.id, three); assert.equal((recovered as With<typeof recovered, 'recoveryCodesRemaining'>).recoveryCodesRemaining, 0);
  const [[stored]] = await pool.execute<RowDataPacket[]>('SELECT two_factor_recovery_codes FROM users WHERE id=?', [three]);
  assert.deepEqual(stored.two_factor_recovery_codes, []);
  const reusedToken = await challenge();
  assert.equal(((await routes['POST /api/auth/2fa/login'](req as FixtureValue, null, { challenge_token: reusedToken, code: recoveryCode } as FixtureValue, response() as FixtureValue)) as FixtureValue).status, 401);

  const concurrentToken = await challenge();
  const results = await Promise.all([1, 2].map(() => routes['POST /api/auth/2fa/login'](req as FixtureValue, null, { challenge_token: concurrentToken, code: otp() } as FixtureValue, response() as FixtureValue)));
  assert.equal(results.filter(result => (result as With<typeof result, 'user'>).user?.id === three).length, 1, 'Challenge is consumed atomically');
  assert.equal(results.filter(result => (result as With<typeof result, 'status'>).status === 401).length, 1);

  // Reject the final session INSERT in MySQL itself, after the recovery code
  // update and challenge deletion. Both earlier writes must roll back together.
  const rollbackChallenge = ((await signin('four@example.test'))! as FixtureValue).challengeToken;
  assert.match(rollbackChallenge, /^[a-f0-9]{64}$/);
  const [[beforeFailure]] = await pool.execute<RowDataPacket[]>('SELECT two_factor_recovery_codes FROM users WHERE id=?', [four]);
  await pool.execute(`ALTER TABLE sessions ADD CONSTRAINT test_session_insert_rejected CHECK (user_id <> '${four}')`);
  const failedResponse = response();
  const loggedErrors: FixtureValue[] = [];
  const logMock = t.mock.method(console, 'error', (...args: FixtureValue[]) => loggedErrors.push(args));
  try {
    const failed = await routes['POST /api/auth/2fa/login'](req as FixtureValue, null,
      { challenge_token: rollbackChallenge, code: recoveryCode } as FixtureValue, failedResponse as FixtureValue);
    assert.equal((failed as With<typeof failed, 'status'>).status, 500);
    assert.equal(loggedErrors.length, 1);
    // MariaDB reports a CHECK violation as errno 4025 (ER_CONSTRAINT_FAILED).
    assert.equal(loggedErrors[0][1]?.errno, 4025, 'Failure comes from the real database constraint');
    assert.match(loggedErrors[0][1]?.message, /test_session_insert_rejected/);
  } finally {
    logMock.mock.restore();
    await pool.execute('ALTER TABLE sessions DROP CONSTRAINT test_session_insert_rejected');
  }
  assert.equal(failedResponse.headers.has('Set-Cookie'), false, 'Uncommitted sessions must not issue cookies');
  const [[afterFailure]] = await pool.execute<RowDataPacket[]>('SELECT two_factor_recovery_codes FROM users WHERE id=?', [four]);
  assert.deepEqual(afterFailure.two_factor_recovery_codes, beforeFailure.two_factor_recovery_codes, 'Failed session creation keeps the recovery code usable');
  const [[pending]] = await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS count FROM two_factor_challenges WHERE user_id=?', [four]);
  assert.equal(pending.count, 1, 'Failed session creation restores the challenge');
  const [[sessions]] = await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?', [four]);
  assert.equal(sessions.count, 0);
  const retryResponse = response();
  const retried = await routes['POST /api/auth/2fa/login'](req as FixtureValue, null,
    { challenge_token: rollbackChallenge, code: recoveryCode } as FixtureValue, retryResponse as FixtureValue);
  assert.equal((retried as With<typeof retried, 'user'>).user.id, four, 'The same challenge and recovery code work after the database recovers');
  assert.equal((retried as With<typeof retried, 'recoveryCodesRemaining'>).recoveryCodesRemaining, 0);
  assert.equal(retryResponse.headers.has('Set-Cookie'), true);
});
