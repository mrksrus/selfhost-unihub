import type { FixtureValue } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime.cts');

const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const fixtureId = (n: number) => `02710000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// The frozen encrypted full archive of 0.27.1 (data schema 6, fixtures/backups/v6-0.27.1)
// through the production restore job on another installation: it imports
// only what a 0.28 backup holds and says what it left out. Its CalDAV events
// stay out with their children, the done task's state waits for the sync as
// a shape overlay, and the Sync account's server mail stays out with its
// files and provider evidence. Local items keep their archived ids as their
// stable identity, so restoring it again adds nothing.
test('frozen 0.27.1 archive imports what the data classes keep, with a note of what it left out', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async (t) => {
  const database = process.env.MYSQL_TEST_DATABASE || 'unihub_test';
  assert.match(database, /_test$/, 'Use an empty disposable database ending in _test');
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database,
    user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password', timezone: '+00:00', connectionLimit: 4 });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-backup-v6-'));
  let owned = false;
  t.after(async () => {
    try {
      if (owned) {
        const connection = await pool.getConnection();
        try {
          await connection.query('SET FOREIGN_KEY_CHECKS = 0');
          const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES');
          for (const row of tables) await connection.query('DROP TABLE ??', [Object.values(row)[0]]);
        } finally { await connection.query('SET FOREIGN_KEY_CHECKS = 1'); connection.release(); }
      }
    } finally {
      await pool.end();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  const [existing] = await pool.query<RowDataPacket[]>('SHOW TABLES');
  assert.equal(existing.length, 0, 'Refusing to change a nonempty database');
  owned = true;

  const fixture = path.join(__dirname, 'fixtures/backups/v6-0.27.1');
  const expected = JSON.parse(await fs.readFile(path.join(fixture, 'expected.json'), 'utf8'));
  const bytes = await fs.readFile(path.join(fixture, 'full.unihub-backup'));
  assert.equal(sha256(bytes), expected.sha256, 'the frozen archive is unchanged');

  const runtime = createBackupRuntime(directory, 'v6-destination-synthetic-key', pool);
  await runtime('services/database').ensureSchema();
  const userId = crypto.randomUUID();
  await pool.execute<ResultSetHeader>("INSERT INTO users (id, email, password_hash, full_name) VALUES (?, 'v6-reader@example.test', 'synthetic-hash', 'Reader')", [userId]);
  // The folders every account gets at sign-up.
  await runtime('services/mail-folders').ensureDefaultMailFoldersForUser(userId);
  const jobs = runtime('services/backup-restore-jobs');
  async function waitFor(read: () => Promise<FixtureValue>, done: (job: FixtureValue) => boolean, what: string) {
    const deadline = Date.now() + 60000;
    for (;;) {
      const job = await read();
      if (done(job)) return job;
      if (job?.status === 'failed') assert.fail(`${what}: ${job.error}`);
      if (Date.now() > deadline) assert.fail(`${what} timed out: ${JSON.stringify(job)}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  async function restore(conflict_mode: string) {
    const upload = path.join(directory, crypto.randomUUID() + '.upload');
    await fs.writeFile(upload, bytes);
    const created = await jobs.createUploadedRestoreJob(userId, upload, { sections: 'full', conflict_mode, credentials_mode: 'restore' });
    if (created.status === 'awaiting_password') assert.equal((await jobs.unlockRestoreJob(userId, created.id, expected.recovery_password)).error, undefined);
    const validated = await waitFor(() => jobs.getRestoreJob(userId, created.id), job => job?.status === 'validated', 'Validation');
    // The review before the restore already says what the archive leaves out.
    const review = typeof validated.validation_result === 'string' ? JSON.parse(validated.validation_result) : validated.validation_result;
    assert.deepEqual(review.contents.left_out.map((item: FixtureValue) => [item.what, item.count]), [['CalDAV and subscription events', 3], ['Sync-mode mail', 1]]);
    assert.equal((await jobs.startRestoreJob(userId, created.id)).error, undefined);
    const completed = await waitFor(() => jobs.getRestoreJob(userId, created.id), job => job?.status === 'completed', 'Restore');
    return typeof completed.result_counts === 'string' ? JSON.parse(completed.result_counts) : completed.result_counts;
  }
  const rows = async (sql: string) => (await pool.query<RowDataPacket[]>(sql, [userId]))[0];

  const result = await restore('keep_existing');
  assert.deepEqual(result.contents.left_out.map((item: FixtureValue) => [item.what, item.count]), [['CalDAV and subscription events', 3], ['Sync-mode mail', 1]]);
  assert.ok(result.notes.some((note: string) => /Provider data is not in this backup/.test(note)));
  assert.ok(result.notes.some((note: string) => /1 synced task gets its ToDo state and subtasks back when the calendar syncs/.test(note)));

  // Local tasks, with the archived ids as their identity.
  const events = await rows('SELECT uid, title, calendar_id, todo_status FROM calendar_events WHERE user_id = ? ORDER BY title');
  assert.deepEqual(events.map(row => [row.title, row.uid]), [['Buy stamps', fixtureId(23)], ['Pay invoice', fixtureId(25)], ['Quarterly plan', fixtureId(26)]]);
  assert.deepEqual((await rows('SELECT title FROM calendar_event_subtasks WHERE user_id = ?')).map(row => row.title), ['Find the envelope']);
  assert.deepEqual(await rows('SELECT id FROM calendar_event_attendees WHERE user_id = ?'), [], 'the synced event\'s attendee stays with it');
  assert.deepEqual(await rows('SELECT id FROM calendar_event_external_refs WHERE user_id = ?'), []);
  // The CalDAV account and its calendar come back, to sync again.
  const calendars = await rows('SELECT c.id, c.name, a.provider FROM calendar_calendars c JOIN calendar_accounts a ON a.id = c.account_id WHERE c.user_id = ? ORDER BY c.name');
  assert.deepEqual(calendars.map(row => [row.name, row.provider]), [['Errands', 'local'], ['Team', 'caldav'], ['Work', 'local']]);

  // The done synced task's state waits as a shape overlay for 30 days.
  const overlays = await rows(`SELECT calendar_id, match_kind, uid, shape_title, shape_start, payload, TIMESTAMPDIFF(DAY, UTC_TIMESTAMP(), expires_at) AS days
    FROM calendar_overlay_restores WHERE user_id = ?`);
  assert.equal(overlays.length, 1, 'only the task with UniHub state');
  const [overlay] = overlays;
  assert.deepEqual([overlay.calendar_id, overlay.match_kind, overlay.uid, overlay.shape_title, new Date(overlay.shape_start).toISOString()],
    [calendars.find(row => row.name === 'Team')!.id, 'shape', null, 'Review draft', '2030-02-04T09:00:00.000Z']);
  assert.ok(overlay.days >= 29 && overlay.days <= 30);
  const state = typeof overlay.payload === 'string' ? JSON.parse(overlay.payload) : overlay.payload;
  assert.deepEqual([state.todo_status, state.done_at, JSON.parse(state.source_email_json).subject], ['done', '2030-02-04 11:00:00', 'Draft for review']);
  assert.deepEqual(state.subtasks, [{ title: 'Read section one', is_done: true, position: 0 }, { title: 'Write comments', is_done: false, position: 1 }]);

  // Mail: the Download account's message and the Sync account's own sent copy, with their raw files.
  const emails = await rows('SELECT e.subject, e.raw_storage_path, e.raw_sha256, a.sync_mode FROM emails e JOIN mail_accounts a ON a.id = e.mail_account_id WHERE e.user_id = ? ORDER BY e.subject');
  assert.deepEqual(emails.map(row => [row.subject, row.sync_mode]), [['Downloaded message', 'download'], ['My own sent copy', 'sync']]);
  for (const email of emails) assert.equal(sha256(await fs.readFile(email.raw_storage_path)), email.raw_sha256);
  assert.deepEqual(await rows('SELECT id FROM email_attachments WHERE user_id = ?'), [], 'the server copy\'s attachment stays with it');
  for (const table of ['mail_remote_mailboxes', 'mail_remote_occurrences']) assert.deepEqual(await rows(`SELECT id FROM ${table} WHERE user_id = ?`), [], table);
  assert.equal((await rows('SELECT COUNT(*) AS n FROM mail_accounts WHERE user_id = ?'))[0].n, 2);
  const restoredFiles = await fs.readdir(path.join(directory, 'attachments', userId)).catch(() => []);
  assert.deepEqual(restoredFiles, []);

  // The contact and the recording, the recording with its archived id as identity.
  assert.deepEqual((await rows('SELECT first_name FROM contacts WHERE user_id = ?')).map(row => row.first_name), ['Zoë']);
  assert.deepEqual((await rows('SELECT title, uid FROM recordings WHERE user_id = ?')).map(row => [row.title, row.uid]), [['Interview', fixtureId(70)]]);

  // Restoring the same archive again finds every item; the waiting state is kept once.
  const before = await Promise.all(['calendar_events', 'calendar_event_subtasks', 'calendar_calendars', 'emails', 'contacts', 'recordings', 'calendar_overlay_restores']
    .map(async table => [table, (await rows(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`))[0].n]));
  await restore('keep_existing');
  const after = await Promise.all(before.map(async ([table]) => [table, (await rows(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`))[0].n]));
  assert.deepEqual(after, before);
});
