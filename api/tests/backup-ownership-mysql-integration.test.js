const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function wav() {
  const bytes = Buffer.alloc(46);
  bytes.write('RIFF'); bytes.writeUInt32LE(38, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(2, 40);
  return bytes;
}

function restoreFixture(encrypt) {
  const id = () => crypto.randomUUID();
  const ids = Object.fromEntries(['contact', 'folder', 'account', 'rule', 'email', 'attachment', 'score', 'calendarAccount', 'calendar', 'event', 'subtask', 'attendee', 'ref', 'recording', 'tag'].map(name => [name, id()]));
  const audio = wav();
  return {
    app: 'unihub', version: 1,
    files: [{ kind: 'recording', id: ids.recording, filename: 'recording.wav', sha256: crypto.createHash('sha256').update(audio).digest('hex'), data_base64: audio.toString('base64') }],
    data: {
      user: { full_name: 'Restored profile', timezone: 'Europe/Vienna' },
      user_settings: [{ setting_key: 'restore-setting', setting_value: 'restored' }],
      contacts: [{ id: ids.contact, first_name: 'Restored', last_name: 'Contact', email: 'contact@example.test', notes: 'Original note' }],
      mail_folders: [{ id: ids.folder, slug: 'inbox', display_name: 'Restored Inbox', is_system: true, position: 17 }],
      mail_accounts: [{ id: ids.account, email_address: 'mail@example.test', provider: 'custom', imap_host: '127.0.0.1', imap_port: 993, smtp_host: '127.0.0.1', smtp_port: 587, encrypted_password: encrypt('synthetic-mail-password'), is_active: true }],
      mail_sender_rules: [{ id: ids.rule, mail_account_id: ids.account, match_type: 'domain', match_value: 'example.test', target_folder: 'inbox', priority: 25 }],
      emails: [{ id: ids.email, mail_account_id: ids.account, message_id: '<restore@example.test>', subject: 'Original subject', from_address: 'from@example.test', to_addresses: '[]', body_text: 'Original body', folder: 'inbox', source_folder: 'INBOX', imap_uid: 77, imap_uidvalidity: 42, received_at: '2026-01-01 10:00:00' }],
      email_attachments: [{ id: ids.attachment, email_id: ids.email, filename: 'attachment.txt', content_type: 'text/plain', size_bytes: 12 }],
      mail_email_scores: [{ id: ids.score, email_id: ids.email, score_version: 'v1', total_score: 25 }],
      calendar_accounts: [{ id: ids.calendarAccount, provider: 'local', display_name: 'Local' }],
      calendar_calendars: [{ id: ids.calendar, account_id: ids.calendarAccount, name: 'Restored Calendar', color: '#123456' }],
      calendar_events: [{ id: ids.event, calendar_id: ids.calendar, title: 'Original event', start_time: '2030-01-01 10:00:00', end_time: '2030-01-01 11:00:00' }],
      calendar_event_subtasks: [{ id: ids.subtask, event_id: ids.event, title: 'Subtask', is_done: true }],
      calendar_event_attendees: [{ id: ids.attendee, event_id: ids.event, email: 'attendee@example.test', display_name: 'Attendee' }],
      calendar_event_external_refs: [{ id: ids.ref, event_id: ids.event, calendar_id: ids.calendar, account_id: ids.calendarAccount, provider: 'local', external_event_id: 'external-event' }],
      recordings: [{ id: ids.recording, title: 'Original recording', original_filename: 'recording.wav', content_type: 'text/html', size_bytes: audio.length, storage_path: '/unused/victim.wav', recorded_at: '2026-01-01 10:00:00', created_at: '2026-01-01 10:00:00' }],
      recording_tags: [{ id: ids.tag, name: 'Restored tag', color: '#123456' }],
      recording_tag_links: [{ recording_id: ids.recording, tag_id: ids.tag }],
    },
  };
}

test('MySQL restores colliding backup IDs without changing another user in every conflict mode', { skip: !process.env.MYSQL_TEST_HOST, timeout: 120000 }, async (t) => {
  process.env.ENCRYPTION_KEY ||= 'backup-ownership-test-key';
  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE || 'unihub_test', user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password', timezone: '+00:00' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-backup-ownership-'));
  const { setDb, getDb } = require('../src/state');
  const previousDb = getDb();
  const recordingsPath = require.resolve('../src/services/recordings');
  const originalRecordings = require(recordingsPath);
  const backupPath = require.resolve('../src/services/backup');
  const originalBackup = require.cache[backupPath];
  require.cache[recordingsPath].exports = { ...originalRecordings, RECORDINGS_ROOT: directory };
  delete require.cache[backupPath];
  const { importBackupForUser } = require(backupPath);
  const { encrypt } = require('../src/security/encryption');
  setDb({ execute: (...args) => connection.execute(...args), getConnection: async () => ({ execute: (...args) => connection.execute(...args), beginTransaction: () => connection.beginTransaction(), commit: () => connection.commit(), rollback: () => connection.rollback(), release() {} }) });
  t.after(async () => {
    setDb(previousDb);
    require.cache[recordingsPath].exports = originalRecordings;
    if (originalBackup) require.cache[backupPath] = originalBackup; else delete require.cache[backupPath];
    await connection.end();
    await fs.rm(directory, { recursive: true, force: true });
  });
  // Connection-local tables retain global primary/unique keys for collision
  // regression; ownership checks are application policy, not temporary-table FKs.
  const schema = await fs.readFile(path.join(__dirname, 'fixtures/v0.9.23.0/schema.sql'), 'utf8');
  for (const source of schema.replace(/^--.*$/gm, '').split(';').map(sql => sql.trim()).filter(sql => sql.startsWith('CREATE TABLE'))) {
    const sql = source.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMPORARY TABLE')
      .replace(/^\s*FOREIGN KEY[^\n]*\n/gm, '').replace(/^\s*FULLTEXT INDEX[^\n]*\n/gm, '').replace(/,\s*\) ENGINE/, '\n  ) ENGINE');
    await connection.execute(sql);
  }
  // The frozen old schema remains unchanged. This restore security fixture
  // runs against the current application column added by production migration.
  await connection.execute('ALTER TABLE emails ADD COLUMN import_complete BOOLEAN NOT NULL DEFAULT FALSE');
  await connection.execute('CREATE TEMPORARY TABLE notification_config (id INT PRIMARY KEY, reminder_revision BIGINT DEFAULT 0)');
  await connection.execute('INSERT INTO notification_config (id) VALUES (1)');
  const victim = crypto.randomUUID();
  await connection.execute("INSERT INTO users (id,email,password_hash,full_name) VALUES (?, 'victim@example.test', 'synthetic-hash', 'Victim')", [victim]);
  const backup = restoreFixture(encrypt);
  const tables = Object.entries(backup.data).filter(([, rows]) => Array.isArray(rows)).map(([table]) => table);
  for (const table of tables) {
    for (const source of backup.data[table]) {
      const row = { ...source, user_id: victim };
      const columns = Object.keys(row);
      await connection.execute(`INSERT INTO ${table} (${columns.map(column => '`' + column + '`').join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, Object.values(row));
    }
  }
  async function rowsFor(table, userId) {
    const [rows] = await connection.execute(`SELECT * FROM ${table} WHERE ${table === 'users' ? 'id' : 'user_id'} = ?`, [userId]);
    return rows.map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  const victimBefore = Object.fromEntries(await Promise.all(['users', ...tables].map(async table => [table, await rowsFor(table, victim)])));
  async function assertVictimUnchanged() {
    for (const [table, expected] of Object.entries(victimBefore)) assert.deepEqual(await rowsFor(table, victim), expected, `Victim ${table} must remain unchanged`);
  }
  for (const conflictMode of ['keep_existing', 'replace', 'keep_both']) {
    await t.test(conflictMode, async () => {
      const userId = crypto.randomUUID();
      await connection.execute('INSERT INTO users (id,email,password_hash) VALUES (?, ?, ?)', [userId, userId + '@example.test', 'synthetic-hash']);
      const result = await importBackupForUser(userId, structuredClone(backup), { mode: 'apply', conflict_mode: conflictMode });
      assert.equal(result.valid, true);
      await assertVictimUnchanged();
      const restored = Object.fromEntries(await Promise.all(tables.map(async table => [table, await rowsFor(table, userId)])));
      for (const table of tables) {
        assert.equal(restored[table].length, 1, `${table} restored once`);
        if (backup.data[table][0].id) assert.notEqual(restored[table][0].id, backup.data[table][0].id, `${table} receives a fresh ID`);
        assert.equal(restored[table][0].user_id, userId);
      }
      const row = table => restored[table][0];
      assert.equal(row('emails').mail_account_id, row('mail_accounts').id);
      assert.equal(row('mail_sender_rules').mail_account_id, row('mail_accounts').id);
      assert.equal(row('email_attachments').email_id, row('emails').id);
      assert.equal(row('mail_email_scores').email_id, row('emails').id);
      assert.equal(row('calendar_calendars').account_id, row('calendar_accounts').id);
      assert.equal(row('calendar_events').calendar_id, row('calendar_calendars').id);
      assert.equal(row('calendar_event_subtasks').event_id, row('calendar_events').id);
      assert.equal(row('calendar_event_attendees').event_id, row('calendar_events').id);
      assert.equal(row('calendar_event_external_refs').event_id, row('calendar_events').id);
      assert.equal(row('calendar_event_external_refs').calendar_id, row('calendar_calendars').id);
      assert.equal(row('calendar_event_external_refs').account_id, row('calendar_accounts').id);
      assert.equal(row('recording_tag_links').recording_id, row('recordings').id);
      assert.equal(row('recording_tag_links').tag_id, row('recording_tags').id);
      assert.equal(row('recordings').content_type, 'audio/wav', 'Stored bytes determine a safe media type');
      assert.deepEqual(await fs.readFile(row('recordings').storage_path), wav());
      assert.equal(row('mail_accounts').is_active, 0, 'Rejected private mail settings cannot activate restored accounts');
      assert.equal(row('mail_accounts').delete_emails_on_server, 0);

      // Deliberate same-owner matching retains conflict semantics on a repeat
      // restore; a second copy must keep its children attached to that copy.
      const ownBackup = structuredClone(backup);
      ownBackup.data = { user: backup.data.user, ...restored };
      ownBackup.files[0].id = row('recordings').id;
      ownBackup.data.contacts[0].notes = 'Changed note';
      ownBackup.data.emails[0].body_text = 'Changed body';
      ownBackup.data.recordings[0].title = 'Changed recording';
      const repeated = await importBackupForUser(userId, ownBackup, { mode: 'apply', conflict_mode: conflictMode });
      assert.equal(repeated.valid, true);
      await assertVictimUnchanged();
      const contacts = await rowsFor('contacts', userId);
      const emails = await rowsFor('emails', userId);
      const recordings = await rowsFor('recordings', userId);
      const expectedCount = conflictMode === 'keep_both' ? 2 : 1;
      assert.equal(contacts.length, expectedCount);
      assert.equal(emails.length, expectedCount);
      assert.equal(recordings.length, expectedCount);
      const expectedNote = conflictMode === 'replace' ? 'Changed note' : 'Original note';
      assert.equal(contacts.find(item => item.id === row('contacts').id).notes, expectedNote);
      assert.equal(emails.find(item => item.id === row('emails').id).body_text, conflictMode === 'replace' ? 'Changed body' : 'Original body');
      if (conflictMode === 'keep_both') {
        const copiedEmail = emails.find(item => item.id !== row('emails').id);
        const attachments = await rowsFor('email_attachments', userId);
        assert.ok(attachments.some(item => item.email_id === copiedEmail.id));
        const copiedRecording = recordings.find(item => item.id !== row('recordings').id);
        assert.ok((await rowsFor('recording_tag_links', userId)).some(item => item.recording_id === copiedRecording.id && item.tag_id === row('recording_tags').id));
      }

      // Foreign references without an imported parent must be rejected and roll
      // back even if the parent exists in the same database under another user.
      for (const [table, reference] of [
        ['calendar_calendars', 'account_id'], ['calendar_events', 'calendar_id'],
        ['calendar_event_subtasks', 'event_id'], ['calendar_event_attendees', 'event_id'],
        ['calendar_event_external_refs', 'event_id'], ['emails', 'mail_account_id'],
        ['mail_sender_rules', 'mail_account_id'], ['email_attachments', 'email_id'],
        ['mail_email_scores', 'email_id'], ['recording_tag_links', 'recording_id'],
      ]) {
        const child = { ...backup.data[table][0], ...(backup.data[table][0].id ? { id: crypto.randomUUID() } : {}) };
        assert.ok(child[reference]);
        const attack = { app: 'unihub', version: 1, files: [], data: { contacts: [{ id: crypto.randomUUID(), first_name: 'Must roll back' }], [table]: [child] } };
        const beforeContacts = await rowsFor('contacts', userId);
        await assert.rejects(importBackupForUser(userId, attack, { mode: 'apply', conflict_mode: conflictMode }), /unavailable .* record|inconsistent .* relationship/);
        assert.deepEqual(await rowsFor('contacts', userId), beforeContacts);
        await assertVictimUnchanged();
      }
    });
  }
});
