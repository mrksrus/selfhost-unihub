import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// A calendar's own bin through the real request handler: what an editor
// deletes from Blair's calendar is in that calendar's bin and in Blair's own,
// and comes back into her calendar; in an organisation calendar the items
// have no owner, a reader and outsiders reach none, bin.delete and the bin
// minimum hold for the purge, and a deleted organisation calendar is purged
// with its events, bin and shares after the shared retention.
test('a calendar\'s bin: editors restore, the owner sees the same item, readers none, bin.delete and the minimum hold, a deleted calendar is purged', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { purgeBin } = require('../dist/src/services/bin') as typeof import('../src/services/bin');
  const { ids, groups, clients } = await seedPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey, revoked: drew } = clients;
  type Client = typeof admin;
  const call = async (client: Client, method: string, url: string, body?: unknown, status = 200): Promise<FixtureValue> => {
    const reply = await client.request(method, url, body);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    return reply.body;
  };
  const days = (n: number) => new Date(Date.now() + n * 86400000);
  const count = async (sql: string, params: unknown[]) => Number((await pool.query<RowDataPacket[]>(sql, params))[0][0].n);
  const policy = (key: string, value: string, group = '') => pool.execute(
    "INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES (?, ?, ?, ?, 0)", [group ? 'group' : 'installation', group, `policy.${key}`, value]);
  const clearPolicies = () => pool.execute("DELETE FROM setting_policies WHERE setting_key LIKE 'policy.bin.%'");
  const event = (client: Client, calendarId: string, title: string) => call(client, 'POST', '/api/calendar/events',
    { title, start_time: '2031-05-04T09:00:00Z', end_time: '2031-05-04T10:00:00Z', calendar_id: calendarId }).then(answer => answer.event);
  const binOf = async (client: Client, calendarId?: string) => (await call(client, 'GET', `/api/bin${calendarId ? `?calendar=${calendarId}` : ''}`)) as FixtureValue;

  // ── Blair's calendar: Alex's delete is in the calendar's bin and Blair's own ──
  const account = (await call(blair, 'GET', '/api/calendar/calendars')).calendars[0].account_id;
  const team = (await call(blair, 'POST', '/api/calendar/calendars', { account_id: account, name: 'Team' })).calendar;
  await call(blair, 'PUT', `/api/calendar/calendars/${team.id}/shares`, { principal: { kind: 'user', id: ids.manager }, permission: 'edit' });
  const planning = await event(blair, team.id, 'Planning');
  await call(blair, 'POST', `/api/calendar/events/${planning.id}/subtasks`, { title: 'Bring numbers' });
  const [teamItem] = (await call(alex, 'DELETE', `/api/calendar/events/${planning.id}`)).bin_item_ids;
  const [[stored]] = await pool.query<RowDataPacket[]>('SELECT user_id, calendar_id FROM bin_items WHERE id = ?', [teamItem]);
  assert.deepEqual([stored.user_id, stored.calendar_id], [ids.member, team.id]);
  assert.deepEqual([(await binOf(alex, team.id)).items.map((item: FixtureValue) => item.id), (await binOf(alex, team.id)).retention], [[teamItem], '30']);
  assert.ok((await binOf(blair)).items.some((item: FixtureValue) => item.id === teamItem), 'the owner sees the same item in her bin');
  assert.deepEqual((await binOf(alex)).items, [], 'not in the editor\'s own bin');
  assert.equal((await call(casey, 'GET', `/api/bin?calendar=${team.id}`, undefined, 404)).code, 'CALENDAR_NOT_FOUND');
  const back = (await call(alex, 'POST', `/api/bin/${teamItem}/restore`, {})).restored;
  assert.deepEqual(back.map((item: FixtureValue) => item.item_id), [planning.id]);
  const restored = (await call(blair, 'GET', `/api/calendar/events/${planning.id}`)).event;
  assert.deepEqual([restored.calendar_id, restored.user_id, restored.subtasks.map((point: FixtureValue) => point.title)], [team.id, ids.member, ['Bring numbers']]);

  // ── An organisation calendar: items without an owner, editors only ──
  const company = (await call(admin, 'POST', '/api/calendar/shared-calendars', { name: 'Company' })).calendar;
  await call(admin, 'PUT', `/api/calendar/calendars/${company.id}/shares`, { principal: { kind: 'user', id: ids.manager }, permission: 'edit' });
  await call(admin, 'PUT', `/api/calendar/calendars/${company.id}/shares`, { principal: { kind: 'user', id: ids.stranger }, permission: 'read' });
  const holiday = await event(alex, company.id, 'Holiday');
  const [item] = (await call(alex, 'DELETE', `/api/calendar/events/${holiday.id}`)).bin_item_ids;
  const [[orphan]] = await pool.query<RowDataPacket[]>('SELECT user_id, calendar_id FROM bin_items WHERE id = ?', [item]);
  assert.deepEqual([orphan.user_id, orphan.calendar_id], [null, company.id]);
  const companyBin = await binOf(alex, company.id);
  assert.deepEqual([companyBin.items.map((entry: FixtureValue) => entry.id), companyBin.retention], [[item], '30']);
  assert.ok(Math.abs(Date.parse(companyBin.items[0].purge_after) - days(30).getTime()) < 3600000, 'due in 30 days');
  assert.deepEqual((await binOf(alex)).items, [], 'never in a personal bin');
  assert.equal((await call(casey, 'GET', `/api/bin?calendar=${company.id}`, undefined, 403)).code, 'CALENDAR_FORBIDDEN');
  assert.equal((await call(drew, 'GET', `/api/bin?calendar=${company.id}`, undefined, 404)).code, 'CALENDAR_NOT_FOUND');
  assert.deepEqual((await call(casey, 'POST', '/api/bin/restore', { ids: [item] })).failed.map((entry: FixtureValue) => entry.code), ['BIN_ITEM_NOT_FOUND']);
  await call(casey, 'DELETE', `/api/bin/${item}`, undefined, 404);
  assert.equal((await call(casey, 'POST', '/api/bin/empty', { calendar: company.id }, 403)).code, 'CALENDAR_FORBIDDEN');

  // ── bin.delete forbidden: no delete for good, and the purge keeps it ──
  await policy('bin.delete', 'forbidden');
  assert.equal((await call(alex, 'DELETE', `/api/bin/${item}`, undefined, 403)).code, 'POLICY_FORBIDS');
  await purgeBin({ now: days(400) });
  assert.deepEqual([(await binOf(alex, company.id)).retention, (await binOf(alex, company.id)).items.length], ['forever', 1]);
  // Forbidden for some group only, under a minimum of 90 days: that minimum holds for an organisation calendar's bin.
  await clearPolicies();
  await policy('bin.delete', 'forbidden', groups.finance);
  await policy('bin.min_retention', '90');
  await purgeBin({ now: days(40) });
  assert.equal((await binOf(alex, company.id)).items.length, 1, 'kept for the minimum');
  await purgeBin({ now: days(91) });
  assert.deepEqual((await binOf(alex, company.id)).items, [], 'purged after the minimum');
  await clearPolicies();

  // ── Allowed again: an editor deletes for good and empties ──
  for (const title of ['One', 'Two']) await call(alex, 'DELETE', `/api/calendar/events/${(await event(alex, company.id, title)).id}`);
  const [first] = (await binOf(alex, company.id)).items;
  assert.equal((await call(alex, 'DELETE', `/api/bin/${first.id}`)).deleted, 1);
  assert.equal((await call(alex, 'POST', '/api/bin/empty', { calendar: company.id })).deleted, 1);

  // ── A deleted organisation calendar is purged with its events, bin and shares after the retention ──
  await event(alex, company.id, 'Kept');
  await call(alex, 'DELETE', `/api/calendar/events/${(await event(alex, company.id, 'Binned')).id}`);
  await call(admin, 'DELETE', `/api/calendar/shared-calendars/${company.id}`);
  await purgeBin({ now: days(20) });
  assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_calendars WHERE id = ?', [company.id]), 1, 'kept within the retention');
  await purgeBin({ now: days(31) });
  assert.deepEqual([
    await count('SELECT COUNT(*) AS n FROM calendar_calendars WHERE id = ?', [company.id]),
    await count('SELECT COUNT(*) AS n FROM calendar_events WHERE calendar_id = ? OR (user_id IS NULL AND title IN (\'Kept\', \'Binned\'))', [company.id]),
    await count('SELECT COUNT(*) AS n FROM bin_items WHERE calendar_id = ?', [company.id]),
    await count("SELECT COUNT(*) AS n FROM grants WHERE resource_kind = 'calendar' AND resource_id = ?", [company.id]),
  ], [0, 0, 0, 0], 'the calendar, its events, bin and shares are gone');
  assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_events WHERE id = ?', [planning.id]), 1, 'a person\'s calendar is left alone');
});
