import type { FixtureValue, With } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');

// This file runs in its own test process against an empty disposable _test DB.
// ensureSchema needs synthetic first-run bootstrap inputs before config is loaded.
process.env.BOOTSTRAP_ADMIN_EMAIL = 'two-factor-fixture-admin@example.test';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-two-factor-fixture-admin-2026';
process.env.ENCRYPTION_KEY ||= 'two-factor-mysql-test-key';
process.env.JWT_SECRET ||= 'two-factor-mysql-test-jwt-key';

const crypto = (require('node:crypto') as typeof import('node:crypto'));
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
const { getDb, setDb } = require('../dist/src/state') as typeof import('../src/state');

// Independent of the service's implementation: RFC 6238 with SHA-1, 6 digits, 30 s.
function otp(secret: FixtureValue) {
  let bits: FixtureValue = '';
  for (const char of secret) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((byte: FixtureValue) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  return String((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function response() {
  const headers = new Map();
  return { headers, setHeader(key: FixtureValue, value: FixtureValue) { headers.set(key, value); }, getHeader(key: FixtureValue) { return headers.get(key); } };
}

const request = (token?: FixtureValue, url = '/api/auth/2fa', params: Record<string, string> = {}) => ({ url, params, headers: token ? { authorization: `Bearer ${token}` } : {}, socket: { remoteAddress: '127.0.0.1' } });

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
            const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES');
            for (const row of tables) {
              const table = Object.values(row)[0];
              assert.match((table as string), /^[a-z_]+$/);
              await connection.execute(`DROP TABLE \`${table}\``);
            }
          } finally { await connection.execute('SET FOREIGN_KEY_CHECKS = 1'); }
        }
      } finally { await pool.end(); await connection.end(); }
    });
    assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Use an empty disposable test database');
    const [existing] = await connection.query<RowDataPacket[]>('SHOW TABLES');
    assert.equal(existing.length, 0, 'Refusing to change a nonempty database');
    ownsDatabase = true;
    setDb(pool);
    await (require('../dist/src/services/database') as typeof import('../src/services/database')).ensureSchema();

    const { hashPassword, verifyPassword } = require('../dist/src/auth') as typeof import('../src/auth');
    const authRoutes = require('../dist/src/routes/auth') as typeof import('../src/routes/auth');
    const adminRoutes = require('../dist/src/routes/admin') as typeof import('../src/routes/admin');
    const { createTwoFactorLoginChallenge, replaceRecoveryCodes } = require('../dist/src/services/two-factor') as typeof import('../src/services/two-factor');

    const admin = crypto.randomUUID();
    const person = crypto.randomUUID();
    await pool.execute<ResultSetHeader>("INSERT INTO users (id,email,password_hash,role,is_active) VALUES (?,'admin@example.test',?,'admin',TRUE)",
      [admin, await hashPassword('synthetic-admin-password')]);
    await pool.execute<ResultSetHeader>("INSERT INTO users (id,email,password_hash,role,is_active) VALUES (?,'person@example.test',?,'user',TRUE)",
      [person, await hashPassword('synthetic-person-password')]);
    // The table holds token hashes (services/sessions.ts); the names map them back.
    const { sessionKey } = require('../dist/src/services/sessions') as typeof import('../src/services/sessions');
    const names = new Map<string, string>();
    const addSession = (userId: string, token: string) => { names.set(sessionKey(token), token);
      return pool.execute<ResultSetHeader>('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY))', [userId, sessionKey(token)]); };
    const sessions = async (userId: string) => (await pool.execute<RowDataPacket[]>('SELECT token FROM sessions WHERE user_id = ?', [userId]))[0]
      .map((row) => names.get(row.token) ?? row.token).sort();
    await addSession(admin, 'admin-session');
    await addSession(person, 'person-current');
    await addSession(person, 'person-laptop');

    // Setup: a wrong code changes nothing; the right one enables 2FA and signs out the other device.
    const setup = await authRoutes['POST /api/auth/2fa/setup/start'].handler(request('person-current') as FixtureValue, person);
    assert.match(setup.secret!, /^[A-Z2-7]{32}$/);
    assert.match(setup.otpauth_uri!, /^otpauth:\/\/totp\/UniHub%3Aperson%40example\.test\?secret=/);
    const confirm = (body: FixtureValue) => authRoutes['POST /api/auth/2fa/setup/confirm'].handler(request('person-current') as FixtureValue, person, { secret: setup.secret, ...body }, response() as FixtureValue);
    const wrong = String((Number(otp(setup.secret)) + 500000) % 1000000).padStart(6, '0');
    assert.equal(((await confirm({ code: wrong, current_password: 'synthetic-person-password' })) as FixtureValue).status, 400);
    // A signed-in session alone cannot enable 2FA and sign out the other devices.
    assert.equal(((await confirm({ code: otp(setup.secret) })) as FixtureValue).status, 400);
    assert.equal(((await confirm({ code: otp(setup.secret), current_password: 'wrong-person-password' })) as FixtureValue).status, 401);
    assert.deepEqual(await sessions(person), ['person-current', 'person-laptop']);
    assert.equal(((await authRoutes['GET /api/auth/2fa/status'].handler(request('person-current') as FixtureValue, person)) as FixtureValue).enabled, false);
    // A password change or deactivation commits before its session deletion. One landing
    // between the password check and the locked recheck changes nothing either.
    for (const change of ['UPDATE users SET password_hash = ? WHERE id = ?', 'UPDATE users SET is_active = FALSE WHERE id = ?']) {
      const [[saved]] = await pool.execute<RowDataPacket[]>('SELECT password_hash FROM users WHERE id = ?', [person]);
      // The other session has a connection of its own.
      const other = await pool.getConnection();
      const getConnection = async () => {
        const cx = await pool.getConnection();
        return { beginTransaction: () => cx.beginTransaction(), commit: () => cx.commit(), rollback: () => cx.rollback(), release: () => cx.release(),
          execute: async (sql: string, params: FixtureValue) => {
            if (/FROM users WHERE id = \? FOR UPDATE/.test(sql)) await other.execute(change, change.includes('password_hash') ? ['changed-meanwhile', person] : [person]);
            return cx.execute(sql, params);
          } };
      };
      setDb({ execute: (...args: FixtureValue[]) => pool.execute(...args as [string, FixtureValue]), getConnection } as FixtureValue);
      try {
        assert.equal(((await confirm({ code: otp(setup.secret), current_password: 'synthetic-person-password' })) as FixtureValue).status, 401);
      } finally { setDb(pool); other.release(); }
      await pool.execute<ResultSetHeader>('UPDATE users SET password_hash = ?, is_active = TRUE WHERE id = ?', [saved.password_hash, person]);
      assert.equal(((await authRoutes['GET /api/auth/2fa/status'].handler(request('person-current') as FixtureValue, person)) as FixtureValue).enabled, false);
      assert.deepEqual(await sessions(person), ['person-current', 'person-laptop']);
    }
    const enabled = await confirm({ code: otp(setup.secret), current_password: 'synthetic-person-password' });
    assert.equal((enabled as With<typeof enabled, 'enabled'>).enabled, true);
    assert.equal((enabled as With<typeof enabled, 'recoveryCodes'>).recoveryCodes.length, 10);
    assert.deepEqual(await sessions(person), ['person-current']);
    assert.deepEqual(await authRoutes['GET /api/auth/2fa/status'].handler(request('person-current') as FixtureValue, person), { enabled: true, recoveryCodesRemaining: 10, secretReadable: true });

    // A secret stored under another ENCRYPTION_KEY cannot be read. Status says so,
    // regenerating refuses without using up the recovery code, and sign-in with one still works.
    await pool.execute<ResultSetHeader>('UPDATE users SET encrypted_two_factor_secret = ? WHERE id = ?', ['00:00:00', person]);
    assert.deepEqual(await authRoutes['GET /api/auth/2fa/status'].handler(request('person-current') as FixtureValue, person), { enabled: true, recoveryCodesRemaining: 10, secretReadable: false });
    const regenerate = await authRoutes['POST /api/auth/2fa/recovery-codes/regenerate'].handler(request('person-current') as FixtureValue, person, { code: (enabled as With<typeof enabled, 'recoveryCodes'>).recoveryCodes[0] } as FixtureValue, response() as FixtureValue);
    assert.equal((regenerate as With<typeof regenerate, 'status'>).status, 409);
    assert.match((regenerate as With<typeof regenerate, 'error'>).error, /encryption key changed/);
    const challenge = await createTwoFactorLoginChallenge(person, request() as FixtureValue);
    const signedIn = await authRoutes['POST /api/auth/2fa/login'].handler(request() as FixtureValue, null, { challenge_token: challenge, code: (enabled as With<typeof enabled, 'recoveryCodes'>).recoveryCodes[0] } as FixtureValue, response() as FixtureValue);
    assert.equal((signedIn as With<typeof signedIn, 'usedRecoveryCode'>).usedRecoveryCode, true);
    assert.equal((signedIn as With<typeof signedIn, 'recoveryCodesRemaining'>).recoveryCodesRemaining, 9);
    await createTwoFactorLoginChallenge(person, request() as FixtureValue);

    // Admin reset: admins only, not for themselves, with the admin's own password.
    const reset = async (userId: string, target: FixtureValue, password: FixtureValue, token = 'admin-session') => (await adminRoutes['POST /api/admin/users/:id/2fa/reset'].handler(
      request(token, `/api/admin/users/${target}/2fa/reset`, { id: target }) as FixtureValue, userId, { current_password: password } as FixtureValue, response() as FixtureValue)) as FixtureValue;
    // The boundary admits only admins (routes-policy.test.cts); the route's own
    // in-transaction role check still refuses a non-admin whose password verified.
    assert.equal((await reset(person, admin, 'synthetic-person-password', 'person-current')).status, 403);
    assert.equal((await reset(admin, admin, 'synthetic-admin-password')).status, 400);
    // 403, not 401: the client signs out on a 401 from a non-auth endpoint.
    assert.equal((await reset(admin, person, 'wrong-admin-password')).status, 403);
    assert.equal((await reset(admin, crypto.randomUUID(), 'synthetic-admin-password')).status, 404);
    const listed = (await adminRoutes['GET /api/admin/users'].handler(request(null, '/api/admin/users') as FixtureValue, admin)).users;
    assert.equal(listed!.find((user: FixtureValue) => user.id === person)!.two_factor_enabled, true);
    assert.equal(listed!.find((user: FixtureValue) => user.id === admin)!.two_factor_enabled, false);

    // A request from an admin session that was signed out meanwhile changes nothing.
    assert.equal((await reset(admin, person, 'synthetic-admin-password', 'admin-signed-out')).status, 401);
    assert.equal(((await authRoutes['GET /api/auth/2fa/status'].handler(request('person-current') as FixtureValue, person)) as FixtureValue).enabled, true);
    // Deactivation commits before deleting sessions; an admin caught in between changes nothing either.
    await pool.execute<ResultSetHeader>('UPDATE users SET is_active = FALSE WHERE id = ?', [admin]);
    assert.equal((await reset(admin, person, 'synthetic-admin-password')).status, 401);
    assert.equal(((await authRoutes['GET /api/auth/2fa/status'].handler(request('person-current') as FixtureValue, person)) as FixtureValue).enabled, true);
    await pool.execute<ResultSetHeader>('UPDATE users SET is_active = TRUE WHERE id = ?', [admin]);
    // So is an admin whose password changed after it was checked, before the session deletion.
    const other = await pool.getConnection();
    setDb({ execute: (...args: FixtureValue[]) => pool.execute(...args as [string, FixtureValue]), getConnection: (async () => {
      const cx = await pool.getConnection();
      return { beginTransaction: () => cx.beginTransaction(), commit: () => cx.commit(), rollback: () => cx.rollback(), release: () => cx.release(),
        execute: async (sql: string, params: FixtureValue) => {
          if (/FROM users WHERE id IN \(\?, \?\) ORDER BY id FOR UPDATE/.test(sql))
            await other.execute<ResultSetHeader>("UPDATE users SET password_hash = 'changed-meanwhile' WHERE id = ?", [admin]);
          return cx.execute(sql, params);
        } };
    }) } as FixtureValue);
    try {
      assert.equal((await reset(admin, person, 'synthetic-admin-password')).status, 401);
    } finally { setDb(pool); other.release(); }
    await pool.execute<ResultSetHeader>('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword('synthetic-admin-password'), admin]);
    assert.equal(((await authRoutes['GET /api/auth/2fa/status'].handler(request('person-current') as FixtureValue, person)) as FixtureValue).enabled, true);

    assert.equal((await reset(admin, person, 'synthetic-admin-password')).message, 'Two-factor authentication reset');
    const [[after]] = await pool.execute<RowDataPacket[]>('SELECT two_factor_enabled, encrypted_two_factor_secret, two_factor_recovery_codes FROM users WHERE id = ?', [person]);
    assert.deepEqual({ ...after, two_factor_enabled: !!after.two_factor_enabled }, { two_factor_enabled: false, encrypted_two_factor_secret: null, two_factor_recovery_codes: null });
    assert.deepEqual(await sessions(person), []);
    assert.equal((await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS count FROM two_factor_challenges WHERE user_id = ?', [person]))[0][0].count, 0);
    assert.deepEqual(await sessions(admin), ['admin-session']);
    assert.equal((await reset(admin, person, 'synthetic-admin-password')).status, 400);

    // A request from a session the reset deleted, already past authentication, cannot turn 2FA back on.
    const late = await confirm({ code: otp(setup.secret), current_password: 'synthetic-person-password' });
    assert.equal((late as With<typeof late, 'status'>).status, 401);
    assert.equal((late as With<typeof late, 'recoveryCodes'>).recoveryCodes, undefined);
    assert.equal(await replaceRecoveryCodes(person, []), false);
    const [[still]] = await pool.execute<RowDataPacket[]>('SELECT two_factor_enabled, two_factor_recovery_codes FROM users WHERE id = ?', [person]);
    assert.deepEqual({ ...still, two_factor_enabled: !!still.two_factor_enabled }, { two_factor_enabled: false, two_factor_recovery_codes: null });

    // Setting another person's password or role also needs the admin's own
    // password (its own attempt budget: a second admin).
    const steward = crypto.randomUUID();
    await pool.execute<ResultSetHeader>("INSERT INTO users (id,email,password_hash,role,is_active) VALUES (?,'steward@example.test',?,'admin',TRUE)",
      [steward, await hashPassword('synthetic-steward-password')]);
    await addSession(person, 'person-phone');
    const stored = async () => (await pool.execute<RowDataPacket[]>('SELECT role, password_hash FROM users WHERE id = ?', [person]))[0][0];
    const before = await stored();
    const setPassword = async (body: FixtureValue) => (await adminRoutes['PUT /api/admin/users/:id/password'].handler(
      request('admin-session', `/api/admin/users/${person}/password`, { id: person }) as FixtureValue, steward, body, response() as FixtureValue)) as FixtureValue;
    const setRole = async (body: FixtureValue) => (await adminRoutes['PUT /api/admin/users/:id/role'].handler(
      request('admin-session', `/api/admin/users/${person}/role`, { id: person }) as FixtureValue, steward, body, response() as FixtureValue)) as FixtureValue;
    assert.deepEqual([(await setPassword({ new_password: 'synthetic-new-person-password' })).code, (await setRole({ role: 'admin' })).code],
      ['ADMIN_PASSWORD_REQUIRED', 'ADMIN_PASSWORD_REQUIRED']);
    assert.equal((await setPassword({ new_password: 'synthetic-new-person-password', current_password: 'wrong' })).status, 403);
    assert.equal((await setRole({ role: 'admin', current_password: 'wrong' })).status, 403);
    assert.deepEqual(await stored(), before, 'nothing changed without the admin password');
    assert.deepEqual(await sessions(person), ['person-phone']);
    assert.equal((await setRole({ role: 'admin', current_password: 'synthetic-steward-password' })).message, 'User role set to admin');
    assert.equal((await setPassword({ new_password: 'synthetic-new-person-password', current_password: 'synthetic-steward-password' })).message, 'Password updated successfully');
    const changed = await stored();
    assert.equal(changed.role, 'admin');
    assert.ok(await verifyPassword('synthetic-new-person-password', changed.password_hash));
    assert.deepEqual(await sessions(person), [], 'the new password signs the person out everywhere');

    // Deactivating or deleting someone needs it too (B-05); activating does not.
    const leaver = crypto.randomUUID();
    await pool.execute<ResultSetHeader>("INSERT INTO users (id,email,password_hash,role,is_active) VALUES (?,'leaver@example.test','x','user',TRUE)", [leaver]);
    const setActive = async (body: FixtureValue) => (await adminRoutes['PUT /api/admin/users/:id/activate'].handler(
      request('admin-session', `/api/admin/users/${leaver}/activate`, { id: leaver }) as FixtureValue, steward, body, response() as FixtureValue)) as FixtureValue;
    const remove = async (body: FixtureValue) => (await adminRoutes['DELETE /api/admin/users/:id'].handler(
      request('admin-session', `/api/admin/users/${leaver}`, { id: leaver }) as FixtureValue, steward, body, response() as FixtureValue)) as FixtureValue;
    const leaverRow = async () => (await pool.execute<RowDataPacket[]>('SELECT is_active FROM users WHERE id = ?', [leaver]))[0][0];
    assert.deepEqual([(await setActive({ is_active: false })).code, (await remove({})).code], ['ADMIN_PASSWORD_REQUIRED', 'ADMIN_PASSWORD_REQUIRED']);
    assert.equal((await remove({ current_password: 'wrong' })).status, 403);
    assert.equal(!!(await leaverRow())?.is_active, true, 'still there and active');
    assert.equal((await setActive({ is_active: false, current_password: 'synthetic-steward-password' })).message, 'User deactivated');
    assert.equal((await setActive({ is_active: true })).message, 'User activated');

    // Confirmations have their own budget (B-04), spent only by wrong
    // passwords: failed sign-ins do not lock the admin out of admin actions.
    const { consumeAuthAttempt } = require('../dist/src/auth') as typeof import('../src/auth');
    while (consumeAuthAttempt('password', steward) === null);
    // Three wrong confirmations so far, and three right ones that cost nothing.
    for (let attempt = 4; attempt <= 10; attempt++) assert.equal((await remove({ current_password: 'wrong' })).status, 403, `wrong confirmation ${attempt}`);
    assert.equal((await remove({ current_password: 'synthetic-steward-password' })).status, 429, 'ten wrong confirmations pause confirmations');
    assert.ok(await leaverRow(), 'and nothing was deleted');

    // A burst of parallel guesses gets no more than the ten attempts.
    const burstAdmin = crypto.randomUUID();
    await pool.execute<ResultSetHeader>("INSERT INTO users (id,email,password_hash,role,is_active) VALUES (?,'burst@example.test',?,'admin',TRUE)",
      [burstAdmin, await hashPassword('synthetic-burst-password')]);
    const burst = await Promise.all(Array.from({ length: 30 }, async () => ((await adminRoutes['DELETE /api/admin/users/:id'].handler(
      request('admin-session', `/api/admin/users/${leaver}`, { id: leaver }) as FixtureValue, burstAdmin, { current_password: 'wrong' } as FixtureValue, response() as FixtureValue)) as FixtureValue).status));
    assert.deepEqual([burst.filter(status => status === 403).length, burst.filter(status => status === 429).length], [10, 20]);
  });
