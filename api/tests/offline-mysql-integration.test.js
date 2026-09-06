const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { createOfflineSnapshot } = require('../src/services/offline');
const { getDb, setDb } = require('../src/state');

test('MySQL offline queries match application schema, include every contact and refresh deletions', { skip: !process.env.MYSQL_TEST_HOST }, async (t) => {
  const connection = await mysql.createConnection({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
    database: process.env.MYSQL_TEST_DATABASE || 'unihub_test', timezone: '+00:00' });
  const previous = getDb();
  t.after(async () => { setDb(previous); await connection.end(); });
  const schema = await fs.readFile(path.join(__dirname, '../src/services/database.js'), 'utf8');
  const tables = ['contacts', 'calendar_accounts', 'calendar_calendars', 'calendar_events', 'calendar_event_subtasks', 'calendar_event_attendees', 'mail_accounts', 'mail_folders', 'emails', 'email_attachments'];
  for (const table of tables) {
    const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    assert.ok(start >= 0, `application schema defines ${table}`);
    const end = schema.indexOf('`);', start);
    // Use the application's real columns/defaults, with connection-local tables.
    // Temporary InnoDB tables do not support foreign keys or fulltext indexes.
    const sql = schema.slice(start, end).replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMPORARY TABLE')
      .split('\n').filter(line => !/^\s*(FOREIGN KEY|FULLTEXT INDEX)/.test(line)).join('\n').replace(/,\s*\) ENGINE/, '\n) ENGINE');
    await connection.execute(sql);
  }
  const userId = crypto.randomUUID(), otherUser = crypto.randomUUID(), accountId = crypto.randomUUID();
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
  const emailIds = Array.from({ length: 101 }, () => crypto.randomUUID());
  for (let index = 0; index < emailIds.length; index++) await connection.execute(
    'INSERT INTO emails (id, user_id, mail_account_id, from_address, to_addresses, body_text, body_html, raw_storage_path, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [emailIds[index], userId, accountId, 'sender@example.test', '["me@example.test"]', 'x'.repeat(1000), '<p>Full HTML</p>', '/private/raw.eml', new Date(1700000000000 + index * 1000)]);
  await connection.execute('INSERT INTO email_attachments (id, email_id, user_id, filename, content_type, size_bytes, storage_path) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), emailIds[100], userId, 'file.txt', 'text/plain', 1234, '/private/file.txt']);
  const borrowed = { release() {} };
  for (const method of ['execute', 'query', 'beginTransaction', 'commit', 'rollback']) borrowed[method] = connection[method].bind(connection);
  setDb({ async getConnection() { return borrowed; } });
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
  await connection.execute('DELETE FROM contacts WHERE id = ? AND user_id = ?', [contactIds[0], userId]);
  const refreshed = await createOfflineSnapshot(userId);
  assert.equal(refreshed.contacts.length, 2104);
  assert.ok(!refreshed.contacts.some(row => row.id === contactIds[0]));
});
