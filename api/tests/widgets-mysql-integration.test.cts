import type { FixtureValue } from './helpers/test-types.cts';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// The Android widgets' answer through the real request handler: Alex sees
// his own items, Blair's calendar shared with him to edit, her free/busy
// calendar as "Busy" without tasks, and the Support group calendar where he
// manages; Blair contributes to it and gets its tasks without a tick; a
// repeating task shows once among the tasks not yet due; a removed share, a
// stranger and a former member see nothing; detail "none" hides titles and
// ticks; the module switch and an ended two-factor grace refuse the route,
// also for the app's background requests.
test('widgets: agenda and tasks of own, shared and group calendars at the person\'s level and detail', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, groups, clients, password } = await seedPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey, revoked: drew } = clients;
  type Client = typeof admin;
  const app = { 'X-Background-Sync': '1', 'User-Agent': 'UniHubAndroid/0.32.0 (32000)' };
  const call = async (client: Client, method: string, url: string, body?: unknown, status = 200): Promise<FixtureValue> => {
    const reply = await client.request(method, url, body);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    return reply.body;
  };
  const widgets = async (client: Client): Promise<FixtureValue> => {
    const reply = await client.request('GET', '/api/widgets?tz=Europe/Berlin', undefined, app);
    assert.equal(reply.status, 200, JSON.stringify(reply.body).slice(0, 300));
    return reply.body;
  };
  const day = (days: number, hour = 9) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + days, hour)).toISOString();
  const event = async (client: Client, calendarId: string, title: string, start: string | null, extra: Record<string, unknown> = {}) =>
    (await call(client, 'POST', '/api/calendar/events', start ? { title, calendar_id: calendarId, start_time: start, end_time: new Date(Date.parse(start) + 3600_000).toISOString(), ...extra }
      : { title, calendar_id: calendarId, is_todo_only: true, ...extra })).event;
  const calendarOf = async (client: Client, name: string) => {
    const local = (await call(client, 'GET', '/api/calendar/calendars')).calendars[0];
    return (await call(client, 'POST', '/api/calendar/calendars', { account_id: local.account_id, name })).calendar;
  };

  // ── Alex's own: an overdue task, one for tomorrow, one without a date ──
  const alexCal = (await call(alex, 'GET', '/api/calendar/calendars')).calendars[0];
  const late = await event(alex, alexCal.id, 'File report', day(-2));
  const tomorrow = await event(alex, alexCal.id, 'Dentist', day(1));
  const undated = await event(alex, alexCal.id, 'Buy stamps', null);
  const far = await event(alex, alexCal.id, 'Holiday', day(20));
  const done = await event(alex, alexCal.id, 'Old thing', null);
  await call(alex, 'PUT', `/api/calendar/events/${done.id}/todo-status`, { todo_status: 'done' });

  // ── Blair's Team calendar shared with Alex to edit, with a weekly series; her Private one at free/busy ──
  const team = await calendarOf(blair, 'Team');
  const planning = await event(blair, team.id, 'Planning', day(2));
  const series = crypto.randomUUID();
  await pool.execute("INSERT INTO calendar_series (id, calendar_id, uid, ics) VALUES (?, ?, ?, 'BEGIN:VCALENDAR\\r\\nEND:VCALENDAR')", [series, team.id, `${series}@example.test`]);
  const weekly = [3, 10, 17].map(() => crypto.randomUUID());
  for (const [index, id] of weekly.entries()) {
    await pool.execute(`INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time, series_id, recurrence_id)
      VALUES (?, ?, ?, 'Stand-up', ?, ?, ?, ?)`, [id, ids.member, team.id, day([3, 10, 17][index]).slice(0, 19).replace('T', ' '), day([3, 10, 17][index], 10).slice(0, 19).replace('T', ' '), series, String(index)]);
  }
  const privateCal = await calendarOf(blair, 'Private');
  const doctor = await event(blair, privateCal.id, 'Doctor', day(1, 14));
  const secret = await event(blair, privateCal.id, 'Secret task', null);
  await call(blair, 'PUT', `/api/calendar/calendars/${team.id}/shares`, { principal: { kind: 'user', id: ids.manager }, permission: 'edit' });
  await call(blair, 'PUT', `/api/calendar/calendars/${privateCal.id}/shares`, { principal: { kind: 'user', id: ids.manager }, permission: 'freebusy' });

  // ── The Support group calendar: Alex manages, Blair contributes ──
  const support = (await call(alex, 'POST', '/api/calendar/shared-calendars', { name: 'Support desk', color: '#0f766e', group_id: groups.support })).calendar;
  const rota = crypto.randomUUID();
  await pool.execute('INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time) VALUES (?, NULL, ?, \'Rota\', ?, ?)',
    [rota, support.id, day(4).slice(0, 19).replace('T', ' '), day(4, 10).slice(0, 19).replace('T', ' ')]);

  // Alex places Buy stamps first by hand: his order, not the dates.
  await call(alex, 'PUT', `/api/calendar/events/${undated.id}/position`, { before: late.id, after: null });

  const seen = await widgets(alex);
  assert.equal(seen.detail, 'full');
  const agenda = new Map((seen.agenda as FixtureValue[]).map(item => [item.id, item]));
  assert.deepEqual([...agenda.keys()].sort(), [tomorrow.id, planning.id, weekly[0], weekly[1], doctor.id, rota].sort(),
    'the next 14 days of every calendar he has on, each date of a series as its own row');
  assert.ok(!agenda.has(far.id) && !agenda.has(late.id), 'nothing past or beyond 14 days');
  assert.deepEqual([agenda.get(doctor.id).title, agenda.get(planning.id).title, agenda.get(rota).title, agenda.get(rota).color], ['Busy', 'Planning', 'Rota', '#0f766e']);
  const tasks = seen.tasks as FixtureValue[];
  const byId = new Map(tasks.map(task => [task.id, task]));
  assert.equal(tasks[0].id, undated.id, 'his own order first');
  assert.ok(tasks.findIndex(task => task.id === late.id) < tasks.findIndex(task => task.id === tomorrow.id), 'then by date');
  assert.deepEqual([byId.get(late.id).overdue, byId.get(late.id).can_tick, byId.get(tomorrow.id).date_text, byId.get(tomorrow.id).overdue, byId.get(undated.id).date_text],
    [true, true, `Tomorrow ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(day(1)))}`, false, null]);
  assert.deepEqual(tasks.filter(task => weekly.includes(task.id)).map(task => task.id), [weekly[0]], 'a repeating task once, with its next date');
  assert.deepEqual([byId.get(planning.id).can_tick, byId.get(rota).can_tick], [true, true], 'edit and manage tick');
  assert.ok(!byId.has(doctor.id) && !byId.has(secret.id) && !byId.has(done.id), 'no tasks from free/busy, none done');
  assert.equal(seen.more_tasks, 0);
  assert.equal(seen.time_zone, 'Europe/Berlin', 'the zone the dates are written in, for the agenda\'s times');

  // Blair contributes to Support: its task without a tick.
  const blairs = await widgets(blair);
  const rotaForBlair = (blairs.tasks as FixtureValue[]).find(task => task.id === rota);
  assert.deepEqual([rotaForBlair.title, rotaForBlair.can_tick], ['Rota', false]);

  // A stranger and a former member reach none of it; a removed share takes it away.
  for (const client of [casey, drew]) {
    const theirs = await widgets(client);
    assert.deepEqual([theirs.agenda.length, theirs.tasks.length], [0, 0]);
  }
  await call(blair, 'PUT', `/api/calendar/calendars/${team.id}/shares`, { principal: { kind: 'user', id: ids.manager }, permission: null });
  const after = await widgets(alex);
  assert.ok(![...after.agenda, ...after.tasks].some((item: FixtureValue) => item.calendar_id === team.id), 'the revoked calendar is gone');

  // The least detail "none" for everyone: no titles, "Event" or "Busy", no ticking.
  const saved = await admin.request('PUT', '/api/admin/policies', { values: { 'notifications.detail': 'none' }, current_password: password });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const hidden = await widgets(alex);
  assert.equal(hidden.detail, 'none');
  assert.deepEqual([...new Set(hidden.agenda.map((item: FixtureValue) => item.title))].sort(), ['Busy', 'Event']);
  assert.ok(hidden.tasks.length > 0 && hidden.tasks.every((task: FixtureValue) => task.title === null && !task.can_tick && task.id));

  // Gates: the module switched off and an ended two-factor grace.
  await call(alex, 'PUT', '/api/modules', { modules: { calendar: { enabled: false } } });
  const off = await alex.request('GET', '/api/widgets', undefined, app);
  assert.deepEqual([off.status, off.body.code], [403, 'MODULE_DISABLED']);
  await admin.request('PUT', '/api/admin/policies', { values: { 'auth.two_factor': 'required' }, current_password: password });
  await pool.execute('UPDATE users SET two_factor_required_since = UTC_TIMESTAMP() - INTERVAL 8 DAY WHERE id = ?', [ids.member]);
  const grace = await blair.request('GET', '/api/widgets', undefined, app);
  assert.deepEqual([grace.status, grace.body.code], [403, 'TWO_FACTOR_REQUIRED']);
});
