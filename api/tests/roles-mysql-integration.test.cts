import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// Roles through the real request handler: the owner (the fixture's
// administrator), the bootstrap administrator, a manager and a member. Only
// the owner makes or removes administrators and hands ownership on; nobody
// demotes, deactivates or deletes the owner; rights are checked by
// permission, also again under the change's locks.
test('roles: the owner keeps the installation, only the owner makes administrators, rights go by permission', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, clients, password, api } = await seedPeople(t, pool);
  const { admin: owner, manager: alex, member: blair } = clients;
  const status = async (reply: Promise<{ status: number; body: FixtureValue }>) => { const { status: code, body } = await reply; return [code, body.code ?? null]; };
  const roleOf = async (id: string) => (await pool.query<RowDataPacket[]>('SELECT role FROM users WHERE id = ?', [id]))[0][0]?.role;
  const [[bootstrapRow]] = await pool.query<RowDataPacket[]>('SELECT id FROM users WHERE email = ?', [process.env.BOOTSTRAP_ADMIN_EMAIL]);
  const bootstrapId = String(bootstrapRow.id);
  const second = api.client();
  assert.equal((await second.request('POST', '/api/auth/signin', { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD })).status, 200);
  const secondPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  // What each person's role grants, with /me.
  const me = async (client: typeof owner) => (await client.request('GET', '/api/auth/me')).body.user as FixtureValue;
  const ownerMe = await me(owner);
  assert.equal(ownerMe.role, 'owner');
  assert.ok(['owner.transfer', 'admins.manage', 'groups.manage', 'users.manage', 'server.settings'].every(permission => ownerMe.permissions.includes(permission)));
  const adminMe = await me(second);
  assert.equal(adminMe.role, 'admin');
  assert.ok(adminMe.permissions.includes('users.manage') && !adminMe.permissions.includes('admins.manage') && !adminMe.permissions.includes('owner.transfer'));
  assert.deepEqual([(await me(alex)).permissions, (await me(alex)).manages_groups], [[], true]);
  assert.deepEqual([(await me(blair)).permissions, (await me(blair)).manages_groups], [[], false]);

  // An administrator does administrator work, but makes no administrator.
  assert.equal((await second.request('GET', '/api/admin/users')).status, 200);
  assert.deepEqual(await status(second.request('PUT', `/api/admin/users/${ids.member}/role`, { role: 'admin', current_password: secondPassword })), [403, 'ADMINS_MANAGE_REQUIRED']);
  assert.deepEqual(await status(second.request('POST', '/api/admin/users', { email: 'new-admin@example.test', role: 'admin', current_password: secondPassword })), [403, 'ADMINS_MANAGE_REQUIRED']);
  assert.equal(await roleOf(ids.member), 'user');

  // The owner does.
  assert.equal((await owner.request('PUT', `/api/admin/users/${ids.member}/role`, { role: 'admin', current_password: password })).status, 200);
  assert.equal(await roleOf(ids.member), 'admin');
  assert.equal((await owner.request('PUT', `/api/admin/users/${ids.member}/role`, { role: 'user', current_password: password })).status, 200);
  assert.equal(await roleOf(ids.member), 'user');

  // Nobody demotes, deactivates or deletes the owner, also not the owner.
  assert.deepEqual(await status(owner.request('PUT', `/api/admin/users/${ids.admin}/role`, { role: 'user', current_password: password })), [400, 'OWNER_PROTECTED']);
  assert.deepEqual(await status(second.request('PUT', `/api/admin/users/${ids.admin}/activate`, { is_active: false, current_password: secondPassword })), [400, 'OWNER_PROTECTED']);
  assert.deepEqual(await status(second.request('DELETE', `/api/admin/users/${ids.admin}`, { current_password: secondPassword })), [400, 'OWNER_PROTECTED']);
  assert.deepEqual(await status(owner.request('DELETE', '/api/settings/account', { current_password: password })), [400, 'OWNER_PROTECTED']);
  assert.equal(await roleOf(ids.admin), 'owner');
  assert.equal((await me(owner)).role, 'owner', 'still signed in');

  // A right lost while the change waits: the owner's grant waits for the
  // person's row, ownership moves meanwhile, and the grant is refused.
  const holder = await pool.getConnection();
  try {
    await holder.beginTransaction();
    await holder.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [ids.member]);
    const pending = owner.request('PUT', `/api/admin/users/${ids.member}/role`, { role: 'admin', current_password: password });
    for (let waited = 0; ; waited += 50) {
      const [[row]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT id FROM users WHERE id = % FOR UPDATE' AND ID NOT IN (?, CONNECTION_ID())", [holder.threadId]);
      if (Number(row.n) > 0) break;
      assert.ok(waited < 20000, 'the change waits for the person');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await holder.execute("UPDATE users SET role = 'admin' WHERE id = ?", [ids.admin]);
    await holder.execute("UPDATE users SET role = 'owner' WHERE id = ?", [bootstrapId]);
    await holder.commit();
    assert.deepEqual(await status(pending), [403, 'ADMINS_MANAGE_REQUIRED']);
  } finally { holder.release(); }
  assert.equal(await roleOf(ids.member), 'user');
  // Back as the fixture had it.
  await pool.execute("UPDATE users SET role = 'admin' WHERE id = ?", [bootstrapId]);
  await pool.execute("UPDATE users SET role = 'owner' WHERE id = ?", [ids.admin]);

  // Handing ownership on: to an active administrator only, with the owner's password.
  assert.equal((await second.request('POST', '/api/admin/owner/transfer', { user_id: ids.admin, current_password: secondPassword })).status, 403);
  assert.deepEqual(await status(owner.request('POST', '/api/admin/owner/transfer', { user_id: ids.member, current_password: password })), [400, 'OWNER_TRANSFER_INVALID']);
  assert.equal((await owner.request('POST', '/api/admin/owner/transfer', { user_id: bootstrapId, current_password: 'not-the-password' })).status, 403);
  assert.deepEqual((await owner.request('POST', '/api/admin/owner/transfer', { user_id: bootstrapId, current_password: password })).body, { owner: bootstrapId });
  assert.deepEqual([await roleOf(bootstrapId), await roleOf(ids.admin)], ['owner', 'admin']);
  assert.ok(!(await me(owner)).permissions.includes('owner.transfer'));
  assert.equal((await owner.request('POST', '/api/admin/owner/transfer', { user_id: ids.admin, current_password: password })).status, 403);
  // The former owner is an ordinary administrator now: the new owner may deactivate them.
  assert.equal((await second.request('PUT', `/api/admin/users/${ids.admin}/activate`, { is_active: false, current_password: secondPassword })).status, 200);
  const [[transfer]] = await pool.query<RowDataPacket[]>("SELECT actor_id, target_user_id FROM audit_log WHERE action = 'owner.transferred'");
  assert.deepEqual([transfer.actor_id, transfer.target_user_id], [ids.admin, bootstrapId]);
});
