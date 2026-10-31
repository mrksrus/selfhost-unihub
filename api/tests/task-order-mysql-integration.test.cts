import type { FixtureValue } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http = (require('node:http') as typeof import('node:http'));
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime.cts');

// The hand order of tasks (0.27, D31, D32) and where new tasks and events
// go, through the real request handler and database: an owner and a
// stranger, the module switch, a running restore, a synced task's order over
// a re-sync, a restore and a deletion at the server, and the restore of the
// order and of the default settings with remapped ids.
const BASE = 'https://dav.example.test';
const CALENDAR_HREF = '/dav/calendars/person/work/';
const DAY = 86400000;

function icsDate(ms: number) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function eventIcs(uid: string, title: string, startMs: number) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//UniHub test//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T000000Z',
    `DTSTART:${icsDate(startMs)}`, `DTEND:${icsDate(startMs + 3600000)}`, `SUMMARY:${title}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

test('task order and calendar defaults: owner-scoped, gated, kept over re-sync and restore', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  assert.match((process.env.MYSQL_TEST_DATABASE as string), /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE,
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, connectionLimit: 8, timezone: 'Z' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-task-order-'));
  let server: FixtureValue; let owned = false;
  t.after(async () => {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
      if (owned) {
        const connection = await pool.getConnection();
        try {
          await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
          const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES');
          for (const row of tables) {
            const table = Object.values(row)[0];
            assert.match((table as string), /^[a-z_]+$/);
            await connection.execute('DROP TABLE `' + table + '`');
          }
          await connection.execute('SET FOREIGN_KEY_CHECKS = 1');
        } finally { connection.release(); }
      }
    } finally {
      await pool.end();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES'); assert.equal(tables.length, 0, 'Use an empty disposable test database'); owned = true;
  const runtime = createBackupRuntime(directory, 'task-order-synthetic-key', pool);
  await runtime('services/database').ensureSchema();
  await runtime('services/data-inventory').verifyDatabaseInventory(pool);
  // Step 24 repeats without harm (an interrupted upgrade runs it again).
  const step24 = (runtime('services/database').MIGRATIONS as FixtureValue[]).find(migration => migration.id === 24);
  const repeat = await pool.getConnection();
  try { await step24.up(repeat); await step24.verify(repeat); } finally { repeat.release(); }

  const password = 'task-order-fixture-password';
  const passwordHash = await require('bcryptjs').hash(password, 10);
  const ids: Record<string, string> = {};
  for (const name of ['owner', 'stranger']) {
    ids[name] = crypto.randomUUID();
    await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)', [ids[name], `${name}@example.test`, passwordHash, name]);
  }
  const { handleRequest } = runtime('request-handler');
  server = http.createServer((req, res) => handleRequest(req, res).catch((error: FixtureValue) => res.destroy(error)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  function session() {
    const cookies = new Map<string, string>(); let csrf: string | undefined;
    return async (method: string, route: string, body?: unknown, expected = 200) => {
      const response = await fetch(base + '/api' + route, { method, headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
      }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const separator = pair.indexOf('='); cookies.set(pair.slice(0, separator), pair.slice(separator + 1)); }
      const result = await response.json();
      assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
      if (result.csrfToken) csrf = result.csrfToken;
      return result;
    };
  }
  const signIn = async (name: string) => {
    const request = session();
    await request('POST', '/auth/signin', { email: `${name}@example.test`, password });
    await request('GET', '/auth/me');
    return request;
  };
  const owner = await signIn('owner');
  const stranger = await signIn('stranger');
  const { encrypt } = runtime('security/encryption');
  const { setUserModules } = runtime('services/module-settings');

  async function localCalendar(userId: string, name: string, autoTodo = true) {
    const [[account]] = await pool.query<RowDataPacket[]>("SELECT id FROM calendar_accounts WHERE user_id = ? AND provider = 'local' LIMIT 1", [userId]);
    let accountId = account?.id;
    if (!accountId) {
      accountId = crypto.randomUUID();
      await pool.execute("INSERT INTO calendar_accounts (id, user_id, provider, display_name, is_active, created_at) VALUES (?, ?, 'local', 'Local Calendar', TRUE, '2026-01-01 00:00:00')", [accountId, userId]);
    }
    const id = crypto.randomUUID();
    const [[count]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM calendar_calendars WHERE user_id = ?', [userId]);
    await pool.execute('INSERT INTO calendar_calendars (id, user_id, account_id, name, auto_todo_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, userId, accountId, name, autoTodo, sqlTime(Date.UTC(2026, 0, 2) + Number(count.n) * 60000)]);
    return id;
  }
  async function task(userId: string, calendarId: string, title: string, { dated = null as number | null, createdMs = Date.now() } = {}) {
    const id = crypto.randomUUID();
    const start = dated ?? createdMs;
    await pool.execute(`INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time, is_todo_only, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, userId, calendarId, title, sqlTime(start), sqlTime(start + 1800000), dated === null, sqlTime(createdMs)]);
    return id;
  }
  // The open tasks as ToDo orders them: by rank, then id.
  async function order(request = owner) {
    const { events } = await request('GET', '/calendar/events?include_todos=true&include_done=false&respect_auto_todo=true');
    return (events as FixtureValue[]).sort((a, b) => a.sort_rank - b.sort_rank || (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : 0));
  }
  const titles = async (request = owner) => (await order(request)).map(event => event.title);
  const orderRows = async (userId = ids.owner) => Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM task_order WHERE user_id = ?', [userId]))[0][0].n);

  const inbox = await localCalendar(ids.owner, 'Inbox');
  const t0 = Date.UTC(2026, 9, 1, 8);

  await t.test('a task never moved keeps its date place; placing writes only the moved task', async () => {
    const pay = await task(ids.owner, inbox, 'Pay rent', { createdMs: t0 });
    const call = await task(ids.owner, inbox, 'Call plumber', { createdMs: t0 + 60000 });
    const book = await task(ids.owner, inbox, 'Book flights', { createdMs: t0 + 120000 });
    assert.deepEqual(await titles(), ['Pay rent', 'Call plumber', 'Book flights'], 'no date: creation order');
    assert.ok((await order()).every(event => event.hand_ordered === false));

    const placed = await owner('PUT', `/calendar/events/${book}/position`, { after: pay, before: call });
    assert.deepEqual(Object.keys(placed.ranks), [book]);
    assert.deepEqual(await titles(), ['Pay rent', 'Book flights', 'Call plumber']);
    assert.equal(await orderRows(), 1, 'one row: the moved task');
    const [moved] = (await order()).filter(event => event.id === book);
    assert.equal(moved.hand_ordered, true);
    assert.equal(moved.sort_rank, placed.ranks[book]);
    // The single event answer carries the rank too.
    assert.equal((await owner('GET', `/calendar/events/${book}`)).event.sort_rank, placed.ranks[book]);

    // To the top and the bottom of the section.
    await owner('PUT', `/calendar/events/${call}/position`, { after: null, before: pay });
    assert.deepEqual(await titles(), ['Call plumber', 'Pay rent', 'Book flights']);
    await owner('PUT', `/calendar/events/${call}/position`, { after: book, before: null });
    assert.deepEqual(await titles(), ['Pay rent', 'Book flights', 'Call plumber']);
    // A new task without a date lands at the bottom.
    await task(ids.owner, inbox, 'Water plants', { createdMs: t0 + DAY });
    assert.deepEqual(await titles(), ['Pay rent', 'Book flights', 'Call plumber', 'Water plants']);
  });

  await t.test('repeated drops into one gap spread only the crowded run, keeping the order', async () => {
    await pool.execute('DELETE FROM calendar_events WHERE user_id = ?', [ids.owner]);
    const list: string[] = [];
    const titleOf = new Map<string, string>();
    for (let index = 0; index < 30; index += 1) {
      const id = await task(ids.owner, inbox, `Item ${index}`, { createdMs: t0 + index * 60000 });
      list.push(id); titleOf.set(id, `Item ${index}`);
    }
    let spread: Record<string, number> | null = null;
    for (let step = 0; step < 28 && !spread; step += 1) {
      const moving = list[list.length - 1];
      const expected = list.filter(id => id !== moving);
      expected.splice(1, 0, moving);
      const rowsBefore = await orderRows();
      const { ranks } = await owner('PUT', `/calendar/events/${moving}/position`, { after: list[0], before: expected[2] });
      list.splice(0, list.length, ...expected);
      assert.deepEqual(await titles(), list.map(id => titleOf.get(id)), `order after drop ${step}`);
      if (Object.keys(ranks).length > 1) spread = ranks;
      else assert.equal(await orderRows(), rowsBefore + 1, 'a drop with room writes one row');
    }
    assert.ok(spread, 'the gap ran out and the run was spread');
    assert.ok(Object.keys(spread!).length < list.length, 'only the run around the drop was rewritten');
    assert.equal((await order()).at(-1)!.hand_ordered, false, 'a task far from the drop keeps its date rank');
  });

  await t.test('stale, foreign and malformed placements change nothing', async () => {
    const [first, second, third] = (await order()).map(event => event.id);
    const before = await orderRows();
    await owner('PUT', `/calendar/events/${first}/position`, { after: third, before: second }, 409);
    await owner('PUT', `/calendar/events/${first}/position`, { after: crypto.randomUUID(), before: null }, 409);
    await owner('PUT', `/calendar/events/${first}/position`, {}, 400);
    await owner('PUT', `/calendar/events/${first}/position`, { after: second, before: second }, 400);
    await owner('PUT', `/calendar/events/${first}/position`, { after: first, before: null }, 400);
    await owner('PUT', `/calendar/events/${crypto.randomUUID()}/position`, { after: second, before: null }, 404);
    // A done neighbour is no longer in the open list.
    await owner('PUT', `/calendar/events/${third}/todo-status`, { todo_status: 'done' });
    await owner('PUT', `/calendar/events/${first}/position`, { after: second, before: third }, 409);
    await owner('PUT', `/calendar/events/${third}/position`, { after: first, before: null }, 409);
    await owner('PUT', `/calendar/events/${third}/todo-status`, { todo_status: null });

    // Owner and stranger: neither can place or name the other's tasks.
    const strangerList = await localCalendar(ids.stranger, 'Mine');
    const theirs = await task(ids.stranger, strangerList, 'Their task', { createdMs: t0 });
    const theirOther = await task(ids.stranger, strangerList, 'Their other task', { createdMs: t0 + 60000 });
    await stranger('PUT', `/calendar/events/${first}/position`, { after: theirs, before: null }, 404);
    await owner('PUT', `/calendar/events/${first}/position`, { after: theirs, before: null }, 409);
    await owner('PUT', `/calendar/events/${theirOther}/position`, { after: null, before: theirs }, 404);
    assert.equal(await orderRows(), before);
    assert.equal(await orderRows(ids.stranger), 0);
    assert.deepEqual(await titles(stranger), ['Their task', 'Their other task'], 'the stranger sees only their own order');
  });

  await t.test('the module switch and a running calendar restore refuse placing', async () => {
    const [first, second] = (await order()).map(event => event.id);
    await setUserModules(ids.owner, { modules: { calendar: { enabled: false } } });
    const off = await owner('PUT', `/calendar/events/${second}/position`, { after: null, before: first }, 403);
    assert.equal(off.code, 'MODULE_DISABLED');
    await setUserModules(ids.owner, { modules: { calendar: { enabled: true } } });
    const restoreId = crypto.randomUUID();
    await pool.execute("INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', ?)", [restoreId, ids.owner, JSON.stringify(['calendar'])]);
    const locked = await owner('PUT', `/calendar/events/${second}/position`, { after: null, before: first }, 409);
    assert.equal(locked.code, 'RESTORE_IN_PROGRESS');
    // Another section's restore leaves the order writable.
    await pool.execute("UPDATE backup_restore_jobs SET requested_sections = ? WHERE id = ?", [JSON.stringify(['mail']), restoreId]);
    await owner('PUT', `/calendar/events/${second}/position`, { after: null, before: first });
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreId]);
  });

  await t.test('a date changed in UniHub returns the task to its date place', async () => {
    await pool.execute('DELETE FROM calendar_events WHERE user_id = ?', [ids.owner]);
    const morning = Date.UTC(2026, 10, 20, 9);
    const early = await task(ids.owner, inbox, 'Early', { dated: morning });
    const late = await task(ids.owner, inbox, 'Late', { dated: morning + 3600000 });
    const later = await task(ids.owner, inbox, 'Later', { dated: morning + 7200000 });
    await owner('PUT', `/calendar/events/${later}/position`, { after: null, before: early });
    assert.deepEqual(await titles(), ['Later', 'Early', 'Late']);
    // Saving the dialog with the same time keeps the hand place.
    const unchanged = await owner('GET', `/calendar/events/${later}`);
    await owner('PUT', `/calendar/events/${later}`, { title: 'Later', start_time: unchanged.event.start_time, end_time: unchanged.event.end_time });
    assert.deepEqual(await titles(), ['Later', 'Early', 'Late']);
    // A new time: back to its date's place.
    const edited = await owner('PUT', `/calendar/events/${later}`, { start_time: new Date(morning + 5400000).toISOString(), end_time: new Date(morning + 7200000).toISOString() });
    assert.equal(edited.event.hand_ordered, false);
    assert.deepEqual(await titles(), ['Early', 'Late', 'Later']);
    // "Move to another time" too.
    await owner('PUT', `/calendar/events/${late}/position`, { after: null, before: early });
    assert.deepEqual(await titles(), ['Late', 'Early', 'Later']);
    const moved = await owner('PUT', `/calendar/events/${late}/todo-status`, { todo_status: 'time_moved', start_time: new Date(morning + 2 * DAY).toISOString() });
    assert.equal(moved.event.hand_ordered, false);
    assert.deepEqual(await titles(), ['Early', 'Later', 'Late']);
    assert.equal(await orderRows(), 0);

    // The offline snapshot carries each event's rank.
    await owner('PUT', `/calendar/events/${late}/position`, { after: null, before: early });
    const snapshot = await runtime('services/offline').createOfflineSnapshot(ids.owner);
    const saved = (snapshot.events as FixtureValue[]).sort((a, b) => a.sort_rank - b.sort_rank);
    assert.deepEqual(saved.map(event => [event.title, event.hand_ordered]), [['Late', true], ['Early', false], ['Later', false]]);
  });

  await t.test('defaults: marked on the calendar list, checked per target, falling back when the choice is gone', async () => {
    const someday = await localCalendar(ids.owner, 'Someday', false);
    const errands = await localCalendar(ids.owner, 'Errands');
    const davAccount = crypto.randomUUID(), feedAccount = crypto.randomUUID();
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, display_name, username, encrypted_password, base_url, provider_config, is_active, created_at)
      VALUES (?, ?, 'caldav', 'owner@dav.example.test', 'Work server', 'owner', ?, ?, '{}', TRUE, '2026-02-01 00:00:00')`, [davAccount, ids.owner, encrypt('synthetic-dav-password'), `${BASE}/dav/calendars/person/`]);
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, display_name, is_active, created_at)
      VALUES (?, ?, 'ics', 'Holidays', TRUE, '2026-03-01 00:00:00')`, [feedAccount, ids.owner]);
    const work = crypto.randomUUID(), holidays = crypto.randomUUID();
    await pool.execute("INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id) VALUES (?, ?, ?, 'Work', ?)", [work, ids.owner, davAccount, CALENDAR_HREF]);
    await pool.execute("INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id, read_only) VALUES (?, ?, ?, 'Holidays', 'https://feeds.example.test/h.ics', TRUE)", [holidays, ids.owner, feedAccount]);
    const marks = async () => Object.fromEntries(((await owner('GET', '/calendar/calendars')).calendars as FixtureValue[])
      .map(calendar => [calendar.name, [calendar.default_for_tasks, calendar.default_for_events, calendar.write_block, calendar.takes_undated_tasks]]));

    assert.deepEqual(await marks(), {
      Inbox: [true, true, null, true], Someday: [false, false, null, true], Errands: [false, false, null, true],
      Work: [false, false, null, false], Holidays: [false, false, 'read_only', false],
    });
    // Per target: a task list is one's own UniHub list with ToDo on; a calendar any writable one.
    const setValue = (values: Record<string, string>, expected = 200, request = owner) => request('PUT', '/settings/values', { values }, expected);
    for (const [value, reason] of [[work, /stay in UniHub/], [holidays, /read-only/], [someday, /does not show in ToDo/], [crypto.randomUUID(), /your own lists/]] as const) {
      assert.match((await setValue({ default_task_list_id: value }, 400)).error, reason);
    }
    assert.match((await setValue({ default_calendar_id: holidays }, 400)).error, /read-only/);
    const theirList = (await pool.query<RowDataPacket[]>('SELECT id FROM calendar_calendars WHERE user_id = ?', [ids.stranger]))[0][0].id;
    await setValue({ default_task_list_id: theirList }, 400);
    await setValue({ default_calendar_id: inbox }, 400, stranger);
    await setValue({ default_task_list_id: errands, default_calendar_id: work });
    assert.deepEqual((await marks()).Errands.slice(0, 2), [true, false]);
    assert.deepEqual((await marks()).Work.slice(0, 2), [false, true]);

    // A task created without a calendar (older apps) goes to the default list.
    const created = await owner('POST', '/calendar/events', { title: 'Buy stamps', is_todo_only: true });
    assert.equal(created.event.calendar_id, errands);
    assert.equal(typeof created.event.sort_rank, 'number');

    // Paused or gone: UniHub's choice applies, and the stored value says why.
    await pool.execute('UPDATE calendar_accounts SET is_active = FALSE WHERE id = ?', [davAccount]);
    assert.deepEqual((await marks()).Work, [false, false, 'sync_paused', false]);
    assert.equal((await marks()).Inbox[1], true, 'events fall back to the first writable calendar');
    await owner('DELETE', `/calendar/calendars/${errands}`);
    assert.equal((await marks()).Inbox[0], true, 'tasks fall back to the oldest list with ToDo on');
    assert.equal((await owner('POST', '/calendar/events', { title: 'Renew passport', is_todo_only: true })).event.calendar_id, inbox);
    const defaults = await runtime('services/calendar').resolveCalendarDefaults(ids.owner);
    assert.deepEqual(defaults.stale, { taskList: true, calendar: true });
    await pool.execute('UPDATE calendar_accounts SET is_active = TRUE WHERE id = ?', [davAccount]);

    // A reference names one person's record: never an installation policy.
    await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', 'user.default_calendar_id', ?, 1)", [holidays]);
    const { settings } = await owner('GET', '/settings/values');
    assert.deepEqual(settings.default_calendar_id, { value: work, source: 'user', locked: false });
    await pool.execute("DELETE FROM setting_policies WHERE setting_key = 'user.default_calendar_id'");
    await pool.execute('DELETE FROM calendar_accounts WHERE id IN (?, ?)', [davAccount, feedAccount]);
    await setValue({ default_calendar_id: '' });
  });

  await t.test('a synced task keeps its hand place over a rebuilt sync, a restore and a deletion at the server', async () => {
    const caldav = runtime('services/caldav');
    const calendarSync = runtime('services/calendar-sync');
    const remote = { ctag: '1', objects: new Map<string, { etag: string; ics: string }>() };
    caldav.listCalendars = async () => [{ href: CALENDAR_HREF, url: `${BASE}${CALENDAR_HREF}`, displayName: 'Work', ctag: remote.ctag, readOnly: false }];
    caldav.listCalendarObjects = async () => [...remote.objects].map(([href, object]) => ({ href, url: `${BASE}${href}`, etag: object.etag }));
    caldav.fetchCalendarObjects = async ({ objects }: FixtureValue) => objects.filter((item: FixtureValue) => remote.objects.has(item.href))
      .map((item: FixtureValue) => ({ href: item.href, etag: remote.objects.get(item.href)!.etag, ics: remote.objects.get(item.href)!.ics }));
    caldav.resourceGone = async ({ url, kind }: FixtureValue) => kind === 'calendar' ? !url.endsWith(CALENDAR_HREF) : !remote.objects.has(new URL(url).pathname);
    await pool.execute('DELETE FROM calendar_events WHERE user_id = ?', [ids.owner]);

    const accountId = crypto.randomUUID();
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, display_name, username, encrypted_password, base_url, provider_config, is_active)
      VALUES (?, ?, 'caldav', 'owner@dav.example.test', 'Work server', 'owner', ?, ?, ?, TRUE)`,
    [accountId, ids.owner, encrypt('synthetic-dav-password'), `${BASE}/dav/calendars/person/`, JSON.stringify({ server: { url: BASE, source: 'discovered', label: 'dav.example.test' }, principalHref: '/dav/principals/person/' })]);
    const start = Date.now() + 3 * DAY;
    remote.objects.set(`${CALENDAR_HREF}standup.ics`, { etag: '"s1"', ics: eventIcs('standup@example.test', 'Standup', start) });
    remote.objects.set(`${CALENDAR_HREF}review.ics`, { etag: '"r1"', ics: eventIcs('review@example.test', 'Review', start + 3600000) });
    await calendarSync.syncCalendarAccount(accountId, { userId: ids.owner });
    // ToDo shows the calendar's events once its "Show in ToDo" is on.
    await pool.execute('UPDATE calendar_calendars SET auto_todo_enabled = TRUE WHERE account_id = ?', [accountId]);
    assert.deepEqual(await titles(), ['Standup', 'Review']);
    const byTitle = async () => Object.fromEntries((await order()).map(event => [event.title, event.id]));
    const synced = await byTitle();
    await owner('PUT', `/calendar/events/${synced.Review}/position`, { after: null, before: synced.Standup });
    assert.deepEqual(await titles(), ['Review', 'Standup']);
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT event_id, remote_uid, recurrence_id FROM task_order WHERE user_id = ?', [ids.owner]);
    assert.deepEqual({ ...row }, { event_id: null, remote_uid: 'review@example.test', recurrence_id: '' }, 'keyed by the provider identity, not the row');

    // An ordinary sync and the daily expansion keep it.
    remote.ctag = '2';
    remote.objects.set(`${CALENDAR_HREF}review.ics`, { etag: '"r2"', ics: eventIcs('review@example.test', 'Review (room 2)', start + 3600000) });
    await pool.execute('UPDATE calendar_calendars SET remote_expanded_on = NULL WHERE account_id = ?', [accountId]);
    await calendarSync.syncCalendarAccount(accountId, { userId: ids.owner });
    assert.deepEqual(await titles(), ['Review (room 2)', 'Standup']);

    // The server copies are gone locally (as after a restore): the next sync
    // builds new rows, and the order finds them by UID.
    await pool.execute('DELETE FROM calendar_remote_objects WHERE account_id = ?', [accountId]);
    await pool.execute('UPDATE calendar_calendars SET remote_ctag = NULL, remote_expanded_on = NULL, sync_token = NULL WHERE account_id = ?', [accountId]);
    await calendarSync.syncCalendarAccount(accountId, { userId: ids.owner });
    const rebuilt = await byTitle();
    assert.notEqual(rebuilt.Standup, synced.Standup, 'the rows were rebuilt');
    assert.deepEqual(await titles(), ['Review (room 2)', 'Standup']);
    assert.equal((await order())[0].hand_ordered, true);

    // A restore of the calendar section into the same person, the account
    // removed in between: new ids, and the order comes back with its UID.
    const backup = await runtime('services/backup').buildBackupForUser(ids.owner, { sections: ['calendar'] });
    assert.equal((backup.data.task_order as FixtureValue[]).length, 1);
    // As the account's removal does: its events, then the account.
    await pool.execute('DELETE e FROM calendar_events e JOIN calendar_calendars c ON c.id = e.calendar_id WHERE c.account_id = ?', [accountId]);
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [accountId]);
    assert.equal(await orderRows(), 0, 'removing the account removes its order');
    const result = await runtime('services/backup').importBackupForUser(ids.owner, backup, { mode: 'apply', sections: ['calendar'], startAccountSync: () => {} });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    const [[restoredAccount]] = await pool.query<RowDataPacket[]>("SELECT id FROM calendar_accounts WHERE user_id = ? AND provider = 'caldav'", [ids.owner]);
    assert.notEqual(restoredAccount.id, accountId);
    const [[restoredRank]] = await pool.query<RowDataPacket[]>('SELECT t.calendar_id, c.account_id FROM task_order t JOIN calendar_calendars c ON c.id = t.calendar_id WHERE t.user_id = ?', [ids.owner]);
    assert.equal(restoredRank.account_id, restoredAccount.id, 'the calendar id was remapped');
    // The synthetic server name does not resolve, so the restore pauses the
    // account; signing in again is outside this test.
    await pool.execute('UPDATE calendar_accounts SET is_active = TRUE WHERE id = ?', [restoredAccount.id]);
    await calendarSync.syncCalendarAccount(restoredAccount.id, { userId: ids.owner });
    assert.deepEqual(await titles(), ['Review (room 2)', 'Standup']);
    assert.equal((await order())[0].hand_ordered, true);

    // Deleted at the server: the order of the item goes with it.
    remote.ctag = '3';
    remote.objects.delete(`${CALENDAR_HREF}review.ics`);
    await calendarSync.syncCalendarAccount(restoredAccount.id, { userId: ids.owner });
    assert.deepEqual(await titles(), ['Standup']);
    assert.equal(await orderRows(), 0);
    await pool.execute("DELETE FROM calendar_accounts WHERE user_id = ? AND provider = 'caldav'", [ids.owner]);
  });

  await t.test('order of synced items leaves only on deletion at the server, not with the sync window', async () => {
    const caldav = runtime('services/caldav');
    const calendarSync = runtime('services/calendar-sync');
    // A listing covers the sync window only: an object without an occurrence
    // there is left out, though the server still has it.
    const remote = { ctag: '1', objects: new Map<string, { etag: string; ics: string; outside?: boolean }>() };
    caldav.listCalendars = async () => [{ href: CALENDAR_HREF, url: `${BASE}${CALENDAR_HREF}`, displayName: 'Work', ctag: remote.ctag, readOnly: false }];
    caldav.listCalendarObjects = async () => [...remote.objects].filter(([, object]) => !object.outside).map(([href, object]) => ({ href, url: `${BASE}${href}`, etag: object.etag }));
    caldav.fetchCalendarObjects = async ({ objects }: FixtureValue) => objects.filter((item: FixtureValue) => remote.objects.has(item.href))
      .map((item: FixtureValue) => ({ href: item.href, etag: remote.objects.get(item.href)!.etag, ics: remote.objects.get(item.href)!.ics }));
    caldav.resourceGone = async ({ url, kind }: FixtureValue) => kind === 'calendar' ? !url.endsWith(CALENDAR_HREF) : !remote.objects.has(new URL(url).pathname);
    const accountId = crypto.randomUUID();
    await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, display_name, username, encrypted_password, base_url, provider_config, is_active)
      VALUES (?, ?, 'caldav', 'owner@dav.example.test', 'Work server', 'owner', ?, ?, ?, TRUE)`,
    [accountId, ids.owner, encrypt('synthetic-dav-password'), `${BASE}/dav/calendars/person/`, JSON.stringify({ server: { url: BASE, source: 'discovered', label: 'dav.example.test' }, principalHref: '/dav/principals/person/' })]);
    const week = 7 * DAY;
    const first = Math.ceil((Date.now() + 2 * DAY) / 3600000) * 3600000;
    const far = Date.now() + 900 * DAY;
    const series = (moved: number | null) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//UniHub test//EN',
      'BEGIN:VEVENT', 'UID:weekly@example.test', 'DTSTAMP:20261001T000000Z', `DTSTART:${icsDate(first)}`, `DTEND:${icsDate(first + 3600000)}`,
      'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Weekly review', 'END:VEVENT',
      ...(moved === null ? [] : ['BEGIN:VEVENT', 'UID:weekly@example.test', 'DTSTAMP:20261001T000000Z', `RECURRENCE-ID:${icsDate(first + week)}`,
        `DTSTART:${icsDate(moved)}`, `DTEND:${icsDate(moved + 3600000)}`, 'SUMMARY:Weekly review', 'END:VEVENT']),
      'END:VCALENDAR', ''].join('\r\n');
    // A single event is always expanded; a series is bounded by the window.
    const solo = (start: number) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//UniHub test//EN', 'BEGIN:VEVENT', 'UID:solo@example.test',
      'DTSTAMP:20261001T000000Z', `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(start + 3600000)}`, 'RRULE:FREQ=DAILY;COUNT=1', 'SUMMARY:Solo',
      'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    const seriesHref = `${CALENDAR_HREF}weekly.ics`, soloHref = `${CALENDAR_HREF}solo.ics`;
    remote.objects.set(seriesHref, { etag: '"w1"', ics: series(null) });
    remote.objects.set(soloHref, { etag: '"o1"', ics: solo(first + 3 * week) });
    let version = 1;
    const sync = async () => {
      remote.ctag = String(++version);
      await pool.execute('UPDATE calendar_calendars SET remote_expanded_on = NULL WHERE account_id = ?', [accountId]);
      await calendarSync.syncCalendarAccount(accountId, { userId: ids.owner });
    };
    await sync();
    await pool.execute('UPDATE calendar_calendars SET auto_todo_enabled = TRUE WHERE account_id = ?', [accountId]);
    const [[work]] = await pool.query<RowDataPacket[]>('SELECT id FROM calendar_calendars WHERE account_id = ?', [accountId]);
    // The calendar's tasks in order, by title and original week.
    const label = (event: FixtureValue) => event.title === 'Solo' ? 'Solo' : `Week ${Math.round((Date.parse(event.start_time) - first) / week) + 1}`;
    const listed = async () => (await order()).filter(event => event.calendar_id === work.id);
    const labels = async () => (await listed()).map(label);
    assert.deepEqual(await labels(), ['Week 1', 'Week 2', 'Week 3', 'Solo']);
    const byLabel = async () => Object.fromEntries((await listed()).map(event => [label(event), event.id]));
    const events = await byLabel();
    await owner('PUT', `/calendar/events/${events['Week 2']}/position`, { after: null, before: events['Week 1'] });
    await owner('PUT', `/calendar/events/${events.Solo}/position`, { after: events['Week 2'], before: events['Week 1'] });
    assert.deepEqual(await labels(), ['Week 2', 'Solo', 'Week 1', 'Week 3']);
    const ranks = async () => (await pool.query<RowDataPacket[]>('SELECT remote_uid, recurrence_id FROM task_order WHERE user_id = ? AND calendar_id = ? ORDER BY remote_uid, recurrence_id', [ids.owner, work.id]))[0].map(row => `${row.remote_uid}|${row.recurrence_id}`);
    const placed = [`solo@example.test|${icsDate(first + 3 * week)}`, `weekly@example.test|${icsDate(first + week)}`];
    assert.deepEqual(await ranks(), placed);

    // Another client moves week 2 and the single event beyond the window:
    // their rows go, their places stay.
    remote.objects.set(seriesHref, { etag: '"w2"', ics: series(far) });
    remote.objects.set(soloHref, { etag: '"o2"', ics: solo(far), outside: true });
    await sync();
    assert.deepEqual(await labels(), ['Week 1', 'Week 3']);
    assert.deepEqual(await ranks(), placed, 'an expansion that omits an item is no deletion');
    // Moved back to their dates: the hand places apply again.
    remote.objects.set(seriesHref, { etag: '"w3"', ics: series(first + week) });
    remote.objects.set(soloHref, { etag: '"o3"', ics: solo(first + 3 * week) });
    await sync();
    assert.deepEqual(await labels(), ['Week 2', 'Solo', 'Week 1', 'Week 3']);
    assert.deepEqual((await listed()).slice(0, 2).map(event => event.hand_ordered), [true, true]);

    // No expiry by date: a rank of an occurrence from long ago (or one whose
    // RECURRENCE-ID is old while its moved start is in view) stays.
    const stale = '20200106T100000Z';
    const keyOf = runtime('services/task-order').itemKey;
    for (const recurrence of [stale, '20300107T100000Z']) {
      await pool.execute('INSERT INTO task_order (user_id, item_key, calendar_id, remote_uid, recurrence_id, sort_rank) VALUES (?, ?, ?, ?, ?, 1)',
        [ids.owner, keyOf({ calendar_id: work.id, remote_uid: 'weekly@example.test', recurrence_id: recurrence }), work.id, 'weekly@example.test', recurrence]);
    }
    await sync();
    const withOld = [...placed, `weekly@example.test|${stale}`, 'weekly@example.test|20300107T100000Z'].sort();
    assert.deepEqual(await ranks(), withOld);

    // Deleted at the server (verified): its order goes.
    remote.objects.delete(soloHref);
    await sync();
    assert.deepEqual(await labels(), ['Week 2', 'Week 1', 'Week 3']);
    assert.deepEqual(await ranks(), withOld.filter(rank => !rank.startsWith('solo@')));
    // Deleting the series removes every rank of its UID.
    remote.objects.delete(seriesHref);
    await sync();
    assert.deepEqual(await ranks(), []);
    await pool.execute('DELETE e FROM calendar_events e JOIN calendar_calendars c ON c.id = e.calendar_id WHERE c.account_id = ?', [accountId]);
    await pool.execute('DELETE FROM calendar_accounts WHERE id = ?', [accountId]);
  });

  await t.test('restore keeps local order and calendar defaults with remapped ids', async () => {
    await pool.execute('DELETE FROM calendar_events WHERE user_id = ?', [ids.owner]);
    const first = await task(ids.owner, inbox, 'First', { createdMs: t0 });
    const second = await task(ids.owner, inbox, 'Second', { createdMs: t0 + 60000 });
    await owner('PUT', `/calendar/events/${second}/position`, { after: null, before: first });
    await owner('PUT', '/settings/values', { values: { default_task_list_id: inbox, default_calendar_id: inbox } });
    const backup = await runtime('services/backup').buildBackupForUser(ids.owner, { sections: ['settings', 'calendar'] });
    assert.equal(backup.version, 6);

    // Keep both: the copies get their own calendar, events and order rows,
    // and the defaults follow the restored calendar (the calendar id map,
    // never the mail account map).
    const kept = await runtime('services/backup').importBackupForUser(ids.owner, backup, { mode: 'apply', sections: ['settings', 'calendar'], conflict_mode: 'keep_both', startAccountSync: () => {} });
    assert.equal(kept.valid, true, JSON.stringify(kept.errors));
    // The local account is kept beside the original, with its own Inbox.
    const [[copy]] = await pool.query<RowDataPacket[]>("SELECT id FROM calendar_calendars WHERE user_id = ? AND name = 'Inbox' AND id <> ?", [ids.owner, inbox]);
    assert.ok(copy, 'the calendar was kept beside the original');
    const { settings } = await owner('GET', '/settings/values');
    assert.equal(settings.default_task_list_id.value, copy.id);
    assert.equal(settings.default_calendar_id.value, copy.id);
    assert.equal(await orderRows(), 2, 'the restore adds only the archived hand places');
    const restored = (await order()).filter(event => event.calendar_id === copy.id).map(event => [event.title, event.hand_ordered]);
    assert.deepEqual(restored, [['Second', true], ['First', false]]);
    // Restoring again with Keep existing adds no rows.
    const rowsBefore = await orderRows();
    await runtime('services/backup').importBackupForUser(ids.owner, backup, { mode: 'apply', sections: ['settings', 'calendar'], conflict_mode: 'keep_existing', startAccountSync: () => {} });
    assert.equal(await orderRows(), rowsBefore);

    // Settings alone: a calendar still the person's stays; one that names
    // nothing of theirs becomes UniHub's choice.
    await pool.execute("DELETE FROM user_settings WHERE user_id IN (?, ?) AND setting_key IN ('default_task_list_id', 'default_calendar_id')", [ids.owner, ids.stranger]);
    await runtime('services/backup').importBackupForUser(ids.owner, backup, { mode: 'apply', sections: ['settings'], startAccountSync: () => {} });
    assert.equal((await owner('GET', '/settings/values')).settings.default_task_list_id.value, inbox);
    await runtime('services/backup').importBackupForUser(ids.stranger, backup, { mode: 'apply', sections: ['settings'], startAccountSync: () => {} });
    const [strangerRefs] = await pool.query<RowDataPacket[]>("SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key IN ('default_task_list_id', 'default_calendar_id')", [ids.stranger]);
    assert.deepEqual(strangerRefs.map(row => row.setting_value), ['', '']);

    // An archive whose order names a task outside it is refused.
    const broken = structuredClone(backup);
    (broken.data.task_order as FixtureValue[])[0].event_id = crypto.randomUUID();
    const refused = await runtime('services/backup').importBackupForUser(ids.owner, broken, { mode: 'dry-run', sections: ['calendar'] });
    assert.equal(refused.valid, false);
    assert.match(refused.errors.join('\n'), /task order row that names no task/);
  });
  await t.test('a restore on a later day brings back the exact order, next to tasks placed by hand', async () => {
    const chores = await localCalendar(ids.owner, 'Chores');
    const at = (text: string) => Date.parse(`${text}Z`);
    const made: Record<string, string> = {};
    for (const [title, created] of [['First', '2026-10-01T08:00:00'], ['Second', '2026-10-01T08:01:00'], ['Pair A', '2026-10-01T09:00:00'],
      ['Pair B', '2026-10-01T09:00:00'], ['Pair C', '2026-10-01T09:00:00'], ['Close', '2026-10-01T09:00:01'], ['Last', '2026-10-01T10:00:00']] as const) {
      made[title] = await task(ids.owner, chores, title, { createdMs: at(created) });
    }
    const listOf = async (request: FixtureValue, calendarId: string) => (await order(request)).filter(event => event.calendar_id === calendarId)
      .map(event => [event.title, event.hand_ordered]);
    // First goes after Second; Close goes between two tasks of one second.
    await owner('PUT', `/calendar/events/${made.First}/position`, { after: made.Second, before: (await order()).find(event => event.title === 'Pair A' || event.title === 'Pair B' || event.title === 'Pair C')!.id });
    const pairs = (await order()).filter(event => event.title.startsWith('Pair'));
    await owner('PUT', `/calendar/events/${made.Close}/position`, { after: pairs[0].id, before: pairs[1].id });
    const saved = await listOf(owner, chores);
    assert.deepEqual(saved.map(([title]) => title), ['Second', 'First', pairs[0].title, 'Close', pairs[1].title, pairs[2].title, 'Last']);
    const backup = await runtime('services/backup').buildBackupForUser(ids.owner, { sections: ['calendar'] });
    const restoreInto = async (userId: string, conflict_mode: string) => {
      const result = await runtime('services/backup').importBackupForUser(userId, structuredClone(backup), { mode: 'apply', sections: ['calendar'], conflict_mode, startAccountSync: () => {} });
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    };

    // Into a new person, weeks later: new ids, the creation times kept.
    const freshId = crypto.randomUUID();
    await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)', [freshId, 'fresh@example.test', passwordHash, 'fresh']);
    await restoreInto(freshId, 'keep_existing');
    const fresh = await signIn('fresh');
    const [[freshChores]] = await pool.query<RowDataPacket[]>("SELECT id FROM calendar_calendars WHERE user_id = ? AND name = 'Chores'", [freshId]);
    assert.deepEqual(await listOf(fresh, freshChores.id), saved);
    // Only the archived hand places became rows; the rest follows the
    // restored order keys and creation times.
    assert.equal(await orderRows(freshId), (backup.data.task_order as FixtureValue[]).length);

    // Into the same person: Replace keeps the rows, Keep both makes a copy.
    await restoreInto(ids.owner, 'replace');
    assert.deepEqual(await listOf(owner, chores), saved);
    await restoreInto(ids.owner, 'keep_both');
    assert.deepEqual(await listOf(owner, chores), saved);
    const [copies] = await pool.query<RowDataPacket[]>("SELECT id FROM calendar_calendars WHERE user_id = ? AND name LIKE 'Chores%' AND id <> ?", [ids.owner, chores]);
    assert.equal(copies.length, 1);
    assert.deepEqual(await listOf(owner, copies[0].id), saved);
  });

  await t.test('Replace makes the order the archive\'s; Keep existing and Keep both leave the destination\'s', async () => {
    const errands = await localCalendar(ids.owner, 'Shopping');
    const milk = await task(ids.owner, errands, 'Milk', { createdMs: Date.UTC(2026, 9, 2, 8) });
    const bread = await task(ids.owner, errands, 'Bread', { createdMs: Date.UTC(2026, 9, 2, 8, 1) });
    const listOf = async (calendarId: string) => (await order()).filter(event => event.calendar_id === calendarId).map(event => [event.title, event.hand_ordered]);
    const archived = await listOf(errands);
    assert.deepEqual(archived, [['Milk', false], ['Bread', false]]);
    const backup = await runtime('services/backup').buildBackupForUser(ids.owner, { sections: ['calendar'] });
    const restore = async (conflict_mode: string) => {
      const result = await runtime('services/backup').importBackupForUser(ids.owner, structuredClone(backup), { mode: 'apply', sections: ['calendar'], conflict_mode, startAccountSync: () => {} });
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    };
    // Placed after the backup.
    const dragged = [['Bread', true], ['Milk', false]];
    await owner('PUT', `/calendar/events/${bread}/position`, { after: null, before: milk });
    assert.deepEqual(await listOf(errands), dragged);
    // Keep existing: the existing tasks and their order stay.
    await restore('keep_existing');
    assert.deepEqual(await listOf(errands), dragged);
    // Keep both: the original keeps its order, the copy has the archive's.
    await restore('keep_both');
    assert.deepEqual(await listOf(errands), dragged);
    const [[copy]] = await pool.query<RowDataPacket[]>("SELECT id FROM calendar_calendars WHERE user_id = ? AND name = 'Shopping' AND id <> ?", [ids.owner, errands]);
    assert.deepEqual(await listOf(copy.id), archived);
    // Replace: the archive's order, the later placement gone.
    await restore('replace');
    assert.deepEqual(await listOf(errands), archived);
  });

  await t.test('tasks with equal ranks keep their order over a restore with new ids', async () => {
    const ties = await localCalendar(ids.owner, 'Ties');
    // Two ids whose date-rank offsets collide (2467), made in the same second.
    const created = '2026-10-03 08:00:00';
    for (const [id, title] of [['7f0c2c4e-0000-4000-8000-000000000027', 'Twenty-seven'], ['7f0c2c4e-0000-4000-8000-000000000009', 'Nine']]) {
      await pool.execute(`INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time, is_todo_only, created_at)
        VALUES (?, ?, ?, ?, ?, ?, TRUE, ?)`, [id, ids.owner, ties, title, created, created, created]);
    }
    const listOf = async (request: FixtureValue, calendarId: string) => (await order(request)).filter(event => event.calendar_id === calendarId);
    const saved = await listOf(owner, ties);
    assert.equal(saved[0].sort_rank, saved[1].sort_rank, 'the two ranks tie');
    assert.deepEqual(saved.map(event => event.title), ['Nine', 'Twenty-seven'], 'the tie is ordered by the stable key');
    const backup = await runtime('services/backup').buildBackupForUser(ids.owner, { sections: ['calendar'] });
    const tiedId = crypto.randomUUID();
    await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)', [tiedId, 'tied@example.test', passwordHash, 'tied']);
    const result = await runtime('services/backup').importBackupForUser(tiedId, backup, { mode: 'apply', sections: ['calendar'], startAccountSync: () => {} });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    const tied = await signIn('tied');
    const [[restoredTies]] = await pool.query<RowDataPacket[]>("SELECT id FROM calendar_calendars WHERE user_id = ? AND name = 'Ties'", [tiedId]);
    const restored = await listOf(tied, restoredTies.id);
    assert.deepEqual(restored.map(event => [event.title, event.sort_rank, event.sort_key]), saved.map(event => [event.title, event.sort_rank, event.sort_key]));
    assert.ok(restored.every(event => !saved.some(source => source.id === event.id)), 'the restored tasks have new ids');
    assert.equal(await orderRows(tiedId), (backup.data.task_order as FixtureValue[]).length, 'only the archived hand places, no rows for the tie');
  });
});
