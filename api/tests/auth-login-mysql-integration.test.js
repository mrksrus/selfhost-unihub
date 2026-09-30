const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.ENCRYPTION_KEY ||= 'auth-integration-encryption-key';
process.env.JWT_SECRET ||= 'auth-integration-jwt-key';

function response() {
  const headers = new Map();
  return { headers, setHeader(key, value) { headers.set(key, value); }, getHeader(key) { return headers.get(key); } };
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
  const mysql = require('mysql2/promise');
  const bcrypt = require('bcryptjs');
  const { setDb } = require('../src/state');
  const { encrypt } = require('../src/security/encryption');
  const { verifyToken } = require('../src/auth');
  const routes = require('../src/routes/auth');
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, database: process.env.MYSQL_TEST_DATABASE, connectionLimit: 4 });
  const created = [];
  t.after(async () => {
    for (const name of created.reverse()) await pool.execute(`DROP TABLE ${name}`);
    setDb(null); await pool.end();
  });
  const [existing] = await pool.query('SHOW TABLES');
  assert.equal(existing.length, 0, 'This integration fixture requires an empty disposable test database');
  for (const [name, ddl] of [
    ['users', `id CHAR(36) PRIMARY KEY, email VARCHAR(255) UNIQUE, password_hash TEXT, full_name TEXT, avatar_url TEXT, role VARCHAR(20), timezone VARCHAR(80), is_active BOOLEAN, two_factor_enabled BOOLEAN DEFAULT FALSE, encrypted_two_factor_secret TEXT, two_factor_recovery_codes JSON`],
    ['sessions', `id INT AUTO_INCREMENT PRIMARY KEY, user_id CHAR(36), token VARCHAR(512) NOT NULL UNIQUE, expires_at DATETIME, FOREIGN KEY (user_id) REFERENCES users(id)`],
    ['two_factor_challenges', `id CHAR(36) PRIMARY KEY, user_id CHAR(36), token_hash CHAR(64) UNIQUE, expires_at DATETIME, ip_address VARCHAR(64), user_agent TEXT, FOREIGN KEY (user_id) REFERENCES users(id)`],
  ]) { await pool.execute(`CREATE TABLE ${name} (${ddl}) ENGINE=InnoDB`); created.push(name); }
  setDb(pool);
  const [one, two, three, four] = Array.from({ length: 4 }, () => crypto.randomUUID());
  const password = 'integration-correct-password';
  const hash = await bcrypt.hash(password, 4);
  const recoveryCode = 'ABCDE-12345';
  for (const [id, email, has2fa] of [[one, 'one@example.test', false], [two, 'two@example.test', false], [three, 'three@example.test', true], [four, 'four@example.test', true]]) {
    await pool.execute('INSERT INTO users (id,email,password_hash,role,is_active,two_factor_enabled,encrypted_two_factor_secret,two_factor_recovery_codes) VALUES (?,?,?,\'user\',TRUE,?,?,?)',
      [id, email, hash, has2fa, has2fa ? encrypt('JBSWY3DPEHPK3PXP') : null, has2fa ? JSON.stringify([await bcrypt.hash(recoveryCode, 4)]) : null]);
  }
  const req = { headers: {}, socket: { remoteAddress: '192.0.2.1' } };
  const signin = (email, pass = password) => routes['POST /api/auth/signin'](req, null, { email, password: pass }, response());
  // A correct login to user two never clears failed guesses against user one.
  for (let index = 0; index < 10; index++) {
    assert.equal((await signin(index % 2 ? 'ONE@example.test' : 'one@example.test', 'incorrect')).status, 401);
    if (index < 3) assert.equal((await signin('two@example.test')).user.id, two);
  }
  assert.equal((await signin('one@example.test')).status, 429);
  assert.equal((await signin('two@example.test')).user.id, two, 'Same proxy/IP must not lock another account');

  async function challenge() {
    const result = await signin('three@example.test');
    assert.equal(result.requires2fa, true);
    return result.challengeToken;
  }
  const token = await challenge();
  const res = response();
  const verified = await routes['POST /api/auth/2fa/login'](req, null, { challenge_token: token, code: otp() }, res);
  assert.equal(verified.user.id, three);
  const cookies = res.headers.get('Set-Cookie').map(value => value.split(';')[0]).join('; ');
  assert.equal(await verifyToken({ headers: { cookie: cookies } }), three, 'Issued session authenticates the actual user');
  assert.equal((await routes['POST /api/auth/2fa/login'](req, null, { challenge_token: token, code: otp() }, response())).status, 401);

  const recoveryToken = await challenge();
  const recovered = await routes['POST /api/auth/2fa/login'](req, null, { challenge_token: recoveryToken, code: recoveryCode }, response());
  assert.equal(recovered.user.id, three); assert.equal(recovered.recoveryCodesRemaining, 0);
  const [[stored]] = await pool.execute('SELECT two_factor_recovery_codes FROM users WHERE id=?', [three]);
  assert.deepEqual(stored.two_factor_recovery_codes, []);
  const reusedToken = await challenge();
  assert.equal((await routes['POST /api/auth/2fa/login'](req, null, { challenge_token: reusedToken, code: recoveryCode }, response())).status, 401);

  const concurrentToken = await challenge();
  const results = await Promise.all([1, 2].map(() => routes['POST /api/auth/2fa/login'](req, null, { challenge_token: concurrentToken, code: otp() }, response())));
  assert.equal(results.filter(result => result.user?.id === three).length, 1, 'Challenge is consumed atomically');
  assert.equal(results.filter(result => result.status === 401).length, 1);

  // Reject the final session INSERT in MySQL itself, after the recovery code
  // update and challenge deletion. Both earlier writes must roll back together.
  const rollbackChallenge = (await signin('four@example.test')).challengeToken;
  assert.match(rollbackChallenge, /^[a-f0-9]{64}$/);
  const [[beforeFailure]] = await pool.execute('SELECT two_factor_recovery_codes FROM users WHERE id=?', [four]);
  await pool.execute(`ALTER TABLE sessions ADD CONSTRAINT test_session_insert_rejected CHECK (user_id <> '${four}')`);
  const failedResponse = response();
  const loggedErrors = [];
  const logMock = t.mock.method(console, 'error', (...args) => loggedErrors.push(args));
  try {
    const failed = await routes['POST /api/auth/2fa/login'](req, null,
      { challenge_token: rollbackChallenge, code: recoveryCode }, failedResponse);
    assert.equal(failed.status, 500);
    assert.equal(loggedErrors.length, 1);
    assert.equal(loggedErrors[0][1]?.code, 'ER_CHECK_CONSTRAINT_VIOLATED', 'Failure comes from the real database constraint');
  } finally {
    logMock.mock.restore();
    await pool.execute('ALTER TABLE sessions DROP CHECK test_session_insert_rejected');
  }
  assert.equal(failedResponse.headers.has('Set-Cookie'), false, 'Uncommitted sessions must not issue cookies');
  const [[afterFailure]] = await pool.execute('SELECT two_factor_recovery_codes FROM users WHERE id=?', [four]);
  assert.deepEqual(afterFailure.two_factor_recovery_codes, beforeFailure.two_factor_recovery_codes, 'Failed session creation keeps the recovery code usable');
  const [[pending]] = await pool.execute('SELECT COUNT(*) AS count FROM two_factor_challenges WHERE user_id=?', [four]);
  assert.equal(pending.count, 1, 'Failed session creation restores the challenge');
  const [[sessions]] = await pool.execute('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?', [four]);
  assert.equal(sessions.count, 0);
  const retryResponse = response();
  const retried = await routes['POST /api/auth/2fa/login'](req, null,
    { challenge_token: rollbackChallenge, code: recoveryCode }, retryResponse);
  assert.equal(retried.user.id, four, 'The same challenge and recovery code work after the database recovers');
  assert.equal(retried.recoveryCodesRemaining, 0);
  assert.equal(retryResponse.headers.has('Set-Cookie'), true);
});
