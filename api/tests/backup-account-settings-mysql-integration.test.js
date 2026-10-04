const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime');

const uuid = () => crypto.randomUUID();

async function waitFor(read, wanted, description) {
  const deadline = Date.now() + 60000;
  let current;
  while (Date.now() < deadline) {
    current = await read();
    if (wanted(current)) return current;
    if (current?.status === 'failed') assert.fail(`${description}: ${current.error}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail(`${description} timed out: ${JSON.stringify(current)}`);
}

test('an account settings backup restores accounts as fresh sign-ins without content', {
  skip: !process.env.MYSQL_TEST_HOST,
  timeout: 120000,
}, async (t) => {
  const database = process.env.MYSQL_TEST_DATABASE || 'unihub_test';
  assert.match(database, /_test$/, 'Use an empty disposable database ending in _test');
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    database, user: process.env.MYSQL_TEST_USER || 'unihub_test',
    password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
    timezone: '+00:00', connectionLimit: 4,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-backup-accounts-'));
  let ownsDatabase = false;
  t.after(async () => {
    try {
      if (ownsDatabase) {
        const connection = await pool.getConnection();
        try {
          await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
          const [tables] = await connection.query('SHOW TABLES');
          for (const row of tables) {
            const table = Object.values(row)[0];
            assert.match(table, /^[a-z_]+$/);
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
  const [existing] = await pool.query('SHOW TABLES');
  assert.equal(existing.length, 0, 'Refusing to change a nonempty database');
  ownsDatabase = true;
  const source = createBackupRuntime(path.join(directory, 'source'), 'source-accounts-key', pool);
  const destination = createBackupRuntime(path.join(directory, 'destination'), 'different-destination-accounts-key', pool);
  await source('services/database').ensureSchema();
  await source('services/notifications').ensureNotificationSchema();
  const sourceCrypto = source('security/encryption');
  const destinationCrypto = destination('security/encryption');
  async function insert(table, row) {
    const columns = Object.keys(row);
    await pool.execute(`INSERT INTO ${table} (${columns.map(name => '`' + name + '`').join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, Object.values(row));
  }
  async function newUser(label) {
    const id = uuid();
    await insert('users', { id, email: label + '@example.test', password_hash: 'synthetic-hash', full_name: label, role: 'user' });
    return id;
  }
  const rows = async (table, userId) => (await pool.execute(`SELECT * FROM ${table} WHERE user_id = ?`, [userId]))[0];

  const sourceUser = await newUser('accounts-source');
  await insert('user_settings', { user_id: sourceUser, setting_key: 'calendar_preferences', setting_value: JSON.stringify({ firstDay: 1 }) });
  await insert('contacts', { id: uuid(), user_id: sourceUser, first_name: 'Not exported' });
  const mailAccountId = uuid();
  // Paused by an earlier restore: account settings still sign in again.
  await insert('mail_accounts', { id: mailAccountId, user_id: sourceUser, email_address: 'synced@example.test', provider: 'custom',
    username: 'synced-login', imap_host: '8.8.8.8', imap_port: 993, smtp_host: '9.9.9.9', smtp_port: 465,
    encrypted_password: sourceCrypto.encrypt('synthetic-mail-password'), is_active: 0, sync_mode: 'sync', sync_status: 'idle',
    sync_window_days: 90, trash_window_days: 14, sync_policy_confirmed_at: '2030-01-01 10:00:00' });
  await insert('mail_folders', { id: uuid(), user_id: sourceUser, mail_account_id: mailAccountId, slug: 'custom-folder', display_name: 'Custom', position: 5, is_system: 0 });
  await insert('emails', { id: uuid(), user_id: sourceUser, mail_account_id: mailAccountId, message_id: '<content@example.test>', subject: 'Not exported',
    from_address: 'sender@example.test', to_addresses: JSON.stringify(['synced@example.test']), body_text: 'Synced content stays on the provider', folder: 'inbox', received_at: '2030-01-02 12:00:00' });
  const calendarAccountId = uuid();
  await insert('calendar_accounts', { id: calendarAccountId, user_id: sourceUser, provider: 'caldav', display_name: 'Remote calendar',
    account_email: 'calendar@example.test', username: 'calendar-user', discovery_url: 'https://8.8.8.8/dav/', base_url: 'https://8.8.8.8/dav/',
    encrypted_password: sourceCrypto.encrypt('synthetic-calendar-password'), is_active: 1, sync_status: 'ok' });
  await insert('calendar_calendars', { id: uuid(), user_id: sourceUser, account_id: calendarAccountId, name: 'Remote', external_id: 'https://8.8.8.8/dav/remote/' });
  // Subscriptions keep their feed URL encrypted; email and base_url are empty.
  for (const [name, feed] of [['Holidays', 'https://8.8.8.8/holidays.ics'], ['Sports', 'https://8.8.8.8/sports.ics']]) {
    await insert('calendar_accounts', { id: uuid(), user_id: sourceUser, provider: 'ics', display_name: name,
      encrypted_password: sourceCrypto.encrypt(feed), discovery_url: 'https://8.8.8.8', is_active: 1, sync_status: 'ok' });
  }
  const localAccountId = uuid();
  await insert('calendar_accounts', { id: localAccountId, user_id: sourceUser, provider: 'local', display_name: 'Local', is_active: 1 });
  await insert('calendar_calendars', { id: uuid(), user_id: sourceUser, account_id: localAccountId, name: 'Local only' });

  const exportJobs = source('services/export-jobs');
  // Account settings stand in for Mail here; that is not a full backup.
  const almostFull = await exportJobs.startDataExportJob(sourceUser, { sections: ['settings', 'contacts', 'calendar', 'recordings', 'accounts'], encrypt: false });
  assert.equal(almostFull.scope, 'partial');
  await waitFor(() => exportJobs.getDataExportJob(sourceUser, almostFull.id), job => job?.status === 'ready', 'Partial export');
  const started = await exportJobs.startDataExportJob(sourceUser, { sections: ['accounts', 'settings'], encrypt: true });
  assert.deepEqual(started.requested_sections, ['settings', 'accounts']);
  assert.equal(started.scope, 'partial');
  const ready = await waitFor(() => exportJobs.getDataExportJob(sourceUser, started.id), job => job?.status === 'ready', 'Export');
  const bytes = await fs.readFile(ready.file_path);
  assert.equal(bytes.includes(Buffer.from('synthetic-mail-password')), false);
  const [[key]] = await pool.execute('SELECT recovery_password_ciphertext FROM backup_archive_keys WHERE backup_uuid = ? AND user_id = ?', [ready.backup_uuid, sourceUser]);
  const password = source('services/backup-container').revealProtectedRecoveryPassword(key.recovery_password_ciphertext, ready.backup_uuid);

  const destinationUser = await newUser('accounts-destination');
  const keptAccountId = uuid();
  await insert('mail_accounts', { id: keptAccountId, user_id: destinationUser, email_address: 'already-here@example.test', provider: 'custom',
    username: 'already-here', imap_host: '8.8.8.8', encrypted_password: destinationCrypto.encrypt('existing-password'), is_active: 1,
    sync_mode: 'sync', sync_status: 'idle', sync_policy_confirmed_at: '2030-01-01 10:00:00' });

  const started_syncs = [];
  const mail = destination('services/mail');
  mail.ensureDefaultMailFoldersForUser = async userId => { started_syncs.push(['folders', userId]); };
  mail.scheduleMailAccountSync = async (accountId, options = {}) => { started_syncs.push(['mail', accountId, !!options.background]); return { skipped: false }; };
  destination('services/calendar-sync').syncCalendarAccountInBackground = (accountId, options) => { started_syncs.push(['calendar', accountId, options.userId]); };

  const restoreJobs = destination('services/backup-restore-jobs');
  async function restore() {
    const upload = path.join(directory, uuid() + '.upload');
    await fs.writeFile(upload, bytes);
    const created = await restoreJobs.createUploadedRestoreJob(destinationUser, upload, { sections: 'full', conflict_mode: 'replace', credentials_mode: 'restore' });
    assert.equal(created.status, 'awaiting_password');
    await restoreJobs.unlockRestoreJob(destinationUser, created.id, password);
    const validated = await waitFor(() => restoreJobs.getRestoreJob(destinationUser, created.id), job => job?.status === 'validated', 'Validation');
    assert.deepEqual(validated.validation_result.account_only_sections, ['calendar', 'mail']);
    assert.deepEqual(validated.validation_result.counts, { user_settings: 1, calendar_accounts: 3, mail_accounts: 1 });
    await restoreJobs.startRestoreJob(destinationUser, created.id);
    return waitFor(() => restoreJobs.getRestoreJob(destinationUser, created.id), job => job?.status === 'completed', 'Restore');
  }

  await restore();
  const restoredMail = (await rows('mail_accounts', destinationUser)).find(row => row.email_address === 'synced@example.test');
  assert.ok(restoredMail, 'Mail account is restored');
  assert.notEqual(restoredMail.id, mailAccountId);
  assert.equal(restoredMail.is_active, 1, 'Restored account is signed in');
  assert.equal(restoredMail.sync_mode, 'sync');
  assert.equal(restoredMail.sync_status, 'pending');
  assert.equal(restoredMail.sync_window_days, 90);
  assert.equal(restoredMail.trash_window_days, 14);
  assert.ok(restoredMail.sync_policy_confirmed_at, 'No local mail yet: the Sync policy is confirmed like a new account');
  assert.equal(restoredMail.delete_emails_on_server, 0);
  assert.equal(restoredMail.username, 'synced-login');
  assert.equal(restoredMail.smtp_port, 465);
  assert.equal(destinationCrypto.decrypt(restoredMail.encrypted_password), 'synthetic-mail-password');
  const kept = (await rows('mail_accounts', destinationUser)).find(row => row.id === keptAccountId);
  assert.equal(kept.is_active, 1, 'Existing accounts are not paused');
  assert.ok(kept.sync_policy_confirmed_at, 'Existing Sync policy stays confirmed');
  assert.deepEqual(await rows('emails', destinationUser), []);
  assert.equal((await rows('mail_folders', destinationUser)).some(row => row.slug === 'custom-folder'), false);
  assert.deepEqual(await rows('contacts', destinationUser), [], 'Unselected sections are not exported');
  const calendarAccounts = await rows('calendar_accounts', destinationUser);
  assert.deepEqual(calendarAccounts.map(row => row.provider).sort(), ['caldav', 'ics', 'ics'], 'Local calendars are calendar content');
  const caldav = calendarAccounts.find(row => row.provider === 'caldav');
  assert.equal(caldav.is_active, 1);
  assert.equal(caldav.last_synced_at, null);
  assert.equal(destinationCrypto.decrypt(caldav.encrypted_password), 'synthetic-calendar-password');
  assert.deepEqual(calendarAccounts.filter(row => row.provider === 'ics').map(row => destinationCrypto.decrypt(row.encrypted_password)).sort(),
    ['https://8.8.8.8/holidays.ics', 'https://8.8.8.8/sports.ics'], 'Each subscription is restored');
  assert.deepEqual(await rows('calendar_calendars', destinationUser), [], 'Calendars are discovered again by sync');
  assert.equal((await rows('user_settings', destinationUser)).length, 1);
  await waitFor(async () => started_syncs, calls => calls.length === 5, 'Sync start');
  // Queued like a new account's first sync, not as a background pass that
  // a disabled background setting would skip.
  assert.deepEqual(started_syncs.slice(0, 2), [['folders', destinationUser], ['mail', restoredMail.id, false]]);
  assert.deepEqual(started_syncs.slice(2).map(call => call[1]).sort(), calendarAccounts.map(row => row.id).sort());

  // Restoring the same settings again leaves connected accounts unchanged.
  started_syncs.length = 0;
  await pool.execute('UPDATE mail_accounts SET sync_window_days = 30 WHERE id = ?', [restoredMail.id]);
  const again = await restore();
  assert.match(again.result_counts.warnings.join('\n'), /Mail account synced@example.test is already connected/);
  assert.match(again.result_counts.warnings.join('\n'), /Calendar account calendar@example.test is already connected/);
  assert.equal((await rows('mail_accounts', destinationUser)).length, 2);
  assert.match(again.result_counts.warnings.join('\n'), /Calendar account Sports is already connected/);
  assert.equal((await rows('calendar_accounts', destinationUser)).length, 3);
  assert.equal((await rows('mail_accounts', destinationUser)).find(row => row.id === restoredMail.id).sync_window_days, 30);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(started_syncs, []);
});
