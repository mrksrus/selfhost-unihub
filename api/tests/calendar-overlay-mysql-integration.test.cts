import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { installCalDavFake, insertCalDavAccount, eventIcs, WORK } = require('./helpers/caldav-fake.cts');

// The synced-task overlay (0.28 stream B): the ToDo state, done time, source
// email and subtasks UniHub keeps on a task of a CalDAV calendar wait in
// calendar_overlay_restores after a restore, and the sync that creates the
// task's row takes them, once, by the exact UID (two UIDs that differ only in
// case are two items), by recurrence id, or by title and start for an archive
// without UIDs. Never for a stranger's calendar, gone with the calendar,
// nothing while the module is off or a calendar restore runs. Moves keep the
// task's UID. Through the real request handler, MariaDB and a fake CalDAV peer.
test('synced tasks keep their own state through a restore and the first sync, by exact identity', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const caldav = require('../dist/src/services/caldav');
  const server = installCalDavFake(caldav);
  const calendarSync = require('../dist/src/services/calendar-sync') as typeof import('../src/services/calendar-sync');
  const overlays = require('../dist/src/services/calendar-overlays') as typeof import('../src/services/calendar-overlays');
  const { encrypt } = require('../dist/src/security/encryption') as typeof import('../src/security/encryption');
  const password = 'synthetic-overlay-password';
  const passwordHash = await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4);
  const users: Record<string, string> = {};
  for (const name of ['owner', 'stranger']) {
    users[name] = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)', [users[name], `${name}@example.test`, passwordHash, name]);
  }
  const owner = api.client();
  assert.equal((await owner.request('POST', '/api/auth/signin', { email: 'owner@example.test', password })).status, 200);
  const call = async (method: string, path: string, body?: unknown, status = 200): Promise<FixtureValue> => {
    const reply = await owner.request(method, path, body);
    assert.equal(reply.status, status, `${method} ${path}: ${JSON.stringify(reply.body).slice(0, 400)}`);
    return reply.body;
  };

  const accountId = crypto.randomUUID();
  await insertCalDavAccount(pool, encrypt, users.owner, accountId);
  const sync = () => calendarSync.syncCalendarAccount(accountId, { userId: users.owner, full: true });
  await sync();
  const [[{ id: work }]] = await pool.query<RowDataPacket[]>("SELECT id FROM calendar_calendars WHERE account_id = ? AND name = 'Work'", [accountId]);
  let clock = Date.UTC(2026, 10, 10, 9);
  const at = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const state = (title: string, subtasks: string[] = []) => ({
    todo_status: 'done', done_at: '2026-11-01 08:00:00', source_email_id: crypto.randomUUID(),
    source_email_json: { subject: `About ${title}`, from_address: 'sender@example.test' },
    subtasks: subtasks.map((subtask, position) => ({ title: subtask, is_done: position === 0, position })),
    // UniHub's reply to an invitation: never written to the server, so it travels in the overlay.
    attendees: [{ email: 'guest@example.test', display_name: 'Guest', response_status: 'accepted', is_organizer: false, optional_attendee: false, comment: `On ${title}` }],
  });
  const rowOf = async (title: string) => (await pool.query<RowDataPacket[]>('SELECT * FROM calendar_events WHERE user_id = ? AND title = ?', [users.owner, title]))[0];
  const subtasksOf = async (eventId: string) => (await pool.query<RowDataPacket[]>('SELECT title, is_done FROM calendar_event_subtasks WHERE event_id = ? ORDER BY position', [eventId]))[0]
    .map(row => [row.title, !!row.is_done]);
  const attendeesOf = async (eventId: string) => (await pool.query<RowDataPacket[]>('SELECT email, response_status, comment FROM calendar_event_attendees WHERE event_id = ? ORDER BY email', [eventId]))[0]
    .map(row => [row.email, row.response_status, row.comment]);
  const pending = async () => Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM calendar_overlay_restores WHERE user_id = ?', [users.owner]))[0][0].n);
  const write = async (rows: FixtureValue[]) => {
    const cx = await pool.getConnection();
    try { return await overlays.insertOverlays(cx, rows); } finally { cx.release(); }
  };

  await t.test('the first sync after a restore gives a new row its state, once, by exact UID', async () => {
    // Two items whose UIDs differ only in case; only one had state in the archive.
    clock += 86400000;
    server.store(`${WORK}upper.ics`, eventIcs('Task-A@example.test', 'Upper task', clock));
    server.store(`${WORK}lower.ics`, eventIcs('task-a@example.test', 'Lower task', clock + 3600000));
    assert.equal(await write([{ userId: users.owner, calendarId: work, uid: 'Task-A@example.test', recurrenceId: '', state: state('Upper task', ['Draft', 'Send']) }]), 1);
    // A stranger's overlay for the owner's calendar is refused.
    assert.equal(await write([{ userId: users.stranger, calendarId: work, uid: 'task-a@example.test', recurrenceId: '', state: state('Lower task') }]), 0);
    await sync();
    const [upper] = await rowOf('Upper task');
    const [lower] = await rowOf('Lower task');
    assert.equal(upper.uid, 'Task-A@example.test', 'a new synced row takes its iCal UID');
    assert.equal(lower.uid, 'task-a@example.test');
    assert.equal(upper.todo_status, 'done');
    assert.equal(at(upper.done_at), '2026-11-01 08:00:00');
    assert.equal(upper.source_email_id, null, 'an email the person does not have is not linked');
    assert.equal((typeof upper.source_email_json === 'string' ? JSON.parse(upper.source_email_json) : upper.source_email_json).subject, 'About Upper task');
    assert.deepEqual(await subtasksOf(upper.id), [['Draft', true], ['Send', false]]);
    assert.deepEqual(await attendeesOf(upper.id), [['guest@example.test', 'accepted', 'On Upper task']], 'the reply comes back with the item');
    assert.deepEqual((await overlays.overlayStateOf(pool, users.owner, upper.id))!.attendees.map(row => row.email), ['guest@example.test'], 'and a backup takes it again');
    assert.equal(lower.todo_status, null, 'a UID differing only in case is another item');
    assert.deepEqual(await subtasksOf(lower.id), []);
    assert.deepEqual(await attendeesOf(lower.id), []);
    assert.equal(await pending(), 0, 'taken by the sync');
    // Applied once: a later change in UniHub stands through more syncs.
    await call('PUT', `/api/calendar/events/${upper.id}/todo-status`, { todo_status: null });
    await sync();
    assert.equal((await rowOf('Upper task'))[0].todo_status, null);
    assert.deepEqual(await subtasksOf(upper.id), [['Draft', true], ['Send', false]]);
  });

  await t.test('a task with more subtasks than 500 keeps every one, to its row and back out', async () => {
    clock += 86400000;
    const uid = `${crypto.randomUUID()}@example.test`;
    server.store(`${WORK}long-list.ics`, eventIcs(uid, 'Long list', clock));
    const steps = Array.from({ length: 501 }, (_, index) => `Step ${index + 1}`);
    assert.equal(await write([{ userId: users.owner, calendarId: work, uid, recurrenceId: '', state: state('Long list', steps) }]), 1);
    await sync();
    const [row] = await rowOf('Long list');
    const kept = await subtasksOf(row.id);
    assert.equal(kept.length, 501, 'the 501st as well');
    assert.deepEqual(kept.at(-1), ['Step 501', false]);
    // What a backup or the bin takes of the row: every subtask again.
    assert.equal((await overlays.overlayStateOf(pool, users.owner, row.id))!.subtasks.length, 501);
  });

  await t.test('a state its tables cannot hold never stops the sync; one they can is written as it is', async () => {
    clock += 86400000;
    const [bad, good] = [`${crypto.randomUUID()}@example.test`, `${crypto.randomUUID()}@example.test`];
    server.store(`${WORK}padded-bad.ics`, eventIcs(bad, 'Padded too long', clock));
    server.store(`${WORK}padded-good.ics`, eventIcs(good, 'Padded to fit', clock + 3600000));
    const fits = ` ${'x'.repeat(254)}`;
    const spaced = { ...state('Padded to fit', [fits]), attendees: [{ ...state('').attendees[0], display_name: ' Guest ', comment: '  as it is  ' }] };
    // Past validation, as a state written before it was checked would be: one character more than the column holds.
    assert.equal(await write([
      { userId: users.owner, calendarId: work, uid: bad, recurrenceId: '', state: state('Padded too long', [` ${'x'.repeat(255)}`]) },
      { userId: users.owner, calendarId: work, uid: good, recurrenceId: '', state: spaced },
    ]), 2);
    for (let round = 0; round < 2; round++) await sync();
    const [badRow] = await rowOf('Padded too long');
    assert.ok(badRow, 'the provider item arrives');
    assert.equal(badRow.todo_status, null);
    assert.deepEqual(await subtasksOf(badRow.id), []);
    const [goodRow] = await rowOf('Padded to fit');
    assert.deepEqual(await subtasksOf(goodRow.id), [[fits, true]], 'a title of exactly 255 characters, its space kept');
    const [[guest]] = await pool.query<RowDataPacket[]>('SELECT display_name, comment FROM calendar_event_attendees WHERE event_id = ?', [goodRow.id]);
    assert.deepEqual([guest.display_name, guest.comment], [' Guest ', '  as it is  '], 'name and reply as the overlay has them');
    assert.equal(await pending(), 0);
  });

  await t.test('a recurring task keys each date by its recurrence id; an archive without UIDs matches by title and start', async () => {
    clock += 86400000 * 3;
    const start = clock;
    server.store(`${WORK}weekly.ics`, eventIcs('weekly@example.test', 'Weekly review', start, ['RRULE:FREQ=WEEKLY;COUNT=3']));
    clock += 86400000;
    server.store(`${WORK}shape.ics`, eventIcs('shape@example.test', 'Old archive task', clock));
    const secondDate = new Date(start + 7 * 86400000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    await write([
      { userId: users.owner, calendarId: work, uid: 'weekly@example.test', recurrenceId: secondDate, state: state('Weekly review', ['Second week']) },
      { userId: users.owner, calendarId: work, uid: '', recurrenceId: '', matchKind: 'shape', shape: { title: 'Old archive task', start: at(clock) },
        expiresAt: at(Date.now() + 30 * 86400000), state: state('Old archive task') },
    ]);
    await sync();
    const weeks = (await pool.query<RowDataPacket[]>(
      `SELECT e.id, e.todo_status, r.recurrence_id FROM calendar_events e JOIN calendar_event_external_refs r ON r.event_id = e.id
       WHERE e.user_id = ? AND e.title = 'Weekly review' ORDER BY e.start_time`, [users.owner]))[0];
    assert.equal(weeks.length, 3);
    assert.deepEqual(weeks.map(week => week.todo_status), [null, 'done', null], `only ${secondDate} was done`);
    assert.deepEqual(await subtasksOf(weeks[1].id), [['Second week', true]]);
    assert.equal((await rowOf('Old archive task'))[0].todo_status, 'done', 'matched by title and start');
    assert.equal(await pending(), 0);
  });

  await t.test('UIDs that differ only by a trailing space are two items, kept as the server has them', async () => {
    clock += 86400000;
    server.store(`${WORK}plain-uid.ics`, eventIcs('space@example.test', 'Plain UID', clock));
    server.store(`${WORK}spaced-uid.ics`, eventIcs('space@example.test ', 'Spaced UID', clock + 3600000));
    await write([{ userId: users.owner, calendarId: work, uid: 'space@example.test ', recurrenceId: '', state: state('Spaced UID', ['Spaced step']) }]);
    await sync();
    const [plain] = await rowOf('Plain UID');
    const [spaced] = await rowOf('Spaced UID');
    assert.deepEqual([plain.uid, spaced.uid], ['space@example.test', 'space@example.test '], 'the UIDs as the server has them');
    assert.deepEqual([plain.todo_status, spaced.todo_status], [null, 'done'], 'the overlay went to its own item');
    assert.deepEqual(await subtasksOf(spaced.id), [['Spaced step', true]]);
    const stored = (await pool.query<RowDataPacket[]>(`SELECT uid FROM calendar_remote_objects WHERE calendar_id = ? AND uid LIKE 'space@%' ORDER BY uid`, [work]))[0].map(row => row.uid);
    assert.deepEqual(stored.sort(), ['space@example.test', 'space@example.test '].sort());
  });

  await t.test('an archive without UIDs: a title and start two tasks share matches neither, until it is the only one', async () => {
    clock += 86400000;
    const start = clock;
    server.store(`${WORK}twin-a.ics`, eventIcs('twin-a@example.test', 'Twin task', start));
    server.store(`${WORK}twin-b.ics`, eventIcs('twin-b@example.test', 'Twin task', start));
    await write([{ userId: users.owner, calendarId: work, uid: '', recurrenceId: '', matchKind: 'shape', shape: { title: 'Twin task', start: at(start) },
      expiresAt: at(Date.now() + 30 * 86400000), state: state('Twin task') }]);
    // The first sync makes both rows: whichever comes first is not the match.
    await sync();
    assert.deepEqual((await rowOf('Twin task')).map(row => row.todo_status), [null, null]);
    const cx = await pool.getConnection();
    try { assert.equal(await overlays.applyOverlaysToLiveRows(cx, users.owner, { calendarIds: [work] }), 0, 'nor when applied to the live rows'); } finally { cx.release(); }
    assert.equal(await pending(), 1, 'it waits');
    // One of them is gone: the match is the only one now.
    server.remote.objects.delete(`${WORK}twin-b.ics`);
    await sync();
    assert.deepEqual((await rowOf('Twin task')).map(row => row.todo_status), ['done']);
    assert.equal(await pending(), 0);
  });

  await t.test('an overlay whose item exists already is applied at once; one waits while its item is not back', async () => {
    const [lower] = await rowOf('Lower task');
    const cx = await pool.getConnection();
    try {
      await overlays.insertOverlays(cx, [
        { userId: users.owner, calendarId: work, uid: 'task-a@example.test', recurrenceId: '', state: state('Lower task', ['Live']) },
        { userId: users.owner, calendarId: work, uid: 'not-yet@example.test', recurrenceId: '', state: state('Later') },
      ]);
      assert.equal(await overlays.applyOverlaysToLiveRows(cx, users.owner, { calendarIds: [work] }), 1);
    } finally { cx.release(); }
    assert.equal((await rowOf('Lower task'))[0].todo_status, 'done');
    assert.deepEqual(await subtasksOf(lower.id), [['Live', true]]);
    assert.deepEqual(await attendeesOf(lower.id), [['guest@example.test', 'accepted', 'On Lower task']]);
    assert.equal(await pending(), 1, 'the other waits for its item');
  });

  await t.test('nothing is applied while the module is off or a calendar restore runs; an overlay goes with its calendar', async () => {
    clock += 86400000;
    server.store(`${WORK}not-yet.ics`, eventIcs('not-yet@example.test', 'Later', clock));
    await call('PUT', '/api/modules', { modules: { calendar: { enabled: false } } });
    await sync().catch(() => undefined);
    assert.equal((await rowOf('Later')).length, 0, 'no sync while the module is off');
    await call('PUT', '/api/modules', { modules: { calendar: { enabled: true } } });
    const restoreId = crypto.randomUUID();
    await pool.execute("INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '[\"calendar\"]')", [restoreId, users.owner]);
    await sync().catch(() => undefined);
    assert.equal((await rowOf('Later')).length, 0, 'no sync while the calendar is restored');
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreId]);
    assert.equal(await pending(), 1);
    // The calendar removed: the overlay goes with it.
    const [[local]] = await pool.query<RowDataPacket[]>("SELECT c.id FROM calendar_calendars c JOIN calendar_accounts a ON a.id = c.account_id WHERE c.user_id = ? AND a.provider = 'caldav' AND c.name = 'Shared'", [users.owner]);
    await write([{ userId: users.owner, calendarId: local.id, uid: 'elsewhere@example.test', recurrenceId: '', state: state('Elsewhere') }]);
    assert.equal(await pending(), 2);
    await pool.execute('DELETE FROM calendar_calendars WHERE id = ?', [local.id]);
    assert.equal(await pending(), 1);
    await sync();
    assert.equal((await rowOf('Later'))[0].todo_status, 'done', 'applied by the first sync after the restore');
    assert.equal(await pending(), 0);
  });

  await t.test('a move keeps the item\'s UID: a UniHub task sent to a server calendar, and a server task taken into a list', async () => {
    const { calendarId: inbox } = await (require('../dist/src/services/calendar') as typeof import('../src/services/calendar')).ensureDefaultLocalCalendarForUser(users.owner);
    clock += 86400000;
    const taskId = crypto.randomUUID();
    await pool.execute('INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time, uid) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [taskId, users.owner, inbox, 'Local to server', at(clock), at(clock + 1800000), 'Local-UID@example.test']);
    await call('POST', `/api/calendar/events/${taskId}/move`, { calendar_id: work });
    assert.equal((await rowOf('Local to server'))[0].uid, 'Local-UID@example.test');
    assert.ok(server.remote.objects.get(`${WORK}Local-UID%40example.test.ics`)?.ics.includes('UID:Local-UID@example.test') || [...server.remote.objects.values()].some(object => object.ics.includes('UID:Local-UID@example.test')),
      'the server copy carries the task\'s UID');
    // Back into the list: the server's UID stays on the row.
    await call('POST', `/api/calendar/events/${taskId}/move`, { calendar_id: inbox });
    assert.equal((await rowOf('Local to server'))[0].uid, 'Local-UID@example.test');
    // The target already holds an item with that UID (here: one differing only in case does not count).
    clock += 86400000;
    server.store(`${WORK}taken.ics`, eventIcs('Taken@example.test', 'Holder', clock));
    await sync();
    const otherId = crypto.randomUUID();
    await pool.execute('INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time, uid) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [otherId, users.owner, inbox, 'Second holder', at(clock + 7200000), at(clock + 9000000), 'Taken@example.test']);
    await call('POST', `/api/calendar/events/${otherId}/move`, { calendar_id: work });
    const moved = (await rowOf('Second holder'))[0];
    assert.notEqual(moved.uid, 'Taken@example.test', 'a UID the calendar holds is not sent twice');
    assert.match(moved.uid, /^[0-9a-f-]{36}$/, 'the new UID is recorded on the row');
  });
});
