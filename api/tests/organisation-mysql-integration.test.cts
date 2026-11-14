import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople, PEOPLE } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

const skip = !process.env.MYSQL_TEST_HOST;

// Upgrade step 27 (0.30, the organisation) on a database of 0.29 (step 26)
// with people and a confirmed rules notice: it changes no row, also when it
// runs again after an interruption, and from then on the database itself
// refuses a second owner.
test('upgrade 27 adds the organisation without changing anyone, and allows one owner at most', { skip, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t, { migrate: false });
  const { runMigrations } = require('../dist/src/services/database-migrations') as typeof import('../src/services/database-migrations');
  const { MIGRATIONS } = require('../dist/src/services/database') as typeof import('../src/services/database');
  const { BASELINE } = require('../dist/src/services/database-baseline') as typeof import('../src/services/database-baseline');
  const { addOrganisation } = require('../dist/src/services/organisation-migration') as typeof import('../src/services/organisation-migration');
  await runMigrations(pool, MIGRATIONS.filter(step => step.id <= 26), BASELINE);

  const ids = { admin: crypto.randomUUID(), second: crypto.randomUUID(), alex: crypto.randomUUID() };
  for (const [name, role] of [['admin', 'admin'], ['second', 'admin'], ['alex', 'user']] as const) {
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)', [ids[name], `${name}@example.test`, 'x', name, role]);
  }
  await pool.execute("INSERT INTO system_settings (setting_key, setting_value) VALUES ('policy_revision', '3') ON DUPLICATE KEY UPDATE setting_value = '3'");
  await pool.execute('INSERT INTO policy_notices (user_id, revision) VALUES (?, 3)', [ids.alex]);
  const people = async () => (await pool.query<RowDataPacket[]>("SELECT email, role, is_active, two_factor_enabled FROM users WHERE email LIKE '%@example.test' ORDER BY email"))[0];
  const before = await people();

  // An interrupted step 27: its work ran, the step was not recorded.
  const interrupted = await pool.getConnection();
  try { await addOrganisation(interrupted); } finally { interrupted.release(); }
  await runMigrations(pool, MIGRATIONS, BASELINE);
  const [[step]] = await pool.query<RowDataPacket[]>('SELECT name FROM schema_migrations WHERE id = 27');
  assert.equal(step.name, 'organisation');

  assert.deepEqual(await people(), before, 'no role, status or 2FA changed');
  const [[owners]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'");
  assert.equal(Number(owners.n), 0, 'choosing the owner is not this step');
  const [[grace]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM users WHERE two_factor_required_since IS NOT NULL');
  assert.equal(Number(grace.n), 0, 'no grace runs');
  const [notices] = await pool.query<RowDataPacket[]>('SELECT user_id, revision, rules_hash FROM policy_notices');
  assert.deepEqual(notices.map(row => [row.user_id, Number(row.revision), row.rules_hash]), [[ids.alex, 3, null]], 'a confirmation from before keeps its revision');

  // One owner at most, whatever writes the rows.
  await pool.execute("UPDATE users SET role = 'owner' WHERE id = ?", [ids.admin]);
  await assert.rejects(pool.execute("UPDATE users SET role = 'owner' WHERE id = ?", [ids.second]), /Duplicate entry/);
  await pool.execute("UPDATE users SET role = 'admin' WHERE id = ?", [ids.admin]);
  await pool.execute("UPDATE users SET role = 'owner' WHERE id = ?", [ids.second]);

  // A group's members go with the group and with the person.
  const group = crypto.randomUUID();
  await pool.execute("INSERT INTO org_groups (id, name) VALUES (?, 'Support')", [group]);
  await assert.rejects(pool.execute("INSERT INTO org_groups (id, name) VALUES (?, 'support')", [crypto.randomUUID()]), /Duplicate entry/, 'group names are unique without regard to case');
  await pool.execute("INSERT INTO org_group_members (group_id, user_id, role) VALUES (?, ?, 'manager'), (?, ?, 'member')", [group, ids.alex, group, ids.admin]);
  await pool.execute('DELETE FROM users WHERE id = ?', [ids.alex]);
  assert.deepEqual((await pool.query<RowDataPacket[]>('SELECT user_id FROM org_group_members'))[0].map(row => row.user_id), [ids.admin]);
  await pool.execute('DELETE FROM org_groups WHERE id = ?', [group]);
  assert.equal((await pool.query<RowDataPacket[]>('SELECT * FROM org_group_members'))[0].length, 0);
});

// The access service's first kind, a group, with the shared fixture: an
// administrator manages every group, a manager their own, a member reads
// theirs, and a stranger or a removed manager cannot even see it.
test('a group is managed by administrators and its managers, read by its members, and hidden from everyone else', { skip, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, groups, clients } = await seedPeople(t, pool);
  const access = require('../dist/src/services/access') as typeof import('../src/services/access');
  const { clientError } = require('../dist/src/http/errors') as typeof import('../src/http/errors');

  // Every fixture person holds a real session through the request handler.
  for (const [name, client] of Object.entries(clients)) {
    const me = await client.request('GET', '/api/auth/me');
    assert.equal(me.status, 200, name);
    assert.equal((me.body.user as { email: string }).email, PEOPLE[name as keyof typeof PEOPLE].email);
  }

  const support = { kind: 'group', id: groups.support } as const;
  const finance = { kind: 'group', id: groups.finance } as const;
  const level = (person: keyof typeof ids, resource: typeof support | typeof finance) => access.accessLevel(ids[person], resource);
  assert.deepEqual(
    await Promise.all((['admin', 'manager', 'member', 'stranger', 'revoked'] as const).map(async person => [person, await level(person, support), await level(person, finance)])),
    [['admin', 'manage', 'manage'], ['manager', 'manage', 'read'], ['member', 'read', null], ['stranger', null, null], ['revoked', null, null]]);

  const refusal = async (person: keyof typeof ids, resource: { kind: 'group'; id: string }, permission: 'read' | 'manage') => {
    try { await access.assertCan(ids[person], resource, permission); return null; } catch (error) { return clientError(error, 'unexpected'); }
  };
  assert.equal(await refusal('manager', support, 'manage'), null);
  assert.deepEqual(await refusal('member', support, 'manage'), { error: 'You cannot manage this group.', status: 403, code: 'GROUP_FORBIDDEN' });
  for (const [person, resource] of [['stranger', support], ['revoked', support], ['member', finance], ['admin', { kind: 'group', id: crypto.randomUUID() }]] as const) {
    assert.deepEqual(await refusal(person, resource, 'read'), { error: 'Group not found', status: 404, code: 'GROUP_NOT_FOUND' }, `${person} cannot see it`);
  }
  assert.equal(await access.can(ids.member, support, 'read'), true);
  assert.equal(await access.can(ids.member, support, 'manage'), false);

  assert.deepEqual((await access.visible(ids.admin, 'group')).sort(), [groups.support, groups.finance].sort());
  assert.deepEqual((await access.visible(ids.manager, 'group')).sort(), [groups.support, groups.finance].sort());
  assert.deepEqual(await access.visible(ids.member, 'group'), [groups.support]);
  assert.deepEqual(await access.visible(ids.stranger, 'group'), []);
  assert.deepEqual(await access.principalsOf(ids.manager), { user: ids.manager, groups: [groups.finance, groups.support], everyone: true });

  // A deactivated manager keeps the membership row and loses the right with the account.
  await pool.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [ids.manager]);
  assert.equal(await level('manager', support), null);
  assert.deepEqual(await access.visible(ids.manager, 'group'), []);
});
