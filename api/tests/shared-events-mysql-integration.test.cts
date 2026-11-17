import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// Writes to calendars others share, through the real request handler with
// the shared people: Alex writes in Blair's calendar as an editor, then as a
// contributor (only the points he added are his) and as a reader (his own
// reminders only); Casey and Drew reach nothing; a share removed while a
// write waits for the calendar, the owner's calendar restore and an archived
// calendar stop the write inside its transaction; an event moves only
// between calendars of the same owner; in Support's calendar the rows have
// no owner and members add their own points.
test('shared events: levels, contributors own their points, the guard inside the transaction, moves and group calendars', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, groups, clients } = await seedPeople(t, pool);
  const { manager: alex, member: blair, stranger: casey, revoked: drew } = clients;
  type Client = typeof alex;
  const call = async (client: Client, method: string, url: string, body?: unknown, status = 200): Promise<FixtureValue> => {
    const reply = await client.request(method, url, body);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    return reply.body;
  };
  const refused = async (client: Client, method: string, url: string, body?: unknown) => {
    const reply = await client.request(method, url, body);
    return [reply.status, reply.body.code ?? null];
  };
  const row = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0][0];
  const share = (calendarId: string, permission: string | null) => call(blair, 'PUT', `/api/calendar/calendars/${calendarId}/shares`, { principal: { kind: 'user', id: ids.manager }, permission });

  const account = (await call(blair, 'GET', '/api/calendar/calendars')).calendars[0].account_id;
  const team = (await call(blair, 'POST', '/api/calendar/calendars', { account_id: account, name: 'Team' })).calendar;
  const meeting = (await call(blair, 'POST', '/api/calendar/events', { title: 'Planning', start_time: '2031-03-04T09:00:00Z', end_time: '2031-03-04T10:00:00Z',
    calendar_id: team.id, reminders: [15] })).event;
  const blairsPoint = (await call(blair, 'POST', `/api/calendar/events/${meeting.id}/subtasks`, { title: 'Bring numbers' })).subtask;
  const ev = (id: string, rest = '') => `/api/calendar/events/${id}${rest}`;

  // ── An editor creates, changes, ticks, adds points and deletes; the rows stay Blair's ──
  await share(team.id, 'edit');
  const added = (await call(alex, 'POST', '/api/calendar/events', { title: 'Order paper', is_todo_only: true, calendar_id: team.id, reminders: [60] })).event;
  assert.deepEqual([(await row('SELECT user_id, reminders FROM calendar_events WHERE id = ?', [added.id])).user_id, added.reminders], [ids.member, [60]],
    'the row is the owner\'s; the creator\'s reminder is their own');
  assert.equal((await row('SELECT reminders FROM calendar_events WHERE id = ?', [added.id])).reminders, null);
  assert.equal((await call(alex, 'PUT', ev(meeting.id), { title: 'Planning 2031' })).event.title, 'Planning 2031');
  assert.equal((await call(alex, 'PUT', ev(added.id, '/todo-status'), { todo_status: 'done' })).event.todo_status, 'done');
  const alexPoint = (await call(alex, 'POST', ev(meeting.id, '/subtasks'), { title: 'Room booked' })).subtask;
  assert.deepEqual([alexPoint.created_by, alexPoint.created_by_name, (await row('SELECT user_id FROM calendar_event_subtasks WHERE id = ?', [alexPoint.id])).user_id],
    [ids.manager, 'Alex Manager', ids.member]);
  await call(alex, 'DELETE', ev(added.id));
  assert.equal(await row('SELECT id FROM calendar_events WHERE id = ?', [added.id]), undefined);
  assert.deepEqual((await call(blair, 'GET', ev(meeting.id))).event.reminders, [15], 'the owner keeps the event\'s reminders');

  // ── A contributor adds, changes, ticks and removes only the points they added ──
  await share(team.id, 'contribute');
  const mine = (await call(alex, 'POST', ev(meeting.id, '/subtasks'), { title: 'Agenda: hiring', position: 0 })).subtask;
  assert.equal(mine.position, 2, 'a contributor adds at the end');
  assert.deepEqual([(await call(alex, 'PUT', ev(meeting.id, `/subtasks/${mine.id}`), { title: 'Agenda: hiring plan', is_done: true })).subtask.is_done], [true]);
  for (const [method, url, body] of [
    ['PUT', ev(meeting.id, `/subtasks/${blairsPoint.id}`), { is_done: true }], ['DELETE', ev(meeting.id, `/subtasks/${blairsPoint.id}`)],
    ['PUT', ev(meeting.id, `/subtasks/${mine.id}`), { position: 0 }], ['POST', ev(meeting.id, '/subtasks/reorder'), { subtask_ids: [mine.id, blairsPoint.id, alexPoint.id] }],
    ['PUT', ev(meeting.id), { title: 'Mine now' }], ['PUT', ev(meeting.id), { start_time: '2031-03-04T11:00:00Z', end_time: '2031-03-04T12:00:00Z' }],
    ['PUT', ev(meeting.id, '/todo-status'), { todo_status: 'done' }], ['DELETE', ev(meeting.id)],
    ['POST', '/api/calendar/events', { title: 'New', start_time: '2031-03-05T09:00:00Z', end_time: '2031-03-05T10:00:00Z', calendar_id: team.id }],
  ] as const) {
    assert.deepEqual(await refused(alex, method, url, body), [403, 'CALENDAR_FORBIDDEN'], `contribute: ${method} ${url} ${JSON.stringify(body ?? '')}`);
  }
  await call(alex, 'DELETE', ev(meeting.id, `/subtasks/${mine.id}`));
  const after = (await call(blair, 'GET', ev(meeting.id))).event;
  assert.deepEqual([after.title, after.start_time, after.todo_status, after.subtasks.map((point: FixtureValue) => [point.title, point.is_done])],
    ['Planning 2031', '2031-03-04T09:00:00.000Z', null, [['Bring numbers', false], ['Room booked', false]]]);

  // ── A reader sets only their own reminders ──
  await share(team.id, 'read');
  assert.deepEqual(await refused(alex, 'POST', ev(meeting.id, '/subtasks'), { title: 'Late point' }), [403, 'CALENDAR_FORBIDDEN']);
  assert.deepEqual((await call(alex, 'PUT', ev(meeting.id), { reminders: [5, 30] })).event.reminders, [5, 30]);
  assert.deepEqual([(await call(blair, 'GET', ev(meeting.id))).event.reminders, (await call(alex, 'GET', ev(meeting.id))).event.reminders], [[15], [5, 30]]);
  assert.deepEqual(await refused(alex, 'PUT', ev(meeting.id), { reminders: [10], title: 'With a title' }), [403, 'CALENDAR_FORBIDDEN']);

  // ── Casey and Drew (removed from Support) reach nothing; a delete changes nothing ──
  await call(blair, 'PUT', `/api/calendar/calendars/${team.id}/shares`, { principal: { kind: 'group', id: groups.support }, permission: 'edit' });
  for (const [name, client] of [['Casey', casey], ['Drew', drew]] as const) {
    for (const [method, url, body] of [['PUT', ev(meeting.id), { title: 'X' }], ['PUT', ev(meeting.id, '/todo-status'), { todo_status: 'done' }],
      ['POST', ev(meeting.id, '/subtasks'), { title: 'X' }], ['PUT', ev(meeting.id, `/subtasks/${blairsPoint.id}`), { is_done: true }], ['GET', ev(meeting.id, '/subtasks')]] as const) {
      assert.equal((await client.request(method, url, body)).status, 404, `${name}: ${method} ${url}`);
    }
    assert.deepEqual((await call(client, 'DELETE', ev(meeting.id))).bin_item_ids, []);
  }
  assert.ok(await row('SELECT id FROM calendar_events WHERE id = ?', [meeting.id]));
  await call(blair, 'PUT', `/api/calendar/calendars/${team.id}/shares`, { principal: { kind: 'group', id: groups.support }, permission: null });

  // ── A share removed while the write waits for the calendar: refused inside its transaction ──
  await share(team.id, 'edit');
  const holder = await pool.getConnection();
  try {
    await holder.beginTransaction();
    await holder.query('SELECT id FROM calendar_calendars WHERE id = ? FOR UPDATE', [team.id]);
    await holder.query("DELETE FROM grants WHERE resource_kind = 'calendar' AND resource_id = ? AND principal_id = ?", [team.id, ids.manager]);
    const waiting = alex.request('PUT', ev(meeting.id), { title: 'Too late' });
    await new Promise(resolve => setTimeout(resolve, 700));
    await holder.commit();
    const reply = await waiting;
    assert.deepEqual([reply.status, reply.body.code], [404, 'CALENDAR_NOT_FOUND']);
  } finally { holder.release(); }
  assert.equal((await row('SELECT title FROM calendar_events WHERE id = ?', [meeting.id])).title, 'Planning 2031');

  // ── The owner's calendar restore and an archived calendar stop every write, the owner's too ──
  await share(team.id, 'edit');
  const restoreJob = crypto.randomUUID();
  await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '["calendar"]')`, [restoreJob, ids.member]);
  assert.deepEqual(await refused(alex, 'PUT', ev(meeting.id), { title: 'During restore' }), [409, 'RESTORE_IN_PROGRESS']);
  assert.deepEqual(await refused(alex, 'POST', ev(meeting.id, '/subtasks'), { title: 'During restore' }), [409, 'RESTORE_IN_PROGRESS']);
  await pool.execute("UPDATE backup_restore_jobs SET status = 'completed' WHERE id = ?", [restoreJob]);
  await pool.execute('UPDATE calendar_calendars SET archived_at = UTC_TIMESTAMP() WHERE id = ?', [team.id]);
  for (const client of [alex, blair]) {
    assert.deepEqual(await refused(client, 'PUT', ev(meeting.id), { title: 'Archived' }), [403, 'CALENDAR_FORBIDDEN']);
    assert.deepEqual(await refused(client, 'DELETE', ev(meeting.id)), [403, 'CALENDAR_FORBIDDEN']);
  }
  assert.deepEqual(await refused(blair, 'POST', ev(meeting.id, '/subtasks'), { title: 'Archived' }), [403, 'CALENDAR_FORBIDDEN']);
  await pool.execute('UPDATE calendar_calendars SET archived_at = NULL WHERE id = ?', [team.id]);

  // ── Moves only between calendars of the same owner ──
  const alexOwn = (await call(alex, 'GET', '/api/calendar/calendars')).calendars.find((calendar: FixtureValue) => calendar.user_id === ids.manager).id;
  const other = (await call(blair, 'POST', '/api/calendar/calendars', { account_id: account, name: 'Other' })).calendar;
  await share(other.id, 'edit');
  assert.deepEqual(await refused(alex, 'PUT', ev(meeting.id), { calendar_id: alexOwn }), [409, 'CALENDAR_MOVE_SHARED']);
  const own = (await call(alex, 'POST', '/api/calendar/events', { title: 'Mine', start_time: '2031-03-06T09:00:00Z', end_time: '2031-03-06T10:00:00Z', calendar_id: alexOwn })).event;
  assert.deepEqual(await refused(alex, 'PUT', ev(own.id), { calendar_id: team.id }), [409, 'CALENDAR_MOVE_SHARED']);
  assert.equal((await call(alex, 'PUT', ev(meeting.id), { calendar_id: other.id })).event.calendar_id, other.id);
  assert.deepEqual([(await row('SELECT user_id, calendar_id FROM calendar_events WHERE id = ?', [meeting.id]))].map(item => [item.user_id, item.calendar_id]), [[ids.member, other.id]]);

  // ── Support's calendar: rows without an owner, members add their own points, the manager edits ──
  const support = (await call(alex, 'POST', '/api/calendar/shared-calendars', { name: 'Support desk', group_id: groups.support })).calendar;
  assert.deepEqual(await refused(blair, 'POST', '/api/calendar/events', { title: 'Party', start_time: '2031-04-01T09:00:00Z', end_time: '2031-04-01T10:00:00Z', calendar_id: support.id }),
    [403, 'CALENDAR_FORBIDDEN']);
  const rota = (await call(alex, 'POST', '/api/calendar/events', { title: 'Rota', start_time: '2031-04-01T09:00:00Z', end_time: '2031-04-01T10:00:00Z', calendar_id: support.id })).event;
  assert.equal((await row('SELECT user_id FROM calendar_events WHERE id = ?', [rota.id])).user_id, null);
  const cover = (await call(blair, 'POST', ev(rota.id, '/subtasks'), { title: 'Cover Friday' })).subtask;
  assert.deepEqual([cover.created_by, (await row('SELECT user_id FROM calendar_event_subtasks WHERE id = ?', [cover.id])).user_id], [ids.member, null]);
  assert.equal((await call(alex, 'PUT', ev(rota.id, `/subtasks/${cover.id}`), { is_done: true })).subtask.is_done, true);
  assert.deepEqual(await refused(blair, 'PUT', ev(rota.id), { title: 'Moved' }), [403, 'CALENDAR_FORBIDDEN']);
  assert.deepEqual(await refused(casey, 'POST', ev(rota.id, '/subtasks'), { title: 'Not mine' }), [404, null]);

  // ── Blair's own events through the same guard: a synced event keeps its calendar; a driver error answers the route's own message ──
  const [synced, syncedCalendar, linked] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await pool.execute("INSERT INTO calendar_accounts (id, user_id, provider, display_name, is_active) VALUES (?, ?, 'caldav', 'Provider', TRUE)", [synced, ids.member]);
  await pool.execute("INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id) VALUES (?, ?, ?, 'Synced', '/dav/cal/')", [syncedCalendar, ids.member, synced]);
  await pool.execute("INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time) VALUES (?, ?, ?, 'Linked', '2031-05-01 09:00:00', '2031-05-01 10:00:00')",
    [linked, ids.member, syncedCalendar]);
  await pool.execute("INSERT INTO calendar_event_external_refs (id, user_id, event_id, calendar_id, account_id, provider, external_event_id) VALUES (UUID(), ?, ?, ?, ?, 'caldav', 'linked-uid')",
    [ids.member, linked, syncedCalendar, synced]);
  const detach = await blair.request('PUT', ev(linked), { calendar_id: null });
  assert.deepEqual([detach.status, /synced with a calendar server/.test(String(detach.body.error))], [400, true]);
  assert.equal((await row('SELECT calendar_id FROM calendar_events WHERE id = ?', [linked])).calendar_id, syncedCalendar, 'a refused detach writes nothing');
  await pool.execute('DELETE FROM calendar_event_external_refs WHERE event_id = ?', [linked]);
  assert.equal((await call(blair, 'PUT', ev(linked), { calendar_id: null })).event.calendar_id, null, 'an unlinked event can be detached');
  const tooLong = await blair.request('PUT', ev(meeting.id), { title: 'x'.repeat(300) });
  assert.deepEqual([tooLong.status, tooLong.body.error], [500, 'Failed to update event'], 'never the driver message');
});
