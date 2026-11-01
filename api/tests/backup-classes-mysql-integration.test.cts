import type { FixtureValue } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime.cts');

const uuid = () => crypto.randomUUID();

// User backups by data class (0.28) on the real database: what an archive
// holds of mail by account mode and the "Include downloaded mail" choice;
// local tasks matched by their stable UID wherever they moved (B-34), also
// when two UIDs differ only in case; and UniHub's state on synced tasks,
// applied to the live task or kept for the sync.
test('backups by data class: Download mail choice, UID matching and synced-task state', { skip: !process.env.MYSQL_TEST_HOST, timeout: 120000 }, async (t) => {
  const database = process.env.MYSQL_TEST_DATABASE || 'unihub_test';
  assert.match(database, /_test$/, 'Use an empty disposable database ending in _test');
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database,
    user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password', timezone: '+00:00', connectionLimit: 4 });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-backup-classes-'));
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
  const runtime = createBackupRuntime(directory, 'backup-classes-synthetic-key', pool);
  await runtime('services/database').ensureSchema();
  const backup = runtime('services/backup');
  const insert = async (table: string, row: FixtureValue) => {
    const columns = Object.keys(row);
    await pool.execute<ResultSetHeader>(`INSERT INTO ${table} (${columns.map(name => '`' + name + '`').join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, Object.values(row));
  };
  const newUser = async (label: string) => {
    const id = uuid();
    await insert('users', { id, email: `${label}@example.test`, password_hash: 'synthetic-hash', full_name: label, role: 'user' });
    return id;
  };
  const rows = async (sql: string, params: unknown[]) => (await pool.query<RowDataPacket[]>(sql, params))[0];
  const restore = async (userId: string, archive: FixtureValue, conflict_mode: string, sections = ['calendar']) => {
    const result = await backup.importBackupForUser(userId, structuredClone(archive), { mode: 'apply', sections, conflict_mode, startAccountSync: () => {} });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    return result;
  };
  const localList = async (userId: string, name: string) => {
    let [[account]] = await pool.query<RowDataPacket[]>("SELECT id FROM calendar_accounts WHERE user_id = ? AND provider = 'local'", [userId]);
    if (!account) { account = { id: uuid() } as RowDataPacket; await insert('calendar_accounts', { id: account.id, user_id: userId, provider: 'local', display_name: 'UniHub', is_active: 1 }); }
    const id = uuid();
    await insert('calendar_calendars', { id, user_id: userId, account_id: account.id, name, color: '#22c55e', is_visible: 1 });
    return id;
  };

  await t.test('mail: Download mail by choice, always for an account that deletes at the provider, Sync mail only when UniHub holds the only copy', async () => {
    const owner = await newUser('mail-owner');
    const stranger = await newUser('mail-stranger');
    const accounts = { kept: uuid(), deletes: uuid(), sync: uuid() };
    await insert('mail_accounts', { id: accounts.kept, user_id: owner, email_address: 'kept@example.test', provider: 'custom', sync_mode: 'download', delete_emails_on_server: 0 });
    await insert('mail_accounts', { id: accounts.deletes, user_id: owner, email_address: 'deletes@example.test', provider: 'custom', sync_mode: 'download', delete_emails_on_server: 1 });
    await insert('mail_accounts', { id: accounts.sync, user_id: owner, email_address: 'sync@example.test', provider: 'custom', sync_mode: 'sync', delete_emails_on_server: 0 });
    await insert('mail_accounts', { id: uuid(), user_id: stranger, email_address: 'other@example.test', provider: 'custom', sync_mode: 'download', delete_emails_on_server: 1 });
    const email = async (subject: string, accountId: string, extra: FixtureValue = {}) => {
      const id = uuid();
      await insert('emails', { id, user_id: owner, mail_account_id: accountId, subject, from_address: 'sender@example.test', to_addresses: '[]', folder: 'inbox', ...extra });
      return id;
    };
    await email('Downloaded', accounts.kept, { imap_uid: 1, imap_uidvalidity: 7 });
    await email('Only copy', accounts.deletes, { imap_uid: 2, imap_uidvalidity: 7 });
    const synced = await email('On the server', accounts.sync, { imap_uid: 3, imap_uidvalidity: 7 });
    await email('Draft', accounts.sync, { is_draft: 1 });
    await insert('email_attachments', { id: uuid(), user_id: owner, email_id: synced, filename: 'server.pdf', content_type: 'application/pdf', size_bytes: 3 });
    await insert('mail_email_scores', { id: uuid(), user_id: owner, email_id: synced, score_version: 'v1', total_score: 1, reasons: '[]', metadata: '{}' });

    const choice = await runtime('services/backup-classes').downloadMailChoice(owner);
    assert.deepEqual(choice, { value: true, forced: false, reason: 'Accounts that delete mail at the provider always include their downloaded mail.', forced_account_ids: [accounts.deletes] });

    const subjects = (archive: FixtureValue) => archive.data.emails.map((row: FixtureValue) => row.subject).sort();
    const without = await backup.buildBackupForUser(owner, { sections: ['mail'], includeFileData: false, includeDownloadMail: false });
    assert.deepEqual(subjects(without), ['Draft', 'Only copy']);
    assert.deepEqual(without.data.email_attachments, [], 'the server copy\'s files stay with it');
    assert.deepEqual(without.data.mail_email_scores, []);
    assert.deepEqual(without.data.mail_accounts.map((row: FixtureValue) => row.id).sort(), Object.values(accounts).sort(), 'every account\'s settings');
    assert.deepEqual(without.contents.left_out.map((row: FixtureValue) => [row.what, row.count]), [['Sync-mode mail', 1], ['Downloaded mail', 1]]);
    assert.ok(without.contents.included.includes('local-by-policy'));

    const withMail = await backup.buildBackupForUser(owner, { sections: ['mail'], includeFileData: false });
    assert.deepEqual(subjects(withMail), ['Downloaded', 'Draft', 'Only copy']);
    assert.deepEqual(withMail.contents.left_out.map((row: FixtureValue) => [row.what, row.count]), [['Sync-mode mail', 1]]);

    // An administrator's policy includes downloaded mail whatever the choice.
    await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', 'policy.backup.download_mail', 'always', 1)");
    try {
      const forced = await runtime('services/backup-classes').downloadMailChoice(owner);
      assert.deepEqual([forced.value, forced.forced, forced.reason], [true, true, 'Your backups always include downloaded mail, as your administrator requires.']);
      const declined = await backup.buildBackupForUser(owner, { sections: ['mail'], includeFileData: false, includeDownloadMail: false });
      assert.deepEqual(subjects(declined), ['Downloaded', 'Draft', 'Only copy']);
    } finally { await pool.execute("DELETE FROM setting_policies WHERE setting_key = 'policy.backup.download_mail'"); }
  });

  await t.test('local tasks: a moved task restores onto itself (B-34), twice into a new person gives no copies, UIDs differing in case or a trailing space stay apart', async () => {
    const owner = await newUser('task-owner');
    const errands = await localList(owner, 'Errands');
    const work = await localList(owner, 'Work');
    const moved = uuid();
    await insert('calendar_events', { id: moved, user_id: owner, calendar_id: errands, uid: 'Task@example.test', title: 'Post the letter', start_time: '2030-04-01 09:00:00', end_time: '2030-04-01 09:15:00', is_todo_only: 1 });
    await insert('calendar_events', { id: uuid(), user_id: owner, calendar_id: errands, uid: 'task@example.test', title: 'Water the plants', start_time: '2030-04-02 09:00:00', end_time: '2030-04-02 09:15:00', is_todo_only: 1 });
    await insert('calendar_events', { id: uuid(), user_id: owner, calendar_id: errands, uid: 'Task@example.test ', title: 'Feed the cat', start_time: '2030-04-03 09:00:00', end_time: '2030-04-03 09:15:00', is_todo_only: 1 });
    await insert('calendar_event_subtasks', { id: uuid(), user_id: owner, event_id: moved, title: 'Buy a stamp', is_done: 0, position: 0 });
    const archive = await backup.buildBackupForUser(owner, { sections: ['calendar'], includeFileData: false });
    assert.deepEqual(archive.data.calendar_events.map((row: FixtureValue) => row.uid).sort(), ['Task@example.test', 'Task@example.test ', 'task@example.test']);

    // After the backup the task moves to Work and is renamed.
    await pool.execute('UPDATE calendar_events SET calendar_id = ?, title = ? WHERE id = ?', [work, 'Post the parcel', moved]);
    const tasks = () => rows('SELECT id, uid, calendar_id, title FROM calendar_events WHERE user_id = ? ORDER BY BINARY uid', [owner]);
    await restore(owner, archive, 'keep_existing');
    assert.deepEqual((await tasks()).map(row => [row.id, row.uid, row.calendar_id, row.title]).find(row => row[0] === moved), [moved, 'Task@example.test', work, 'Post the parcel'],
      'Keep existing keeps the moved task as it is now');
    assert.equal((await tasks()).length, 3, 'no copy in the archived list');
    await restore(owner, archive, 'replace');
    assert.deepEqual((await tasks()).find(row => row.id === moved), { id: moved, uid: 'Task@example.test', calendar_id: errands, title: 'Post the letter' },
      'Replace puts the archived task back, in its archived list');
    assert.equal((await tasks()).length, 3);
    assert.equal((await rows('SELECT COUNT(*) AS n FROM calendar_event_subtasks WHERE event_id = ?', [moved]))[0].n, 1);

    // Into a new person, twice: the second restore finds each task by its UID.
    const fresh = await newUser('task-fresh');
    await restore(fresh, archive, 'keep_existing');
    await restore(fresh, archive, 'keep_existing');
    const restored = await rows('SELECT uid, title FROM calendar_events WHERE user_id = ? ORDER BY BINARY uid', [fresh]);
    assert.deepEqual(restored.map(row => [row.uid, row.title]), [['Task@example.test', 'Post the letter'], ['Task@example.test ', 'Feed the cat'], ['task@example.test', 'Water the plants']]);
    assert.equal((await rows('SELECT COUNT(*) AS n FROM calendar_calendars WHERE user_id = ?', [fresh]))[0].n, 2);
    // Keep both copies them under new UIDs, so a later restore still finds the originals.
    await restore(fresh, archive, 'keep_both');
    const doubled = await rows('SELECT uid FROM calendar_events WHERE user_id = ?', [fresh]);
    assert.equal(doubled.length, 6);
    assert.equal(new Set(doubled.map(row => row.uid)).size, 6);
  });

  await t.test('synced tasks: the state goes onto the live task (Keep existing fills gaps, Replace overwrites) or waits for the sync', async () => {
    const owner = await newUser('synced-owner');
    const accountId = uuid(), calendarId = uuid(), taskId = uuid();
    await insert('calendar_accounts', { id: accountId, user_id: owner, provider: 'caldav', display_name: 'Team', account_email: 'team@example.test', base_url: 'https://dav.example.test/', is_active: 1 });
    await insert('calendar_calendars', { id: calendarId, user_id: owner, account_id: accountId, name: 'Team', external_id: 'https://dav.example.test/team/', color: '#2244ff', is_visible: 1 });
    await insert('calendar_events', { id: taskId, user_id: owner, calendar_id: calendarId, uid: 'Synced@example.test', title: 'Review draft', start_time: '2030-05-01 10:00:00', end_time: '2030-05-01 11:00:00',
      todo_status: 'done', done_at: '2030-05-01 12:00:00' });
    await insert('calendar_event_external_refs', { id: uuid(), user_id: owner, event_id: taskId, calendar_id: calendarId, account_id: accountId, provider: 'caldav', external_event_id: 'review.ics', external_etag: 'one' });
    for (const [position, title] of ['Read', 'Comment'].entries()) await insert('calendar_event_subtasks', { id: uuid(), user_id: owner, event_id: taskId, title, is_done: position === 0 ? 1 : 0, position });
    const archive = await backup.buildBackupForUser(owner, { sections: ['calendar'], includeFileData: false });
    assert.deepEqual(archive.data.calendar_events, [], 'the provider holds the task');
    assert.deepEqual(archive.data.calendar_event_external_refs, []);
    assert.equal(archive.data.calendar_overlay_restores.length, 1);
    assert.deepEqual(archive.contents.left_out.map((row: FixtureValue) => [row.what, row.count]), [['CalDAV and subscription events', 1]]);

    const state = async () => {
      const [[task]] = await pool.query<RowDataPacket[]>('SELECT todo_status, done_at FROM calendar_events WHERE id = ?', [taskId]);
      const subtasks = await rows('SELECT title, is_done FROM calendar_event_subtasks WHERE event_id = ? ORDER BY position', [taskId]);
      return [task.todo_status, task.done_at && new Date(task.done_at).toISOString(), subtasks.map(row => `${row.title}:${row.is_done}`)];
    };
    // The state was lost locally: Keep existing brings it back onto the live task.
    await pool.execute('UPDATE calendar_events SET todo_status = NULL, done_at = NULL WHERE id = ?', [taskId]);
    await pool.execute('DELETE FROM calendar_event_subtasks WHERE event_id = ?', [taskId]);
    const filled = await restore(owner, archive, 'keep_existing');
    assert.deepEqual(await state(), ['done', '2030-05-01T12:00:00.000Z', ['Read:1', 'Comment:0']]);
    assert.equal((await rows('SELECT COUNT(*) AS n FROM calendar_overlay_restores WHERE user_id = ?', [owner]))[0].n, 0, 'nothing waits');
    assert.equal(filled.notes.some((note: string) => /when the calendar syncs/.test(note)), false);
    // A newer state is kept by Keep existing and overwritten by Replace.
    await pool.execute("UPDATE calendar_events SET todo_status = 'cancelled', done_at = NULL WHERE id = ?", [taskId]);
    await pool.execute("UPDATE calendar_event_subtasks SET title = 'Rewritten' WHERE event_id = ?", [taskId]);
    await restore(owner, archive, 'keep_existing');
    assert.deepEqual(await state(), ['cancelled', null, ['Rewritten:1', 'Rewritten:0']]);
    await restore(owner, archive, 'replace');
    assert.deepEqual(await state(), ['done', '2030-05-01T12:00:00.000Z', ['Read:1', 'Comment:0']]);

    // Into a new person the task is not there yet: the state waits, once, for the sync.
    const fresh = await newUser('synced-fresh');
    const waiting = await restore(fresh, archive, 'keep_existing');
    await restore(fresh, archive, 'keep_existing');
    const pending = await rows(`SELECT o.uid, o.match_kind, o.expires_at, c.name FROM calendar_overlay_restores o JOIN calendar_calendars c ON c.id = o.calendar_id AND c.user_id = o.user_id
      WHERE o.user_id = ?`, [fresh]);
    assert.deepEqual(pending.map(row => [row.uid, row.match_kind, row.expires_at, row.name]), [['Synced@example.test', 'uid', null, 'Team']]);
    assert.ok(waiting.notes.some((note: string) => /1 synced task gets its ToDo state and subtasks back when the calendar syncs/.test(note)));
    assert.equal((await rows('SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ?', [fresh]))[0].n, 0, 'the restore never writes a synced task itself');
    // A backup before that sync carries the waiting state on.
    const again = await backup.buildBackupForUser(fresh, { sections: ['calendar'], includeFileData: false });
    assert.deepEqual(again.data.calendar_overlay_restores.map((row: FixtureValue) => row.uid), ['Synced@example.test']);

    // A task made from a downloaded message: restored with the mail, the waiting state names the message's new id.
    const mailAccount = uuid(), message = uuid();
    await insert('mail_accounts', { id: mailAccount, user_id: owner, email_address: 'inbox@example.test', provider: 'custom', sync_mode: 'download' });
    await insert('mail_folders', { id: uuid(), user_id: owner, slug: 'inbox', display_name: 'Inbox', position: 0, is_system: 1 });
    await insert('emails', { id: message, user_id: owner, mail_account_id: mailAccount, subject: 'Draft for review', from_address: 'colleague@example.test', to_addresses: '[]', folder: 'inbox' });
    await pool.execute('UPDATE calendar_events SET source_email_id = ? WHERE id = ?', [message, taskId]);
    const withMail = await backup.buildBackupForUser(owner, { sections: ['calendar', 'mail'], includeFileData: false });
    const reader = await newUser('synced-mail-reader');
    await restore(reader, withMail, 'keep_existing', ['calendar', 'mail']);
    const [[restoredMessage]] = await pool.query<RowDataPacket[]>('SELECT id FROM emails WHERE user_id = ?', [reader]);
    assert.notEqual(restoredMessage.id, message);
    const [[overlay]] = await pool.query<RowDataPacket[]>("SELECT JSON_VALUE(payload, '$.source_email_id') AS email FROM calendar_overlay_restores WHERE user_id = ?", [reader]);
    assert.equal(overlay.email, restoredMessage.id);
  });
});
