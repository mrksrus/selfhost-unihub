import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

test('signed-in devices can be listed and signed out one by one, and security events are audited', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'audit-bootstrap@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-audit-bootstrap-password';
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const sessions = require('../dist/src/services/sessions') as typeof import('../src/services/sessions');
  const audit = require('../dist/src/services/audit') as typeof import('../src/services/audit');
  const authRoutes = require('../dist/src/routes/auth') as FixtureValue;
  const { generateToken, getSessionExpiry, SESSION_DAYS } = require('../dist/src/auth') as typeof import('../src/auth');

  const owner = crypto.randomUUID(), stranger = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'owner@example.test', 'x'), (?, 'stranger@example.test', 'x')", [owner, stranger]);
  const phone = generateToken(owner), laptop = generateToken(owner), theirs = generateToken(stranger);
  await sessions.createSession({ userId: owner, token: laptop, expiresAt: getSessionExpiry(), ipAddress: '192.0.2.10', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0' });
  await sessions.createSession({ userId: owner, token: phone, expiresAt: getSessionExpiry(), ipAddress: '198.51.100.7', userAgent: 'Mozilla/5.0 (Linux; Android 16) UniHubAndroid/0.23.0 (23000)' });
  await sessions.createSession({ userId: stranger, token: theirs, expiresAt: getSessionExpiry() });

  const request = (token: string, url = '/api/auth/sessions', params: Record<string, string> = {}) =>
    ({ url, params, headers: { cookie: `auth-token=${token}`, 'user-agent': 'test' }, socket: { remoteAddress: '203.0.113.5' } });
  const listed = (await authRoutes['GET /api/auth/sessions'].handler(request(laptop), owner)).sessions;
  assert.equal(listed.length, 2, 'only the owner\'s sessions');
  const mine = listed.find((session: FixtureValue) => session.current);
  const other = listed.find((session: FixtureValue) => !session.current);
  assert.deepEqual([mine.ipAddress, other.ipAddress], ['192.0.2.10', '198.51.100.7']);
  assert.match(other.userAgent, /Android/);
  // Expiry is set in local calendar days, so a DST change in between moves it by an hour; it is shown to the day.
  assert.ok(Math.abs(Date.parse(mine.lastActiveAt) - Date.now()) < 2 * 3_600_000, 'a fresh session was used now');
  assert.equal(SESSION_DAYS, 21);

  const revoke = (token: string, id: string, actor = owner) => authRoutes['DELETE /api/auth/sessions/:id'].handler(request(token, `/api/auth/sessions/${id}`, { id }), actor);
  assert.equal((await revoke(laptop, mine.id)).code, 'SESSION_CURRENT');
  const [[strangerSession]] = await pool.query<RowDataPacket[]>('SELECT id FROM sessions WHERE user_id = ?', [stranger]);
  assert.equal((await revoke(laptop, strangerSession.id)).status, 404, 'another user\'s session is not found');
  assert.ok(await sessions.findSession(theirs));
  assert.deepEqual(await revoke(laptop, other.id), { signedOut: true });
  assert.equal(await sessions.findSession(phone), null, 'the phone is signed out');
  assert.ok(await sessions.findSession(laptop), 'this device stays signed in');

  // The audit entry commits with its transaction, or not at all.
  const { withTransaction } = require('../dist/src/services/transactions') as typeof import('../src/services/transactions');
  await assert.rejects(withTransaction(async cx => {
    await audit.recordAudit({ action: 'admin.two_factor_reset', actorId: stranger, targetUserId: owner }, cx);
    throw new Error('rolled back');
  }, pool), /rolled back/);
  for (let index = 0; index < 3; index++) await audit.recordAudit({ action: 'admin.role_changed', actorId: stranger, targetUserId: owner, details: { role: index % 2 ? 'admin' : 'user' } });
  const first = await audit.listAuditLog({ limit: 2 });
  assert.equal(first.more, true);
  const last = first.entries[first.entries.length - 1];
  const second = await audit.listAuditLog({ limit: 2, before: { createdAt: last.createdAt, id: last.id } });
  const all = [...first.entries, ...second.entries];
  assert.deepEqual(all.map(entry => entry.action).sort(), ['admin.role_changed', 'admin.role_changed', 'admin.role_changed', 'auth.session_revoked']);
  assert.equal(new Set(all.map(entry => entry.id)).size, 4, 'pages do not repeat entries');
  const revoked = all.find(entry => entry.action === 'auth.session_revoked')!;
  assert.deepEqual([revoked.actor?.email, revoked.target?.email, revoked.ipAddress, revoked.details], ['owner@example.test', 'owner@example.test', '203.0.113.5', { session: other.id }]);
  assert.ok(!all.some(entry => entry.action === 'admin.two_factor_reset'));

  // An entry about a deleted account stays, without the address book.
  await pool.execute('DELETE FROM users WHERE id = ?', [stranger]);
  const kept = (await audit.listAuditLog({ limit: 50 })).entries.filter(entry => entry.actor?.id === stranger);
  assert.equal(kept.length, 3);
  assert.equal(kept[0].actor!.email, null);
  await pool.execute('UPDATE audit_log SET created_at = UTC_TIMESTAMP() - INTERVAL 400 DAY WHERE actor_id = ?', [stranger]);
  assert.equal(await audit.pruneAuditLog(), 3);
  assert.equal((await audit.listAuditLog()).entries.length, 1);
});
