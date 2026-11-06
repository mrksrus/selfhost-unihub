import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// Upgrade step 25 on a database of 0.27 (step 24) with the rows real
// installations have: local tasks, a synced event, the occurrences of a
// recurring one, a synced row whose server copy is gone, calendars and
// recordings. Each must get the identity a later restore matches it by, also
// when the step runs again after an interruption, and rows made afterwards
// get one without the code that makes them naming it.
test('upgrade 25 gives every event, calendar and recording its stable identity, also after an interrupted run', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t, { migrate: false });
  const { runMigrations } = require('../dist/src/services/database-migrations') as typeof import('../src/services/database-migrations');
  const { MIGRATIONS } = require('../dist/src/services/database') as typeof import('../src/services/database');
  const { BASELINE } = require('../dist/src/services/database-baseline') as typeof import('../src/services/database-baseline');
  await runMigrations(pool, MIGRATIONS.filter(step => step.id <= 24), BASELINE);

  const id = () => crypto.randomUUID();
  const [alex, blair] = [id(), id()];
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'alex@example.test', 'x'), (?, 'blair@example.test', 'x')", [alex, blair]);
  const [localAccount, serverAccount, blairAccount] = [id(), id(), id()];
  await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider) VALUES (?, ?, 'local'), (?, ?, 'caldav'), (?, ?, 'local')`,
    [localAccount, alex, serverAccount, alex, blairAccount, blair]);
  const [errands, team, blairList] = [id(), id(), id()];
  await pool.execute(`INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id) VALUES (?, ?, ?, 'Errands', NULL), (?, ?, ?, 'Team', '/dav/team/'), (?, ?, ?, 'Errands', NULL)`,
    [errands, alex, localAccount, team, alex, serverAccount, blairList, blair, blairAccount]);
  const event = async (user: string, calendar: string, title: string) => {
    const eventId = id();
    await pool.execute("INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time) VALUES (?, ?, ?, ?, '2026-11-02 09:00:00', '2026-11-02 10:00:00')", [eventId, user, calendar, title]);
    return eventId;
  };
  const synced = async (eventId: string, key: string, objectId: string | null) => pool.execute(`INSERT INTO calendar_event_external_refs
    (id, user_id, event_id, calendar_id, account_id, provider, external_event_id, remote_object_id) VALUES (?, ?, ?, ?, ?, 'caldav', ?, ?)`, [id(), alex, eventId, team, serverAccount, key, objectId]);
  const local = await event(alex, errands, 'Buy stamps');
  const blairs = await event(blair, blairList, 'Buy stamps');
  const single = await event(alex, team, 'Planning');
  const [weeklyA, weeklyB] = [await event(alex, team, 'Weekly'), await event(alex, team, 'Weekly')];
  const orphan = await event(alex, team, 'Copy gone');
  const [singleObject, weeklyObject] = [id(), id()];
  const uidOfWeekly = 'weekly-' + 'x'.repeat(300) + '@example.test';
  for (const [objectId, uid] of [[singleObject, 'planning@example.test'], [weeklyObject, uidOfWeekly]]) {
    await pool.execute(`INSERT INTO calendar_remote_objects (id, user_id, account_id, calendar_id, href, href_hash, uid, ics) VALUES (?, ?, ?, ?, ?, ?, ?, 'BEGIN:VCALENDAR')`,
      [objectId, alex, serverAccount, team, `/dav/team/${objectId}.ics`, crypto.createHash('sha256').update(objectId).digest('hex'), uid]);
  }
  await synced(single, `${singleObject}`, singleObject);
  await synced(weeklyA, `${weeklyObject}:1`, weeklyObject);
  await synced(weeklyB, `${weeklyObject}:2`, weeklyObject);
  await synced(orphan, 'legacy-ref', null);
  const recording = id();
  await pool.execute("INSERT INTO recordings (id, user_id, title, content_type, storage_path) VALUES (?, ?, 'Interview', 'audio/webm', 'recordings/x.webm')", [recording, alex]);

  // Each row's modification date from before the upgrade, which filling in the identity must keep.
  const modified = '2029-05-06 07:08:09';
  for (const table of ['calendar_events', 'calendar_calendars', 'recordings']) await pool.execute(`UPDATE ${table} SET updated_at = ?`, [modified]);

  // An interrupted step 25: the first column and part of the backfill ran, the step was not recorded.
  await pool.execute('ALTER TABLE calendar_events ADD COLUMN uid VARCHAR(500) NULL');
  await pool.execute('UPDATE calendar_events SET uid = id, updated_at = updated_at WHERE id = ?', [local]);
  await runMigrations(pool, MIGRATIONS, BASELINE);

  const [[step]] = await pool.query<RowDataPacket[]>('SELECT name FROM schema_migrations WHERE id = 25');
  assert.equal(step.name, 'backup-store-and-safety');
  const [events] = await pool.query<RowDataPacket[]>('SELECT id, uid FROM calendar_events');
  const uidOf = new Map(events.map(row => [row.id, row.uid]));
  assert.equal(uidOf.get(local), local, 'a local task keeps its id as identity');
  assert.equal(uidOf.get(blairs), blairs);
  assert.equal(uidOf.get(single), 'planning@example.test', 'a synced event takes its iCal UID');
  assert.equal(uidOf.get(weeklyA), uidOfWeekly, 'every occurrence shares the UID, at its full length');
  assert.equal(uidOf.get(weeklyB), uidOfWeekly);
  assert.equal(uidOf.get(orphan), orphan, 'a synced row without its server copy still gets an identity');
  const [calendars] = await pool.query<RowDataPacket[]>('SELECT id, uid FROM calendar_calendars');
  for (const row of calendars) assert.equal(row.uid, row.id);
  const [[recorded]] = await pool.query<RowDataPacket[]>('SELECT uid FROM recordings WHERE id = ?', [recording]);
  assert.equal(recorded.uid, recording);

  for (const table of ['calendar_events', 'calendar_calendars', 'recordings']) {
    const [dates] = await pool.query<RowDataPacket[]>(`SELECT DISTINCT DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS at FROM ${table}`);
    assert.deepEqual(dates.map(row => row.at), [modified], `${table} keeps its modification dates`);
  }

  // UIDs compare exactly: two that differ only in case or a trailing space are two items.
  const upper = await event(alex, errands, 'Upper');
  const lower = await event(alex, errands, 'Lower');
  const spaced = await event(alex, errands, 'Spaced');
  await pool.execute('UPDATE calendar_events SET uid = ? WHERE id = ?', ['Task@example.test', upper]);
  await pool.execute('UPDATE calendar_events SET uid = ? WHERE id = ?', ['task@example.test', lower]);
  await pool.execute('UPDATE calendar_events SET uid = ? WHERE id = ?', ['Task@example.test ', spaced]);
  const [exact] = await pool.query<RowDataPacket[]>('SELECT id FROM calendar_events WHERE user_id = ? AND uid = ?', [alex, 'Task@example.test']);
  assert.deepEqual(exact.map(row => row.id), [upper]);
  const [trailing] = await pool.query<RowDataPacket[]>('SELECT id FROM calendar_events WHERE user_id = ? AND uid = ?', [alex, 'Task@example.test ']);
  assert.deepEqual(trailing.map(row => row.id), [spaced]);

  // Rows made after the upgrade by code that does not name an identity get a new one each.
  const [later, later2] = [await event(alex, errands, 'New task'), await event(alex, errands, 'New task')];
  const [fresh] = await pool.query<RowDataPacket[]>('SELECT uid FROM calendar_events WHERE id IN (?, ?)', [later, later2]);
  assert.equal(new Set(fresh.map(row => row.uid)).size, 2);
  for (const row of fresh) assert.match(row.uid, /^[0-9a-f-]{36}$/);
  await assert.rejects(pool.execute('UPDATE recordings SET uid = NULL WHERE id = ?', [recording]), /cannot be null|ER_BAD_NULL/i);

  // Starting again finds the step done.
  await runMigrations(pool, MIGRATIONS, BASELINE);
  const [[count]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 25');
  assert.equal(Number(count.n), 1);
});

// A backup queued before the upgrade was asked for when every backup held
// downloaded mail; "Include downloaded mail" did not exist yet. Resumed
// after the upgrade, it still holds that mail.
test('upgrade 25: an export queued before it still includes downloaded mail', { skip: !process.env.MYSQL_TEST_HOST, timeout: 120000 }, async t => {
  const fs = require('node:fs/promises') as typeof import('node:fs/promises');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const { createBackupRuntime } = require('./helpers/isolated-backup-runtime.cts');
  const pool = await withTestDatabase(t, { migrate: false });
  const { runMigrations } = require('../dist/src/services/database-migrations') as typeof import('../src/services/database-migrations');
  const { MIGRATIONS } = require('../dist/src/services/database') as typeof import('../src/services/database');
  const { BASELINE } = require('../dist/src/services/database-baseline') as typeof import('../src/services/database-baseline');
  await runMigrations(pool, MIGRATIONS.filter(step => step.id <= 24), BASELINE);
  const id = () => crypto.randomUUID();
  const [owner, account, jobId] = [id(), id(), id()];
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'queued@example.test', 'x')", [owner]);
  await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode) VALUES (?, ?, 'inbox@example.test', 'custom', 'download')", [account, owner]);
  await pool.execute("INSERT INTO emails (id, user_id, mail_account_id, subject, from_address, to_addresses, folder) VALUES (?, ?, ?, 'Downloaded message', 'sender@example.test', '[]', 'inbox')", [id(), owner, account]);
  await pool.execute("INSERT INTO data_export_jobs (id, user_id, scope, status, requested_sections, encryption_enabled) VALUES (?, ?, 'full', 'queued', '[\"mail\"]', 0)", [jobId, owner]);
  await runMigrations(pool, MIGRATIONS, BASELINE);
  const [[queued]] = await pool.query<RowDataPacket[]>('SELECT include_download_mail FROM data_export_jobs WHERE id = ?', [jobId]);
  assert.equal(Number(queued.include_download_mail), 1);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-queued-export-'));
  const runtime = createBackupRuntime(directory, 'queued-export-synthetic-key', pool);
  try {
    const jobs = runtime('services/export-jobs');
    await jobs.resumePendingDataExportJobs({ schedule: false });
    await jobs.runDataExportJob(jobId);
    const job = await jobs.getDataExportJob(owner, jobId);
    assert.equal(job.status, 'ready', job.error);
    const [[key]] = await pool.query<RowDataPacket[]>('SELECT server_wrapped_key FROM backup_archive_keys WHERE export_job_id = ?', [jobId]);
    const container = runtime('services/backup-container');
    const zip = path.join(directory, 'queued.zip');
    await container.decryptBackupFile(job.file_path, zip, container.unwrapDataKeyFromServer(key.server_wrapped_key, job.backup_uuid));
    const { backup } = await runtime('services/backup').backupFromZipFile(zip);
    assert.deepEqual(backup.data.emails.map((row: { subject: string }) => row.subject), ['Downloaded message']);
    assert.deepEqual(backup.contents.left_out, []);
  } finally {
    await runtime('services/side-pools').endSidePools(pool);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// 0.27 cut a synced object's UID to 500 UTF-16 code units, so two items whose
// UIDs agree that far (250 and 251 emoji; 500 and 501 letters) shared one.
// After the upgrade each is keyed by its own UID, or by its own row when no
// column holds it: a backup and a Replace restore, before and after a full
// sync, give neither the other's ToDo state or subtasks.
test('upgrade 25: items 0.27 gave one cut UID are told apart, and a restore gives neither the other\'s state', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const fs = require('node:fs/promises') as typeof import('node:fs/promises');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const { createBackupRuntime } = require('./helpers/isolated-backup-runtime.cts');
  const { installCalDavFake, insertCalDavAccount, eventIcs, WORK } = require('./helpers/caldav-fake.cts');
  const pool = await withTestDatabase(t, { migrate: false });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-cut-uid-'));
  const runtime = createBackupRuntime(directory, 'cut-uid-synthetic-key', pool);
  t.after(async () => {
    await runtime('services/side-pools').endSidePools(pool);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const { runMigrations } = runtime('services/database-migrations');
  const { MIGRATIONS } = runtime('services/database');
  const { BASELINE } = runtime('services/database-baseline');
  await runMigrations(pool, MIGRATIONS.filter((step: { id: number }) => step.id <= 24), BASELINE);
  const id = () => crypto.randomUUID();
  const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
  const [owner, account, calendar] = [id(), id(), id()];
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'cut-uid@example.test', 'x')", [owner]);
  const { encrypt } = runtime('security/encryption');
  await insertCalDavAccount(pool, encrypt, owner, account);
  await pool.execute("INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id, read_only) VALUES (?, ?, ?, 'Work', ?, 0)", [calendar, owner, account, WORK]);
  const server = installCalDavFake(runtime('services/caldav'));
  // A synced item as 0.27 left it: its object with the UID cut, the event row, the link.
  const item = async (uid: string, title: string, hour: number, done: boolean) => {
    const [eventId, objectId, href] = [id(), id(), `${WORK}${hash(title).slice(0, 12)}.ics`];
    const ics = eventIcs(uid, title, Date.UTC(2026, 10, 12, hour));
    server.store(href, ics);
    await pool.execute(`INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time, todo_status, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [eventId, owner, calendar, title, `2026-11-12 ${hour}:00:00`, `2026-11-12 ${hour}:30:00`, done ? 'done' : null, done ? '2026-11-01 08:00:00' : null]);
    if (done) await pool.execute("INSERT INTO calendar_event_subtasks (id, user_id, event_id, title, is_done, position) VALUES (?, ?, ?, ?, 1, 0)", [id(), owner, eventId, `Step of ${title}`]);
    await pool.execute('INSERT INTO calendar_remote_objects (id, user_id, account_id, calendar_id, href, href_hash, etag, uid, ics) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [objectId, owner, account, calendar, href, hash(href), server.remote.objects.get(href).etag, uid.slice(0, 500), ics]);
    await pool.execute(`INSERT INTO calendar_event_external_refs (id, user_id, event_id, calendar_id, account_id, provider, external_event_id, remote_object_id)
      VALUES (?, ?, ?, ?, ?, 'caldav', ?, ?)`, [id(), owner, eventId, calendar, account, `${objectId}|`, objectId]);
    return eventId;
  };
  const cases = [
    { label: 'emoji', short: '🦊'.repeat(250), long: '🦊'.repeat(251), keepable: true },
    { label: 'letters', short: 'q'.repeat(500), long: 'q'.repeat(501), keepable: false },
  ].map(entry => ({ ...entry, shortId: '', longId: '' }));
  for (const [index, entry] of cases.entries()) {
    // Only the item whose UID is the short one has UniHub state.
    entry.shortId = await item(entry.short, `Short ${entry.label}`, 9 + index * 2, true);
    entry.longId = await item(entry.long, `Long ${entry.label}`, 10 + index * 2, false);
  }
  await runMigrations(pool, MIGRATIONS, BASELINE);

  const rowOf = async (eventId: string) => {
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT uid, todo_status, (SELECT COUNT(*) FROM calendar_event_subtasks s WHERE s.event_id = e.id) AS steps FROM calendar_events e WHERE id = ?', [eventId]);
    return row;
  };
  const check = async (moment: string) => {
    for (const entry of cases) {
      const short = await rowOf(entry.shortId), long = await rowOf(entry.longId);
      assert.deepEqual([short.uid, short.todo_status, Number(short.steps)], [entry.short, 'done', 1], `${moment}, ${entry.label}: the short item keeps its own`);
      assert.equal(long.uid, entry.keepable ? entry.long : entry.longId, `${moment}, ${entry.label}: the long item by its own UID, or its own row`);
      assert.deepEqual([long.todo_status, Number(long.steps)], [null, 0], `${moment}, ${entry.label}: and none of the short item's state`);
    }
  };
  await check('after the upgrade');
  const [[unkept]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM calendar_remote_objects WHERE user_id = ? AND uid IS NULL", [owner]);
  assert.equal(Number(unkept.n), 1, 'the object whose UID no column holds has none');

  // An unmodified backup, restored with Replace, then again after a full sync.
  const backup = runtime('services/backup');
  const archive = await backup.buildBackupForUser(owner, { sections: ['calendar'], includeFileData: false });
  const restore = async () => {
    const result = await backup.importBackupForUser(owner, structuredClone(archive), { mode: 'apply', sections: ['calendar'], conflict_mode: 'replace', startAccountSync: async () => {} });
    assert.equal(result.valid, true, JSON.stringify(result));
  };
  await restore();
  await check('after a Replace restore');
  await pool.execute('UPDATE calendar_accounts SET is_active = TRUE, encrypted_password = ? WHERE id = ?', [encrypt('synthetic-dav-password'), account]);
  await runtime('services/calendar-sync').syncCalendarAccount(account, { userId: owner, full: true });
  await check('after a full sync');
  await restore();
  await check('after the restore that follows it');
});
