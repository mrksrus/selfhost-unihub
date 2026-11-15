import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
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

// Another administrator's account is the owner's to change, as making and
// removing administrators is: an administrator who is not the owner cannot
// deactivate, activate or delete one, reset their password or 2FA or give
// them a setup link, but may still sign their devices out. Members stay an
// administrator's to manage, and the owner may do all of it.
test('roles: only the owner removes another administrator or changes their sign-in', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, clients, password, api } = await seedPeople(t, pool);
  const owner = clients.admin;
  const b = api.client();
  const bPassword = String(process.env.BOOTSTRAP_ADMIN_PASSWORD);
  assert.equal((await b.request('POST', '/api/auth/signin', { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: bPassword })).status, 200);
  const [[bRow]] = await pool.query<RowDataPacket[]>('SELECT id FROM users WHERE email = ?', [process.env.BOOTSTRAP_ADMIN_EMAIL]);
  const bId = String(bRow.id);
  // C: the manager made an administrator, with 2FA on; D: an administrator who has not set a password yet.
  const c = ids.manager, d = ids.stranger, member = ids.member;
  await pool.execute("UPDATE users SET role = 'admin', two_factor_enabled = TRUE WHERE id = ?", [c]);
  await pool.execute("UPDATE users SET role = 'admin', password_hash = '' WHERE id = ?", [d]);
  const status = async (reply: Promise<{ status: number; body: FixtureValue }>) => { const { status: code, body } = await reply; return [code, body.code ?? null]; };
  const row = async (id: string) => (await pool.query<RowDataPacket[]>('SELECT role, is_active, password_hash, two_factor_enabled FROM users WHERE id = ?', [id]))[0][0];
  const refused = [403, 'ADMINS_OWNER_ONLY'];

  const before = await row(c);
  assert.deepEqual(await status(b.request('PUT', `/api/admin/users/${c}/activate`, { is_active: false, current_password: bPassword })), refused, 'deactivate');
  assert.deepEqual(await status(b.request('PUT', `/api/admin/users/${c}/password`, { new_password: 'administrator-chosen-password', current_password: bPassword })), refused, 'password');
  assert.deepEqual(await status(b.request('POST', `/api/admin/users/${c}/2fa/reset`, { current_password: bPassword })), refused, 'two-factor reset');
  assert.deepEqual(await status(b.request('DELETE', `/api/admin/users/${c}`, { current_password: bPassword })), refused, 'delete');
  assert.deepEqual(await status(b.request('POST', `/api/admin/users/${d}/setup-link`, { current_password: bPassword })), refused, 'setup link');
  assert.deepEqual(await row(c), before, 'C is untouched');
  assert.equal((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM invites WHERE user_id = ?', [d]))[0][0].n, 0, 'no link for D');
  await pool.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [d]);
  assert.deepEqual(await status(b.request('PUT', `/api/admin/users/${d}/activate`, { is_active: true, current_password: bPassword })), refused, 'activate');
  assert.equal(Number((await row(d)).is_active), 0);
  await pool.execute('UPDATE users SET is_active = TRUE WHERE id = ?', [d]);

  // Their data and the owner's are the owner's to change on the administrator's
  // path too: B cannot delete them, empty their bin, delete a backup or revoke a link.
  const contactOf = async (id: string) => { await pool.execute("INSERT INTO contacts (id, user_id, uid, uid_hash, first_name) VALUES (UUID(), ?, UUID(), SHA2(UUID(), 256), 'Kept')", [id]); };
  const contacts = async (id: string) => Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM contacts WHERE user_id = ?', [id]))[0][0].n);
  for (const id of [ids.admin, c, member]) await contactOf(id);
  for (const id of [ids.admin, c]) {
    assert.deepEqual(await status(b.request('POST', `/api/admin/users/${id}/clear/contacts`, { current_password: bPassword })), refused, 'delete data');
    assert.deepEqual(await status(b.request('POST', `/api/admin/users/${id}/bin/empty`, { current_password: bPassword })), refused, 'empty the bin');
    assert.deepEqual(await status(b.request('DELETE', `/api/admin/users/${id}/backups/${crypto.randomUUID()}`, { current_password: bPassword })), refused, 'delete a backup');
    assert.equal(await contacts(id), 1);
  }
  assert.equal((await owner.request('POST', `/api/admin/users/${d}/setup-link`, { current_password: password })).status, 200);
  assert.deepEqual(await status(b.request('DELETE', `/api/admin/users/${d}/setup-link`)), refused, 'revoke a setup link');
  assert.equal((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM invites WHERE user_id = ?', [d]))[0][0].n, 1, 'D\'s link still works');
  assert.equal((await b.request('POST', `/api/admin/users/${member}/clear/contacts`, { current_password: bPassword })).status, 200, 'a member\'s data stays B\'s to manage');
  assert.equal(await contacts(member), 0);
  assert.equal((await owner.request('POST', `/api/admin/users/${c}/clear/contacts`, { current_password: password })).status, 200, 'the owner may');
  assert.equal(await contacts(c), 0);

  // Signing C's devices out stays open to B: it ends sessions and changes nothing else.
  assert.equal((await clients.manager.request('GET', '/api/auth/me')).status, 200);
  assert.equal((await b.request('DELETE', `/api/admin/users/${c}/devices`, { current_password: bPassword })).status, 200);
  assert.equal((await clients.manager.request('GET', '/api/auth/me')).status, 401);
  assert.deepEqual(await row(c), before);

  // A member stays B's to manage, and B's own password is B's.
  assert.equal((await b.request('PUT', `/api/admin/users/${member}/activate`, { is_active: false, current_password: bPassword })).status, 200);
  assert.equal((await b.request('PUT', `/api/admin/users/${member}/activate`, { is_active: true })).status, 200);
  assert.equal((await b.request('PUT', `/api/admin/users/${member}/password`, { new_password: 'administrator-reset-password', current_password: bPassword })).status, 200);
  assert.equal((await b.request('PUT', `/api/admin/users/${bId}/password`, { new_password: 'bootstrap-chosen-password', current_password: bPassword })).status, 200);

  // The owner may do each of them.
  assert.equal((await owner.request('POST', `/api/admin/users/${c}/2fa/reset`, { current_password: password })).status, 200);
  assert.equal((await owner.request('PUT', `/api/admin/users/${c}/password`, { new_password: 'owner-reset-password', current_password: password })).status, 200);
  assert.equal((await owner.request('POST', `/api/admin/users/${d}/setup-link`, { current_password: password })).status, 200);
  assert.equal((await owner.request('PUT', `/api/admin/users/${c}/activate`, { is_active: false, current_password: password })).status, 200);
  assert.equal((await owner.request('PUT', `/api/admin/users/${c}/activate`, { is_active: true })).status, 200);
  assert.equal((await owner.request('DELETE', `/api/admin/users/${c}`, { current_password: password })).status, 200);
  assert.equal((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM users WHERE id = ?', [c]))[0][0].n, 0);
});
