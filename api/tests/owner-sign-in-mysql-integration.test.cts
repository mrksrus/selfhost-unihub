import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople, PEOPLE } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// Only the owner changes the owner's sign-in. An administrator who could set
// the owner's password, turn off their two-factor authentication or give
// them a setup link could sign in as the owner and so make or remove
// administrators. Through the real request handler: an administrator is
// refused each of these against the owner and allowed them against a member;
// ending the owner's devices stays allowed (it only signs them out); the
// owner may change their own password.
test('an administrator cannot change the owner\'s sign-in; the owner can, and a member\'s stays an administrator\'s to reset', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, clients, password, api } = await seedPeople(t, pool);
  const owner = clients.admin;
  // The bootstrap administrator: an administrator, not the owner (the fixture handed ownership on).
  const admin = api.client();
  const adminPassword = String(process.env.BOOTSTRAP_ADMIN_PASSWORD);
  assert.equal((await admin.request('POST', '/api/auth/signin', { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: adminPassword })).status, 200);
  const credentials = async (id: string) => (await pool.query<RowDataPacket[]>('SELECT password_hash, two_factor_enabled FROM users WHERE id = ?', [id]))[0][0];
  const refused = async (reply: Promise<{ status: number; body: Record<string, unknown> }>, what: string) => {
    const { status, body } = await reply;
    assert.deepEqual([status, body.code, body.error], [400, 'OWNER_PROTECTED', 'Only the owner can change the owner\'s password, two-factor authentication or setup link.'], what);
  };

  await pool.execute('UPDATE users SET two_factor_enabled = TRUE WHERE id IN (?, ?)', [ids.admin, ids.member]);
  const before = await credentials(ids.admin);
  await refused(admin.request('PUT', `/api/admin/users/${ids.admin}/password`, { new_password: 'administrator-chosen-password', current_password: adminPassword }), 'password reset');
  await refused(admin.request('POST', `/api/admin/users/${ids.admin}/2fa/reset`, { current_password: adminPassword }), 'two-factor reset');
  await refused(admin.request('POST', `/api/admin/users/${ids.admin}/setup-link`, { current_password: adminPassword }), 'setup link');
  assert.deepEqual(await credentials(ids.admin), before, 'the owner\'s password and two-factor authentication are untouched');
  assert.equal((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM invites WHERE user_id = ?', [ids.admin]))[0][0].n, 0, 'no setup link for the owner');
  assert.equal((await owner.request('GET', '/api/auth/me')).status, 200, 'the owner stays signed in');

  // The same administrator against a member: allowed.
  const reset = await admin.request('PUT', `/api/admin/users/${ids.member}/password`, { new_password: 'administrator-reset-password', current_password: adminPassword });
  assert.equal(reset.status, 200, String(reset.body.error));
  assert.equal((await admin.request('POST', `/api/admin/users/${ids.member}/2fa/reset`, { current_password: adminPassword })).status, 200);
  assert.equal(Number((await credentials(ids.member)).two_factor_enabled), 0);
  await pool.execute("UPDATE users SET password_hash = '' WHERE id = ?", [ids.stranger]);
  const link = await admin.request('POST', `/api/admin/users/${ids.stranger}/setup-link`, { current_password: adminPassword });
  assert.equal(link.status, 200, String(link.body.error));

  // Ending the owner's devices signs them out and nothing else: the owner
  // signs in again with the password they had (the flag set above had no
  // authenticator behind it, so it goes before they sign in).
  assert.equal((await admin.request('DELETE', `/api/admin/users/${ids.admin}/devices`, { current_password: adminPassword })).status, 200);
  assert.equal((await owner.request('GET', '/api/auth/me')).status, 401);
  await pool.execute('UPDATE users SET two_factor_enabled = FALSE WHERE id = ?', [ids.admin]);
  const again = await owner.request('POST', '/api/auth/signin', { email: PEOPLE.admin.email, password });
  assert.equal(again.status, 200);
  assert.ok(owner.signedIn, 'signed in, not asked for a second factor');

  // The owner changes their own password.
  const own = await owner.request('PUT', `/api/admin/users/${ids.admin}/password`, { new_password: 'owner-chosen-new-password', current_password: password });
  assert.equal(own.status, 200, String(own.body.error));
  assert.notEqual((await credentials(ids.admin)).password_hash, before.password_hash);
});
