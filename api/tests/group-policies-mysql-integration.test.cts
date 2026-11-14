import type { RowDataPacket } from 'mysql2/promise';
import type { FixtureValue } from './helpers/test-types.cts';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

const skip = !process.env.MYSQL_TEST_HOST;

// Group policies (0.30) through the real request handler and MariaDB, with
// the shared people: the administrator, Alex (manager of Support, member of
// Finance), Blair (member of Support), Casey (in no group) and Drew (removed
// from Support). A group only makes a rule stricter than Everyone's (the
// installation's), and among a person's groups the strictest wins.
test('group policies: stricter only, the strictest group wins, floors, the notice, the rules lock, and conflicts', { skip, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const people = await seedPeople(t, pool);
  const { ids, groups, clients, password } = people;
  const { admin, manager: alex, member: blair, stranger: casey, revoked: drew } = clients;
  type Client = typeof admin;
  async function call(client: Client, method: string, url: string, body?: unknown, status = 200) {
    const reply = await client.request(method, url, method === 'GET' ? undefined : body ?? {});
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 500)}`);
    return reply.body as FixtureValue;
  }
  const everyone = (values: Record<string, unknown>, extra: Record<string, unknown> = {}, status = 200) =>
    call(admin, 'PUT', '/api/admin/policies', { values, current_password: password, ...extra }, status);
  const group = (id: string, body: Record<string, unknown>, status = 200) =>
    call(admin, 'PUT', `/api/admin/groups/${id}/policies`, { current_password: password, ...body }, status);
  const policy = async (client: Client, key: string) => (await call(client, 'GET', '/api/policies/effective')).policies[key];
  const value = async (client: Client, key: string) => (await policy(client, key)).value;
  // Everyone confirms the rules first (the notice of 0.28 D38).
  const acknowledgeAll = async () => {
    for (const client of Object.values(clients)) await call(client, 'POST', '/api/policies/acknowledge', { revision: (await call(client, 'GET', '/api/policies/effective')).revision });
  };
  const noticeDue = async (client: Client) => { const effective = await call(client, 'GET', '/api/policies/effective'); return effective.acknowledged_revision < effective.revision; };
  const clean = async () => { await pool.query('DELETE FROM setting_policies'); await acknowledgeAll(); };

  await t.test('a group makes a key stricter for its members only; a looser value is refused and has no effect', async () => {
    await clean();
    await group(groups.support, { values: { 'backup.create': 'forbidden' } });
    for (const client of [alex, blair]) assert.equal((await policy(client, 'backup.create')).allowed, false);
    for (const client of [casey, drew, admin]) assert.equal((await policy(client, 'backup.create')).allowed, true);
    // The boundary refuses it for a member, before any side effect.
    const refused = await call(blair, 'POST', '/api/backup/jobs', {}, 403);
    assert.deepEqual([refused.code, refused.details.policy], ['POLICY_FORBIDS', 'backup.create']);
    assert.equal(Number(((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM data_export_jobs'))[0][0]).n), 0);

    // Looser than Everyone: refused on save, and a stored looser value (Everyone got stricter later) changes nothing.
    await everyone({ 'backup.server_retention_days': 90 });
    assert.equal((await group(groups.support, { values: { 'backup.server_retention_days': 30 } }, 400)).code, 'POLICY_INVALID');
    await group(groups.support, { values: { 'backup.server_retention_days': 90 } });
    await everyone({ 'backup.server_retention_days': 365 });
    assert.equal(await value(blair, 'backup.server_retention_days'), 365);
    // The group's page offers only values at least as strict as Everyone's.
    const page = await call(admin, 'GET', `/api/admin/groups/${groups.support}/policies`);
    assert.deepEqual(page.target, { kind: 'group', id: groups.support, name: 'Support' });
    assert.deepEqual([page.policies['backup.server_retention_days'].value, page.policies['backup.server_retention_days'].values], [90, [365]]);
    assert.deepEqual([page.policies['backup.create'].value, page.policies['backup.create'].source, page.policies['backup.create'].default], ['forbidden', 'policy', 'allowed']);
    // Removing the group's value lets Everyone's hold again.
    await group(groups.support, { clear: ['backup.create'] });
    assert.equal((await policy(blair, 'backup.create')).allowed, true);
    // Only administrators with server.settings reach the pages; an unknown group is 404.
    await call(alex, 'GET', `/api/admin/groups/${groups.support}/policies`, undefined, 403);
    assert.equal((await call(admin, 'GET', `/api/admin/groups/${crypto.randomUUID()}/policies`, undefined, 404)).code, 'GROUP_NOT_FOUND');
    // The activity log names the group.
    const [logged] = await pool.query<RowDataPacket[]>("SELECT details FROM audit_log WHERE action = 'admin.policy_changed' ORDER BY created_at, id");
    const details = logged.map(row => typeof row.details === 'string' ? JSON.parse(row.details) : row.details);
    assert.ok(details.some(entry => entry.key === 'backup.create' && entry.target === groups.support && entry.to === 'forbidden'));
    assert.ok(details.some(entry => entry.key === 'backup.server_retention_days' && entry.target === undefined), 'Everyone\'s change has no target');
  });

  await t.test('a person in two groups gets the strictest; a key without an order applies only where the groups agree', async () => {
    await clean();
    await group(groups.support, { values: { 'app_lock.max_background': '900', 'app_lock.required': ['mail'], 'mail.mode.new_accounts': 'sync' } });
    await group(groups.finance, { values: { 'app_lock.max_background': '60', 'app_lock.required': ['contacts'], 'mail.mode.new_accounts': 'download' } });
    assert.equal(await value(alex, 'app_lock.max_background'), '60');
    assert.equal(await value(blair, 'app_lock.max_background'), '900');
    assert.deepEqual(await value(alex, 'app_lock.required'), ['mail', 'contacts'], 'the app lock areas add up');
    assert.equal(await value(alex, 'mail.mode.new_accounts'), 'user_choice', 'Alex\'s groups disagree: Everyone\'s value holds');
    assert.equal(await value(blair, 'mail.mode.new_accounts'), 'sync');
    assert.equal(await value(casey, 'mail.mode.new_accounts'), 'user_choice');
    const page = await call(admin, 'GET', '/api/admin/policies');
    assert.equal(page.policies['mail.mode.new_accounts'].conflict, true);
    assert.deepEqual(page.policies['mail.mode.new_accounts'].groups.map((entry: FixtureValue) => [entry.name, entry.value]), [['Finance', 'download'], ['Support', 'sync']]);
    assert.equal(page.policies['app_lock.max_background'].conflict, undefined, 'a key with an order has no conflict');
    assert.equal(page.target, undefined);
  });

  await t.test('floors per group: the bin\'s minimum, the app lock and the least notification detail', async () => {
    await clean();
    await group(groups.support, { values: { 'bin.delete': 'forbidden', 'notifications.detail': 'none' }, bin_min_retention: 'forever' });
    await everyone({ 'bin.delete': 'forbidden' }, { bin_min_retention: '30' });
    const settings = async (client: Client) => (await call(client, 'GET', '/api/settings/values')).settings;
    assert.equal((await settings(blair)).bin_retention.floor, 'forever', 'Support keeps items until they are restored');
    assert.equal((await settings(casey)).bin_retention.floor, '30');
    assert.deepEqual([(await settings(blair)).reminder_notification_detail.value, (await settings(blair)).reminder_notification_detail.floor], ['none', 'none']);
    assert.equal((await settings(casey)).reminder_notification_detail.floor, undefined);
    const { defaultSettingValues } = require('../dist/src/services/settings') as typeof import('../src/services/settings');
    assert.equal((await defaultSettingValues('mail_account', ids.member)).notify_detail, 'none');
    assert.equal((await defaultSettingValues('mail_account', ids.stranger)).notify_detail, 'full');
    // 'sender' floors mail at the sender and leaves reminders at full detail (a reminder has no sender).
    await group(groups.support, { values: { 'notifications.detail': 'sender' } });
    assert.equal((await defaultSettingValues('mail_account', ids.member)).notify_detail, 'sender');
    assert.equal((await settings(blair)).reminder_notification_detail.floor, undefined);
    const refused = await call(blair, 'PUT', '/api/settings/values', { values: { bin_retention: '30' } }, 403);
    assert.equal(refused.code, 'POLICY_FLOOR');
  });

  await t.test('the notice shows only to the people whose rules changed', async () => {
    await clean();
    const before = (await call(admin, 'GET', '/api/policies/effective')).revision;
    await group(groups.finance, { values: { 'accounts.remove': 'forbidden' } });
    assert.equal((await call(admin, 'GET', '/api/policies/effective')).revision, before + 1);
    assert.equal(await noticeDue(alex), true, 'Alex is in Finance');
    for (const client of [blair, casey, drew]) assert.equal(await noticeDue(client), false);
    // A save that leaves everyone's rules as they were moves nothing.
    await group(groups.finance, { values: { 'accounts.remove': 'forbidden' } });
    assert.equal((await call(admin, 'GET', '/api/policies/effective')).revision, before + 1);
    await call(alex, 'POST', '/api/policies/acknowledge', { revision: before + 1 });
    assert.equal(await noticeDue(alex), false);
    // Everyone's change reaches everyone again.
    await everyone({ 'accounts.add': 'forbidden' });
    for (const client of [alex, blair, casey, drew]) assert.equal(await noticeDue(client), true);
  });

  await t.test('a membership change goes through the rules lock: it waits for a destructive step\'s final check and moves the rules', async () => {
    await clean();
    await group(groups.finance, { values: { 'data.clear': 'forbidden' } });
    await acknowledgeAll();
    const { assertFinalStep } = require('../dist/src/services/final-step') as typeof import('../src/services/final-step');
    // Blair's destructive step holds its final check.
    const step = await pool.getConnection();
    await step.beginTransaction();
    const answer = await assertFinalStep(step, { userId: ids.member, policies: ['data.clear'] });
    assert.equal(answer.policy('data.clear').allowed, true);
    // The administrator adds Blair to Finance meanwhile (services/groups.ts, under the rules lock).
    let joined = false;
    const joining = admin.request('POST', `/api/groups/${groups.finance}/members`, { user_ids: [ids.member] }).then(reply => { joined = true; return reply; });
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(joined, false, 'the change waits for the step');
    await step.commit();
    step.release();
    assert.equal((await joining).status, 200);
    assert.equal((await policy(blair, 'data.clear')).allowed, false);
    assert.equal(await noticeDue(blair), true);
    assert.equal(await noticeDue(casey), false);
    await call(admin, 'DELETE', `/api/groups/${groups.finance}/members/${ids.member}`);
    assert.equal((await policy(blair, 'data.clear')).allowed, true);
  });

  await t.test('a combination that cannot hold is refused for a group, for a person in two groups and on a membership change', async () => {
    await clean();
    await group(groups.support, { values: { 'mail.mode.download': 'forbidden' } });
    // Alex is in Support and Finance: Finance forbidding Sync leaves Alex no mail mode.
    const refused = await group(groups.finance, { values: { 'mail.mode.sync': 'forbidden' } }, 400);
    assert.equal(refused.code, 'POLICY_CONFLICT');
    assert.match(refused.error, /^For Alex Manager: Allow at least one mail mode/);
    assert.equal(await value(alex, 'mail.mode.sync'), 'allowed', 'nothing was saved');
    // The group with Everyone's: new accounts in Download mode while Support forbids it.
    assert.match((await group(groups.support, { values: { 'mail.mode.new_accounts': 'download' } }, 400)).error, /^For the group Support: New accounts cannot use Download mode/);
    // A third group, with nobody in it, may forbid Sync; joining it is refused for a member of Support.
    const ops = crypto.randomUUID();
    await pool.execute("INSERT INTO org_groups (id, name) VALUES (?, 'Operations')", [ops]);
    await group(ops, { values: { 'mail.mode.sync': 'forbidden' } });
    const joining = await call(admin, 'POST', `/api/groups/${ops}/members`, { user_ids: [ids.member] }, 400);
    assert.deepEqual([joining.code, /^For Blair Member: Allow at least one mail mode/.test(joining.error)], ['POLICY_CONFLICT', true]);
    assert.equal(Number(((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM org_group_members WHERE group_id = ?', [ops]))[0][0]).n), 0, 'the membership rolled back');
    await pool.execute('DELETE FROM org_groups WHERE id = ?', [ops]);
  });
});
