import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// Repeating events in Blair's own calendar, through the real request
// handler: a weekly series across a daylight-saving change, one date and
// every date changed (ids, ticks and points kept), its time moved, its rule
// changed and a date deleted (both to the bin, back as single events), each
// person's reminders per series and per date, Alex as editor, contributor,
// reader and free/busy holder; a daily series extended once a day and
// deleted and restored as a whole; a personal backup with the series
// restored for another person, and its readable copy.
test('repeating local events: dates in place, one or all, the bin, levels, reminders, extension and backup', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, clients } = await seedPeople(t, pool);
  const { manager: alex, member: blair } = clients;
  type Client = typeof alex;
  const notifications = require('../dist/src/services/notifications') as typeof import('../src/services/notifications');
  const series = require('../dist/src/services/calendar-series') as typeof import('../src/services/calendar-series');
  const backup = require('../dist/src/services/backup') as typeof import('../src/services/backup');
  const { writeZip } = require('../dist/src/services/export-jobs') as typeof import('../src/services/export-jobs');
  const { calendarEntries } = require('../dist/src/services/backup-readable') as typeof import('../src/services/backup-readable');
  const call = async (client: Client, method: string, url: string, body?: unknown, status = 200): Promise<FixtureValue> => {
    const reply = await client.request(method, url, body);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    return reply.body;
  };
  const refused = async (client: Client, method: string, url: string, body?: unknown) => {
    const reply = await client.request(method, url, body);
    return [reply.status, reply.body.code ?? null];
  };
  const rows = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0];
  const share = (calendarId: string, permission: string | null) => call(blair, 'PUT', `/api/calendar/calendars/${calendarId}/shares`, { principal: { kind: 'user', id: ids.manager }, permission });
  const ev = (id: string, rest = '') => `/api/calendar/events/${id}${rest}`;
  const pass = async () => { for (;;) { if (!('skipped' in await notifications.processNotificationJobs())) return; await new Promise(resolve => setTimeout(resolve, 50)); } };

  const account = (await call(blair, 'GET', '/api/calendar/calendars')).calendars[0].account_id;
  const team = (await call(blair, 'POST', '/api/calendar/calendars', { account_id: account, name: 'Team' })).calendar;
  // Each person's view of the team calendar's events, in date order.
  const listOf = async (client: Client) => (await call(client, 'GET', `/api/calendar/events?calendar_ids=${team.id}&range_start=2000-01-01T00:00:00Z&range_end=2100-01-01T00:00:00Z`)).events as FixtureValue[];
  const datesOf = async (seriesId: string) => (await listOf(blair)).filter(event => event.series_key === seriesId);

  // The Monday before the next March change to summer time in Berlin.
  const year = new Date().getUTCFullYear() + 1;
  const change = 31 - new Date(Date.UTC(year, 2, 31)).getUTCDay();
  const at = (day: number, hour: number) => new Date(Date.UTC(year, 2, day, hour)).toISOString();
  const monday = change - 6;

  // ── A weekly series keeps 09:00 in Berlin across the change, the same instants for everyone ──
  const created = (await call(blair, 'POST', '/api/calendar/events', { title: 'Weekly sync', start_time: at(monday, 8), end_time: at(monday, 9), calendar_id: team.id,
    reminders: [15], repeat: { freq: 'WEEKLY', by_day: ['MO'], count: 4 }, time_zone: 'Europe/Berlin' })).event;
  const seriesId = created.series_key;
  assert.deepEqual([created.repeat, created.time_zone], [{ freq: 'WEEKLY', by_day: ['MO'], count: 4 }, 'Europe/Berlin']);
  assert.match(created.recurrence, /^FREQ=WEEKLY;/);
  let dates = await datesOf(seriesId);
  const [d1, d2, d3, d4] = dates.map(date => date.id as string);
  assert.equal(d1, created.id, 'the event is the first date');
  assert.deepEqual(dates.map(date => date.start_time), [at(monday, 8), at(monday + 7, 7), at(monday + 14, 7), at(monday + 21, 7)]);
  assert.deepEqual(dates.map(date => date.reminders), [[15], [15], [15], [15]], 'the series\' reminder on every date');
  await share(team.id, 'read');
  assert.deepEqual((await listOf(alex)).map(date => date.start_time), dates.map(date => date.start_time), 'a reader sees the same instants');
  assert.match((await rows('SELECT ics FROM calendar_series WHERE id = ?', [seriesId]))[0].ics, /DTSTART;TZID=Europe\/Berlin:\d{8}T090000/);

  // ── Each person's reminders: Alex's for the series, his own for one date wins; Blair keeps the event's ──
  await call(alex, 'PUT', ev(d1), { reminders: [10], scope: 'series' });
  await call(alex, 'PUT', ev(d3), { reminders: [30] });
  assert.deepEqual((await listOf(alex)).map(date => date.reminders), [[10], [10], [30], [10]]);
  assert.deepEqual((await datesOf(seriesId)).map(date => date.reminders), [[15], [15], [15], [15]]);
  // The scheduler queues each person's own: Blair's push device makes her dates its business too.
  const ecdh = crypto.createECDH('prime256v1');
  await call(blair, 'POST', '/api/notifications/subscription', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/series-blair',
    keys: { p256dh: ecdh.generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } } });
  await pass();
  const queued = await rows('SELECT event_id, user_id, minutes FROM notification_reminders WHERE event_id IN (?, ?, ?, ?) ORDER BY user_id, event_id', [d1, d2, d3, d4]);
  const by = (person: string) => Object.fromEntries(queued.filter(item => item.user_id === person).map(item => [item.event_id, item.minutes]));
  assert.deepEqual(by(ids.manager), { [d1]: 10, [d2]: 10, [d3]: 30, [d4]: 10 });
  assert.deepEqual(by(ids.member), { [d1]: 15, [d2]: 15, [d3]: 15, [d4]: 15 });

  // ── A free/busy holder sees each date as Busy, without its rule ──
  await share(team.id, 'freebusy');
  assert.deepEqual((await listOf(alex)).map(date => [date.title, date.start_time]), dates.map(date => ['Busy', date.start_time]));
  const busy = (await call(alex, 'GET', ev(d2))).event;
  assert.deepEqual([busy.title, busy.repeat, busy.recurrence], ['Busy', undefined, null]);

  // ── One date: its exception and its row; the other dates and its points stay ──
  const point = (await call(blair, 'POST', ev(d2, '/subtasks'), { title: 'Agenda' })).subtask;
  await call(blair, 'PUT', ev(d2), { title: 'Sync with guests', scope: 'occurrence' });
  dates = await datesOf(seriesId);
  assert.deepEqual(dates.map(date => [date.id, date.title, date.start_time]),
    [[d1, 'Weekly sync', at(monday, 8)], [d2, 'Sync with guests', at(monday + 7, 7)], [d3, 'Weekly sync', at(monday + 14, 7)], [d4, 'Weekly sync', at(monday + 21, 7)]]);
  assert.deepEqual(dates[1].subtasks.map((item: FixtureValue) => item.id), [point.id]);
  assert.match((await rows('SELECT ics FROM calendar_series WHERE id = ?', [seriesId]))[0].ics, /RECURRENCE-ID;TZID=Europe\/Berlin:\d{8}T090000/);
  assert.deepEqual(await refused(blair, 'PUT', ev(d2), { title: 'X', scope: 'all' }), [400, 'SERIES_SCOPE_INVALID']);

  // ── Every date: same ids, the tick and the points kept; a changed date keeps its own title ──
  await call(blair, 'PUT', ev(d3, '/todo-status'), { todo_status: 'done' });
  await call(blair, 'PUT', ev(d1), { title: 'Team sync', scope: 'series' });
  dates = await datesOf(seriesId);
  assert.deepEqual(dates.map(date => [date.id, date.title, date.todo_status, date.subtasks.length]),
    [[d1, 'Team sync', null, 0], [d2, 'Sync with guests', null, 1], [d3, 'Team sync', 'done', 0], [d4, 'Team sync', null, 0]]);

  // ── The series an hour later: every date moves with its key, keeping its id, tick and points ──
  await call(blair, 'PUT', ev(d1), { start_time: at(monday, 9), end_time: at(monday, 10), scope: 'series' });
  dates = await datesOf(seriesId);
  assert.deepEqual(dates.map(date => [date.id, date.start_time, date.todo_status, date.subtasks.length]),
    [[d1, at(monday, 9), null, 0], [d2, at(monday + 7, 7), null, 1], [d3, at(monday + 14, 8), 'done', 0], [d4, at(monday + 21, 8), null, 0]],
    'a date changed on its own keeps its own time');

  // ── Levels: an editor changes every date (the rows stay Blair's); a contributor adds a point to one date; a reader neither ──
  await share(team.id, 'edit');
  await call(alex, 'PUT', ev(d4), { location: 'Room 4', scope: 'series' });
  assert.deepEqual((await rows('SELECT DISTINCT user_id, location FROM calendar_events WHERE series_id = ? AND id <> ?', [seriesId, d2])).map(row => [row.user_id, row.location]), [[ids.member, 'Room 4']]);
  await share(team.id, 'contribute');
  await call(alex, 'POST', ev(d1, '/subtasks'), { title: 'My point' });
  assert.deepEqual((await datesOf(seriesId)).map(date => date.subtasks.length), [1, 1, 0, 0]);
  for (const [method, url, body] of [['PUT', ev(d1), { title: 'Mine', scope: 'series' }], ['PUT', ev(d1), { repeat: { freq: 'DAILY' } }], ['DELETE', `${ev(d1)}?scope=series`]] as const) {
    assert.deepEqual(await refused(alex, method, url, body), [403, 'CALENDAR_FORBIDDEN'], `contribute: ${method} ${url}`);
  }
  await share(team.id, 'read');
  assert.deepEqual(await refused(alex, 'POST', ev(d1, '/subtasks'), { title: 'Late' }), [403, 'CALENDAR_FORBIDDEN']);
  assert.deepEqual(await refused(alex, 'PUT', ev(d1), { title: 'Mine', scope: 'series' }), [403, 'CALENDAR_FORBIDDEN']);
  assert.deepEqual(await refused(blair, 'PUT', ev(d1), { repeat: { freq: 'HOURLY' } }), [400, 'RRULE_UNSUPPORTED']);
  const other = (await call(blair, 'GET', '/api/calendar/calendars')).calendars.find((calendar: FixtureValue) => calendar.id !== team.id && calendar.user_id === ids.member);
  assert.deepEqual(await refused(blair, 'PUT', ev(d2), { calendar_id: other.id }), [409, 'SERIES_MOVE_REFUSED']);
  assert.deepEqual(await refused(blair, 'POST', ev(d2, '/move'), { calendar_id: other.id }), [409, 'SERIES_MOVE_REFUSED'], 'nor one date to another list');

  // ── A date moved in ToDo keeps its time through a change to every date ──
  await call(blair, 'PUT', ev(d2, '/todo-status'), { todo_status: 'time_moved', start_time: at(monday + 8, 7) });
  await call(blair, 'PUT', ev(d1), { location: 'Room 5', scope: 'series' });
  const movedDate = (await call(blair, 'GET', ev(d2))).event;
  assert.deepEqual([movedDate.start_time, movedDate.end_time, movedDate.todo_status], [at(monday + 8, 7), at(monday + 8, 8), 'time_moved']);

  // ── The rule changed: the ticked date goes to the bin, the empty one is removed; back as a single event ──
  await call(blair, 'PUT', ev(d1), { repeat: { freq: 'WEEKLY', by_day: ['MO'], count: 2 } });
  assert.deepEqual((await datesOf(seriesId)).map(date => date.id), [d1, d2]);
  assert.deepEqual((await rows('SELECT id FROM calendar_events WHERE id IN (?, ?)', [d3, d4])), []);
  const [ticked] = await rows("SELECT id, calendar_id FROM bin_items WHERE item_id = ? AND user_id = ?", [d3, ids.member]);
  assert.equal(ticked.calendar_id, team.id);
  assert.equal((await rows('SELECT id FROM bin_items WHERE item_id = ?', [d4])).length, 0);
  await call(blair, 'POST', `/api/bin/${ticked.id}/restore`, {});
  const back = (await call(blair, 'GET', ev(d3))).event;
  assert.deepEqual([back.series_key, back.todo_status, back.title, back.repeat], [null, 'done', 'Team sync', undefined]);

  // ── One date deleted: an EXDATE and the row in the bin ──
  const deleted = await call(blair, 'DELETE', ev(d2));
  assert.equal(deleted.bin_item_ids.length, 1);
  assert.deepEqual((await datesOf(seriesId)).map(date => date.id), [d1]);
  assert.match((await rows('SELECT ics FROM calendar_series WHERE id = ?', [seriesId]))[0].ics, /EXDATE;TZID=Europe\/Berlin:\d{8}T100000/);

  // ── A personal backup carries the series; another person restores it with its rule and changed dates ──
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'series-backup-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const zip = path.join(scratch, 'calendar.zip');
  await writeZip(await backup.buildBackupArchiveEntriesForUser(ids.member, 'calendar', { workDirectory: scratch }), zip);
  const parsed = await backup.backupFromZipFile(zip);
  assert.equal(parsed.backup.version, 8);
  const archived = parsed.backup.data.calendar_series as FixtureValue[];
  assert.deepEqual(archived.map(row => row.id), [seriesId]);
  const readable = calendarEntries(parsed.backup.data, 'Europe/Berlin').map(entry => entry.data.toString('utf8')).find(text => text.includes('X-WR-CALNAME:Team'))!;
  assert.equal(readable.match(/^RRULE:/gm)?.length, 1, 'the readable copy holds the series once');
  assert.equal(readable.match(/^SUMMARY:Team sync/gm)?.length, 2, 'the series and the restored single date, not a VEVENT per date');
  const fresh = crypto.randomUUID();
  await pool.execute('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)', [fresh, 'fresh-series@example.test', 'synthetic-hash', 'Fresh']);
  const imported = await backup.importBackupForUser(fresh, parsed.backup, { mode: 'apply', conflict_mode: 'replace', fileSourcesByPath: parsed.fileSourcesByPath });
  assert.equal(imported.valid, true, (imported as FixtureValue).errors?.join('\n'));
  const [restoredSeries] = await rows('SELECT s.id, s.ics, s.calendar_id FROM calendar_series s JOIN calendar_calendars c ON c.id = s.calendar_id WHERE c.user_id = ?', [fresh]);
  assert.notEqual(restoredSeries.id, seriesId);
  assert.equal(restoredSeries.ics, archived[0].ics, 'the rule, its zone and its changed and removed dates');
  assert.deepEqual((await rows('SELECT recurrence_id FROM calendar_events WHERE series_id = ?', [restoredSeries.id])).map(row => row.recurrence_id),
    (await rows('SELECT recurrence_id FROM calendar_events WHERE series_id = ?', [seriesId])).map(row => row.recurrence_id));
  assert.deepEqual((await rows('SELECT calendar_id FROM bin_items WHERE user_id = ?', [fresh])).map(row => row.calendar_id), [restoredSeries.calendar_id],
    'the deleted date is in the restored calendar\'s bin');

  // The deleted date comes back as a single event with its point.
  await call(blair, 'POST', `/api/bin/${deleted.bin_item_ids[0]}/restore`, {});
  const single = (await call(blair, 'GET', ev(d2))).event;
  assert.deepEqual([single.series_key, single.subtasks.map((item: FixtureValue) => item.title)], [null, ['Agenda']]);

  // ── A daily series fills the window; the daily extension only adds ──
  const today = new Date(); today.setUTCHours(6, 0, 0, 0);
  const daily = (await call(blair, 'POST', '/api/calendar/events', { title: 'Stand-up', start_time: today.toISOString(), end_time: new Date(today.getTime() + 900000).toISOString(),
    calendar_id: team.id, repeat: { freq: 'DAILY' }, time_zone: 'UTC' })).event;
  const count = async () => Number((await rows('SELECT COUNT(*) AS n FROM calendar_events WHERE series_id = ?', [daily.series_key]))[0].n);
  const full = await count();
  assert.ok(full >= 730 && full <= 732, `a daily series holds the next two years (${full})`);
  const [last] = await rows('SELECT id FROM calendar_events WHERE series_id = ? ORDER BY start_time DESC LIMIT 1', [daily.series_key]);
  await pool.execute('DELETE FROM calendar_events WHERE id = ?', [last.id]);
  await pool.execute("UPDATE calendar_events SET title = 'Kept as it is' WHERE id = ?", [daily.id]);
  await pool.execute('INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time, series_id, recurrence_id, uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), ids.member, team.id, 'Off the rule', '2000-01-01 06:30:00', '2000-01-01 07:00:00', daily.series_key, '20000101T063000Z', crypto.randomUUID()]);
  await pool.execute('UPDATE calendar_calendars SET remote_expanded_on = NULL WHERE id = ?', [team.id]);
  assert.equal(await series.extendSeries(), 1, 'the date that came into the window');
  assert.equal(await series.extendSeries(), 0, 'once a day');
  await pool.execute('UPDATE calendar_calendars SET remote_expanded_on = UTC_DATE() - INTERVAL 1 DAY WHERE id = ?', [team.id]);
  assert.equal(await series.extendSeries(), 0, 'nothing new');
  assert.equal(await count(), full + 1);
  assert.equal((await call(blair, 'GET', ev(daily.id))).event.title, 'Kept as it is');

  // ── Blair's own earlier backup restored with "replace" after the series moved a day: each date back on its key ──
  const keysOf = async () => (await rows('SELECT id, recurrence_id FROM calendar_events WHERE series_id = ? ORDER BY id', [daily.series_key])).map(row => [row.id, row.recurrence_id]);
  const backedUp = await keysOf();
  const ownZip = path.join(scratch, 'own.zip');
  await writeZip(await backup.buildBackupArchiveEntriesForUser(ids.member, 'calendar', { workDirectory: scratch }), ownZip);
  const own = await backup.backupFromZipFile(ownZip);
  await call(blair, 'PUT', ev(daily.id), { start_time: new Date(today.getTime() + 86400000).toISOString(), end_time: new Date(today.getTime() + 86400000 + 900000).toISOString(), scope: 'series' });
  // A ticked date made since on a key the backup's date takes back: it goes to the bin.
  const since = crypto.randomUUID();
  await pool.execute("INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time, todo_status, series_id, recurrence_id, uid) VALUES (?, ?, ?, 'Since', ?, ?, 'done', ?, ?, ?)",
    [since, ids.member, team.id, '2000-01-01 06:30:00', '2000-01-01 07:00:00', daily.series_key, '20000101T063000Z', since]);
  const replaced = await backup.importBackupForUser(ids.member, own.backup, { mode: 'apply', conflict_mode: 'replace', fileSourcesByPath: own.fileSourcesByPath });
  assert.equal(replaced.valid, true, (replaced as FixtureValue).errors?.join('\n'));
  assert.deepEqual(await keysOf(), backedUp);
  assert.equal((await rows('SELECT id FROM bin_items WHERE item_id = ? AND user_id = ?', [since, ids.member])).length, 1);

  // ── Every date deleted: one bin item, restored as the series with its ids ──
  const before = (await rows('SELECT id, recurrence_id FROM calendar_events WHERE series_id = ? ORDER BY id', [daily.series_key])).map(row => [row.id, row.recurrence_id]);
  const whole = await call(blair, 'DELETE', `${ev(daily.id)}?scope=series`);
  assert.equal(whole.bin_item_ids.length, 1);
  const [size] = await rows('SELECT LENGTH(payload) AS bytes FROM bin_items WHERE id = ?', [whole.bin_item_ids[0]]);
  t.diagnostic(`a deleted daily series of ${before.length} dates is one bin item of ${size.bytes} bytes`);
  assert.deepEqual([await count(), (await rows('SELECT id FROM calendar_series WHERE id = ?', [daily.series_key])).length], [0, 0]);
  await call(blair, 'POST', `/api/bin/${whole.bin_item_ids[0]}/restore`, {});
  assert.deepEqual((await rows('SELECT id, recurrence_id FROM calendar_events WHERE series_id = ? ORDER BY id', [daily.series_key])).map(row => [row.id, row.recurrence_id]), before);
  assert.equal((await call(blair, 'GET', ev(daily.id))).event.repeat.freq, 'DAILY');

  // ── The calendar deleted with its series and restored: the series is back with its dates ──
  const gone = await call(blair, 'DELETE', `/api/calendar/calendars/${team.id}`);
  assert.equal(gone.deleted_events, before.length + 3, 'the daily dates, the weekly one and the two single dates');
  const [calendarItem] = await rows("SELECT id FROM bin_items WHERE user_id = ? AND item_type = 'calendar' AND item_id = ?", [ids.member, team.id]);
  await call(blair, 'POST', `/api/bin/${calendarItem.id}/restore`, {});
  assert.deepEqual((await rows('SELECT id, recurrence_id FROM calendar_events WHERE series_id = ? ORDER BY id', [daily.series_key])).map(row => [row.id, row.recurrence_id]), before);
  assert.deepEqual((await datesOf(seriesId)).map(date => date.id), [d1]);

  // ── "Keep existing" after dates left the rule, came back and were renamed: the dates there stay, none twice ──
  const review = (await call(blair, 'POST', '/api/calendar/events', { title: 'Review', start_time: at(monday + 1, 8), end_time: at(monday + 1, 9), calendar_id: team.id,
    repeat: { freq: 'DAILY', count: 4 }, time_zone: 'UTC' })).event;
  const laterZip = path.join(scratch, 'later.zip');
  await writeZip(await backup.buildBackupArchiveEntriesForUser(ids.member, 'calendar', { workDirectory: scratch }), laterZip);
  const later = await backup.backupFromZipFile(laterZip);
  await call(blair, 'PUT', ev(review.id), { repeat: { freq: 'DAILY', count: 2 } });
  await call(blair, 'PUT', ev(review.id), { repeat: { freq: 'DAILY', count: 4 } });
  await call(blair, 'PUT', ev(review.id), { title: 'Reviewed', scope: 'series' });
  const reviewDates = (await datesOf(review.series_key)).map(date => [date.id, date.title]);
  const kept = await backup.importBackupForUser(ids.member, later.backup, { mode: 'apply', conflict_mode: 'keep_existing', fileSourcesByPath: later.fileSourcesByPath });
  assert.equal(kept.valid, true, (kept as FixtureValue).errors?.join('\n'));
  assert.deepEqual((await datesOf(review.series_key)).map(date => [date.id, date.title]), reviewDates);
});
