import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// Shared, group and organisation calendars through the real request handler
// with the shared people: Blair (member of Support) shares her calendar;
// Alex (manager of Support, member of Finance) walks every level on it;
// Casey (in no group), Drew (removed from Support) and the administrator
// without a share reach nothing; a synced calendar is never shared; Alex
// creates the Support calendar, which every member reaches at contribute and
// which becomes an organisation calendar when Support is deleted; nothing of
// a calendar no person owns is in a personal backup or cleared with a
// person's calendar.
test('shared calendars: levels, reach, free/busy, synced calendars, administrators, group calendars and isolation', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, groups, clients, password } = await seedPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey, revoked: drew } = clients;
  type Client = typeof admin;
  const call = async (client: Client, method: string, url: string, body?: unknown, status = 200): Promise<FixtureValue> => {
    const reply = await client.request(method, url, body);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    return reply.body;
  };
  const refused = async (client: Client, method: string, url: string, body?: unknown) => {
    const reply = await client.request(method, url, body);
    return [reply.status, reply.body.code ?? null];
  };
  const user = (id: string) => ({ kind: 'user', id });
  const group = (id: string) => ({ kind: 'group', id });
  const calendarsOf = async (client: Client) => (await call(client, 'GET', '/api/calendar/calendars')).calendars as FixtureValue[];
  const listed = async (client: Client, id: string) => (await calendarsOf(client)).find(item => item.id === id);
  const eventsOf = async (client: Client, query = '') => (await call(client, 'GET', `/api/calendar/events?include_todos=true${query}`)).events as FixtureValue[];
  const count = async (sql: string, params: unknown[] = []) => Number((await pool.query<RowDataPacket[]>(sql, params))[0][0].n);

  // ── Blair's calendar with an event, a task without a date, a point and an attendee ──
  const own = await calendarsOf(blair);
  const local = own[0];
  const team = (await call(blair, 'POST', '/api/calendar/calendars', { account_id: local.account_id, name: 'Team' })).calendar;
  const cal = `/api/calendar/calendars/${team.id}`;
  const meeting = (await call(blair, 'POST', '/api/calendar/events', { title: 'Planning', description: 'Budget talk', location: 'Room 4',
    start_time: '2031-03-04T09:00:00Z', end_time: '2031-03-04T10:00:00Z', calendar_id: team.id, attendees: [{ email: 'guest@example.test' }] })).event;
  await call(blair, 'POST', `/api/calendar/events/${meeting.id}/subtasks`, { title: 'Bring numbers' });
  const task = (await call(blair, 'POST', '/api/calendar/events', { title: 'Order paper', is_todo_only: true, calendar_id: team.id })).event;
  assert.deepEqual([(await listed(blair, team.id)).permission, (await listed(blair, team.id)).owner_kind, (await listed(blair, team.id)).owner], ['manage', 'user', null]);
  const ownRead = (await call(blair, 'GET', `/api/calendar/events/${meeting.id}`)).event;
  assert.deepEqual([ownRead.subtasks.map((point: FixtureValue) => [point.title, point.created_by]), ownRead.attendees.map((person: FixtureValue) => person.email), ownRead.series_key],
    [[['Bring numbers', ids.member]], ['guest@example.test'], null], 'the owner reads the event with its points and attendees');
  for (const client of [alex, casey, drew, admin]) assert.equal(await listed(client, team.id), undefined, 'nobody else lists it before a share');

  // ── (2) Reach: a member shares with their own groups and the people in them, never everyone ──
  assert.deepEqual(await refused(blair, 'PUT', `${cal}/shares`, { principal: { kind: 'everyone' }, permission: 'read' }), [403, 'SHARE_OUT_OF_REACH']);
  assert.deepEqual(await refused(blair, 'PUT', `${cal}/shares`, { principal: group(groups.finance), permission: 'read' }), [403, 'SHARE_OUT_OF_REACH']);
  assert.deepEqual(await refused(blair, 'PUT', `${cal}/shares`, { principal: user(ids.stranger), permission: 'read' }), [403, 'SHARE_OUT_OF_REACH']);
  assert.deepEqual(await refused(blair, 'PUT', `${cal}/shares`, { principal: user(ids.member), permission: 'read' }), [400, 'SHARE_IS_OWNER']);
  assert.deepEqual(await refused(blair, 'PUT', `${cal}/shares`, { principal: user(ids.manager), permission: 'own' }), [400, 'SHARE_INVALID']);
  const candidates = await call(blair, 'GET', `${cal}/share-candidates?q=`);
  assert.deepEqual([candidates.people.map((person: FixtureValue) => person.email).sort(), candidates.groups.map((item: FixtureValue) => item.name), candidates.everyone],
    [['alex@example.test', 'blair@example.test'], ['Support'], false]);

  // ── (1) Alex walks every level on Blair's calendar; outsiders and the administrator reach nothing ──
  const routes: [string, string, unknown?][] = [
    ['GET', `${cal}/shares`], ['PUT', `${cal}/shares`, { principal: user(ids.manager), permission: 'read' }], ['GET', `${cal}/share-candidates?q=a`],
    ['PUT', `${cal}/view`, { notify_changes: true }], ['PUT', `/api/calendar/shared-calendars/${team.id}`, { name: 'Renamed' }],
    ['DELETE', `/api/calendar/shared-calendars/${team.id}`], ['GET', `/api/calendar/events/${meeting.id}`],
  ];
  const outsiders = async () => {
    for (const [name, client] of [['Casey', casey], ['Drew', drew], ['the administrator', admin]] as const) {
      for (const [method, url, body] of routes) {
        const expected = url.includes('/events/') ? [404, null] : [404, 'CALENDAR_NOT_FOUND'];
        assert.deepEqual(await refused(client, method, url, body), expected, `${name} ${method} ${url}`);
      }
      assert.ok(!(await eventsOf(client)).some(event => [meeting.id, task.id].includes(event.id)), `${name} lists none of its events`);
    }
  };
  await outsiders();
  for (const level of ['freebusy', 'read', 'contribute', 'edit', 'manage'] as const) {
    await call(blair, 'PUT', `${cal}/shares`, { principal: user(ids.manager), permission: level });
    const entry = await listed(alex, team.id);
    assert.deepEqual([entry.permission, entry.owner_kind, entry.owner?.email, entry.write_block], [level, 'user', 'blair@example.test', ['edit', 'manage'].includes(level) ? null : 'read_only'], level);
    const seen = (await eventsOf(alex)).filter(event => event.calendar_id === team.id);
    const single = (await call(alex, 'GET', `/api/calendar/events/${meeting.id}`)).event;
    // ── (3) Free/busy: times only, as "Busy"; no task without a date ──
    if (level === 'freebusy') {
      assert.deepEqual(seen.map(event => [event.id, event.title, event.description, event.location, event.subtasks, event.attendees, event.start_time]),
        [[meeting.id, 'Busy', null, null, [], [], '2031-03-04T09:00:00.000Z']], 'free/busy: times only');
      assert.deepEqual([single.title, single.description, single.subtasks], ['Busy', null, []]);
      assert.deepEqual(await refused(alex, 'GET', `/api/calendar/events/${task.id}`), [404, null], 'free/busy: no task');
    } else {
      assert.deepEqual(seen.map(event => event.title).sort(), ['Order paper', 'Planning'], level);
      assert.deepEqual([single.description, single.subtasks.map((point: FixtureValue) => point.title), single.attendees.map((person: FixtureValue) => person.email)],
        ['Budget talk', ['Bring numbers'], ['guest@example.test']], level);
    }
    for (const [method, url, body] of routes.slice(0, 3)) {
      if (level === 'manage') await call(alex, method, url, method === 'PUT' ? { principal: group(groups.support), permission: 'read' } : body);
      else assert.deepEqual(await refused(alex, method, url, body), [403, 'CALENDAR_FORBIDDEN'], `${level}: ${method} ${url}`);
    }
    // Every level has its own view; renaming needs manage; only a group's or the organisation's calendar is deleted here.
    await call(alex, 'PUT', `${cal}/view`, { notify_changes: level === 'read' });
    if (level !== 'manage') assert.deepEqual(await refused(alex, 'PUT', `/api/calendar/shared-calendars/${team.id}`, { name: 'Renamed' }), [403, 'CALENDAR_FORBIDDEN']);
  }
  assert.deepEqual(await refused(alex, 'DELETE', `/api/calendar/shared-calendars/${team.id}`), [400, 'CALENDAR_HAS_OWNER']);
  // As manager Alex shared with Support, within his reach; never with Casey or everyone.
  assert.deepEqual(await refused(alex, 'PUT', `${cal}/shares`, { principal: user(ids.stranger), permission: 'read' }), [403, 'SHARE_OUT_OF_REACH']);
  assert.deepEqual((await call(blair, 'GET', `${cal}/shares`)).shares.map((share: FixtureValue) => [share.principal.kind, share.name, share.permission]).sort(),
    [['group', 'Support', 'read'], ['user', 'Alex Manager', 'manage']]);
  // Drew, removed from Support, gets nothing through it; Casey and the administrator still nothing.
  await outsiders();

  // The person's own view: off, another colour; the owner's switches stay on the calendar.
  await call(blair, 'PUT', `${cal}/shares`, { principal: user(ids.manager), permission: 'read' });
  const view = (await call(alex, 'PUT', `${cal}/view`, { is_visible: false, color: '#112233', notify_changes: true })).view;
  assert.deepEqual(view, { is_visible: false, color: '#112233', notify_changes: true });
  assert.deepEqual([(await listed(alex, team.id)).is_visible, (await listed(alex, team.id)).color], [false, '#112233']);
  assert.ok(!(await eventsOf(alex, '&visible_only=true')).some(event => event.calendar_id === team.id), 'a calendar switched off is left out');
  assert.ok((await eventsOf(alex)).some(event => event.calendar_id === team.id));
  assert.deepEqual([(await listed(blair, team.id)).is_visible, (await listed(blair, team.id)).color, (await listed(blair, team.id)).view.notify_changes], [true, '#2563eb', false]);
  assert.deepEqual(await refused(blair, 'PUT', `${cal}/view`, { color: '#112233' }), [400, 'INVALID_INPUT']);
  assert.equal((await call(blair, 'PUT', `${cal}/view`, { notify_changes: true })).view.notify_changes, true);

  // An archived calendar is read-only for everyone, its owner too.
  await pool.execute('UPDATE calendar_calendars SET archived_at = UTC_TIMESTAMP() WHERE id = ?', [team.id]);
  assert.deepEqual([(await listed(blair, team.id)).permission, (await listed(blair, team.id)).archived, (await listed(blair, team.id)).write_block], ['read', true, 'read_only']);
  assert.deepEqual(await refused(blair, 'PUT', `${cal}/shares`, { principal: user(ids.manager), permission: 'edit' }), [403, 'CALENDAR_FORBIDDEN']);
  assert.equal((await listed(alex, team.id)).permission, 'read');
  await pool.execute('UPDATE calendar_calendars SET archived_at = NULL WHERE id = ?', [team.id]);

  // ── (4) A synced calendar is never shared, and a grant on one reaches nobody ──
  for (const provider of ['caldav', 'ics']) {
    const [account, synced] = [crypto.randomUUID(), crypto.randomUUID()];
    await pool.execute("INSERT INTO calendar_accounts (id, user_id, provider, display_name, is_active) VALUES (?, ?, ?, 'Provider', TRUE)", [account, ids.member, provider]);
    await pool.execute("INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id) VALUES (?, ?, ?, 'Synced', ?)", [synced, ids.member, account, `/${provider}/`]);
    const url = `/api/calendar/calendars/${synced}`;
    for (const [method, path, body] of [['GET', `${url}/shares`], ['PUT', `${url}/shares`, { principal: user(ids.manager), permission: 'read' }], ['GET', `${url}/share-candidates?q=`],
      ['PUT', `/api/calendar/shared-calendars/${synced}`, { name: 'X' }]] as const) {
      assert.deepEqual(await refused(blair, method, path, body), [400, 'CALENDAR_NOT_SHAREABLE'], `${provider}: ${method} ${path}`);
    }
    await pool.execute("INSERT INTO grants (id, resource_kind, resource_id, principal_kind, principal_id, permission) VALUES (UUID(), 'calendar', ?, 'user', ?, 'read')", [synced, ids.manager]);
    assert.equal(await listed(alex, synced), undefined, `${provider}: a grant on a synced calendar reaches nobody`);
    assert.deepEqual(await refused(alex, 'PUT', `${url}/view`, { notify_changes: true }), [404, 'CALENDAR_NOT_FOUND']);
  }

  // ── (5) The administrator: names and counts, never a member's content ──
  const adminList = (await call(admin, 'GET', '/api/admin/calendars')).calendars as FixtureValue[];
  const listedTeam = adminList.find(item => item.id === team.id);
  assert.deepEqual(Object.keys(listedTeam).sort(), ['archived_at', 'color', 'created_at', 'deleted_at', 'event_count', 'group', 'id', 'name', 'owner', 'owner_kind', 'share_count']);
  assert.deepEqual([listedTeam.name, listedTeam.owner.email, listedTeam.share_count, listedTeam.event_count], ['Team', 'blair@example.test', 2, 2]);
  assert.ok(!adminList.some(item => item.id === local.id), 'a calendar shared with nobody is not listed');
  for (const client of [alex, blair]) assert.equal((await client.request('GET', '/api/admin/calendars')).status, 403);

  // ── (6) Group calendars: Alex creates Support's, members contribute, others see nothing ──
  assert.deepEqual(await refused(blair, 'POST', '/api/calendar/shared-calendars', { name: 'Support', group_id: groups.support }), [403, 'CALENDAR_FORBIDDEN']);
  assert.deepEqual(await refused(alex, 'POST', '/api/calendar/shared-calendars', { name: 'Finance', group_id: groups.finance }), [403, 'CALENDAR_FORBIDDEN']);
  assert.deepEqual(await refused(alex, 'POST', '/api/calendar/shared-calendars', { name: 'Everyone' }), [403, 'CALENDAR_FORBIDDEN']);
  const support = (await call(alex, 'POST', '/api/calendar/shared-calendars', { name: 'Support desk', color: '#0f766e', group_id: groups.support })).calendar;
  assert.deepEqual([support.owner_kind, support.group.name, support.share_count], ['group', 'Support', 1]);
  const supportEvent = crypto.randomUUID();
  await pool.execute("INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time) VALUES (?, NULL, ?, 'Rota', '2031-03-05 08:00:00', '2031-03-05 09:00:00')", [supportEvent, support.id]);
  await pool.execute('INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, created_by) VALUES (UUID(), ?, NULL, ?, ?)', [supportEvent, 'Cover Friday', ids.member]);
  const asBlair = await listed(blair, support.id);
  assert.deepEqual([asBlair.permission, asBlair.owner_kind, asBlair.group.name, asBlair.owner], ['contribute', 'group', 'Support', null]);
  assert.equal((await listed(alex, support.id)).permission, 'manage');
  const rota = (await call(blair, 'GET', `/api/calendar/events/${supportEvent}`)).event;
  assert.deepEqual([rota.title, rota.subtasks.map((point: FixtureValue) => [point.title, point.created_by, point.created_by_name])], ['Rota', [['Cover Friday', ids.member, 'Blair Member']]]);
  // Casey joins Finance only: still nothing of Support's calendar; Drew neither.
  await pool.execute("INSERT INTO org_group_members (group_id, user_id, role, added_by) VALUES (?, ?, 'member', ?)", [groups.finance, ids.stranger, ids.admin]);
  for (const client of [casey, drew]) {
    assert.equal(await listed(client, support.id), undefined);
    assert.deepEqual(await refused(client, 'GET', `/api/calendar/events/${supportEvent}`), [404, null]);
  }
  // A manager may lower the group's level; Blair (contribute) may not delete; a manager deletes softly and an administrator restores.
  assert.deepEqual(await refused(blair, 'DELETE', `/api/calendar/shared-calendars/${support.id}`), [403, 'CALENDAR_FORBIDDEN']);
  await call(alex, 'DELETE', `/api/calendar/shared-calendars/${support.id}`);
  assert.equal(await listed(blair, support.id), undefined, 'a deleted calendar is hidden');
  assert.ok((await call(admin, 'GET', '/api/admin/calendars')).calendars.find((item: FixtureValue) => item.id === support.id).deleted_at);
  assert.equal((await alex.request('POST', `/api/admin/calendars/${support.id}/restore`)).status, 403);
  await call(admin, 'POST', `/api/admin/calendars/${support.id}/restore`);
  assert.equal((await listed(blair, support.id)).permission, 'contribute');
  // The administrator shares an organisation calendar with anyone; Alex, managing the group calendar, may lower Drew's share but not raise it.
  const company = (await call(admin, 'POST', '/api/calendar/shared-calendars', { name: 'Company holidays' })).calendar;
  assert.deepEqual([company.owner_kind, company.group], ['organisation', null]);
  await call(admin, 'PUT', `/api/calendar/calendars/${company.id}/shares`, { principal: { kind: 'everyone' }, permission: 'read' });
  for (const client of [alex, blair, casey, drew]) assert.equal((await listed(client, company.id)).permission, 'read');
  await call(admin, 'PUT', `/api/calendar/calendars/${support.id}/shares`, { principal: user(ids.revoked), permission: 'read' });
  assert.deepEqual(await refused(alex, 'PUT', `/api/calendar/calendars/${support.id}/shares`, { principal: user(ids.revoked), permission: 'edit' }), [403, 'SHARE_OUT_OF_REACH']);
  await call(alex, 'PUT', `/api/calendar/calendars/${support.id}/shares`, { principal: user(ids.revoked), permission: 'freebusy' });
  assert.equal((await listed(drew, support.id)).permission, 'freebusy');
  assert.deepEqual((await eventsOf(drew)).filter(event => event.calendar_id === support.id).map(event => event.title), ['Busy']);

  // ── (7) Isolation: nothing of a calendar no person owns in a personal backup, a clear or a person's paths ──
  const backup = require('../dist/src/services/backup') as typeof import('../src/services/backup');
  for (const person of ['member', 'manager'] as const) {
    const exported = await backup.buildBackupForUser(ids[person], { sections: ['calendar'], includeFileData: false });
    const exportedIds = (table: string) => ((exported.data as FixtureValue)[table] as FixtureValue[]).map(row => row.id ?? row.calendar_id);
    assert.ok(![support.id, company.id].some(id => exportedIds('calendar_calendars').includes(id)), `${person}: no organisation calendar`);
    assert.ok(!exportedIds('calendar_events').includes(supportEvent), `${person}: no organisation event`);
    assert.ok(((exported.data as FixtureValue).calendar_event_subtasks as FixtureValue[]).every(row => row.event_id !== supportEvent));
  }
  await call(blair, 'POST', '/api/settings/clear-calendar', {});
  assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_events WHERE id = ?', [supportEvent]), 1, 'clearing a person\'s calendar leaves the group\'s');
  assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_event_subtasks WHERE event_id = ?', [supportEvent]), 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM grants WHERE resource_kind = 'calendar' AND resource_id = ?", [team.id]), 0, 'a cleared calendar\'s shares go with it');
  assert.equal(await listed(alex, team.id), undefined);

  // A person's calendar deleted to the bin ends its shares; so does deleting the person.
  const second = (await call(blair, 'POST', '/api/calendar/calendars', { account_id: (await calendarsOf(blair))[0].account_id, name: 'Second' })).calendar;
  await call(blair, 'PUT', `/api/calendar/calendars/${second.id}/shares`, { principal: group(groups.support), permission: 'read' });
  await call(blair, 'DELETE', `/api/calendar/calendars/${second.id}`);
  assert.equal(await count("SELECT COUNT(*) AS n FROM grants WHERE resource_kind = 'calendar' AND resource_id = ?", [second.id]), 0);
  const third = (await call(blair, 'POST', '/api/calendar/calendars', { account_id: (await calendarsOf(blair))[0].account_id, name: 'Third' })).calendar;
  await call(blair, 'PUT', `/api/calendar/calendars/${third.id}/shares`, { principal: group(groups.support), permission: 'read' });
  await call(admin, 'DELETE', `/api/admin/users/${ids.member}`, { current_password: password });
  assert.equal(await count("SELECT COUNT(*) AS n FROM grants WHERE resource_kind = 'calendar' AND resource_id = ?", [third.id]), 0);

  // Deleting Support leaves its calendar as an organisation calendar with its events (on delete set null).
  await call(admin, 'DELETE', `/api/admin/groups/${groups.support}`, { current_password: password });
  const [[orphan]] = await pool.query<RowDataPacket[]>('SELECT user_id, group_id, deleted_at FROM calendar_calendars WHERE id = ?', [support.id]);
  assert.deepEqual([orphan.user_id, orphan.group_id, orphan.deleted_at], [null, null, null]);
  const afterGroup = (await call(admin, 'GET', '/api/admin/calendars')).calendars.find((item: FixtureValue) => item.id === support.id);
  assert.deepEqual([afterGroup.owner_kind, afterGroup.group, afterGroup.event_count, afterGroup.share_count], ['organisation', null, 1, 1]);
  assert.equal(await listed(alex, support.id), undefined, 'the group\'s share went with the group');
  assert.equal((await listed(drew, support.id)).permission, 'freebusy', 'a person\'s own share stays');
});
