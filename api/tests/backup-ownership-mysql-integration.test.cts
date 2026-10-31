import type { FixtureValue } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));

function wav() {
  const bytes = Buffer.alloc(46);
  bytes.write('RIFF'); bytes.writeUInt32LE(38, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(2, 40);
  return bytes;
}

function restoreFixture(encrypt: FixtureValue) {
  const id = () => crypto.randomUUID();
  const ids = Object.fromEntries(['contact', 'folder', 'account', 'rule', 'email', 'attachment', 'score', 'calendarAccount', 'calendar', 'event', 'subtask', 'attendee', 'ref', 'recording', 'tag'].map(name => [name, id()]));
  const audio = wav();
  return {
    app: 'unihub', version: 1,
    files: [{ kind: 'recording', id: ids.recording, filename: 'recording.wav', sha256: crypto.createHash('sha256').update(audio).digest('hex'), data_base64: audio.toString('base64') }],
    data: {
      user: { full_name: 'Restored profile', timezone: 'Europe/Vienna' },
      user_settings: [{ setting_key: 'restore-setting', setting_value: 'restored' }, { setting_key: 'default_mail_account_id', setting_value: ids.account }],
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
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  const connection = await mysql.createConnection({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE || 'unihub_test', user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password', timezone: '+00:00' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-backup-ownership-'));
  const { setDb, getDb } = require('../dist/src/state') as typeof import('../src/state');
  const previousDb = getDb();
  const recordingsPath = require.resolve('../dist/src/services/recordings');
  const originalRecordings = require(recordingsPath) as typeof import('../src/services/recordings');
  const backupPath = require.resolve('../dist/src/services/backup');
  const originalBackup = require.cache[backupPath];
  require.cache[recordingsPath]!.exports = { ...originalRecordings, RECORDINGS_ROOT: directory };
  t.after(require('./helpers/backup-service-modules.cts').evictBackupServiceModules());
  const { importBackupForUser } = require(backupPath) as typeof import('../src/services/backup');
  const { encrypt } = require('../dist/src/security/encryption') as typeof import('../src/security/encryption');
  setDb({ execute: (...args: FixtureValue[]) => connection.execute(...args as [string, FixtureValue]), getConnection: async () => ({ execute: (...args: FixtureValue[]) => connection.execute(...args as [string, FixtureValue]), beginTransaction: () => connection.beginTransaction(), commit: () => connection.commit(), rollback: () => connection.rollback(), release() {} }) } as FixtureValue);
  t.after(async () => {
    setDb(previousDb);
    (require.cache as FixtureValue)[recordingsPath].exports = originalRecordings;
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
  // The immutable v0.9 fixture predates migrations 5–7. Shadow the new
  // restore-suspension tables on this connection; no provider work is runnable.
  await connection.execute(`CREATE TEMPORARY TABLE mail_writebacks (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending', state VARCHAR(24) NULL,
    is_current BOOLEAN NOT NULL DEFAULT TRUE,
    evidence_json JSON NULL, error VARCHAR(255) NULL) ENGINE=InnoDB`);
  await connection.execute(`CREATE TEMPORARY TABLE mail_engine_accounts (
    mail_account_id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL,
    generation BIGINT NOT NULL DEFAULT 0, paused_reason VARCHAR(255) NULL,
    lease_owner VARCHAR(128) NULL, lease_until DATETIME NULL) ENGINE=InnoDB`);
  await connection.execute(`CREATE TEMPORARY TABLE mail_engine_jobs (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL,
    state VARCHAR(24) NOT NULL DEFAULT 'queued', cancellation_requested BOOLEAN NOT NULL DEFAULT FALSE,
    lease_owner VARCHAR(128) NULL, lease_until DATETIME NULL, error VARCHAR(255) NULL) ENGINE=InnoDB`);
  // The frozen old schema remains unchanged. This restore security fixture
  // runs against the current application columns added by production migrations.
  await connection.execute('ALTER TABLE emails ADD COLUMN import_complete BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN filing_account_id CHAR(36) NULL, ADD COLUMN is_legacy BOOLEAN NOT NULL DEFAULT FALSE');
  await connection.execute('ALTER TABLE mail_folders ADD COLUMN mail_account_id CHAR(36) NULL, ADD COLUMN special_use VARCHAR(32) NULL');
  await connection.execute('ALTER TABLE calendar_events ADD COLUMN source_email_id CHAR(36) NULL, ADD COLUMN source_email_json LONGTEXT NULL');
  // 0.27 (upgrade 24): the order key of events and the hand order of tasks.
  await connection.execute('ALTER TABLE calendar_events ADD COLUMN order_key VARCHAR(64) NULL');
  await connection.execute(`CREATE TEMPORARY TABLE task_order (user_id CHAR(36) NOT NULL, item_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    calendar_id CHAR(36) NULL, event_id CHAR(36) NULL, remote_uid VARCHAR(500) NULL, recurrence_id VARCHAR(64) NOT NULL DEFAULT '', sort_rank BIGINT NOT NULL,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, item_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // 0.27 (upgrade 24): the move journal, which a calendar restore locks and
  // settles (calendar-move.ts), and the server copies (upgrade 12) it reads.
  await connection.execute(`CREATE TEMPORARY TABLE calendar_event_moves (id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, event_id CHAR(36) NULL,
    source_calendar_id CHAR(36) NULL, source_object_id CHAR(36) NULL, target_calendar_id CHAR(36) NULL, target_href VARCHAR(2048) NULL, state VARCHAR(16) NOT NULL) ENGINE=InnoDB`);
  await connection.execute(`CREATE TEMPORARY TABLE calendar_remote_objects (id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, calendar_id CHAR(36) NOT NULL,
    href VARCHAR(2048) NOT NULL, etag VARCHAR(255) NULL) ENGINE=InnoDB`);
  await connection.execute("ALTER TABLE mail_accounts ADD COLUMN sync_mode VARCHAR(16) NOT NULL DEFAULT 'download', ADD COLUMN sync_status VARCHAR(16) NOT NULL DEFAULT 'idle'");
  await connection.execute('ALTER TABLE mail_accounts ADD COLUMN sync_window_days INT NULL, ADD COLUMN trash_window_days INT NULL DEFAULT 30, ADD COLUMN sync_policy_confirmed_at DATETIME NULL');
  await connection.execute('ALTER TABLE emails ADD COLUMN remote_folder VARCHAR(255) NULL, ADD COLUMN remote_uid BIGINT NULL, ADD COLUMN remote_uidvalidity BIGINT NULL, ADD COLUMN remote_missing BOOLEAN NOT NULL DEFAULT FALSE');
  await connection.execute("ALTER TABLE emails ADD COLUMN observation_revision BIGINT NOT NULL DEFAULT 0, ADD COLUMN observed_modseq VARCHAR(32) NULL, ADD COLUMN raw_format VARCHAR(24) NOT NULL DEFAULT 'legacy_normalized', ADD COLUMN raw_bytes BIGINT NULL, ADD COLUMN raw_verified BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN content_state VARCHAR(24) NOT NULL DEFAULT 'legacy'");
  // 0.26 (upgrade 22): the contact model the restore writes. The shadow
  // tables state the production collations: a server whose default differs
  // (MariaDB 11.8 in CI) otherwise refuses the restore's UNION of contact ids.
  await connection.execute(`ALTER TABLE contacts ADD COLUMN uid VARCHAR(255) NULL, ADD COLUMN uid_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL, ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1,
    ADD COLUMN display_name VARCHAR(255) NULL, ADD COLUMN middle_name VARCHAR(255) NULL, ADD COLUMN name_prefix VARCHAR(255) NULL, ADD COLUMN name_suffix VARCHAR(255) NULL,
    ADD COLUMN department VARCHAR(255) NULL, ADD COLUMN birthday VARCHAR(32) NULL, ADD COLUMN anniversary VARCHAR(32) NULL, ADD COLUMN name_key VARCHAR(255) NOT NULL DEFAULT '',
    ADD UNIQUE KEY uq_contacts_uid (user_id, uid_hash)`);
  await connection.execute(`CREATE TEMPORARY TABLE contact_values (
    id CHAR(36) PRIMARY KEY, contact_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, kind VARCHAR(16) NOT NULL, position SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    is_preferred TINYINT(1) NOT NULL DEFAULT 0, label VARCHAR(32) NOT NULL DEFAULT '', custom_label VARCHAR(100) NULL, value VARCHAR(2048) NOT NULL,
    value_key VARCHAR(255) NOT NULL DEFAULT '', po_box VARCHAR(255) NULL, extended VARCHAR(255) NULL, street TEXT NULL, locality VARCHAR(255) NULL,
    region VARCHAR(255) NULL, postal_code VARCHAR(255) NULL, country VARCHAR(255) NULL, params JSON NULL, vcard_group VARCHAR(64) NULL, legacy_slot TINYINT UNSIGNED NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TEMPORARY TABLE contact_properties (
    id CHAR(36) PRIMARY KEY, contact_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, position SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    vcard_group VARCHAR(64) NULL, name VARCHAR(64) NOT NULL, params JSON NULL, value MEDIUMTEXT NOT NULL, source_version VARCHAR(8) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute('CREATE TEMPORARY TABLE contact_uid_aliases (user_id CHAR(36) NOT NULL, uid_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, uid VARCHAR(255) NOT NULL, contact_id CHAR(36) NOT NULL, merge_id CHAR(36) NULL, PRIMARY KEY (user_id, uid_hash)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  await connection.execute(`CREATE TEMPORARY TABLE contact_photos (contact_id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, sha256 CHAR(64) NOT NULL,
    width SMALLINT UNSIGNED NOT NULL, height SMALLINT UNSIGNED NOT NULL, bytes INT UNSIGNED NOT NULL, thumb_sha256 CHAR(64) NOT NULL, source VARCHAR(16) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute('CREATE TEMPORARY TABLE contact_duplicate_dismissals (contact_a CHAR(36) NOT NULL, contact_b CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, PRIMARY KEY (contact_a, contact_b)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  // A restored draft loses its schedule (0.24); the restore clears it on this connection.
  await connection.execute(`CREATE TEMPORARY TABLE mail_scheduled_sends (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, email_id CHAR(36) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'scheduled', last_error VARCHAR(255) NULL) ENGINE=InnoDB`);
  await connection.execute('CREATE TEMPORARY TABLE notification_config (id INT PRIMARY KEY, reminder_revision BIGINT DEFAULT 0)');
  await connection.execute<ResultSetHeader>('INSERT INTO notification_config (id) VALUES (1)');
  const victim = crypto.randomUUID();
  await connection.execute<ResultSetHeader>("INSERT INTO users (id,email,password_hash,full_name) VALUES (?, 'victim@example.test', 'synthetic-hash', 'Victim')", [victim]);
  const backup: FixtureValue = restoreFixture(encrypt);
  const tables = Object.entries(backup.data).filter(([, rows]) => Array.isArray(rows)).map(([table]) => table);
  for (const table of tables) {
    for (const source of backup.data[table]) {
      const row = { ...source, user_id: victim };
      const columns = Object.keys(row);
      await connection.execute<ResultSetHeader>(`INSERT INTO ${table} (${columns.map(column => '`' + column + '`').join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, Object.values(row));
    }
  }
  async function rowsFor(table: string, userId: string) {
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT * FROM ${table} WHERE ${table === 'users' ? 'id' : 'user_id'} = ?`, [userId]);
    return rows.map((row: FixtureValue) => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  const victimBefore = Object.fromEntries(await Promise.all(['users', ...tables].map(async table => [table, await rowsFor(table, victim)])));
  async function assertVictimUnchanged() {
    for (const [table, expected] of Object.entries(victimBefore)) assert.deepEqual(await rowsFor(table, victim), expected, `Victim ${table} must remain unchanged`);
  }
  for (const conflictMode of ['keep_existing', 'replace', 'keep_both']) {
    await t.test(conflictMode, async () => {
      const userId = crypto.randomUUID();
      await connection.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash) VALUES (?, ?, ?)', [userId, userId + '@example.test', 'synthetic-hash']);
      const result = await importBackupForUser(userId, structuredClone(backup), { mode: 'apply', conflict_mode: conflictMode });
      assert.equal(result.valid, true);
      await assertVictimUnchanged();
      const restored = Object.fromEntries(await Promise.all(tables.map(async table => [table, await rowsFor(table, userId)])));
      for (const table of tables) {
        assert.equal(restored[table].length, backup.data[table].length, `${table} restored once`);
        if (backup.data[table][0].id) assert.notEqual(restored[table][0].id, backup.data[table][0].id, `${table} receives a fresh ID`);
        assert.equal(restored[table][0].user_id, userId);
      }
      const row = (table: string) => restored[table][0];
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
      const defaultAccount = (rows: FixtureValue[]) => rows.find(item => item.setting_key === 'default_mail_account_id')?.setting_value;
      assert.equal(defaultAccount(restored.user_settings), row('mail_accounts').id, 'The default sending account names the restored account, not the colliding one');
      // Settings without their account: the first account, not another user's ID.
      const settingsOnlyUser = crypto.randomUUID();
      await connection.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash) VALUES (?, ?, ?)', [settingsOnlyUser, settingsOnlyUser + '@example.test', 'synthetic-hash']);
      const settingsOnly = { app: 'unihub', version: 1, files: [], data: { user_settings: structuredClone(backup.data.user_settings) } };
      assert.equal((await importBackupForUser(settingsOnlyUser, settingsOnly, { mode: 'apply', conflict_mode: conflictMode })).valid, true);
      assert.equal(defaultAccount(await rowsFor('user_settings', settingsOnlyUser)), '');

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
      assert.equal(contacts.find((item) => item.id === row('contacts').id).notes, expectedNote);
      assert.equal(emails.find((item) => item.id === row('emails').id).body_text, conflictMode === 'replace' ? 'Changed body' : 'Original body');
      if (conflictMode === 'keep_both') {
        const copiedEmail = emails.find((item) => item.id !== row('emails').id);
        const attachments = await rowsFor('email_attachments', userId);
        assert.ok(attachments.some((item) => item.email_id === copiedEmail.id));
        const copiedRecording = recordings.find((item) => item.id !== row('recordings').id);
        assert.ok((await rowsFor('recording_tag_links', userId)).some((item) => item.recording_id === copiedRecording.id && item.tag_id === row('recording_tags').id));
      }

      // Foreign references without an imported parent must be rejected and roll
      // back even if the parent exists in the same database under another user.
      for (const [table, reference] of [
        ['calendar_calendars', 'account_id'], ['calendar_events', 'calendar_id'],
        ['calendar_event_subtasks', 'event_id'], ['calendar_event_attendees', 'event_id'],
        ['calendar_event_external_refs', 'event_id'], ['emails', 'mail_account_id'],
        ['mail_sender_rules', 'mail_account_id'], ['email_attachments', 'email_id'],
        ['mail_email_scores', 'email_id'], ['recording_tag_links', 'recording_id'],
      ] as const) {
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
