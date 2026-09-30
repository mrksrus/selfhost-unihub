const test = require('node:test');
const assert = require('node:assert/strict');

// This file runs in its own test process against an empty disposable _test DB.
// ensureSchema needs synthetic first-run bootstrap inputs before config is loaded.
process.env.BOOTSTRAP_ADMIN_EMAIL = 'offline-fixture-admin@example.test';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-offline-fixture-admin-2026';

const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { createOfflineSnapshot } = require('../src/services/offline');
const { getDb, setDb } = require('../src/state');
const mailRoutes = require('../src/routes/mail');

test('MySQL offline queries match application schema, include every contact and refresh deletions', { skip: !process.env.MYSQL_TEST_HOST }, async (t) => {
  const connection = await mysql.createConnection({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
    database: process.env.MYSQL_TEST_DATABASE || 'unihub_test', timezone: '+00:00' });
  const previous = getDb();
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
    database: process.env.MYSQL_TEST_DATABASE || 'unihub_test', timezone: '+00:00', connectionLimit: 3 });
  let ownsDatabase = false;
  t.after(async () => {
    setDb(previous);
    try {
      if (ownsDatabase) {
        await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
        try {
          const [tables] = await connection.query('SHOW TABLES');
          for (const row of tables) {
            const table = Object.values(row)[0];
            assert.match(table, /^[a-z_]+$/);
            await connection.execute(`DROP TABLE \`${table}\``);
          }
        } finally { await connection.execute('SET FOREIGN_KEY_CHECKS = 1'); }
      }
    } finally { await pool.end(); await connection.end(); }
  });
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Use an empty disposable test database');
  const [existing] = await connection.query('SHOW TABLES');
  assert.equal(existing.length, 0, 'Refusing to change a nonempty database');
  ownsDatabase = true;
  // The production folder view joins accounts and writebacks more than once.
  // MySQL cannot reopen a TEMPORARY table in those nested reads, so use the
  // actual numbered schema migrations in this empty, serial, disposable DB.
  setDb(pool);
  await require('../src/services/database').ensureSchema();
  const userId = crypto.randomUUID(), otherUser = crypto.randomUUID(), accountId = crypto.randomUUID();
  await connection.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'offline@example.test', 'synthetic-hash'), (?, 'offline-other@example.test', 'synthetic-hash')", [userId, otherUser]);
  const contactIds = Array.from({ length: 2105 }, () => crypto.randomUUID());
  for (let index = 0; index < contactIds.length; index += 200) {
    const ids = contactIds.slice(index, index + 200);
    await connection.execute(`INSERT INTO contacts (id, user_id, first_name, notes) VALUES ${ids.map(() => '(?, ?, ?, ?)').join(',')}`,
      ids.flatMap((id, row) => [id, userId, `Contact ${index + row}`, 'Complete notes']));
  }
  await connection.execute('INSERT INTO contacts (id, user_id, first_name) VALUES (?, ?, ?)', [crypto.randomUUID(), otherUser, 'Other user']);
  const calendarAccount = crypto.randomUUID(), calendarId = crypto.randomUUID(), eventId = crypto.randomUUID();
  await connection.execute('INSERT INTO calendar_accounts (id, user_id, provider, display_name, encrypted_password) VALUES (?, ?, ?, ?, ?)', [calendarAccount, userId, 'caldav', 'Private calendar', 'secret-calendar']);
  await connection.execute('INSERT INTO calendar_calendars (id, user_id, account_id, name) VALUES (?, ?, ?, ?)', [calendarId, userId, calendarAccount, 'Calendar']);
  await connection.execute('INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time, reminders) VALUES (?, ?, ?, ?, ?, ?, ?)', [eventId, userId, calendarId, 'Event', '2026-09-06 10:00:00', '2026-09-06 11:00:00', '[0,15]']);
  await connection.execute('INSERT INTO calendar_event_subtasks (id, event_id, user_id, title) VALUES (?, ?, ?, ?)', [crypto.randomUUID(), eventId, userId, 'Subtask']);
  await connection.execute('INSERT INTO calendar_event_attendees (id, event_id, user_id, email) VALUES (?, ?, ?, ?)', [crypto.randomUUID(), eventId, userId, 'attendee@example.test']);
  await connection.execute('INSERT INTO mail_accounts (id, user_id, email_address, provider, encrypted_password) VALUES (?, ?, ?, ?, ?)', [accountId, userId, 'me@example.test', 'custom', 'secret-mail']);
  const receivingId = crypto.randomUUID(), linkedFolder = crypto.randomUUID(), sourceFolder = crypto.randomUUID(), ruleId = crypto.randomUUID();
  await connection.execute('INSERT INTO mail_accounts (id, user_id, email_address, provider) VALUES (?, ?, ?, ?)', [receivingId, userId, 'receiving@example.test', 'custom']);
  await connection.execute('INSERT INTO mail_folders (id, user_id, slug, display_name, is_system) VALUES (?, ?, ?, ?, FALSE)', [linkedFolder, userId, 'linked', 'Linked']);
  await connection.execute('INSERT INTO mail_folders (id, user_id, slug, display_name, is_system, mail_account_id) VALUES (?, ?, ?, ?, FALSE, ?)', [sourceFolder, userId, 'source-only', 'Source only', accountId]);
  await connection.execute('INSERT INTO mail_folder_remote_boxes (folder_id, mail_account_id, remote_name) VALUES (?, ?, ?)', [linkedFolder, receivingId, 'Linked']);
  await connection.execute('INSERT INTO mail_folder_reconciliations (mail_account_id, user_id, inventory, previous_mappings) VALUES (?, ?, ?, ?)', [receivingId, userId, '["INBOX","Linked"]', '[]']);
  await connection.execute('INSERT INTO mail_sender_rules (id, user_id, mail_account_id, match_type, match_value, target_folder) VALUES (?, ?, ?, ?, ?, ?)', [ruleId, userId, receivingId, 'email', 'sender@example.test', 'source-only']);
  const emailIds = Array.from({ length: 101 }, () => crypto.randomUUID());
  for (let index = 0; index < emailIds.length; index++) await connection.execute(
    'INSERT INTO emails (id, user_id, mail_account_id, from_address, to_addresses, body_text, body_html, raw_storage_path, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [emailIds[index], userId, accountId, 'sender@example.test', '["me@example.test"]', 'x'.repeat(1000), '<p>Full HTML</p>', '/private/raw.eml', new Date(1700000000000 + index * 1000)]);
  await connection.execute('INSERT INTO email_attachments (id, email_id, user_id, filename, content_type, size_bytes, storage_path) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), emailIds[100], userId, 'file.txt', 'text/plain', 1234, '/private/file.txt']);
  await connection.execute('UPDATE emails SET filing_account_id = ?, source_folder = ?, imap_uid = 41, imap_uidvalidity = 12 WHERE id = ?', [receivingId, 'Provider/Original', emailIds[100]]);
  await connection.execute('UPDATE emails SET filing_account_id = ?, is_legacy = TRUE WHERE id = ?', [receivingId, emailIds[99]]);
  const borrowed = { release() {} };
  for (const method of ['execute', 'query', 'beginTransaction', 'commit', 'rollback']) borrowed[method] = connection[method].bind(connection);
  setDb({ execute: connection.execute.bind(connection), async getConnection() { return borrowed; } });
  const snapshot = await createOfflineSnapshot(userId);
  assert.equal(snapshot.contacts.length, 2105);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].subtasks.length, 1);
  assert.equal(snapshot.events[0].attendees.length, 1);
  assert.equal(snapshot.emails.length, 100);
  assert.equal(snapshot.emails[0].body_text.length, 1000);
  assert.equal(snapshot.emails[0].attachments[0].size_bytes, 1234);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-calendar|secret-mail|\/private\//);
  assert.equal(snapshot.bytes, Buffer.byteLength(JSON.stringify(snapshot)));
  assert.equal(snapshot.emails[0].source_mail_account_id, accountId);
  assert.equal(snapshot.emails[0].mail_account_id, receivingId);
  assert.equal(snapshot.emails[1].is_legacy, true);
  assert.deepEqual(snapshot.folders.find(row => row.slug === 'linked').connected_account_ids, [receivingId]);
  assert.equal(snapshot.folders.find(row => row.slug === 'source-only').mail_account_id, accountId);

  const request = url => ({ url, headers: { host: 'localhost' } });
  const list = await mailRoutes['GET /api/mail/emails'](request('/api/mail/emails?account_id=' + receivingId), userId);
  assert.equal(list.pagination.total, 1);
  const detail = await mailRoutes['GET /api/mail/emails/:id'](request('/api/mail/emails/' + emailIds[100]), userId);
  for (const email of [list.emails[0], detail.email]) {
    assert.equal(email.mail_account_id, receivingId); assert.equal(email.source_mail_account_id, accountId);
    assert.equal(email.source_folder, undefined); assert.equal(email.imap_uid, undefined); assert.equal(email.imap_uidvalidity, undefined);
  }
  const backfill = mode => mailRoutes['POST /api/mail/sender-rules/backfill']({}, userId, { account_id: receivingId, mode });
  const rejected = await backfill('apply');
  assert.equal(rejected.scanned, 1); assert.equal(rejected.applied, 0);
  await connection.execute('UPDATE mail_sender_rules SET target_folder = ? WHERE id = ?', ['linked', ruleId]);
  const applied = await backfill('apply');
  assert.equal(applied.scanned, 1); assert.equal(applied.applied, 1);
  const [[filed]] = await connection.execute('SELECT * FROM emails WHERE id = ?', [emailIds[100]]);
  assert.equal(filed.folder, 'linked'); assert.equal(filed.mail_account_id, accountId);
  assert.equal(filed.filing_account_id, receivingId); assert.equal(filed.source_folder, 'Provider/Original'); assert.equal(filed.imap_uid, 41); assert.equal(filed.imap_uidvalidity, 12);
  const folders = await mailRoutes['GET /api/mail/folders'](request('/api/mail/folders?account_id=' + receivingId), userId);
  assert.equal(folders.folders.find(row => row.slug === 'linked').total_count, 1);
  assert.equal(folders.folders.some(row => row.slug === 'source-only'), false);
  // Simulate another completed move after scanning, before the backfill write transaction.
  await connection.execute('UPDATE emails SET folder = ? WHERE id = ?', ['inbox', emailIds[100]]);
  borrowed.beginTransaction = async () => {
    await connection.execute('UPDATE emails SET filing_account_id = ? WHERE id = ?', [accountId, emailIds[100]]);
    await connection.beginTransaction();
  };
  const raced = await backfill('apply');
  assert.equal(raced.matched, 1); assert.equal(raced.applied, 0);
  borrowed.beginTransaction = connection.beginTransaction.bind(connection);
  await connection.execute('DELETE FROM contacts WHERE id = ? AND user_id = ?', [contactIds[0], userId]);
  const refreshed = await createOfflineSnapshot(userId);
  assert.equal(refreshed.contacts.length, 2104);
  assert.ok(!refreshed.contacts.some(row => row.id === contactIds[0]));
});
