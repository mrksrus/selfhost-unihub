import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// Groups through the real request handler with the shared people: the owner
// creates and deletes groups and names managers; Alex manages Support (and
// is a member of Finance); Blair is a member of Support; Casey is in no
// group; Drew was a manager of Support and was removed.
test('groups: administrators create them, managers keep their members, members read them, everyone else sees nothing', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, groups, clients, password } = await seedPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey, revoked: drew } = clients;
  const status = async (reply: Promise<{ status: number; body: FixtureValue }>) => { const { status: code, body } = await reply; return [code, body.code ?? null]; };
  const members = async (group: string) => (await pool.query<RowDataPacket[]>('SELECT user_id, role FROM org_group_members WHERE group_id = ? ORDER BY user_id', [group]))[0]
    .map(row => [row.user_id, row.role]);

  // The owner creates a group; names are unique without regard to case.
  const created = await admin.request('POST', '/api/admin/groups', { name: 'Field', description: 'On the road' });
  assert.equal(created.status, 200, String(created.body.error));
  const field = (created.body.group as FixtureValue).id as string;
  assert.deepEqual(await status(admin.request('POST', '/api/admin/groups', { name: 'field' })), [409, 'GROUP_NAME_TAKEN']);
  assert.deepEqual(await status(admin.request('POST', '/api/admin/groups', { name: ' ' })), [400, 'GROUP_NAME_INVALID']);
  const listed = (await admin.request('GET', '/api/admin/groups')).body.groups as FixtureValue[];
  assert.deepEqual(listed.map(group => [group.name, group.member_count, group.manager_count]), [['Field', 0, 0], ['Finance', 1, 0], ['Support', 2, 1]]);

  // A manager is no administrator: no group is created, deleted or given a manager, and no Server page opens.
  for (const [method, path, body] of [
    ['POST', '/api/admin/groups', { name: 'Shadow' }], ['DELETE', `/api/admin/groups/${groups.support}`, { current_password: password }],
    ['PUT', `/api/admin/groups/${groups.support}/managers/${ids.member}`, { manager: true }], ['GET', '/api/admin/groups', undefined], ['GET', '/api/admin/users', undefined],
  ] as const) assert.equal((await alex.request(method, path, body)).status, 403, `${method} ${path}`);

  // Their own groups, and what each shows them.
  const mine = (await alex.request('GET', '/api/groups')).body.groups as FixtureValue[];
  assert.deepEqual(mine.map(group => [group.name, group.role]), [['Finance', 'member'], ['Support', 'manager']]);
  const support = (await alex.request('GET', `/api/groups/${groups.support}`)).body;
  assert.equal(support.can_manage, true);
  assert.deepEqual((support.members as FixtureValue[]).map(member => member.email).sort(), ['alex@example.test', 'blair@example.test']);
  const finance = (await alex.request('GET', `/api/groups/${groups.finance}`)).body;
  assert.deepEqual([finance.can_manage, finance.members], [false, []], 'a member of Finance sees its managers only (it has none)');

  // Alex keeps Support's members: finds Casey, adds them, renames the group.
  const candidates = (await alex.request('GET', `/api/groups/${groups.support}/candidates?q=cas`)).body.people as FixtureValue[];
  assert.deepEqual(candidates.map(person => person.email), ['casey@example.test']);
  assert.deepEqual((await alex.request('GET', `/api/groups/${groups.support}/candidates?q=%25`)).body.people, [], 'a wildcard is searched as itself');
  const added = await alex.request('POST', `/api/groups/${groups.support}/members`, { user_ids: [ids.stranger, ids.member] });
  assert.equal(added.status, 200, String(added.body.error));
  assert.ok((added.body.members as FixtureValue[]).some(member => member.id === ids.stranger));
  assert.deepEqual(await status(alex.request('POST', `/api/groups/${groups.support}/members`, { user_ids: ['not-an-id'] })), [400, 'MEMBERS_INVALID']);
  assert.equal((await alex.request('PUT', `/api/groups/${groups.support}`, { name: 'Customer support' })).status, 200);
  assert.deepEqual(await status(alex.request('PUT', `/api/groups/${groups.support}`, { name: 'finance' })), [409, 'GROUP_NAME_TAKEN']);

  // Not in Finance (only a member there), not in Field (not theirs: hidden).
  assert.deepEqual(await status(alex.request('POST', `/api/groups/${groups.finance}/members`, { user_ids: [ids.stranger] })), [403, 'GROUP_FORBIDDEN']);
  assert.deepEqual(await status(alex.request('PUT', `/api/groups/${groups.finance}`, { name: 'Money' })), [403, 'GROUP_FORBIDDEN']);
  for (const [method, path, body] of [['GET', `/api/groups/${field}`, undefined], ['POST', `/api/groups/${field}/members`, { user_ids: [ids.stranger] }],
    ['DELETE', `/api/groups/${field}/members/${ids.stranger}`, undefined], ['GET', `/api/groups/${field}/candidates?q=a`, undefined]] as const) {
    assert.deepEqual(await status(alex.request(method, path, body)), [404, 'GROUP_NOT_FOUND'], `${method} ${path}`);
  }

  // Blair reads Support (its managers), and manages nothing.
  const asMember = (await blair.request('GET', `/api/groups/${groups.support}`)).body;
  assert.deepEqual([asMember.can_manage, (asMember.members as FixtureValue[]).map(member => member.email)], [false, ['alex@example.test']]);
  assert.deepEqual(await status(blair.request('POST', `/api/groups/${groups.support}/members`, { user_ids: [ids.revoked] })), [403, 'GROUP_FORBIDDEN']);
  assert.deepEqual(await status(blair.request('DELETE', `/api/groups/${groups.support}/members/${ids.stranger}`)), [403, 'GROUP_FORBIDDEN']);
  assert.deepEqual(await status(blair.request('GET', `/api/groups/${groups.support}/candidates?q=a`)), [403, 'GROUP_FORBIDDEN']);

  // The removed manager and a stranger see nothing of Support or Finance.
  for (const client of [drew]) {
    for (const group of [groups.support, groups.finance]) assert.deepEqual(await status(client.request('GET', `/api/groups/${group}`)), [404, 'GROUP_NOT_FOUND']);
    assert.deepEqual(await status(client.request('POST', `/api/groups/${groups.support}/members`, { user_ids: [ids.revoked] })), [404, 'GROUP_NOT_FOUND']);
    assert.deepEqual((await client.request('GET', '/api/groups')).body.groups, []);
  }
  assert.deepEqual(await status(casey.request('GET', `/api/groups/${groups.finance}`)), [404, 'GROUP_NOT_FOUND']);

  // Alex removes a member; a manager only an administrator removes.
  assert.equal((await alex.request('DELETE', `/api/groups/${groups.support}/members/${ids.stranger}`)).status, 200);
  assert.deepEqual(await status(alex.request('DELETE', `/api/groups/${groups.support}/members/${ids.stranger}`)), [404, 'MEMBER_NOT_FOUND']);
  assert.equal((await admin.request('PUT', `/api/admin/groups/${groups.support}/managers/${ids.member}`, { manager: true })).status, 200);
  assert.deepEqual(await status(alex.request('DELETE', `/api/groups/${groups.support}/members/${ids.member}`)), [403, 'GROUP_FORBIDDEN']);
  assert.equal((await admin.request('PUT', `/api/admin/groups/${groups.support}/managers/${ids.member}`, { manager: false })).status, 200);
  assert.deepEqual(await members(groups.support), [[ids.manager, 'manager'], [ids.member, 'member']].sort());

  // Naming someone outside the group a manager adds them.
  assert.equal((await admin.request('PUT', `/api/admin/groups/${field}/managers/${ids.stranger}`, { manager: true })).status, 200);
  assert.deepEqual(await members(field), [[ids.stranger, 'manager']]);
  assert.equal(((await casey.request('GET', '/api/auth/me')).body.user as FixtureValue).manages_groups, true);

  // Alex loses Support while their change waits for the rules lock: the
  // change is refused under the lock and adds nobody.
  const holder = await pool.getConnection();
  try {
    await holder.beginTransaction();
    await holder.execute("INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES ('policy_revision', '0')");
    await holder.execute("SELECT setting_value FROM system_settings WHERE setting_key = 'policy_revision' FOR UPDATE");
    const pending = alex.request('POST', `/api/groups/${groups.support}/members`, { user_ids: [ids.revoked] });
    for (let waited = 0; ; waited += 50) {
      const [[row]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE '%system_settings%' AND ID NOT IN (?, CONNECTION_ID())", [holder.threadId]);
      if (Number(row.n) > 0) break;
      assert.ok(waited < 20000, 'the change reaches the rules lock');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await holder.execute("UPDATE org_group_members SET role = 'member' WHERE group_id = ? AND user_id = ?", [groups.support, ids.manager]);
    await holder.commit();
    assert.deepEqual(await status(pending), [403, 'GROUP_FORBIDDEN']);
  } finally { holder.release(); }
  assert.ok(!(await members(groups.support)).some(([id]) => id === ids.revoked), 'nobody was added');

  // Deleting a group needs the password and takes its memberships and policies; nobody's account goes.
  await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('group', ?, 'policy.backup.delete', 'forbidden', FALSE)", [groups.support]);
  assert.equal(((await admin.request('GET', '/api/admin/groups')).body.groups as FixtureValue[]).find(group => group.id === groups.support)?.has_policies, true);
  assert.equal((await admin.request('DELETE', `/api/admin/groups/${groups.support}`, { current_password: 'not-the-password' })).status, 403);
  assert.equal((await admin.request('DELETE', `/api/admin/groups/${groups.support}`, { current_password: password })).status, 200);
  assert.deepEqual(await members(groups.support), []);
  assert.equal((await pool.query<RowDataPacket[]>("SELECT * FROM setting_policies WHERE target_kind = 'group' AND target_id = ?", [groups.support]))[0].length, 0);
  assert.equal((await pool.query<RowDataPacket[]>('SELECT * FROM users WHERE id IN (?, ?)', [ids.manager, ids.member]))[0].length, 2);
  assert.deepEqual(await status(alex.request('GET', `/api/groups/${groups.support}`)), [404, 'GROUP_NOT_FOUND']);

  const [actions] = await pool.query<RowDataPacket[]>('SELECT action, actor_id, target_user_id FROM audit_log WHERE action LIKE ? OR action LIKE ? ORDER BY created_at, action', ['admin.group%', 'group.%']);
  assert.deepEqual([...new Set(actions.map(row => row.action))].sort(),
    ['admin.group_created', 'admin.group_deleted', 'admin.group_manager_set', 'group.member_added', 'group.member_removed', 'group.renamed']);
  assert.ok(actions.some(row => row.action === 'group.member_added' && row.actor_id === ids.manager && row.target_user_id === ids.stranger));
});
