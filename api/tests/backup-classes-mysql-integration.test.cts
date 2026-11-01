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
test('backups by data class: Download mail choice, UID matching and synced-task state', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async (t) => {
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

  await t.test('mail: Download mail by choice, always for an account that deletes at the provider, Sync mail only when the provider holds a live copy', async () => {
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
    // The Sync account's INBOX as the last LIST saw it (epoch 7), and copies in it.
    const inbox = uuid();
    await insert('mail_remote_mailboxes', { id: inbox, user_id: owner, mail_account_id: accounts.sync, remote_name: 'INBOX', delimiter: '/', uidvalidity: 7, state: 'active' });
    const occurrence = (emailId: string, uid: number, { uidvalidity = 7, presence = 'present' } = {}) => insert('mail_remote_occurrences', {
      id: uuid(), user_id: owner, mail_account_id: accounts.sync, mailbox_id: inbox, uidvalidity, uid, email_id: emailId, presence, observed_at: '2030-01-01 00:00:00' });
    const attachment = async (emailId: string, filename: string) => {
      const id = uuid(), bytes = crypto.randomBytes(16);
      const stored = path.join(directory, 'attachments', owner, `${id}.bin`);
      await fs.mkdir(path.dirname(stored), { recursive: true });
      await fs.writeFile(stored, bytes);
      await insert('email_attachments', { id, user_id: owner, email_id: emailId, filename, content_type: 'application/octet-stream', size_bytes: bytes.length, storage_path: stored });
    };
    const linked = (uid: number, uidvalidity = 7) => ({ remote_folder: 'INBOX', remote_uid: uid, remote_uidvalidity: uidvalidity, imap_uid: uid, imap_uidvalidity: uidvalidity });
    await email('Downloaded', accounts.kept, { imap_uid: 1, imap_uidvalidity: 7 });
    await email('Only copy', accounts.deletes, { imap_uid: 2, imap_uidvalidity: 7 });
    // The provider's copy, which a re-sync brings back: the only Sync message a backup leaves out.
    const synced = await email('On the server', accounts.sync, linked(3));
    await occurrence(synced, 3);
    await attachment(synced, 'server.bin');
    await insert('mail_email_scores', { id: uuid(), user_id: owner, email_id: synced, score_version: 'v1', total_score: 1, reasons: '[]', metadata: '{}' });
    // What the sync never removes, or what no live copy at the provider backs, is UniHub's own copy.
    await occurrence(await email('Kept as Legacy', accounts.sync, { ...linked(4), is_legacy: 1 }), 4);
    await occurrence(await email('Filed elsewhere', accounts.sync, { ...linked(5), filing_account_id: accounts.kept }), 5);
    const pending = await email('Change pending', accounts.sync, linked(6));
    await occurrence(pending, 6);
    await insert('mail_writebacks', { id: uuid(), user_id: owner, mail_account_id: accounts.sync, email_id: pending, action: 'read', target_value: '1', base_value: '0',
      remote_folder: 'INBOX', remote_uid: 6, remote_uidvalidity: 7 });
    const gone = await email('Gone at the provider', accounts.sync, { ...linked(8), remote_missing: 1 });
    await occurrence(gone, 8, { presence: 'absent' });
    await attachment(gone, 'only-here.bin');
    // Its Gmail identity, which a backup carries on the item (the mapping table stays out for Sync).
    await insert('mail_gmail_messages', { mail_account_id: accounts.sync, gmail_msgid: '424242', user_id: owner, email_id: gone });
    await email('Known absent', accounts.sync, { imap_uid: 7, imap_uidvalidity: 19, remote_missing: 1, is_legacy: 1 });
    await email('Old address only', accounts.sync, linked(9));
    await occurrence(await email('In an old mailbox epoch', accounts.sync, linked(10, 6)), 10, { uidvalidity: 6 });
    await email('Draft', accounts.sync, { is_draft: 1 });
    const keptSync = ['Change pending', 'Draft', 'Filed elsewhere', 'Gone at the provider', 'In an old mailbox epoch', 'Kept as Legacy', 'Known absent', 'Old address only'];

    const choice = await runtime('services/backup-classes').downloadMailChoice(owner);
    assert.deepEqual(choice, { value: true, forced: false, reason: 'Accounts that delete mail at the provider always include their downloaded mail.', forced_account_ids: [accounts.deletes] });

    const subjects = (rows: FixtureValue[]) => rows.map((row: FixtureValue) => row.subject).sort();
    const without = await backup.buildBackupForUser(owner, { sections: ['mail'], includeFileData: false, includeDownloadMail: false });
    assert.deepEqual(subjects(without.data.emails), [...keptSync, 'Only copy'].sort());
    assert.deepEqual(without.data.email_attachments.map((row: FixtureValue) => row.filename), ['only-here.bin'], 'the server copy\'s files stay with it, a kept copy\'s go along');
    assert.deepEqual(without.data.mail_email_scores, []);
    assert.deepEqual(without.data.mail_accounts.map((row: FixtureValue) => row.id).sort(), Object.values(accounts).sort(), 'every account\'s settings');
    assert.deepEqual(without.contents.left_out.map((row: FixtureValue) => [row.what, row.count]), [['Sync-mode mail', 1], ['Downloaded mail', 1]]);
    assert.ok(without.contents.included.includes('local-by-policy'));

    const withMail = await backup.buildBackupForUser(owner, { sections: ['mail'], includeFileData: false });
    assert.deepEqual(subjects(withMail.data.emails), [...keptSync, 'Downloaded', 'Only copy'].sort());
    assert.deepEqual(withMail.contents.left_out.map((row: FixtureValue) => [row.what, row.count]), [['Sync-mode mail', 1]]);
    assert.equal(withMail.data.mail_gmail_messages.length, 0, 'no mapping of a Sync account');
    assert.deepEqual(withMail.data.emails.filter((row: FixtureValue) => row.remote_gmail_msgid != null).map((row: FixtureValue) => [row.subject, row.remote_gmail_msgid]),
      [['Gone at the provider', '424242']]);

    // The same mail in an archive of 0.27 (schema 6), which held every message
    // with the provider evidence: its import keeps the same messages.
    await pool.execute("UPDATE mail_accounts SET sync_mode = 'download' WHERE id = ?", [accounts.sync]);
    let old: FixtureValue;
    try { old = await backup.buildBackupForUser(owner, { sections: ['mail'], includeFileData: true }); } finally {
      await pool.execute("UPDATE mail_accounts SET sync_mode = 'sync' WHERE id = ?", [accounts.sync]);
    }
    old.version = 6;
    delete old.contents;
    old.data.mail_accounts.find((row: FixtureValue) => row.id === accounts.sync).sync_mode = 'sync';
    // Schema 6 held the Gmail identity only in the mapping table.
    for (const row of old.data.emails) delete row.remote_gmail_msgid;
    assert.equal(old.data.mail_gmail_messages.length, 1);
    assert.deepEqual(old.files.map((file: FixtureValue) => file.kind), ['email_attachment', 'email_attachment'], 'it holds both files');
    assert.ok(old.data.mail_remote_occurrences.length >= 6, 'the archive carries the occurrences');
    const reader = await newUser('mail-reader');
    await runtime('services/mail-folders').ensureDefaultMailFoldersForUser(reader);
    const imported = await restore(reader, old, 'keep_existing', ['mail']);
    const [readerMail] = await pool.query<RowDataPacket[]>(`SELECT e.subject, a.sync_mode FROM emails e JOIN mail_accounts a ON a.id = e.mail_account_id WHERE e.user_id = ?`, [reader]);
    assert.deepEqual(subjects(readerMail.filter(row => row.sync_mode === 'sync')), keptSync);
    assert.deepEqual(subjects(readerMail.filter(row => row.sync_mode !== 'sync')), ['Downloaded', 'Only copy']);
    const [carried] = await pool.query<RowDataPacket[]>('SELECT subject, remote_gmail_msgid FROM emails WHERE user_id = ? AND remote_gmail_msgid IS NOT NULL', [reader]);
    assert.deepEqual(carried.map(row => [row.subject, row.remote_gmail_msgid]), [['Gone at the provider', '424242']], 'the kept item takes its identity from the old mapping');
    assert.deepEqual(imported.contents.left_out.map((row: FixtureValue) => [row.what, row.count]), [['Sync-mode mail', 1]]);
    assert.deepEqual((await pool.query<RowDataPacket[]>('SELECT filename FROM email_attachments WHERE user_id = ?', [reader]))[0].map(row => row.filename), ['only-here.bin']);

    // An administrator's policy includes downloaded mail whatever the choice.
    await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', 'policy.backup.download_mail', 'always', 1)");
    try {
      const forced = await runtime('services/backup-classes').downloadMailChoice(owner);
      assert.deepEqual([forced.value, forced.forced, forced.reason], [true, true, 'Your backups always include downloaded mail, as your administrator requires.']);
      const declined = await backup.buildBackupForUser(owner, { sections: ['mail'], includeFileData: false, includeDownloadMail: false });
      assert.deepEqual(subjects(declined.data.emails), [...keptSync, 'Downloaded', 'Only copy'].sort());
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

  await t.test('synced tasks: every subtask the app allows comes back, from a schema 7 export and from an archive before it', async () => {
    const owner = await newUser('checklist-owner');
    const accountId = uuid(), calendarId = uuid(), taskId = uuid();
    await insert('calendar_accounts', { id: accountId, user_id: owner, provider: 'caldav', display_name: 'Team', account_email: 'team@example.test', base_url: 'https://dav.example.test/', is_active: 1 });
    await insert('calendar_calendars', { id: calendarId, user_id: owner, account_id: accountId, name: 'Team', external_id: 'https://dav.example.test/team/', color: '#2244ff', is_visible: 1 });
    await insert('calendar_events', { id: taskId, user_id: owner, calendar_id: calendarId, uid: 'Checklist@example.test', title: 'Long checklist', start_time: '2030-06-01 10:00:00', end_time: '2030-06-01 11:00:00' });
    // The app sets no limit on a task's subtasks.
    const subtasks = Array.from({ length: 501 }, (_, n) => [uuid(), owner, taskId, `Step ${n}`, n % 2, n]);
    await pool.query('INSERT INTO calendar_event_subtasks (id, user_id, event_id, title, is_done, position) VALUES ?', [subtasks]);
    const waitingSteps = async (userId: string) => {
      const [rows] = await pool.query<RowDataPacket[]>('SELECT match_kind, payload FROM calendar_overlay_restores WHERE user_id = ?', [userId]);
      return rows.map(row => [row.match_kind, (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload).subtasks.length]);
    };

    const current = await backup.buildBackupForUser(owner, { sections: ['calendar'], includeFileData: false });
    const review = backup.validateBackupPayload(current);
    assert.equal(review.valid, true, JSON.stringify(review.errors));
    const reader = await newUser('checklist-reader');
    await restore(reader, current, 'keep_existing');
    assert.deepEqual(await waitingSteps(reader), [['uid', 501]]);

    // The same task in an archive of 0.27 (schema 6): an event row with its subtasks, no UIDs, no overlays.
    await pool.execute("UPDATE calendar_accounts SET provider = 'local' WHERE id = ?", [accountId]);
    let old: FixtureValue;
    try { old = await backup.buildBackupForUser(owner, { sections: ['calendar'], includeFileData: false }); } finally {
      await pool.execute("UPDATE calendar_accounts SET provider = 'caldav' WHERE id = ?", [accountId]);
    }
    old.version = 6;
    delete old.contents;
    delete old.data.calendar_overlay_restores;
    old.data.calendar_accounts.find((row: FixtureValue) => row.id === accountId).provider = 'caldav';
    for (const table of ['calendar_events', 'calendar_calendars']) for (const row of old.data[table]) delete row.uid;
    assert.equal(old.data.calendar_event_subtasks.length, 501);
    const oldReader = await newUser('checklist-old-reader');
    const imported = await restore(oldReader, old, 'keep_existing');
    assert.equal((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ?', [oldReader]))[0][0].n, 0);
    assert.deepEqual(await waitingSteps(oldReader), [['shape', 501]]);
    assert.ok(imported.notes.some((note: string) => /1 synced task gets its ToDo state and subtasks back when the calendar syncs/.test(note)), JSON.stringify(imported.notes));
    // State its conversion cannot store (a title no task can have) refuses the restore by name rather than vanishing.
    const unstorable = structuredClone(old);
    unstorable.data.calendar_events[0].title = 'x'.repeat(300);
    const refused = await backup.importBackupForUser(await newUser('checklist-refused'), unstorable, { mode: 'apply', sections: ['calendar'], conflict_mode: 'keep_existing', startAccountSync: () => {} });
    assert.equal(refused.valid, false);
    assert.match(refused.errors.join('\n'), /synced-task state .* \(converted from an archive before data schema 7\)/);
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
