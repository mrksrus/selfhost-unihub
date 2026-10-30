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

// Moving a task to another list (0.27, slice 3) through the real request
// handler and database, with the installed CalDAV peer replaced by an
// in-memory server that keeps If-None-Match/If-Match and can lose answers.
// Every path keeps the one event row (its ToDo state, subtasks, source email
// and hand place) and leaves the item once at the server and once in UniHub,
// also when the target's answer is lost, the old copy cannot be removed, or
// the process stops between the server write and the local commit.
const BASE = 'https://dav.example.test';
const HOME = '/dav/calendars/person/';
const WORK = `${HOME}work/`;
const PRIVATE = `${HOME}private/`;
const DAY = 86400000;

function icsDate(ms: number) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function eventIcs(uid: string, title: string, startMs: number, extra: string[] = []) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//UniHub test//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T000000Z',
    `DTSTART:${icsDate(startMs)}`, `DTEND:${icsDate(startMs + 3600000)}`, `SUMMARY:${title}`, ...extra, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const davError = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);
const conflictError = () => davError('The event was changed on the calendar server in the meantime.', { status: 409, code: 'CALDAV_CONFLICT' });

test('moving a task between lists and calendars: one copy, the same row, through every partial failure', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  assert.match((process.env.MYSQL_TEST_DATABASE as string), /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE,
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, connectionLimit: 8, timezone: 'Z' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-calendar-move-'));
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
  const runtime = createBackupRuntime(directory, 'calendar-move-synthetic-key', pool);
  await runtime('services/database').ensureSchema();
  await runtime('services/data-inventory').verifyDatabaseInventory(pool);
  // A branch database made an earlier journal, which nothing wrote to: step 24
  // run again replaces it, and repeats without harm.
  const step24 = (runtime('services/database').MIGRATIONS as FixtureValue[]).find(migration => migration.id === 24);
  const repeat = await pool.getConnection();
  try {
    await repeat.execute('DROP TABLE calendar_event_moves');
    await repeat.execute('CREATE TABLE calendar_event_moves (id CHAR(36) NOT NULL PRIMARY KEY, event_id CHAR(36) NOT NULL)');
    await step24.up(repeat); await step24.up(repeat); await step24.verify(repeat);
  } finally { repeat.release(); }

  // --- The calendar server: two calendars of one account ---------------------
  const remote = { version: 1, objects: new Map<string, { etag: string; ics: string }>(), writes: [] as string[][] };
  const faults: { put?: (path: string) => 'store-then-lose' | 'lose' | 'refuse' | void; remove?: (path: string) => 'fail' | void } = {};
  let etags = 0;
  const pathOf = (url: string) => decodeURIComponent(new URL(url).pathname);
  const store = (objectPath: string, ics: string) => { remote.objects.set(objectPath, { etag: `"e${++etags}"`, ics }); remote.version += 1; };
  const copiesOf = (title: string) => [...remote.objects].filter(([, object]) => object.ics.includes(`SUMMARY:${title}\r\n`)).map(([objectPath]) => objectPath);
  const caldav = runtime('services/caldav');
  caldav.listCalendars = async () => [
    { href: WORK, url: `${BASE}${WORK}`, displayName: 'Work', ctag: String(remote.version), readOnly: false },
    { href: PRIVATE, url: `${BASE}${PRIVATE}`, displayName: 'Private', ctag: String(remote.version), readOnly: false },
  ];
  caldav.listCalendarObjects = async ({ calendarUrl }: FixtureValue) => [...remote.objects].filter(([objectPath]) => objectPath.startsWith(pathOf(calendarUrl)))
    .map(([href, object]) => ({ href, url: `${BASE}${href}`, etag: object.etag }));
  caldav.fetchCalendarObjects = async ({ objects }: FixtureValue) => objects.filter((item: FixtureValue) => remote.objects.has(item.href))
    .map((item: FixtureValue) => ({ href: item.href, etag: remote.objects.get(item.href)!.etag, ics: remote.objects.get(item.href)!.ics }));
  caldav.resourceGone = async ({ url, kind }: FixtureValue) => kind === 'calendar' ? ![WORK, PRIVATE].includes(pathOf(url)) : !remote.objects.has(pathOf(url));
  caldav.getCalendarObject = async ({ url }: FixtureValue) => {
    const object = remote.objects.get(pathOf(url));
    return object ? { ...object } : null;
  };
  caldav.putCalendarObject = async ({ url, ics, etag }: FixtureValue) => {
    const objectPath = pathOf(url);
    remote.writes.push(['put', objectPath]);
    const fault = faults.put?.(objectPath);
    if (fault === 'lose') throw davError('socket hang up', {});
    if (fault === 'refuse') throw davError('CalDAV request failed (403)', { status: 403 });
    const current = remote.objects.get(objectPath);
    if (etag ? current?.etag !== etag : current) throw conflictError();
    store(objectPath, ics);
    if (fault === 'store-then-lose') throw davError('The operation was aborted due to timeout', { name: 'TimeoutError' });
    return { etag: remote.objects.get(objectPath)!.etag };
  };
  caldav.deleteCalendarObject = async ({ url, etag }: FixtureValue) => {
    const objectPath = pathOf(url);
    remote.writes.push(['delete', objectPath]);
    if (faults.remove?.(objectPath) === 'fail') throw davError('read ECONNRESET', {});
    const current = remote.objects.get(objectPath);
    if (!current) return;
    if (etag && current.etag !== etag) throw conflictError();
    remote.objects.delete(objectPath);
    remote.version += 1;
  };

  // --- People, lists and requests --------------------------------------------
  const password = 'calendar-move-fixture-password';
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
  const calendarSync = runtime('services/calendar-sync');
  const calendarMove = runtime('services/calendar-move');

  async function localList(userId: string, name: string) {
    const [[account]] = await pool.query<RowDataPacket[]>("SELECT id FROM calendar_accounts WHERE user_id = ? AND provider = 'local' LIMIT 1", [userId]);
    let accountId = account?.id;
    if (!accountId) {
      accountId = crypto.randomUUID();
      await pool.execute("INSERT INTO calendar_accounts (id, user_id, provider, display_name, is_active) VALUES (?, ?, 'local', 'Local Calendar', TRUE)", [accountId, userId]);
    }
    const id = crypto.randomUUID();
    await pool.execute("INSERT INTO calendar_calendars (id, user_id, account_id, name, color, auto_todo_enabled) VALUES (?, ?, ?, ?, '#22c55e', TRUE)", [id, userId, accountId, name]);
    return id;
  }
  const inbox = await localList(ids.owner, 'Inbox');
  const errands = await localList(ids.owner, 'Errands');
  const theirList = await localList(ids.stranger, 'Theirs');

  const accountId = crypto.randomUUID();
  await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, display_name, username, encrypted_password, base_url, provider_config, is_active)
    VALUES (?, ?, 'caldav', 'owner@dav.example.test', 'Work server', 'owner', ?, ?, ?, TRUE)`,
  [accountId, ids.owner, encrypt('synthetic-dav-password'), `${BASE}${HOME}`, JSON.stringify({ server: { url: BASE, source: 'discovered', label: 'dav.example.test' }, principalHref: '/dav/principals/person/' })]);
  const sync = (full = false) => calendarSync.syncCalendarAccount(accountId, { userId: ids.owner, full });
  // The daily expansion: every object applied again.
  const expandAll = async () => { await pool.execute('UPDATE calendar_calendars SET remote_expanded_on = NULL WHERE account_id = ?', [accountId]); return sync(); };
  await sync();
  await pool.execute('UPDATE calendar_calendars SET auto_todo_enabled = TRUE WHERE account_id = ?', [accountId]);
  const calendarId = async (name: string) => (await pool.query<RowDataPacket[]>('SELECT id FROM calendar_calendars WHERE account_id = ? AND name = ?', [accountId, name]))[0][0].id as string;
  const work = await calendarId('Work');
  const privateCalendar = await calendarId('Private');

  let clock = Date.UTC(2026, 10, 2, 9);
  // A dated task with what UniHub keeps of its own: done, subtasks, source email.
  async function localTask(title: string, list = inbox, { undated = false, recurrence = null as string | null, done = true } = {}) {
    const id = crypto.randomUUID();
    clock += 3600000;
    await pool.execute(`INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time, is_todo_only, recurrence, todo_status, done_at, source_email_id, source_email_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ids.owner, list, title, sqlTime(clock), sqlTime(clock + 1800000), undated, recurrence, done ? 'done' : null, done ? sqlTime(clock - DAY) : null, crypto.randomUUID(),
      JSON.stringify({ subject: `About ${title}`, from_name: 'Sender', from_address: 'sender@example.test', received_at: null, attachments: [], account: null, draft: false, to: null })]);
    for (const [position, subtask] of ['First step', 'Second step'].entries()) {
      await pool.execute('INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position) VALUES (?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), id, ids.owner, subtask, position === 0, position]);
    }
    return id;
  }
  // A task that starts at the server, synced into a row.
  async function serverTask(title: string, calendarPath = WORK, extra: string[] = []) {
    clock += 3600000;
    store(`${calendarPath}${title.toLowerCase().replace(/\W+/g, '-')}.ics`, eventIcs(`${crypto.randomUUID()}@example.test`, title, clock, extra));
    await sync();
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT id FROM calendar_events WHERE user_id = ? AND title = ?', [ids.owner, title]);
    await pool.execute("UPDATE calendar_events SET todo_status = 'done', done_at = ? WHERE id = ?", [sqlTime(clock - DAY), row.id]);
    await pool.execute('INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position) VALUES (?, ?, ?, ?, TRUE, 0)', [crypto.randomUUID(), row.id, ids.owner, 'Only step']);
    return row.id as string;
  }
  // What UniHub keeps of its own, compared before and after a move.
  async function kept(eventId: string) {
    const [[event]] = await pool.query<RowDataPacket[]>('SELECT id, todo_status, done_at, source_email_id FROM calendar_events WHERE id = ?', [eventId]);
    const [subtasks] = await pool.query<RowDataPacket[]>('SELECT title, is_done FROM calendar_event_subtasks WHERE event_id = ? ORDER BY position', [eventId]);
    return { ...event, subtasks: subtasks.map(row => [row.title, !!row.is_done]) } as FixtureValue;
  }
  const rowsTitled = async (title: string) => (await pool.query<RowDataPacket[]>('SELECT id, calendar_id FROM calendar_events WHERE user_id = ? AND title = ?', [ids.owner, title]))[0];
  const journal = async (eventId?: string) => (await pool.query<RowDataPacket[]>(
    `SELECT * FROM calendar_event_moves WHERE user_id = ?${eventId ? ' AND event_id = ?' : ''}`, eventId ? [ids.owner, eventId] : [ids.owner]))[0];
  // Due now, as the sync pass would find it later.
  const resume = async () => {
    await pool.execute('UPDATE calendar_event_moves SET next_attempt_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND');
    return calendarMove.resumeDueMoves();
  };
  // Exactly once in UniHub, in this calendar, and linked to its server copy there (if any).
  async function assertOnce(title: string, eventId: string, calendar: string, { copies = 1 } = {}) {
    const rows = await rowsTitled(title);
    assert.deepEqual(rows.map(row => [row.id, row.calendar_id]), [[eventId, calendar]], `${title}: one row, the same one, in the new calendar`);
    assert.equal(copiesOf(title).length, copies, `${title}: ${copies} copy at the server`);
    const [links] = await pool.query<RowDataPacket[]>(
      'SELECT o.calendar_id, o.href FROM calendar_event_external_refs r JOIN calendar_remote_objects o ON o.id = r.remote_object_id WHERE r.event_id = ?', [eventId]);
    if (copies) assert.deepEqual(links.map(link => [link.calendar_id, link.href]), [[calendar, copiesOf(title)[0]]]);
    else assert.equal(links.length, 0);
  }

  await t.test('UniHub list to server calendar: the same row, its state and hand place, one copy', async () => {
    const pay = await localTask('Pay rent', inbox, { done: false });
    const call = await localTask('Call plumber', inbox, { done: false });
    // A hand place, then the move: it keeps its place in All lists.
    await owner('PUT', `/calendar/events/${call}/position`, { after: null, before: pay });
    const before = await kept(call);
    const moved = await owner('POST', `/calendar/events/${call}/move`, { calendar_id: work });
    assert.equal(moved.event.calendar_id, work);
    assert.equal(moved.pending, undefined);
    assert.equal(moved.event.hand_ordered, true, 'the hand place moved with it');
    assert.deepEqual(await kept(call), before);
    await assertOnce('Call plumber', call, work);
    const [[rank]] = await pool.query<RowDataPacket[]>('SELECT event_id, calendar_id, remote_uid FROM task_order WHERE user_id = ?', [ids.owner]);
    assert.equal(rank.event_id, null, 'now keyed by its server identity');
    assert.equal(rank.calendar_id, work);
    assert.equal(await journal().then(rows => rows.length), 0);
    // A sync and the daily expansion find it, and add nothing.
    await sync(); await expandAll();
    await assertOnce('Call plumber', call, work);
    assert.deepEqual(await kept(call), before);
    const { events } = await owner('GET', '/calendar/events?include_todos=true&include_done=true');
    assert.equal(events.find((event: FixtureValue) => event.id === call).hand_ordered, true);
  });

  await t.test('server calendar to another, and back to a UniHub list: old copies removed, row kept', async () => {
    const review = await serverTask('Review notes');
    const before = await kept(review);
    remote.writes.length = 0;
    const toPrivate = await owner('POST', `/calendar/events/${review}/move`, { calendar_id: privateCalendar });
    assert.equal(toPrivate.event.calendar_id, privateCalendar);
    assert.deepEqual(remote.writes.map(([kind, at]) => [kind, at.startsWith(PRIVATE) ? 'private' : 'work']), [['put', 'private'], ['delete', 'work']],
      'created in the target before it was removed from the source');
    await assertOnce('Review notes', review, privateCalendar);
    assert.match(copiesOf('Review notes')[0], new RegExp(`^${PRIVATE}[0-9a-f-]{36}\\.ics$`), 'under a new UID');
    await sync(); await expandAll();
    await assertOnce('Review notes', review, privateCalendar);

    const toList = await owner('POST', `/calendar/events/${review}/move`, { calendar_id: errands });
    assert.equal(toList.event.calendar_id, errands);
    await assertOnce('Review notes', review, errands, { copies: 0 });
    assert.equal((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM calendar_remote_objects WHERE account_id = ?', [accountId]))[0][0].n, 1, 'only the first test\'s copy is stored');
    await sync(); await expandAll();
    await assertOnce('Review notes', review, errands, { copies: 0 });
    assert.deepEqual(await kept(review), before);
    assert.equal((await journal()).length, 0);
    // Between UniHub lists only the list changes.
    await owner('POST', `/calendar/events/${review}/move`, { calendar_id: inbox });
    await assertOnce('Review notes', review, inbox, { copies: 0 });
  });

  await t.test('a lost answer from the target: waits, then adopts the copy the server stored (by retry and by the sync pass)', async () => {
    for (const via of ['retry', 'pass']) {
      const title = `Book flights by ${via}`;
      const book = await localTask(title);
      const before = await kept(book);
      faults.put = () => 'store-then-lose';
      const pending = await owner('POST', `/calendar/events/${book}/move`, { calendar_id: work }, 202);
      faults.put = undefined;
      assert.equal(pending.pending, 'creating');
      assert.equal(pending.event.calendar_id, inbox, 'shown in its old list until the server confirmed');
      const [open] = await journal(book);
      assert.equal(open.state, 'creating');
      assert.equal(open.attempts, 1);
      assert.equal(copiesOf(title).length, 1, 'the server did store it');
      // Meanwhile an edit or deletion would be lost or come back: refused.
      assert.equal((await owner('PUT', `/calendar/events/${book}`, { title: 'Renamed' }, 409)).code, 'CALENDAR_MOVE_PENDING');
      assert.equal((await owner('DELETE', `/calendar/events/${book}`, undefined, 409)).code, 'CALENDAR_MOVE_PENDING');
      assert.equal((await owner('POST', `/calendar/events/${book}/move`, { calendar_id: privateCalendar }, 409)).code, 'CALENDAR_MOVE_PENDING');
      // Its own ToDo state still changes.
      await owner('PUT', `/calendar/events/${book}/todo-status`, { todo_status: null });
      await owner('PUT', `/calendar/events/${book}/todo-status`, { todo_status: 'done' });
      before.done_at = (await kept(book)).done_at;

      remote.writes.length = 0;
      if (via === 'retry') {
        const done = await owner('POST', `/calendar/events/${book}/move`, { calendar_id: work });
        assert.equal(done.event.calendar_id, work);
      } else {
        assert.equal((await resume()).resumed, 1);
      }
      assert.deepEqual(remote.writes, [['put', open.target_href]], 'the same address again, and no new UID');
      await assertOnce(title, book, work);
      assert.equal(copiesOf(title)[0], open.target_href);
      assert.deepEqual(await kept(book), before);
      assert.equal((await journal(book)).length, 0);
      await sync(); await expandAll();
      await assertOnce(title, book, work);
    }
  });

  await t.test('stopped between the server write and the local commit: the next sync links the copy to the moved row', async () => {
    const title = 'Water plants';
    const water = await serverTask(title);
    const before = await kept(water);
    // The copy is stored and the answer lost, as when the process stops before it commits.
    faults.put = () => 'store-then-lose';
    await owner('POST', `/calendar/events/${water}/move`, { calendar_id: privateCalendar }, 202);
    faults.put = undefined;
    assert.equal(copiesOf(title).length, 2, 'old and new copy at the server');
    // The sync finds the new copy first: no second row, the move goes on to removing.
    await sync();
    const [open] = await journal(water);
    assert.equal(open.state, 'removing');
    assert.deepEqual((await rowsTitled(title)).map(row => [row.id, row.calendar_id]), [[water, privateCalendar]]);
    // The sync pass removes the old copy.
    await resume();
    await assertOnce(title, water, privateCalendar);
    assert.equal((await journal()).length, 0);
    assert.deepEqual(await kept(water), before);
    await sync(); await expandAll();
    await assertOnce(title, water, privateCalendar);
  });

  await t.test('the old copy cannot be removed: never shown twice, removed later, even after the task is deleted', async () => {
    for (const deleteMeanwhile of [false, true]) {
      const title = deleteMeanwhile ? 'Renew passport' : 'Fix bike';
      const task = await serverTask(title);
      const before = await kept(task);
      const [oldPath] = copiesOf(title);
      faults.remove = objectPath => objectPath === oldPath ? 'fail' : undefined;
      const answer = await owner('POST', `/calendar/events/${task}/move`, { calendar_id: privateCalendar }, 202);
      assert.equal(answer.pending, 'removing');
      assert.equal(answer.event.calendar_id, privateCalendar, 'already in its new calendar');
      assert.equal(copiesOf(title).length, 2);
      // Neither an incremental sync nor the daily expansion shows the old copy again.
      remote.version += 1;
      await sync(); await expandAll(); await sync(true);
      assert.deepEqual((await rowsTitled(title)).map(row => [row.id, row.calendar_id]), [[task, privateCalendar]]);
      assert.deepEqual(await kept(task), before);
      // Still failing: the pass waits longer each time.
      await resume();
      const [waiting] = await journal(task);
      assert.equal(waiting.attempts, 2);
      assert.match(waiting.last_error, /ECONNRESET/);
      if (deleteMeanwhile) {
        await owner('DELETE', `/calendar/events/${task}`);
        assert.deepEqual(copiesOf(title).length, 1, 'the new copy is deleted, the old one waits');
        const [orphan] = await journal();
        assert.equal(orphan.event_id, null, 'the move outlives its task');
      }
      faults.remove = undefined;
      await resume();
      assert.equal((await journal()).length, 0);
      if (deleteMeanwhile) {
        assert.equal(copiesOf(title).length, 0);
        assert.equal((await rowsTitled(title)).length, 0);
      } else {
        await assertOnce(title, task, privateCalendar);
      }
      await sync(); await expandAll();
      assert.equal((await rowsTitled(title)).length, deleteMeanwhile ? 0 : 1, 'nothing comes back');
    }
  });

  await t.test('the old copy changed elsewhere since: kept there as an event of its own', async () => {
    const title = 'Plan offsite';
    const plan = await serverTask(title);
    const [oldPath] = copiesOf(title);
    // Edited in another client after UniHub last read it.
    faults.remove = objectPath => {
      if (objectPath === oldPath) remote.objects.set(oldPath, { etag: '"elsewhere"', ics: eventIcs('offsite@example.test', `${title} (edited elsewhere)`, clock) });
    };
    const answer = await owner('POST', `/calendar/events/${plan}/move`, { calendar_id: errands });
    faults.remove = undefined;
    assert.equal(answer.source_kept, true);
    assert.equal(answer.event.calendar_id, errands);
    assert.equal((await journal()).length, 0);
    await sync();
    assert.deepEqual((await rowsTitled(title)).map(row => [row.id, row.calendar_id]), [[plan, errands]], 'the moved row stays');
    const elsewhere = await rowsTitled(`${title} (edited elsewhere)`);
    assert.equal(elsewhere.length, 1, 'the changed old copy shows in its calendar');
    assert.equal(elsewhere[0].calendar_id, work);

    // Changed elsewhere while the move waited for the new server, and read
    // by a sync meanwhile: still not deleted.
    const retreat = await serverTask('Team retreat');
    const [retreatPath] = copiesOf('Team retreat');
    faults.put = () => 'lose';
    await owner('POST', `/calendar/events/${retreat}/move`, { calendar_id: privateCalendar }, 202);
    faults.put = undefined;
    store(retreatPath, eventIcs('retreat@example.test', 'Team retreat (new venue)', clock));
    await sync();
    assert.deepEqual((await rowsTitled('Team retreat (new venue)')).map(row => row.id), [retreat], 'the sync updated the waiting row in place');
    assert.equal((await resume()).resumed, 1);
    assert.equal((await journal()).length, 0);
    await sync();
    assert.deepEqual((await rowsTitled('Team retreat')).map(row => [row.id, row.calendar_id]), [[retreat, privateCalendar]], 'moved as it was when the move started');
    assert.equal(copiesOf('Team retreat (new venue)').length, 1, 'the change made elsewhere is kept at the server');
    assert.deepEqual((await rowsTitled('Team retreat (new venue)')).map(row => row.calendar_id), [work], 'and shows in its calendar');
  });

  await t.test('the event dialog\'s calendar change uses the same move, with the edited fields in the new copy', async () => {
    const title = 'Dentist';
    const dentist = await localTask(title);
    const start = new Date(Date.UTC(2026, 11, 1, 8)).toISOString();
    const saved = await owner('PUT', `/calendar/events/${dentist}`, { calendar_id: work, title: `${title} (moved)`, start_time: start, end_time: new Date(Date.UTC(2026, 11, 1, 9)).toISOString() });
    assert.equal(saved.event.calendar_id, work);
    assert.equal(saved.event.title, `${title} (moved)`);
    await assertOnce(`${title} (moved)`, dentist, work);
    assert.match(remote.objects.get(copiesOf(`${title} (moved)`)[0])!.ics, /DTSTART:20261201T080000Z/);
    // A lost answer through this path answers 202 too, and a retry adopts.
    const other = await localTask('Optician');
    faults.put = () => 'store-then-lose';
    const pending = await owner('PUT', `/calendar/events/${other}`, { calendar_id: work, title: 'Optician (moved)' }, 202);
    faults.put = undefined;
    assert.equal(pending.pending, 'creating');
    await owner('PUT', `/calendar/events/${other}`, { calendar_id: work });
    await assertOnce('Optician (moved)', other, work);
  });

  await t.test('refusals change nothing at the server or in UniHub', async () => {
    remote.writes.length = 0;
    const objectsBefore = new Map(remote.objects);
    const undated = await localTask('Someday idea', inbox, { undated: true });
    assert.equal((await owner('POST', `/calendar/events/${undated}/move`, { calendar_id: work }, 400)).code, 'CALENDAR_TODO_REMOTE');
    // A task without a date may go to another UniHub list.
    await owner('POST', `/calendar/events/${undated}/move`, { calendar_id: errands });
    const weekly = await localTask('Weekly review', inbox, { recurrence: 'FREQ=WEEKLY' });
    assert.equal((await owner('POST', `/calendar/events/${weekly}/move`, { calendar_id: work }, 400)).code, 'CALENDAR_RECURRING_MOVE');
    const series = await serverTask('Standup', WORK, ['RRULE:FREQ=DAILY;COUNT=3']);
    assert.equal((await owner('POST', `/calendar/events/${series}/move`, { calendar_id: inbox }, 400)).code, 'CALENDAR_RECURRING_MOVE');
    // A read-only target, and a subscription as target or source.
    const pay = await localTask('Pay invoice');
    await pool.execute('UPDATE calendar_calendars SET read_only = TRUE WHERE id = ?', [privateCalendar]);
    assert.equal((await owner('POST', `/calendar/events/${pay}/move`, { calendar_id: privateCalendar }, 403)).code, 'CALENDAR_READ_ONLY');
    await pool.execute('UPDATE calendar_calendars SET read_only = FALSE WHERE id = ?', [privateCalendar]);
    const feedAccount = crypto.randomUUID(), feed = crypto.randomUUID(), feedEvent = crypto.randomUUID();
    await pool.execute("INSERT INTO calendar_accounts (id, user_id, provider, display_name, is_active) VALUES (?, ?, 'ics', 'Holidays', TRUE)", [feedAccount, ids.owner]);
    await pool.execute("INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id, read_only) VALUES (?, ?, ?, 'Holidays', 'https://feeds.example.test/h.ics', TRUE)", [feed, ids.owner, feedAccount]);
    assert.equal((await owner('POST', `/calendar/events/${pay}/move`, { calendar_id: feed }, 403)).code, 'CALENDAR_READ_ONLY');
    await pool.execute("INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time) VALUES (?, ?, ?, 'Holiday', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [feedEvent, ids.owner, feed]);
    assert.equal((await owner('POST', `/calendar/events/${feedEvent}/move`, { calendar_id: inbox }, 403)).code, 'CALENDAR_READ_ONLY');
    await calendarSync.deleteCalendarAccount(ids.owner, feedAccount);
    // A paused account, and one without its login.
    await pool.execute('UPDATE calendar_accounts SET is_active = FALSE WHERE id = ?', [accountId]);
    assert.equal((await owner('POST', `/calendar/events/${pay}/move`, { calendar_id: work }, 409)).code, 'CALENDAR_SYNC_PAUSED');
    await pool.execute('UPDATE calendar_accounts SET is_active = TRUE, encrypted_password = NULL WHERE id = ?', [accountId]);
    assert.equal((await owner('POST', `/calendar/events/${pay}/move`, { calendar_id: work }, 409)).code, 'CALDAV_NO_PASSWORD');
    const linkedTask = (await rowsTitled('Plan offsite (edited elsewhere)'))[0].id;
    assert.equal((await owner('POST', `/calendar/events/${linkedTask}/move`, { calendar_id: inbox }, 409)).code, 'CALDAV_NO_PASSWORD', 'the source login is checked before anything is written');
    await pool.execute('UPDATE calendar_accounts SET encrypted_password = ? WHERE id = ?', [encrypt('synthetic-dav-password'), accountId]);
    // Linked before 0.17 and not synced since.
    const legacy = crypto.randomUUID();
    await pool.execute("INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time) VALUES (?, ?, ?, 'Old import', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [legacy, ids.owner, work]);
    await pool.execute("INSERT INTO calendar_event_external_refs (id, user_id, event_id, calendar_id, account_id, provider, external_event_id) VALUES (?, ?, ?, ?, ?, 'caldav', 'old-import')",
      [crypto.randomUUID(), ids.owner, legacy, work, accountId]);
    assert.equal((await owner('POST', `/calendar/events/${legacy}/move`, { calendar_id: inbox }, 409)).code, 'CALENDAR_SYNC_PENDING');
    // The server refuses the new copy: nothing waits, nothing moved.
    faults.put = () => 'refuse';
    assert.equal((await owner('POST', `/calendar/events/${pay}/move`, { calendar_id: work }, 422)).code, 'CALDAV_FORBIDDEN');
    faults.put = undefined;
    assert.equal((await rowsTitled('Pay invoice'))[0].calendar_id, inbox);
    assert.deepEqual(remote.writes, [['put', remote.writes[0][1]]], 'only the refused write');
    assert.deepEqual([...remote.objects.keys()].sort(), [...objectsBefore.keys(), ...copiesOf('Standup')].sort());
    assert.equal((await journal()).length, 0);
    // Malformed requests.
    await owner('POST', `/calendar/events/${pay}/move`, {}, 400);
    await owner('POST', `/calendar/events/${pay}/move`, { calendar_id: 'inbox' }, 400);
    await owner('POST', '/calendar/events/not-an-id/move', { calendar_id: inbox }, 404);
  });

  await t.test('owner and stranger: neither moves the other\'s task, nor into the other\'s list', async () => {
    const mine = await localTask('Mine to move');
    assert.equal((await stranger('POST', `/calendar/events/${mine}/move`, { calendar_id: theirList }, 404)).code, 'TASK_NOT_FOUND');
    assert.equal((await owner('POST', `/calendar/events/${mine}/move`, { calendar_id: theirList }, 404)).code, 'CALENDAR_NOT_FOUND');
    assert.equal((await stranger('PUT', `/calendar/events/${mine}`, { calendar_id: theirList }, 404)).error, 'Event not found');
    await owner('PUT', `/calendar/events/${mine}`, { calendar_id: theirList }, 400);
    assert.equal((await rowsTitled('Mine to move'))[0].calendar_id, inbox);
  });

  await t.test('the Calendar module and a calendar restore stop the route and the background move', async () => {
    const title = 'Call bank';
    const bank = await localTask(title);
    await setUserModules(ids.owner, { modules: { calendar: { enabled: false } } });
    assert.equal((await owner('POST', `/calendar/events/${bank}/move`, { calendar_id: work }, 403)).code, 'MODULE_DISABLED');
    await setUserModules(ids.owner, { modules: { calendar: { enabled: true } } });
    const restoreId = crypto.randomUUID();
    await pool.execute("INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', ?)", [restoreId, ids.owner, JSON.stringify(['calendar'])]);
    assert.equal((await owner('POST', `/calendar/events/${bank}/move`, { calendar_id: work }, 409)).code, 'RESTORE_IN_PROGRESS');
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreId]);

    // A move waiting for the server does not go on while either holds.
    faults.put = () => 'lose';
    await owner('POST', `/calendar/events/${bank}/move`, { calendar_id: work }, 202);
    faults.put = undefined;
    remote.writes.length = 0;
    await setUserModules(ids.owner, { modules: { calendar: { enabled: false } } });
    assert.equal((await resume()).resumed, 0);
    await setUserModules(ids.owner, { modules: { calendar: { enabled: true } } });
    await pool.execute("INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', ?)", [restoreId, ids.owner, JSON.stringify(['calendar'])]);
    assert.equal((await resume()).resumed, 0);
    assert.deepEqual(remote.writes, []);
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreId]);
    // The sync pass goes on with it afterwards.
    await pool.execute('UPDATE calendar_event_moves SET next_attempt_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND');
    await pool.execute('UPDATE calendar_accounts SET next_sync_at = UTC_TIMESTAMP() + INTERVAL 1 HOUR WHERE id = ?', [accountId]);
    await calendarSync.runCalendarSyncPass();
    await assertOnce(title, bank, work);
    assert.equal((await journal()).length, 0);
  });

  await t.test('removing the calendar ends a move that needs it', async () => {
    const title = 'Sort photos';
    const photos = await localTask(title);
    faults.put = () => 'lose';
    await owner('POST', `/calendar/events/${photos}/move`, { calendar_id: privateCalendar }, 202);
    faults.put = undefined;
    // The person removes the target from UniHub: the move ends, the task
    // stays, and can be edited again at once.
    await calendarSync.deleteCalendarsWithEvents(pool, ids.owner, [privateCalendar]);
    assert.deepEqual((await rowsTitled(title)).map(row => row.calendar_id), [inbox]);
    await owner('PUT', `/calendar/events/${photos}`, { title: `${title} again` });
    remote.writes.length = 0;
    await resume();
    assert.equal((await journal()).length, 0);
    assert.deepEqual(remote.writes, []);
  });
});
