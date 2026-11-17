import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// What a shared calendar reaches beyond its page, through the real request
// handler and the notification worker: each person's own reminders ring
// only for them; change notifications go only to who switched them on and
// never to whoever made the change; a person whose share ends gets neither
// a queued notification nor a due reminder; offline copies and search hold
// exactly the calendars the person reaches, free/busy as "Busy" without
// tasks; each person keeps their own order of a shared list.
test('shared calendars beyond the page: reminders, change notifications, revocation, offline, search and order', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, clients } = await seedPeople(t, pool);
  const { manager: alex, member: blair, stranger: casey } = clients;
  type Client = typeof alex;
  const notifications = require('../dist/src/services/notifications') as typeof import('../src/services/notifications');
  const webPush = require('web-push') as { sendNotification: unknown };
  const original = webPush.sendNotification;
  const pushed: { endpoint: string; payload: FixtureValue }[] = [];
  webPush.sendNotification = async (subscription: FixtureValue, body: string) => { pushed.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) }); return { statusCode: 201 }; };
  t.after(() => { webPush.sendNotification = original; });
  const call = async (client: Client, method: string, url: string, body?: unknown, status = 200): Promise<FixtureValue> => {
    const reply = await client.request(method, url, body);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    return reply.body;
  };
  const rows = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0];
  const share = (calendarId: string, permission: string | null) => call(blair, 'PUT', `/api/calendar/calendars/${calendarId}/shares`, { principal: { kind: 'user', id: ids.manager }, permission });
  const pass = async () => { for (;;) { if (!('skipped' in await notifications.processNotificationJobs())) return; await new Promise(resolve => setTimeout(resolve, 50)); } };
  const sentTo = (endpoint: string, kind: string) => pushed.filter(item => item.endpoint === endpoint && item.payload.kind === kind).map(item => item.payload);
  const endpoints: Record<string, string> = {};
  for (const [name, client] of [['alex', alex], ['blair', blair], ['casey', casey]] as const) {
    endpoints[name] = `https://fcm.googleapis.com/fcm/send/shared-calendar-${name}`;
    const ecdh = crypto.createECDH('prime256v1');
    await call(client, 'POST', '/api/notifications/subscription', { subscription: { endpoint: endpoints[name], keys: { p256dh: ecdh.generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } } });
  }

  const account = (await call(blair, 'GET', '/api/calendar/calendars')).calendars[0].account_id;
  const team = (await call(blair, 'POST', '/api/calendar/calendars', { account_id: account, name: 'Team' })).calendar;
  const busy = (await call(blair, 'POST', '/api/calendar/calendars', { account_id: account, name: 'Doctor' })).calendar;
  const unshared = (await call(blair, 'POST', '/api/calendar/calendars', { account_id: account, name: 'Diary' })).calendar;
  const soon = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString();
  const add = (calendarId: string, title: string, extra: Record<string, unknown> = {}) => call(blair, 'POST', '/api/calendar/events',
    { title, start_time: soon(5), end_time: soon(65), calendar_id: calendarId, ...extra }).then(answer => answer.event);
  const standup = await add(team.id, 'Planning standup', { reminders: [10] });
  await add(busy.id, 'Planning appointment');
  await add(busy.id, 'Planning paperwork', { is_todo_only: true });
  await add(unshared.id, 'Planning diary');
  await share(team.id, 'read');
  await share(busy.id, 'freebusy');

  // ── Reminders are each person's: Blair has the event's, Alex his own, nobody else any ──
  await call(alex, 'PUT', `/api/calendar/events/${standup.id}`, { reminders: [10] });
  await pass();
  assert.equal(sentTo(endpoints.blair, 'reminder').length, 1, 'the owner has the event\'s reminder');
  assert.deepEqual(sentTo(endpoints.alex, 'reminder').map(payload => payload.title), ['Planning standup'], 'Alex his own');
  assert.deepEqual(sentTo(endpoints.casey, 'reminder'), []);
  // A reminder of a person whose share ended is not sent.
  const review = await add(team.id, 'Planning review');
  await call(alex, 'PUT', `/api/calendar/events/${review.id}`, { reminders: [10] });
  await share(team.id, null);
  await pass();
  assert.ok(!sentTo(endpoints.alex, 'reminder').some(payload => payload.eventId === review.id), 'not after the share ended');
  assert.deepEqual(await rows('SELECT user_id FROM calendar_reminders WHERE event_id = ?', [review.id]).then(found => found.map(row => row.user_id)), [ids.manager],
    'nothing is deleted at revocation');

  // ── Change notifications: only who switched them on, never the actor, one per event in ten minutes ──
  await share(team.id, 'edit');
  await call(alex, 'PUT', `/api/calendar/events/${standup.id}`, { title: 'Planning standup 1' });
  assert.equal((await rows("SELECT COUNT(*) AS n FROM notification_events WHERE kind = 'calendar-change'"))[0].n, 0, 'off by default');
  await call(blair, 'PUT', `/api/calendar/calendars/${team.id}/view`, { notify_changes: true });
  await call(alex, 'PUT', `/api/calendar/calendars/${team.id}/view`, { notify_changes: true });
  await call(alex, 'PUT', `/api/calendar/events/${standup.id}`, { title: 'Planning standup 2' });
  await call(alex, 'POST', `/api/calendar/events/${standup.id}/subtasks`, { title: 'Agenda' });
  await pass();
  assert.deepEqual(sentTo(endpoints.blair, 'calendar-change').map(payload => payload.body), ['Alex Manager changed Planning standup 2'], 'once, with the name and title');
  assert.deepEqual(sentTo(endpoints.alex, 'calendar-change'), [], 'never to the actor');
  // At the detail none: no name, no title.
  await call(blair, 'PUT', '/api/settings/values', { values: { reminder_notification_detail: 'none' } });
  await call(alex, 'POST', '/api/calendar/events', { title: 'Planning retro', start_time: soon(120), end_time: soon(180), calendar_id: team.id });
  await pass();
  assert.deepEqual(sentTo(endpoints.blair, 'calendar-change').slice(1).map(payload => [payload.title, payload.body]), [['A shared calendar changed', '']]);
  // A queued notice to a person whose share ends is not sent.
  await call(blair, 'PUT', `/api/calendar/events/${standup.id}`, { title: 'Planning standup 3' });
  assert.equal((await rows("SELECT COUNT(*) AS n FROM notification_events WHERE kind = 'calendar-change' AND user_id = ?", [ids.manager]))[0].n, 1, 'queued for Alex');
  await share(team.id, null);
  await pass();
  assert.deepEqual(sentTo(endpoints.alex, 'calendar-change'), [], 'not sent after the share ended');
  assert.deepEqual((await rows(`SELECT d.status FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
    WHERE e.kind = 'calendar-change' AND e.user_id = ?`, [ids.manager])).map(row => row.status), ['cancelled']);

  // ── Offline and search: exactly the calendars Alex reaches; free/busy as "Busy" without tasks ──
  await share(team.id, 'read');
  const { snapshot } = await call(alex, 'GET', '/api/offline/snapshot');
  const shown = (calendarId: string) => snapshot.events.filter((event: FixtureValue) => event.calendar_id === calendarId).map((event: FixtureValue) => event.title).sort();
  assert.deepEqual([shown(team.id), shown(busy.id), shown(unshared.id)],
    [['Planning retro', 'Planning review', 'Planning standup 3'], ['Busy'], []]);
  assert.deepEqual(snapshot.calendars.filter((calendar: FixtureValue) => calendar.user_id === ids.member).map((calendar: FixtureValue) => [calendar.name, calendar.permission, calendar.auto_todo_enabled]).sort(),
    [['Doctor', 'freebusy', false], ['Team', 'read', true]]);
  const found = (await call(alex, 'GET', '/api/search?q=Planning')).results.map((result: FixtureValue) => result.title).sort();
  assert.deepEqual(found, ['Planning retro', 'Planning review', 'Planning standup 3'], 'search leaves free/busy and unshared calendars out');
  const todo = (await call(alex, 'GET', '/api/calendar/events?include_todos=true&respect_auto_todo=true')).events;
  assert.ok(!todo.some((event: FixtureValue) => event.calendar_id === busy.id), 'ToDo shows no task of a free/busy calendar');
  await share(busy.id, null);
  const later = (await call(alex, 'GET', '/api/offline/snapshot')).snapshot;
  assert.ok(!later.events.some((event: FixtureValue) => event.calendar_id === busy.id) && !later.calendars.some((calendar: FixtureValue) => calendar.id === busy.id), 'gone from the next copy');

  // ── Each person keeps their own order of a shared list ──
  const tasks = (await call(alex, 'GET', '/api/calendar/events?include_todos=true&respect_auto_todo=true')).events
    .filter((event: FixtureValue) => event.calendar_id === team.id).sort((a: FixtureValue, b: FixtureValue) => a.sort_rank - b.sort_rank);
  const [top, , last] = tasks;
  await call(alex, 'PUT', `/api/calendar/events/${last.id}/position`, { before: top.id, after: null });
  const ordered = async (client: Client) => (await call(client, 'GET', '/api/calendar/events?include_todos=true&respect_auto_todo=true')).events
    .filter((event: FixtureValue) => event.calendar_id === team.id).sort((a: FixtureValue, b: FixtureValue) => a.sort_rank - b.sort_rank).map((event: FixtureValue) => event.id);
  assert.equal((await ordered(alex))[0], last.id, 'Alex placed it first');
  assert.equal((await ordered(blair))[0], top.id, 'Blair\'s order is her own');
});
