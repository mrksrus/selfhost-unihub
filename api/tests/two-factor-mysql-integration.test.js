const test = require('node:test');
const assert = require('node:assert/strict');

// This file runs in its own test process against an empty disposable _test DB.
// ensureSchema needs synthetic first-run bootstrap inputs before config is loaded.
process.env.BOOTSTRAP_ADMIN_EMAIL = 'two-factor-fixture-admin@example.test';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-two-factor-fixture-admin-2026';
process.env.ENCRYPTION_KEY ||= 'two-factor-mysql-test-key';
process.env.JWT_SECRET ||= 'two-factor-mysql-test-jwt-key';

const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { getDb, setDb } = require('../dist/src/state');

// Independent of the service's implementation: RFC 6238 with SHA-1, 6 digits, 30 s.
function otp(secret) {
  let bits = '';
  for (const char of secret) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  return String((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function response() {
  const headers = new Map();
  return { headers, setHeader(key, value) { headers.set(key, value); }, getHeader(key) { return headers.get(key); } };
}

const request = (token, url = '/api/auth/2fa') => ({ url, headers: token ? { authorization: `Bearer ${token}` } : {}, socket: { remoteAddress: '127.0.0.1' } });

test('2FA setup signs out other devices, an unreadable secret keeps recovery codes usable and admins can reset 2FA',
  { skip: !process.env.MYSQL_TEST_HOST }, async (t) => {
    const options = { host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
      user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
      database: process.env.MYSQL_TEST_DATABASE || 'unihub_test', timezone: '+00:00' };
    const connection = await mysql.createConnection(options);
    const pool = mysql.createPool({ ...options, connectionLimit: 4 });
    const previous = getDb();
    let ownsDatabase = false;
    t.after(async () => {
      setDb(previous);
      try {
        if (ownsDatabase) {
          await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
          try {
            const [tables] = await connection.query('SHOW TABLES');
            for (const row of tables) {
              const table = Object.values(row)[0];
              assert.match(table, /^[a-z_]+$/);
              await connection.execute(`DROP TABLE \`${table}\``);
            }
          } finally { await connection.execute('SET FOREIGN_KEY_CHECKS = 1'); }
        }
      } finally { await pool.end(); await connection.end(); }
    });
    assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Use an empty disposable test database');
    const [existing] = await connection.query('SHOW TABLES');
    assert.equal(existing.length, 0, 'Refusing to change a nonempty database');
    ownsDatabase = true;
    setDb(pool);
    await require('../dist/src/services/database').ensureSchema();

    const { hashPassword } = require('../dist/src/auth');
    const authRoutes = require('../dist/src/routes/auth');
    const adminRoutes = require('../dist/src/routes/admin');
    const { createTwoFactorLoginChallenge, replaceRecoveryCodes } = require('../dist/src/services/two-factor');

    const admin = crypto.randomUUID();
    const person = crypto.randomUUID();
    await pool.execute("INSERT INTO users (id,email,password_hash,role,is_active) VALUES (?,'admin@example.test',?,'admin',TRUE)",
      [admin, await hashPassword('synthetic-admin-password')]);
    await pool.execute("INSERT INTO users (id,email,password_hash,role,is_active) VALUES (?,'person@example.test',?,'user',TRUE)",
      [person, await hashPassword('synthetic-person-password')]);
    const addSession = (userId, token) => pool.execute('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY))', [userId, token]);
    const sessions = async userId => (await pool.execute('SELECT token FROM sessions WHERE user_id = ? ORDER BY token', [userId]))[0].map(row => row.token);
    await addSession(admin, 'admin-session');
    await addSession(person, 'person-current');
    await addSession(person, 'person-laptop');

    // Setup: a wrong code changes nothing; the right one enables 2FA and signs out the other device.
    const setup = await authRoutes['POST /api/auth/2fa/setup/start'](request('person-current'), person);
    assert.match(setup.secret, /^[A-Z2-7]{32}$/);
    assert.match(setup.otpauth_uri, /^otpauth:\/\/totp\/UniHub%3Aperson%40example\.test\?secret=/);
    const confirm = (body) => authRoutes['POST /api/auth/2fa/setup/confirm'](request('person-current'), person, { secret: setup.secret, ...body }, response());
    const wrong = String((Number(otp(setup.secret)) + 500000) % 1000000).padStart(6, '0');
    assert.equal((await confirm({ code: wrong, current_password: 'synthetic-person-password' })).status, 400);
    // A signed-in session alone cannot enable 2FA and sign out the other devices.
    assert.equal((await confirm({ code: otp(setup.secret) })).status, 400);
    assert.equal((await confirm({ code: otp(setup.secret), current_password: 'wrong-person-password' })).status, 401);
    assert.deepEqual(await sessions(person), ['person-current', 'person-laptop']);
    assert.equal((await authRoutes['GET /api/auth/2fa/status'](request('person-current'), person)).enabled, false);
    // A password change or deactivation commits before its session deletion. One landing
    // between the password check and the locked recheck changes nothing either.
    for (const change of ['UPDATE users SET password_hash = ? WHERE id = ?', 'UPDATE users SET is_active = FALSE WHERE id = ?']) {
      const [[saved]] = await pool.execute('SELECT password_hash FROM users WHERE id = ?', [person]);
      const getConnection = async () => {
        const cx = await pool.getConnection();
        return { beginTransaction: () => cx.beginTransaction(), commit: () => cx.commit(), rollback: () => cx.rollback(), release: () => cx.release(),
          execute: async (sql, params) => {
            if (/FROM users WHERE id = \? FOR UPDATE/.test(sql)) await pool.execute(change, change.includes('password_hash') ? ['changed-meanwhile', person] : [person]);
            return cx.execute(sql, params);
          } };
      };
      setDb({ execute: (...args) => pool.execute(...args), getConnection });
      try {
        assert.equal((await confirm({ code: otp(setup.secret), current_password: 'synthetic-person-password' })).status, 401);
      } finally { setDb(pool); }
      await pool.execute('UPDATE users SET password_hash = ?, is_active = TRUE WHERE id = ?', [saved.password_hash, person]);
      assert.equal((await authRoutes['GET /api/auth/2fa/status'](request('person-current'), person)).enabled, false);
      assert.deepEqual(await sessions(person), ['person-current', 'person-laptop']);
    }
    const enabled = await confirm({ code: otp(setup.secret), current_password: 'synthetic-person-password' });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.recoveryCodes.length, 10);
    assert.deepEqual(await sessions(person), ['person-current']);
    assert.deepEqual(await authRoutes['GET /api/auth/2fa/status'](request('person-current'), person), { enabled: true, recoveryCodesRemaining: 10, secretReadable: true });

    // A secret stored under another ENCRYPTION_KEY cannot be read. Status says so,
    // regenerating refuses without using up the recovery code, and sign-in with one still works.
    await pool.execute('UPDATE users SET encrypted_two_factor_secret = ? WHERE id = ?', ['00:00:00', person]);
    assert.deepEqual(await authRoutes['GET /api/auth/2fa/status'](request('person-current'), person), { enabled: true, recoveryCodesRemaining: 10, secretReadable: false });
    const regenerate = await authRoutes['POST /api/auth/2fa/recovery-codes/regenerate'](request('person-current'), person, { code: enabled.recoveryCodes[0] }, response());
    assert.equal(regenerate.status, 409);
    assert.match(regenerate.error, /encryption key changed/);
    const challenge = await createTwoFactorLoginChallenge(person, request());
    const signedIn = await authRoutes['POST /api/auth/2fa/login'](request(), null, { challenge_token: challenge, code: enabled.recoveryCodes[0] }, response());
    assert.equal(signedIn.usedRecoveryCode, true);
    assert.equal(signedIn.recoveryCodesRemaining, 9);
    await createTwoFactorLoginChallenge(person, request());

    // Admin reset: admins only, not for themselves, with the admin's own password.
    const resetUrl = `/api/admin/users/${person}/2fa/reset`;
    const reset = (userId, target, password, token = 'admin-session') => adminRoutes['POST /api/admin/users/:id/2fa/reset'](
      request(token, `/api/admin/users/${target}/2fa/reset`), userId, { current_password: password }, response());
    assert.equal((await adminRoutes['POST /api/admin/users/:id/2fa/reset'](request(null, resetUrl), person, { current_password: 'synthetic-person-password' }, response())).status, 403);
    assert.equal((await reset(admin, admin, 'synthetic-admin-password')).status, 400);
    // 403, not 401: the client signs out on a 401 from a non-auth endpoint.
    assert.equal((await reset(admin, person, 'wrong-admin-password')).status, 403);
    assert.equal((await reset(admin, crypto.randomUUID(), 'synthetic-admin-password')).status, 404);
    const listed = (await adminRoutes['GET /api/admin/users'](request(null, '/api/admin/users'), admin)).users;
    assert.equal(listed.find(user => user.id === person).two_factor_enabled, true);
    assert.equal(listed.find(user => user.id === admin).two_factor_enabled, false);

    // A request from an admin session that was signed out meanwhile changes nothing.
    assert.equal((await reset(admin, person, 'synthetic-admin-password', 'admin-signed-out')).status, 401);
    assert.equal((await authRoutes['GET /api/auth/2fa/status'](request('person-current'), person)).enabled, true);
    // Deactivation commits before deleting sessions; an admin caught in between changes nothing either.
    await pool.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [admin]);
    assert.equal((await reset(admin, person, 'synthetic-admin-password')).status, 401);
    assert.equal((await authRoutes['GET /api/auth/2fa/status'](request('person-current'), person)).enabled, true);
    await pool.execute('UPDATE users SET is_active = TRUE WHERE id = ?', [admin]);
    // So is an admin whose password changed after it was checked, before the session deletion.
    setDb({ execute: (...args) => pool.execute(...args), getConnection: async () => {
      const cx = await pool.getConnection();
      return { beginTransaction: () => cx.beginTransaction(), commit: () => cx.commit(), rollback: () => cx.rollback(), release: () => cx.release(),
        execute: async (sql, params) => {
          if (/FROM users WHERE id IN \(\?, \?\) ORDER BY id FOR UPDATE/.test(sql))
            await pool.execute("UPDATE users SET password_hash = 'changed-meanwhile' WHERE id = ?", [admin]);
          return cx.execute(sql, params);
        } };
    } });
    try {
      assert.equal((await reset(admin, person, 'synthetic-admin-password')).status, 401);
    } finally { setDb(pool); }
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword('synthetic-admin-password'), admin]);
    assert.equal((await authRoutes['GET /api/auth/2fa/status'](request('person-current'), person)).enabled, true);

    assert.equal((await reset(admin, person, 'synthetic-admin-password')).message, 'Two-factor authentication reset');
    const [[after]] = await pool.execute('SELECT two_factor_enabled, encrypted_two_factor_secret, two_factor_recovery_codes FROM users WHERE id = ?', [person]);
    assert.deepEqual({ ...after, two_factor_enabled: !!after.two_factor_enabled }, { two_factor_enabled: false, encrypted_two_factor_secret: null, two_factor_recovery_codes: null });
    assert.deepEqual(await sessions(person), []);
    assert.equal((await pool.execute('SELECT COUNT(*) AS count FROM two_factor_challenges WHERE user_id = ?', [person]))[0][0].count, 0);
    assert.deepEqual(await sessions(admin), ['admin-session']);
    assert.equal((await reset(admin, person, 'synthetic-admin-password')).status, 400);

    // A request from a session the reset deleted, already past authentication, cannot turn 2FA back on.
    const late = await confirm({ code: otp(setup.secret), current_password: 'synthetic-person-password' });
    assert.equal(late.status, 401);
    assert.equal(late.recoveryCodes, undefined);
    assert.equal(await replaceRecoveryCodes(person, []), false);
    const [[still]] = await pool.execute('SELECT two_factor_enabled, two_factor_recovery_codes FROM users WHERE id = ?', [person]);
    assert.deepEqual({ ...still, two_factor_enabled: !!still.two_factor_enabled }, { two_factor_enabled: false, two_factor_recovery_codes: null });
  });
