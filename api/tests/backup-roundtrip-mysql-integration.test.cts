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
const sha256 = (bytes: FixtureValue) => crypto.createHash('sha256').update(bytes).digest('hex');
const TABLES = ['user_settings', 'contacts', 'contact_values', 'contact_properties', 'contact_photos', 'contact_uid_aliases', 'contact_duplicate_dismissals', 'mail_folders', 'mail_accounts', 'mail_folder_remote_boxes', 'mail_sender_rules', 'emails', 'email_attachments', 'mail_email_scores', 'calendar_accounts', 'calendar_calendars', 'calendar_events', 'calendar_event_subtasks', 'calendar_event_attendees', 'calendar_event_external_refs', 'recordings', 'recording_tags', 'recording_tag_links', 'recording_transcription_jobs', 'mail_folder_reconciliations', 'mail_folder_recovery_items', 'mail_folder_rule_overrides', 'mail_account_settings', 'mail_templates', 'calendar_settings'];

function wav() {
  const bytes = Buffer.alloc(76);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32, 40);
  for (let index = 0; index < 16; index++) bytes.writeInt16LE(Math.round(Math.sin(index) * 1000), 44 + index * 2);
  return bytes;
}

async function waitFor(read: FixtureValue, wanted: FixtureValue, description: FixtureValue, { allowFailure = false }: FixtureValue = {}) {
  const deadline = Date.now() + 60000;
  let current;
  while (Date.now() < deadline) {
    current = await read();
    if (wanted(current)) return current;
    if (!allowFailure && current?.status === 'failed') assert.fail(`${description}: ${current.error}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail(`${description} timed out: ${JSON.stringify(current)}`);
}

test('production export and restore jobs round-trip what a backup holds through encrypted and legacy archives', {
  skip: !process.env.MYSQL_TEST_HOST,
  timeout: 240000,
}, async (t) => {
  const database = process.env.MYSQL_TEST_DATABASE || 'unihub_test';
  assert.match(database, /_test$/, 'Use an empty disposable database ending in _test');
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  const pool = mysql.createPool({
    host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    database, user: process.env.MYSQL_TEST_USER || 'unihub_test',
    password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
    timezone: '+00:00', connectionLimit: 4,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-backup-roundtrip-'));
  const sourceRoot = path.join(directory, 'source');
  const destinationRoot = path.join(directory, 'destination');
  let ownsDatabase = false;
  t.after(async () => {
    try {
      if (ownsDatabase) {
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
  const [existing] = await pool.query<RowDataPacket[]>('SHOW TABLES');
  assert.equal(existing.length, 0, 'Refusing to change a nonempty database');
  ownsDatabase = true;
  const source = createBackupRuntime(sourceRoot, 'source-roundtrip-key', pool);
  const destination = createBackupRuntime(destinationRoot, 'different-destination-roundtrip-key', pool);
  await source('services/database').ensureSchema();
  const sourceCrypto = source('security/encryption');
  const destinationCrypto = destination('security/encryption');
  async function insert(table: string, row: FixtureValue) {
    const columns = Object.keys(row);
    await pool.execute<ResultSetHeader>(`INSERT INTO ${table} (${columns.map(name => '`' + name + '`').join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, Object.values(row));
  }
  // A contact as the store writes it (uid and child values).
  const { valueKey } = require('../dist/src/services/contact-keys') as typeof import('../src/services/contact-keys');
  async function insertContact(row: FixtureValue, values: [import('../src/contracts/contacts').ContactValueKind, string][] = []) {
    const id = row.id || uuid();
    await insert('contacts', { ...row, id, uid: `urn:uuid:${id}`, uid_hash: crypto.createHash('sha256').update(`urn:uuid:${id}`).digest('hex') });
    for (const [index, [kind, value]] of values.entries()) {
      await insert('contact_values', { id: uuid(), contact_id: id, user_id: row.user_id, kind, position: values.slice(0, index).filter(([other]) => other === kind).length, value, value_key: valueKey(kind, value) });
    }
    return id;
  }
  async function newUser(label: string) {
    const id = uuid();
    await insert('users', { id, email: label + '@example.test', password_hash: 'synthetic-hash', full_name: label, role: 'user' });
    return id;
  }
  async function rowsFor(table: string, userId: string) {
    const [rows] = table === 'mail_folder_remote_boxes'
      ? await pool.execute<RowDataPacket[]>('SELECT boxes.* FROM mail_folder_remote_boxes boxes JOIN mail_folders folders ON folders.id = boxes.folder_id JOIN mail_accounts accounts ON accounts.id = boxes.mail_account_id WHERE folders.user_id = ? AND accounts.user_id = ?', [userId, userId])
      : table === 'mail_folder_rule_overrides'
        ? await pool.execute<RowDataPacket[]>('SELECT o.* FROM mail_folder_rule_overrides o JOIN mail_sender_rules r ON r.id = o.rule_id JOIN mail_accounts a ON a.id = o.mail_account_id WHERE r.user_id = ? AND a.user_id = ?', [userId, userId])
        : await pool.execute<RowDataPacket[]>(`SELECT * FROM ${table} WHERE user_id = ?`, [userId]);
    return rows.map((row: FixtureValue) => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  async function snapshot(userId: string) {
    return Object.fromEntries(await Promise.all(TABLES.map(async table => [table, await rowsFor(table, userId)])));
  }
  const sourceUser = await newUser('roundtrip-source');
  const unrelatedUser = await newUser('roundtrip-unrelated');
  await insertContact({ user_id: unrelatedUser, first_name: 'Do not export or change', notes: 'Unrelated private data' }, [['email', 'unrelated@example.test']]);
  await pool.execute<ResultSetHeader>('UPDATE users SET full_name = ?, timezone = ? WHERE id = ?', ['Grüße Roundtrip', 'Europe/Vienna', sourceUser]);
  await insert('user_settings', { user_id: sourceUser, setting_key: 'calendar_preferences', setting_value: JSON.stringify({ firstDay: 1, custom: 'Grüße\nTwo lines' }) });
  // Choices and an order saved by older releases still name removed modules.
  await insert('user_settings', { user_id: sourceUser, setting_key: 'module_preferences', setting_value: JSON.stringify({ notes: { visible: false, enabled: false, background: false }, games: { visible: false }, recordings: { visible: false } }) });
  await insert('user_settings', { user_id: sourceUser, setting_key: 'module_order', setting_value: JSON.stringify(['notes', 'recordings', 'mail', 'calendar', 'contacts']) });
  const zoeId = await insertContact({ user_id: sourceUser, first_name: 'Zoë', last_name: 'Example', notes: 'Unicode: Grüße\nSecond line', is_favorite: 1 },
    [['email', 'zoe@example.test'], ['email', 'second@example.test'], ['email', 'third@example.test'], ['email', 'fourth@example.test'], ['phone', '+43 12345'],
      ['address', 'Beispielgasse 1, 1010 Wien']]);
  const anaId = await insertContact({ user_id: sourceUser, first_name: 'Ana', last_name: 'Example' }, [['email', 'ana@example.test']]);
  // The rest of the vCard model (0.26): a kept property, a photo with its two
  // content-addressed files, a merged-away UID and a "Not the same person" pair.
  await insert('contact_properties', { id: uuid(), contact_id: zoeId, user_id: sourceUser, position: 0, name: 'X-SYNTHETIC', params: JSON.stringify({ type: ['work'] }), value: 'kept ✓', source_version: '4.0' });
  const photoBytes = { full: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(300)]), thumb: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(40)]) };
  const sourcePhotos = source('services/contact-photos');
  for (const bytes of Object.values(photoBytes)) {
    const file = sourcePhotos.photoPath(sourceUser, sha256(bytes));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  await insert('contact_photos', { contact_id: zoeId, user_id: sourceUser, sha256: sha256(photoBytes.full), width: 512, height: 512, bytes: photoBytes.full.length, thumb_sha256: sha256(photoBytes.thumb), source: 'upload' });
  await insert('contact_uid_aliases', { user_id: sourceUser, uid_hash: sha256('urn:uuid:merged-away-example'), uid: 'urn:uuid:merged-away-example', contact_id: zoeId });
  await insert('contact_duplicate_dismissals', { contact_a: zoeId < anaId ? zoeId : anaId, contact_b: zoeId < anaId ? anaId : zoeId, user_id: sourceUser });
  const folderIds = { research: uuid(), copies: uuid() };
  await insert('mail_folders', { id: folderIds.research, user_id: sourceUser, slug: 'research', display_name: 'Research & Notes', position: 7, is_system: 0 });
  await insert('mail_folders', { id: folderIds.copies, user_id: sourceUser, slug: 'copies', display_name: 'Archived Copies', position: 8, is_system: 0 });
  const originalFiles = new Map();
  const passwords = new Map();
  for (let index = 0; index < 2; index++) {
    const accountId = uuid();
    const emailAddress = `mail-${index}@example.test`;
    passwords.set(emailAddress, `synthetic-mail-password-${index}`);
    await insert('mail_accounts', { id: accountId, user_id: sourceUser, email_address: emailAddress, provider: 'custom', username: emailAddress, imap_host: '8.8.8.8', smtp_host: '9.9.9.9', encrypted_password: sourceCrypto.encrypt(passwords.get(emailAddress)), is_active: 1, sync_mode: index ? 'sync' : 'download', sync_status: index ? 'running' : 'idle', delete_emails_on_server: index ? 0 : 1 });
    await insert('mail_sender_rules', { id: uuid(), user_id: sourceUser, mail_account_id: accountId, match_type: 'email', match_value: 'sender@example.test', target_folder: 'research' });
    for (const [copy, sourceFolder] of ['INBOX/Research', 'Archive/Copies'].entries()) {
    const emailId = uuid(), attachmentId = uuid();
    const fileKey = emailAddress + ':' + sourceFolder;
    const folderSlug = copy ? 'copies' : 'research';
    await insert('mail_folder_remote_boxes', { folder_id: folderIds[folderSlug], mail_account_id: accountId, remote_name: sourceFolder });
    // Message-ID is deliberately repeated within one account, while folder,
    // UID, body and raw bytes distinguish two real archived messages.
    const raw = Buffer.from(`From: sender@example.test\r\nTo: ${emailAddress}\r\nMessage-ID: <roundtrip-${index}@example.test>\r\nSubject: Mail ${index}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nGrüße from message ${index}, copy ${copy}.\r\n`);
    const attachment = Buffer.from([0, 255, 17, 128, index, copy, 10, 13, 0]);
    const rawPath = path.join(sourceRoot, 'mail-raw', sourceUser, emailId + '.eml');
    const attachmentPath = path.join(sourceRoot, 'attachments', sourceUser, attachmentId + '.bin');
    await fs.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
    await fs.writeFile(rawPath, raw); await fs.writeFile(attachmentPath, attachment);
    originalFiles.set('raw:' + fileKey, raw); originalFiles.set('attachment:' + fileKey, attachment);
    await insert('emails', { id: emailId, user_id: sourceUser, mail_account_id: accountId, message_id: `<roundtrip-${index}@example.test>`, subject: 'Mail ' + index, from_address: 'sender@example.test', to_addresses: JSON.stringify([emailAddress]), body_text: 'Body Grüße ' + index + ':' + copy, body_html: `<p>Grüße ${index}:${copy}</p><img src="/api/mail/attachments/${attachmentId}">`, folder: folderSlug, source_folder: sourceFolder, imap_uid: 22 + index + copy * 10, imap_uidvalidity: 123, remote_folder: copy ? 'Moved/Current' : sourceFolder, remote_uid: 100 + index + copy, remote_uidvalidity: 456, remote_missing: copy, raw_storage_path: rawPath, raw_sha256: sha256(raw), raw_bytes: raw.length, raw_format: 'exact_octets', raw_verified: 1, received_at: '2030-01-02 12:34:56', is_starred: 1, has_attachments: 1, import_complete: 1 });
    await insert('email_attachments', { id: attachmentId, user_id: sourceUser, email_id: emailId, filename: 'data-' + index + '.bin', content_type: 'application/octet-stream', size_bytes: attachment.length, storage_path: attachmentPath, content_id: 'content-' + index });
    if (index === 0 && copy === 0) {
      const secondId = uuid();
      const secondBytes = Buffer.from(attachment); secondBytes[secondBytes.length - 1] ^= 127;
      const secondPath = path.join(sourceRoot, 'attachments', sourceUser, secondId + '.bin');
      await fs.writeFile(secondPath, secondBytes);
      // Same name and byte count are not proof that two attachments are equal.
      await insert('email_attachments', { id: secondId, user_id: sourceUser, email_id: emailId, filename: 'data-0.bin', content_type: 'application/octet-stream', size_bytes: secondBytes.length, storage_path: secondPath, content_id: 'second-content-0' });
      await pool.execute<ResultSetHeader>('UPDATE emails SET body_html = CONCAT(body_html, ?) WHERE id = ?', [`<img src="/api/mail/attachments/${secondId}">`, emailId]);
    }
    await insert('mail_email_scores', { id: uuid(), user_id: sourceUser, email_id: emailId, score_version: 'v1', total_score: 12.5, reasons: JSON.stringify(['synthetic reason']), metadata: JSON.stringify({ test: true }) });
    }
  }
  const [mailAccounts] = await pool.execute<RowDataPacket[]>('SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY email_address', [sourceUser]);
  const [sourceEmails] = await pool.execute<RowDataPacket[]>('SELECT * FROM emails WHERE user_id = ? ORDER BY body_text', [sourceUser]);
  await pool.execute<ResultSetHeader>('UPDATE mail_folders SET mail_account_id = ?, special_use = ? WHERE id = ?', [mailAccounts[1].id, 'archive', folderIds.research]);
  await pool.execute<ResultSetHeader>('UPDATE emails SET filing_account_id = ? WHERE id = ?', [mailAccounts[1].id, sourceEmails[0].id]);
  await pool.execute<ResultSetHeader>('UPDATE emails SET is_legacy = TRUE WHERE id = ?', [sourceEmails[1].id]);
  // The default sending account is a mail account ID; restore must remap it.
  await insert('user_settings', { user_id: sourceUser, setting_key: 'default_mail_account_id', setting_value: mailAccounts[1].id });
  // 0.24: registry settings, a folder named by id, a signature, a template,
  // threading headers and a snooze.
  await insert('user_settings', { user_id: sourceUser, setting_key: 'mail_preview_lines', setting_value: '3' });
  await insert('mail_account_settings', { mail_account_id: mailAccounts[1].id, user_id: sourceUser, setting_key: 'notify_folders', setting_value: JSON.stringify(['role:junk', `folder:${folderIds.copies}`]) });
  await insert('mail_account_settings', { mail_account_id: mailAccounts[1].id, user_id: sourceUser, setting_key: 'notify_detail', setting_value: 'sender' });
  await pool.execute<ResultSetHeader>('UPDATE mail_accounts SET signature_html = ?, signature_text = ? WHERE id = ?', ['<p>Grüße, <b>Roundtrip</b></p>', 'Grüße, Roundtrip', mailAccounts[0].id]);
  await insert('mail_templates', { id: uuid(), user_id: sourceUser, name: 'Weekly report', subject: 'Report for week', body_html: '<p>Hello team,</p>', body_text: 'Hello team,' });
  await pool.execute<ResultSetHeader>('UPDATE emails SET in_reply_to = ?, references_header = ?, thread_key = ?, snoozed_until = ? WHERE id = ?',
    ['<parent@example.test>', '<root@example.test> <parent@example.test>', sha256('<root@example.test>'), '2030-03-04 05:06:07', sourceEmails[0].id]);
  for (const account of mailAccounts) {
    const mappings = await rowsFor('mail_folder_remote_boxes', sourceUser);
    await insert('mail_folder_reconciliations', { mail_account_id: account.id, user_id: sourceUser,
      inventory: JSON.stringify(['INBOX/Research', 'Archive/Copies']),
      previous_mappings: JSON.stringify(mappings.filter((row) => row.mail_account_id === account.id)), completed_at: '2030-01-01 11:00:00' });
  }
  await insert('mail_folder_recovery_items', { email_id: sourceEmails[0].id, user_id: sourceUser, source_account_id: mailAccounts[0].id,
    original_folder: 'old-research', original_filing_account_id: mailAccounts[0].id, target_folder: 'research', target_account_id: mailAccounts[1].id, action: 'manual', created_at: '2030-01-01 11:00:00' });
  const [rules] = await pool.execute<RowDataPacket[]>('SELECT id FROM mail_sender_rules WHERE user_id = ? ORDER BY id', [sourceUser]);
  await insert('mail_folder_rule_overrides', { rule_id: rules[0].id, mail_account_id: mailAccounts[1].id, target_folder: 'research' });
  // Legacy row from the removed Games module: kept in place, never exported.
  await insert('tetris_scores', { user_id: sourceUser, score: 13500, lines: 42, level: 5, achieved_at: '2030-01-01 11:00:00' });
  const calendarAccountId = uuid(), calendarId = uuid(), eventId = uuid();
  await insert('calendar_accounts', { id: calendarAccountId, user_id: sourceUser, provider: 'caldav', display_name: 'Roundtrip calendar', account_email: 'calendar@example.test', username: 'calendar-user', discovery_url: 'https://8.8.8.8/dav/', base_url: 'https://8.8.8.8/dav/', encrypted_password: sourceCrypto.encrypt('synthetic-calendar-password'), encrypted_access_token: sourceCrypto.encrypt('synthetic-access-token'), encrypted_refresh_token: sourceCrypto.encrypt('synthetic-refresh-token'), is_active: 1 });
  await insert('calendar_calendars', { id: calendarId, user_id: sourceUser, account_id: calendarAccountId, name: 'Research Calendar', external_id: 'https://8.8.8.8/dav/calendar/', color: '#2244ff', is_visible: 1 });
  await insert('calendar_settings', { calendar_id: calendarId, user_id: sourceUser, setting_key: 'notify_enabled', setting_value: 'false' });
  await insert('calendar_events', { id: eventId, user_id: sourceUser, calendar_id: calendarId, uid: 'Roundtrip-Event@example.test', title: 'Roundtrip event', description: 'Preserve Grüße\nSecond line', start_time: '2030-02-03 10:00:00', end_time: '2030-02-03 11:00:00', recurrence: 'FREQ=WEEKLY;COUNT=3', reminders: JSON.stringify([10, 60]), reminder_minutes: 10, todo_status: 'done', done_at: '2030-02-03 12:00:00', location: 'Vienna' });
  await insert('calendar_event_subtasks', { id: uuid(), user_id: sourceUser, event_id: eventId, title: 'Keep this task', is_done: 1, position: 2 });
  await insert('calendar_event_attendees', { id: uuid(), user_id: sourceUser, event_id: eventId, email: 'attendee@example.test', display_name: 'Attendee', response_status: 'accepted' });
  await insert('calendar_event_external_refs', { id: uuid(), user_id: sourceUser, event_id: eventId, calendar_id: calendarId, account_id: calendarAccountId, provider: 'caldav', external_event_id: 'event.ics', external_etag: 'etag-one' });
  // A task list only UniHub holds, with a task, its subtask and an attendee.
  const localAccountId = uuid(), localCalendarId = uuid(), localEventId = uuid();
  await insert('calendar_accounts', { id: localAccountId, user_id: sourceUser, provider: 'local', display_name: 'UniHub', is_active: 1 });
  await insert('calendar_calendars', { id: localCalendarId, user_id: sourceUser, account_id: localAccountId, name: 'Errands', color: '#22c55e', is_visible: 1 });
  await insert('calendar_events', { id: localEventId, user_id: sourceUser, calendar_id: localCalendarId, title: 'Local errand', description: 'Only UniHub has this', start_time: '2030-02-04 09:00:00', end_time: '2030-02-04 09:30:00', todo_status: 'changed', location: 'Graz' });
  await insert('calendar_event_subtasks', { id: uuid(), user_id: sourceUser, event_id: localEventId, title: 'Buy stamps', is_done: 0, position: 0 });
  await insert('calendar_event_attendees', { id: uuid(), user_id: sourceUser, event_id: localEventId, email: 'helper@example.test', display_name: 'Helper', response_status: 'needs-action' });
  const tagId = uuid();
  const audioByTitle = new Map();
  await insert('recording_tags', { id: tagId, user_id: sourceUser, name: 'Research', color: '#2244ff' });
  for (let index = 0; index < 2; index++) {
    const recordingId = uuid();
    const audio = wav(); audio[audio.length - 1] ^= index;
    const title = 'Synthetic PCM ' + index;
    audioByTitle.set(title, audio);
    const audioPath = path.join(sourceRoot, 'recordings', sourceUser, recordingId + '.wav');
    await fs.mkdir(path.dirname(audioPath), { recursive: true }); await fs.writeFile(audioPath, audio);
    await insert('recordings', { id: recordingId, user_id: sourceUser, title, description: 'Keep original audio bytes', original_filename: 'tone.wav', content_type: 'audio/wav', size_bytes: audio.length, duration_seconds: 0.002, storage_path: audioPath, source: 'recorded', category: 'none', recorded_at: '2030-01-01 10:00:00', metadata: JSON.stringify({ sampleRate: 8000 }) });
    await insert('recording_tag_links', { user_id: sourceUser, recording_id: recordingId, tag_id: tagId });
    await insert('recording_transcription_jobs', { id: uuid(), user_id: sourceUser, recording_id: recordingId, status: 'completed', provider: 'synthetic', model: 'test', language: 'de', transcript_text: 'Saved Grüße transcript ' + index, created_at: '2030-01-01 11:00:00', updated_at: '2030-01-01 11:01:00' });
  }
  // The Sync account's first copy is at the provider (a present occurrence in
  // the mailbox epoch the last LIST saw); its second is marked missing there.
  const [liveSync] = await pool.execute<RowDataPacket[]>('SELECT id, remote_folder, remote_uid, remote_uidvalidity FROM emails WHERE user_id = ? AND mail_account_id = ? AND remote_missing = FALSE',
    [sourceUser, mailAccounts[1].id]);
  assert.equal(liveSync.length, 1);
  const liveMailbox = uuid();
  await insert('mail_remote_mailboxes', { id: liveMailbox, user_id: sourceUser, mail_account_id: mailAccounts[1].id, remote_name: liveSync[0].remote_folder, delimiter: '/', uidvalidity: liveSync[0].remote_uidvalidity, state: 'active' });
  await insert('mail_remote_occurrences', { id: uuid(), user_id: sourceUser, mail_account_id: mailAccounts[1].id, mailbox_id: liveMailbox, uidvalidity: liveSync[0].remote_uidvalidity,
    uid: liveSync[0].remote_uid, email_id: liveSync[0].id, presence: 'present', observed_at: '2030-01-02 12:34:56' });
  const original = await snapshot(sourceUser);
  // What a user backup holds (data classes, 0.28): all of the above except
  // the provider's copies. The Sync account's message at the provider goes
  // with its files, scores, recovery history and provider evidence (the
  // account's folder reconciliation marker stays, so moves are not replayed;
  // its copy marked missing stays as UniHub's own), and the CalDAV event with
  // its children; that task's UniHub state travels as an overlay instead.
  const keptEmails = new Set(original.emails.filter((row: FixtureValue) => row.id !== liveSync[0].id).map((row: FixtureValue) => row.id));
  const keptEvents = new Set(original.calendar_events.filter((row: FixtureValue) => row.calendar_id !== calendarId).map((row: FixtureValue) => row.id));
  const kept: typeof original = { ...original,
    emails: original.emails.filter((row: FixtureValue) => keptEmails.has(row.id)),
    ...Object.fromEntries(['email_attachments', 'mail_email_scores', 'mail_folder_recovery_items'].map(table => [table, original[table].filter((row: FixtureValue) => keptEmails.has(row.email_id))])),
    calendar_events: original.calendar_events.filter((row: FixtureValue) => keptEvents.has(row.id)),
    ...Object.fromEntries(['calendar_event_subtasks', 'calendar_event_attendees'].map(table => [table, original[table].filter((row: FixtureValue) => keptEvents.has(row.event_id))])),
    calendar_event_external_refs: [],
  };
  for (const table of ['emails', 'email_attachments', 'mail_email_scores', 'calendar_events', 'calendar_event_subtasks']) {
    assert.ok(kept[table].length > 0 && kept[table].length < original[table].length, `${table}: the fixture has rows on both sides of the rule`);
  }
  assert.equal(kept.mail_folder_recovery_items.length, 1);
  // An accepted intent of the Download account (a Sync account's provider evidence is not in a backup).
  const pendingSource = kept.emails.find((row: FixtureValue) => row.mail_account_id === mailAccounts[0].id);
  assert.equal(mailAccounts[0].sync_mode, 'download');
  const sourceWritebackId = uuid();
  await insert('mail_writebacks', { id: sourceWritebackId, user_id: sourceUser, mail_account_id: pendingSource.mail_account_id,
    email_id: pendingSource.id, action: 'read', target_value: '1', base_value: '0', remote_folder: 'INBOX', remote_uid: 1, remote_uidvalidity: 1 });

  const unrelated = await snapshot(unrelatedUser);
  const exportJobs = source('services/export-jobs');
  async function exportArchive() {
    // An older client's encrypt: false no longer gives an unencrypted archive.
    const started = await exportJobs.startDataExportJob(sourceUser, { sections: 'full', encrypt: false });
    const ready = await waitFor(() => exportJobs.getDataExportJob(sourceUser, started.id), (job: FixtureValue) => job?.status === 'ready', 'Export');
    const bytes = await fs.readFile(ready.file_path);
    assert.equal(bytes.length, Number(ready.file_size)); assert.equal(sha256(bytes), ready.file_sha256);
    assert.ok(ready.file_path.startsWith(sourceRoot + path.sep));
    assert.equal(Number(ready.encryption_enabled), 1);
    assert.ok(ready.file_path.endsWith('.unihub-backup'));
    assert.ok(ready.keep_until === null || ready.keep_until instanceof Date || typeof ready.keep_until === 'string');
    const [[key]] = await pool.execute<RowDataPacket[]>('SELECT recovery_password_ciphertext FROM backup_archive_keys WHERE backup_uuid = ? AND user_id = ?', [ready.backup_uuid, sourceUser]);
    const password = source('services/backup-container').revealProtectedRecoveryPassword(key.recovery_password_ciphertext, ready.backup_uuid);
    assert.equal(bytes.includes(Buffer.from('synthetic-mail-password-0')), false);
    // The data JSON was staged beside the archive, not in the system temporary directory.
    assert.deepEqual((await fs.readdir(path.join(sourceRoot, 'backups', sourceUser))).filter(name => name.endsWith('.partial')), []);
    return { ...ready, bytes, password };
  }
  const encrypted = await exportArchive();
  const contents = exportJobs.serializeJob(await exportJobs.getDataExportJob(sourceUser, encrypted.id)).contents;
  // The job says what the archive holds and what it left out, with counts.
  assert.deepEqual(contents.left_out.map((item: FixtureValue) => [item.what, item.count]),
    [['CalDAV and subscription events', 1], ['Sync-mode mail', original.emails.length - kept.emails.length]]);
  assert.deepEqual([...contents.included].sort(), ['config', 'local', 'local-by-policy']);
  // A ZIP as releases before 0.28 could write without encryption; the readers still import it.
  const legacyPath = path.join(directory, 'legacy.zip');
  await exportJobs.writeZip(await source('services/backup').buildBackupArchiveEntriesForUser(sourceUser, 'full', { workDirectory: directory }), legacyPath);
  const legacy = { bytes: await fs.readFile(legacyPath), password: null };
  const legacyParsed = await source('services/backup').backupFromZipFile(legacyPath);
  // The kept mail's raw messages and attachments, the recordings, and the two files of one contact photo.
  assert.equal(legacyParsed.manifest.file_count, 11);
  assert.equal(legacyParsed.backup.data.calendar_overlay_restores.length, 1, 'The CalDAV task\'s UniHub state');
  assert.deepEqual(legacyParsed.manifest.missing_files, []);
  assert.equal(legacyParsed.backup.data.contacts.length, 2, 'Other users must not appear in an export');
  assert.deepEqual(await snapshot(sourceUser), original, 'Export must not mutate source rows');

  await t.test('export never advertises an archive larger than this deployment can upload for restore', async () => {
    const limited = createBackupRuntime(sourceRoot, 'source-roundtrip-key', pool);
    limited('config').BACKUP_UPLOAD_MAX_SIZE = 64;
    const service = limited('services/export-jobs');
    const started = await service.startDataExportJob(sourceUser, { sections: 'full', encrypt: true });
    const failed = await waitFor(() => service.getDataExportJob(sourceUser, started.id), (job: FixtureValue) => job?.status === 'failed', 'Oversized archive rejection', { allowFailure: true });
    assert.match(failed.error, /exceeds the import upload limit/i);
    assert.equal(failed.file_path, null);
    const files = await fs.readdir(path.join(sourceRoot, 'backups', sourceUser));
    assert.equal(files.some(filename => filename.startsWith(started.id)), false, 'Remove unusable archive and temporary ZIP');
    const [[keys]] = await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS total FROM backup_archive_keys WHERE export_job_id = ?', [started.id]);
    assert.equal(keys.total, 0, 'Remove unusable archive key metadata');
  });
  await t.test('a missing selected recording fails export clearly while an unrelated section can still export', async () => {
    const originalPath = original.recordings[0].storage_path;
    const heldPath = originalPath + '.held-by-test';
    await fs.rename(originalPath, heldPath);
    try {
      const started = await exportJobs.startDataExportJob(sourceUser, { sections: 'full', encrypt: true });
      const failed = await waitFor(() => exportJobs.getDataExportJob(sourceUser, started.id), (job: FixtureValue) => job?.status === 'failed', 'Missing selected file rejection', { allowFailure: true });
      assert.match(failed.error, /referenced file.*missing|missing.*referenced file/i);
      assert.equal(failed.file_path, null);
      const partial = await exportJobs.startDataExportJob(sourceUser, { sections: ['contacts'] });
      const ready = await waitFor(() => exportJobs.getDataExportJob(sourceUser, partial.id), (job: FixtureValue) => job?.status === 'ready', 'Unrelated contacts export');
      assert.deepEqual(exportJobs.serializeJob(await exportJobs.getDataExportJob(sourceUser, partial.id)).requested_sections, ['contacts']);
    } finally { await fs.rename(heldPath, originalPath); }
  });

  async function uploadAndRestore(runtime: FixtureValue, userId: string, archive: FixtureValue, conflictMode = 'replace', { wrongPasswordFirst = false }: FixtureValue = {}) {
    const service = runtime('services/backup-restore-jobs');
    const upload = path.join(directory, uuid() + '.upload');
    await fs.writeFile(upload, archive.bytes);
    const created = await service.createUploadedRestoreJob(userId, upload, { sections: 'full', conflict_mode: conflictMode, credentials_mode: 'restore' });
    if (archive.password) {
      assert.equal(created.status, 'awaiting_password', 'A different user/deployment needs the recovery password');
      if (wrongPasswordFirst) {
        await assert.rejects(service.unlockRestoreJob(userId, created.id, 'wrong-recovery-password'), /password|unlock|decrypt/i);
        assert.equal((await service.getRestoreJob(userId, created.id)).status, 'awaiting_password');
        assert.equal((await rowsFor('emails', userId)).length, 0);
      }
      const unlocked = await service.unlockRestoreJob(userId, created.id, archive.password);
      assert.equal(unlocked.error, undefined);
    }
    const validated = await waitFor(() => service.getRestoreJob(userId, created.id), (job: FixtureValue) => job?.status === 'validated', 'Restore validation');
    assert.equal(validated.archive_sha256, sha256(archive.bytes));
    const started = await service.startRestoreJob(userId, created.id);
    assert.equal(started.error, undefined);
    return waitFor(() => service.getRestoreJob(userId, created.id), (job: FixtureValue) => job?.status === 'completed' && job.archive_path === null, 'Restore commit and upload cleanup');
  }

  async function assertRestored(runtime: FixtureValue, userId: string, { credentialsAvailable = true }: FixtureValue = {}) {
    const restored = await snapshot(userId);
    const commands = await rowsFor('mail_writebacks', userId);
    assert.ok(commands.length >= 1, 'Accepted provider intent remains inspectable after restore');
    assert.ok(commands.some((row) => {
      const evidence = typeof row.evidence_json === 'string' ? JSON.parse(row.evidence_json) : row.evidence_json;
      return evidence?.archive_operation_id === sourceWritebackId && evidence.restore_requires_revalidation === true;
    }), 'Archived unresolved intent retains its source ID and a revalidation marker');
    for (const row of commands) {
      assert.ok(restored.mail_accounts.some((account: FixtureValue) => account.id === row.mail_account_id));
      assert.ok(restored.emails.some((email: FixtureValue) => email.id === row.email_id && email.mail_account_id === row.mail_account_id));
      assert.notEqual(row.status, 'pending', 'Restore cannot enqueue a provider mutation');
      assert.notEqual(row.state, 'queued');
      assert.notEqual(row.state, 'reconciling');
      assert.equal(row.is_current, 0, 'Archived intent must not become a runnable overlay');
    }
    const [jobs] = await pool.execute<RowDataPacket[]>('SELECT state, lease_owner, lease_until FROM mail_engine_jobs WHERE user_id = ?', [userId]);
    assert.ok(jobs.every((job) => !['queued', 'running', 'error'].includes(job.state) && job.lease_owner == null && job.lease_until == null));
    for (const table of TABLES) {
      assert.equal(restored[table].length, kept[table].length, `${table}: restore every row the backup holds`);
      for (const row of restored[table]) {
        if (!['mail_folder_remote_boxes', 'mail_folder_rule_overrides'].includes(table)) assert.equal(row.user_id, userId);
        if (row.id) assert.ok(!original[table].some((item: FixtureValue) => item.id === row.id), `${table}: new owner receives fresh IDs`);
      }
    }
    const compare = (table: string, fields: FixtureValue) => {
      const select = (row: FixtureValue) => Object.fromEntries(fields.map((field: FixtureValue) => [field, row[field]]));
      const order = (rows: FixtureValue) => rows.map(select).sort((a: FixtureValue, b: FixtureValue) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      assert.deepEqual(order(restored[table]), order(kept[table]), `${table}: preserve content`);
    };
    compare('contacts', ['first_name', 'last_name', 'notes', 'is_favorite']);
    compare('contact_values', ['kind', 'position', 'label', 'value', 'value_key', 'legacy_slot']);
    compare('contact_properties', ['position', 'name', 'params', 'value', 'source_version']);
    compare('contact_photos', ['sha256', 'thumb_sha256', 'width', 'height', 'bytes']);
    compare('contact_uid_aliases', ['uid_hash', 'uid']);
    assert.ok(restored.contact_photos.every((row: FixtureValue) => row.source === 'restore'));
    // Children follow their restored contact; the photo files are in this deployment's own root.
    const restoredIds = new Set(restored.contacts.map((row: FixtureValue) => row.id));
    for (const table of ['contact_values', 'contact_properties', 'contact_photos', 'contact_uid_aliases']) assert.ok(restored[table].every((row: FixtureValue) => restoredIds.has(row.contact_id)), table);
    assert.ok(restored.contact_duplicate_dismissals.every((row: FixtureValue) => restoredIds.has(row.contact_a) && restoredIds.has(row.contact_b) && row.contact_a < row.contact_b));
    const photos = runtime('services/contact-photos');
    for (const bytes of Object.values(photoBytes)) {
      const file = photos.photoPath(userId, sha256(bytes));
      assert.deepEqual(await fs.readFile(file), bytes);
    }
    const plainSettings = (rows: FixtureValue[]) => rows.filter(row => row.setting_key !== 'default_mail_account_id')
      .map(row => ({ setting_key: row.setting_key, setting_value: row.setting_value })).sort((a, b) => a.setting_key.localeCompare(b.setting_key));
    assert.deepEqual(plainSettings(restored.user_settings), plainSettings(original.user_settings), 'user_settings: preserve content');
    const modules = await runtime('services/module-settings').getOrderedUserModules(userId);
    assert.deepEqual(modules.map((module: FixtureValue) => module.id), ['recordings', 'mail', 'calendar', 'contacts'], 'Restored module order');
    assert.equal(modules.find((module: FixtureValue) => module.id === 'recordings').visible, false);
    compare('mail_folders', ['slug', 'display_name', 'position', 'is_system', 'special_use']);
    assert.deepEqual(await rowsFor('tetris_scores', userId), [], 'Removed Games scores are not restored');
    compare('recording_transcription_jobs', ['status', 'provider', 'model', 'language', 'transcript_text', 'created_at', 'updated_at']);
    compare('mail_folder_reconciliations', ['inventory', 'completed_at']);
    compare('mail_folder_recovery_items', ['original_folder', 'target_folder', 'action', 'created_at']);
    compare('emails', ['message_id', 'subject', 'from_address', 'to_addresses', 'body_text', 'folder', 'source_folder', 'imap_uid', 'imap_uidvalidity', 'is_starred', 'has_attachments', 'received_at', 'raw_sha256', 'import_complete', 'is_legacy', 'remote_folder', 'remote_uid', 'remote_uidvalidity', 'remote_missing', 'in_reply_to', 'references_header', 'thread_key', 'snoozed_until']);
    compare('calendar_events', ['title', 'description', 'start_time', 'end_time', 'recurrence', 'reminders', 'reminder_minutes', 'todo_status', 'location']);
    compare('calendar_event_subtasks', ['title', 'is_done', 'position']);
    compare('calendar_event_attendees', ['email', 'display_name', 'response_status']);
    compare('mail_email_scores', ['score_version', 'total_score', 'reasons', 'metadata']);
    compare('recordings', ['title', 'description', 'original_filename', 'content_type', 'size_bytes', 'duration_seconds', 'metadata', 'recorded_at']);
    compare('recording_tags', ['name', 'color']);
    const oldAccountEmail = (id: FixtureValue) => original.mail_accounts.find((row: FixtureValue) => row.id === id)?.email_address || null;
    const newAccountEmail = (id: FixtureValue) => restored.mail_accounts.find((row: FixtureValue) => row.id === id)?.email_address || null;
    const defaultAccount = (rows: FixtureValue[]) => rows.find(row => row.setting_key === 'default_mail_account_id')?.setting_value;
    assert.equal(newAccountEmail(defaultAccount(restored.user_settings)), oldAccountEmail(defaultAccount(original.user_settings)),
      'The default sending account names the restored copy of the same account');
    compare('mail_templates', ['name', 'subject', 'body_html', 'body_text']);
    compare('mail_accounts', ['email_address', 'signature_html', 'signature_text']);
    // Scoped settings follow their restored account, calendar and folder.
    for (const setting of restored.mail_account_settings) {
      const old = original.mail_account_settings.find((row: FixtureValue) => row.setting_key === setting.setting_key);
      assert.equal(newAccountEmail(setting.mail_account_id), oldAccountEmail(old.mail_account_id));
      if (setting.setting_key !== 'notify_folders') { assert.equal(setting.setting_value, old.setting_value); continue; }
      const [role, folder] = JSON.parse(setting.setting_value);
      assert.equal(role, 'role:junk');
      assert.equal(restored.mail_folders.find((row: FixtureValue) => `folder:${row.id}` === folder)?.slug, 'copies', 'A folder named by id names the restored folder');
    }
    assert.deepEqual(restored.calendar_settings.map((row: FixtureValue) => [row.calendar_id, row.setting_key, row.setting_value]),
      [[restored.calendar_calendars.find((row: FixtureValue) => row.name === 'Research Calendar').id, 'notify_enabled', 'false']]);
    for (const folder of restored.mail_folders) {
      const old = original.mail_folders.find((row: FixtureValue) => row.slug === folder.slug);
      assert.equal(newAccountEmail(folder.mail_account_id), oldAccountEmail(old.mail_account_id));
    }
    for (const email of restored.emails) {
      const old = original.emails.find((row: FixtureValue) => row.body_text === email.body_text);
      assert.equal(newAccountEmail(email.filing_account_id), oldAccountEmail(old.filing_account_id));
    }
    for (const journal of restored.mail_folder_recovery_items) {
      const old = original.mail_folder_recovery_items[0];
      assert.equal(restored.emails.find((row: FixtureValue) => row.id === journal.email_id).body_text, original.emails.find((row: FixtureValue) => row.id === old.email_id).body_text);
      for (const field of ['source_account_id', 'original_filing_account_id', 'target_account_id']) assert.equal(newAccountEmail(journal[field]), oldAccountEmail(old[field]));
    }
    for (const marker of restored.mail_folder_reconciliations) {
      const mappings = typeof marker.previous_mappings === 'string' ? JSON.parse(marker.previous_mappings) : marker.previous_mappings;
      assert.ok(mappings.every((row: FixtureValue) => restored.mail_folders.some((folder: string) => (folder as FixtureValue).id === row.folder_id) && row.mail_account_id === marker.mail_account_id));
    }
    for (const override of restored.mail_folder_rule_overrides) {
      assert.ok(restored.mail_sender_rules.some((row: FixtureValue) => row.id === override.rule_id));
      assert.equal(newAccountEmail(override.mail_account_id), oldAccountEmail(original.mail_folder_rule_overrides[0].mail_account_id));
      assert.equal(override.target_folder, 'research');
    }
    for (const transcript of restored.recording_transcription_jobs) {
      assert.ok(restored.recordings.some((row: FixtureValue) => row.id === transcript.recording_id));
      assert.equal(transcript.status, 'completed');
    }
    const decrypt = runtime('security/encryption').decrypt;
    for (const account of restored.mail_accounts) {
      assert.equal(decrypt(account.encrypted_password), credentialsAvailable ? passwords.get(account.email_address) : null);
      assert.equal(account.is_active, 0, 'Even restorable credentials cannot activate a provider after restore');
      assert.equal(account.delete_emails_on_server, 0, 'Restore must not reenable server deletion');
      assert.equal(account.sync_mode, original.mail_accounts.find((row: FixtureValue) => row.email_address === account.email_address).sync_mode);
      assert.equal(account.sync_status, account.sync_mode === 'sync' ? 'pending' : 'idle');
      const accountEmails = restored.emails.filter((row: FixtureValue) => row.mail_account_id === account.id);
      // The Sync account's copy at the provider downloads again; the one marked missing there is restored.
      assert.equal(accountEmails.length, account.sync_mode === 'sync' ? 1 : 2, 'Same Message-ID in distinct folders must not collapse');
      for (const email of accountEmails) {
      const fileKey = account.email_address + ':' + email.source_folder;
      const raw = await fs.readFile(email.raw_storage_path);
      assert.deepEqual(raw, originalFiles.get('raw:' + fileKey)); assert.equal(sha256(raw), email.raw_sha256);
      // The exact original comes back, but not as verified: server deletion waits until UniHub checks it at the provider again.
      assert.equal(email.raw_format, 'exact_octets');
      assert.equal(Number(email.raw_verified), 0, 'A restore never vouches for the provider\'s copy');
      const oldAccount = original.mail_accounts.find((row: FixtureValue) => row.email_address === account.email_address);
      const oldEmail = original.emails.find((row: FixtureValue) => row.mail_account_id === oldAccount.id && row.source_folder === email.source_folder);
      const oldAttachments = original.email_attachments.filter((row: FixtureValue) => row.email_id === oldEmail.id);
      const attachments = restored.email_attachments.filter((row: FixtureValue) => row.email_id === email.id);
      assert.equal(attachments.length, oldAttachments.length, 'Same-name, same-size attachments remain separate');
      for (const attachment of attachments) {
        const oldAttachment = oldAttachments.find((row: FixtureValue) => row.content_id === attachment.content_id);
        assert.ok(oldAttachment);
        assert.deepEqual(await fs.readFile(attachment.storage_path), await fs.readFile(oldAttachment.storage_path));
        assert.ok(email.body_html.includes(`/api/mail/attachments/${attachment.id}`), 'Inline image URL follows the newly allocated attachment ID');
      }
      assert.ok(!original.email_attachments.some((row: FixtureValue) => email.body_html.includes(row.id)));
      assert.ok(restored.mail_email_scores.some((row: FixtureValue) => row.email_id === email.id));
      const mapping = restored.mail_folder_remote_boxes.find((row: FixtureValue) => row.mail_account_id === account.id && row.remote_name === email.source_folder);
      assert.ok(mapping, 'The account retains its folder-to-IMAP mapping');
      assert.equal(mapping.folder_id, restored.mail_folders.find((folder: string) => (folder as FixtureValue).slug === email.folder).id);
      }
      assert.ok(restored.mail_sender_rules.some((row: FixtureValue) => row.mail_account_id === account.id));
      assert.ok(restored.mail_folder_remote_boxes.some((row: FixtureValue) => row.mail_account_id === account.id), 'Both accounts retain their folder-to-IMAP mappings');
    }
    const calendarAccount = restored.calendar_accounts.find((row: FixtureValue) => row.provider === 'caldav');
    for (const [field, expected] of [['encrypted_password', 'synthetic-calendar-password'], ['encrypted_access_token', 'synthetic-access-token'], ['encrypted_refresh_token', 'synthetic-refresh-token']] as const) assert.equal(decrypt(calendarAccount[field]), credentialsAvailable ? expected : null);
    assert.equal(calendarAccount.is_active, credentialsAvailable ? 1 : 0);
    const calendar = restored.calendar_calendars.find((row: FixtureValue) => row.name === 'Research Calendar');
    const errands = restored.calendar_calendars.find((row: FixtureValue) => row.name === 'Errands'), event = restored.calendar_events[0];
    assert.equal(calendar.account_id, calendarAccount.id); assert.equal(event.calendar_id, errands.id);
    assert.equal(errands.account_id, restored.calendar_accounts.find((row: FixtureValue) => row.provider === 'local').id);
    assert.equal(restored.calendar_event_subtasks[0].event_id, event.id); assert.equal(restored.calendar_event_attendees[0].event_id, event.id);
    // The CalDAV task comes back with the next sync; its done state and subtask wait for it.
    const [overlays] = await pool.execute<RowDataPacket[]>('SELECT calendar_id, uid, recurrence_id, match_kind, payload, expires_at FROM calendar_overlay_restores WHERE user_id = ?', [userId]);
    assert.equal(overlays.length, 1);
    assert.deepEqual([overlays[0].calendar_id, overlays[0].uid, overlays[0].recurrence_id, overlays[0].match_kind, overlays[0].expires_at],
      [calendar.id, 'Roundtrip-Event@example.test', '', 'uid', null]);
    const state = typeof overlays[0].payload === 'string' ? JSON.parse(overlays[0].payload) : overlays[0].payload;
    assert.deepEqual([state.todo_status, state.done_at, state.subtasks], ['done', '2030-02-03 12:00:00', [{ title: 'Keep this task', is_done: true, position: 2 }]]);
    for (const recording of restored.recordings) {
      assert.deepEqual(await fs.readFile(recording.storage_path), audioByTitle.get(recording.title));
      assert.ok(restored.recording_tag_links.some((link: FixtureValue) => link.recording_id === recording.id && link.tag_id === restored.recording_tags[0].id));
    }
    const [[profile]] = await pool.execute<RowDataPacket[]>('SELECT full_name, timezone, role FROM users WHERE id = ?', [userId]);
    assert.deepEqual(profile, { full_name: 'Grüße Roundtrip', timezone: 'Europe/Vienna', role: 'user' });
    return restored;
  }

  const encryptedUser = await newUser('encrypted-destination');
  await t.test('encrypted production archive restores what it holds and portable passwords under a different server key', async () => {
    const completed = await uploadAndRestore(destination, encryptedUser, encrypted, 'replace', { wrongPasswordFirst: true });
    assert.equal(completed.is_encrypted, 1);
    const restored = await assertRestored(destination, encryptedUser);
    assert.equal(sourceCrypto.decrypt(restored.mail_accounts[0].encrypted_password), null, 'Destination credentials use the destination key');
    assert.equal(destinationCrypto.decrypt(original.mail_accounts[0].encrypted_password), null, 'Source ciphertext cannot be read directly on the destination');
  });
  await t.test('restored completion state prevents a new provider LIST from replaying migration moves', async () => {
    const before = await rowsFor('emails', encryptedUser);
    const accounts = await rowsFor('mail_accounts', encryptedUser);
    for (const account of accounts) {
      const result = await destination('services/mail-folder-reconciliation').reconcileAccountFolders(encryptedUser, account.id,
        ['INBOX/Research', 'Archive/Copies'], new Map(), pool);
      assert.equal(result.skipped, true);
    }
    await destination('services/mail-folder-reconciliation').prepareFolderReconciliation(pool);
    assert.deepEqual(await rowsFor('emails', encryptedUser), before);
  });
  await t.test('unencrypted ZIP restores every section with the original deployment key', async () => {
    const userId = await newUser('legacy-same-key');
    await uploadAndRestore(source, userId, legacy);
    await assertRestored(source, userId);
  });
  await t.test('legacy ZIP on a different key retains data and clearly disables unavailable credentials', async () => {
    const userId = await newUser('legacy-different-key');
    const completed = await uploadAndRestore(destination, userId, legacy);
    await assertRestored(destination, userId, { credentialsAvailable: false });
    const result = typeof completed.result_counts === 'string' ? JSON.parse(completed.result_counts) : completed.result_counts;
    assert.match(result.warnings.join(' '), /legacy account credential.*could not be decrypted/i);
  });
  await t.test('a lost COMMIT acknowledgement preserves the committed restore and every restored file', async () => {
    let injected = false;
    // The settings of the real pool, so the restore's control pool is a real one too.
    const double = {
      pool: (pool as FixtureValue).pool,
      execute: (...args: FixtureValue[]) => pool.execute(...args as [string, FixtureValue]),
      async getConnection() {
        const connection = await pool.getConnection();
        let completesRestore = false;
        return {
          async execute(sql: string, params: FixtureValue) {
            if (/UPDATE backup_restore_jobs\s+SET status = 'completed'/.test(sql)) completesRestore = true;
            return connection.execute(sql, params);
          },
          query: (...args: FixtureValue[]) => connection.query(...args as [string, FixtureValue]),
          beginTransaction: () => connection.beginTransaction(),
          rollback: () => connection.rollback(),
          release: () => connection.release(),
          async commit() {
            await connection.commit();
            if (completesRestore && !injected) {
              injected = true;
              throw Object.assign(new Error('Synthetic lost COMMIT acknowledgement'), { code: 'PROTOCOL_CONNECTION_LOST' });
            }
          },
        };
      },
    };
    destination('state').setDb(double);
    try {
      const userId = await newUser('commit-acknowledgement-lost');
      await uploadAndRestore(destination, userId, encrypted);
      assert.equal(injected, true, 'Failure must occur after the restore transaction really commits');
      await assertRestored(destination, userId);
    } finally { destination('state').setDb(pool); await destination('services/side-pools').endSidePools(double); }
  });
  await t.test('repeated complete archives honor keep-existing, replace and keep-both without detaching children', async () => {
    await pool.execute<ResultSetHeader>('UPDATE contacts SET notes = ? WHERE user_id = ?', ['Local edit', encryptedUser]);
    await uploadAndRestore(destination, encryptedUser, encrypted, 'keep_existing');
    assert.equal((await rowsFor('contacts', encryptedUser))[0].notes, 'Local edit');
    assert.equal((await rowsFor('emails', encryptedUser)).length, kept.emails.length);
    const downloadAccount = (await rowsFor('mail_accounts', encryptedUser)).find((row) => row.email_address === mailAccounts[0].email_address);
    const localEmail = (await rowsFor('emails', encryptedUser)).find((row) => row.mail_account_id === downloadAccount.id);
    const destinationWritebackId = uuid();
    await insert('mail_writebacks', { id: destinationWritebackId, user_id: encryptedUser, mail_account_id: localEmail.mail_account_id,
      email_id: localEmail.id, action: 'read', target_value: '1', base_value: '0', remote_folder: 'INBOX', remote_uid: 1,
      remote_uidvalidity: 1, is_current: 1 });
    // Legacy accepted rows can have NULL state until the resumable backfill
    // classifies them. Restore must still pause that exact destination intent.
    const [[unclassified]] = await pool.execute<RowDataPacket[]>('SELECT state, status FROM mail_writebacks WHERE id = ?', [destinationWritebackId]);
    assert.equal(unclassified.state, null); assert.equal(unclassified.status, 'pending');
    // A schedule of a message the restore overwrites must not send the restored content.
    await insert('mail_scheduled_sends', { id: uuid(), user_id: encryptedUser, email_id: localEmail.id, mail_account_id: localEmail.mail_account_id,
      send_at: '2030-01-01 00:00:00', client_key: `scheduled-${uuid()}` });
    await uploadAndRestore(destination, encryptedUser, encrypted, 'replace');
    assert.deepEqual(await rowsFor('mail_scheduled_sends', encryptedUser), [], 'A message the restore wrote comes back unscheduled');
    const destinationCommands = await rowsFor('mail_writebacks', encryptedUser);
    const destinationIntent = destinationCommands.find((row) => row.id === destinationWritebackId);
    assert.ok(destinationIntent && destinationIntent.state === 'needs_attention' && destinationIntent.status === 'conflict',
      'Replacing archived mail preserves the destination intent as non-runnable review evidence');
    assert.equal(destinationIntent.is_current, 0, 'Destination intent cannot remain a runnable overlay');
    const destinationEvidence = typeof destinationIntent.evidence_json === 'string'
      ? JSON.parse(destinationIntent.evidence_json) : destinationIntent.evidence_json;
    assert.equal(destinationEvidence.restore_requires_revalidation, true);
    await assertRestored(destination, encryptedUser);
    await uploadAndRestore(destination, encryptedUser, encrypted, 'keep_both');
    const doubled = await snapshot(encryptedUser);
    // Keep both: each contact again under a new id and uid, with its own
    // children; both photo rows share the one pair of files; a merged-away
    // UID keeps pointing at the contact that had it first.
    assert.equal(doubled.contacts.length, original.contacts.length * 2);
    assert.equal(new Set(doubled.contacts.map((row: FixtureValue) => row.uid)).size, doubled.contacts.length);
    for (const table of ['contact_values', 'contact_properties', 'contact_photos', 'contact_duplicate_dismissals']) assert.equal(doubled[table].length, original[table].length * 2, table);
    assert.equal(new Set(doubled.contact_values.map((row: FixtureValue) => row.id)).size, doubled.contact_values.length);
    assert.equal(new Set(doubled.contact_photos.map((row: FixtureValue) => row.sha256)).size, 1);
    assert.deepEqual(doubled.contact_uid_aliases.map((row: FixtureValue) => row.uid), ['urn:uuid:merged-away-example']);
    assert.equal(doubled.emails.length, kept.emails.length * 2); assert.equal(doubled.recordings.length, original.recordings.length * 2);
    assert.equal(doubled.email_attachments.length, kept.email_attachments.length * 2); assert.equal(doubled.recording_tag_links.length, original.recording_tag_links.length * 2);
    for (const email of doubled.emails) assert.ok(doubled.email_attachments.some((row: FixtureValue) => row.email_id === email.id));
    for (const recording of doubled.recordings) {
      assert.ok(doubled.recording_tag_links.some((row: FixtureValue) => row.recording_id === recording.id));
      assert.deepEqual(await fs.readFile(recording.storage_path), audioByTitle.get(recording.title));
    }
    for (const event of doubled.calendar_events) assert.ok(doubled.calendar_event_subtasks.some((row: FixtureValue) => row.event_id === event.id));
    // A template is known by its name, unique per person: keeping both keeps the existing one.
    assert.equal(doubled.mail_templates.length, original.mail_templates.length);
  });
  await t.test('a same-slug folder owned by another filing account fails atomically in every conflict mode', async () => {
    const userId = await newUser('folder-scope-collision');
    const accountId = uuid();
    await insert('mail_accounts', { id: accountId, user_id: userId, email_address: 'local-only@example.test', provider: 'custom', is_active: 0 });
    await insert('mail_folders', { id: uuid(), user_id: userId, slug: 'research', display_name: 'Local private folder', is_system: 0, mail_account_id: accountId });
    const before = await snapshot(userId);
    for (const conflict_mode of ['keep_existing', 'replace', 'keep_both']) {
      await assert.rejects(source('services/backup').importBackupForUser(userId, legacyParsed.backup, {
        mode: 'apply', conflict_mode, fileSourcesByPath: legacyParsed.fileSourcesByPath,
      }), /folder.*conflict|folder.*different|folder.*account/i);
      assert.deepEqual(await snapshot(userId), before, 'Folder collision rolls back account and earlier section writes');
    }
  });
  await t.test('kept reconciliation state cannot hide newly restored mail and fails atomically', async () => {
    const userId = await newUser('kept-inventory-conflict');
    await uploadAndRestore(destination, userId, encrypted);
    await pool.execute<ResultSetHeader>('UPDATE mail_folder_reconciliations SET inventory = ? WHERE user_id = ?', ['[]', userId]);
    const before = await snapshot(userId);
    // The kept message in Archived Copies, filed by its account's folder
    // connection (in the fixture it is a legacy one, which needs none).
    const archive = structuredClone(legacyParsed.backup);
    for (const email of archive.data.emails) if (email.folder === 'copies') email.is_legacy = 0;
    await assert.rejects(destination('services/backup').importBackupForUser(userId, archive, {
      mode: 'apply', conflict_mode: 'keep_both', fileSourcesByPath: legacyParsed.fileSourcesByPath,
    }), /not available in its filing account/);
    assert.deepEqual(await snapshot(userId), before);
  });
  await t.test('damaged encrypted archive fails before importing any rows', async () => {
    const userId = await newUser('damaged-destination');
    const bytes = Buffer.from(encrypted.bytes); bytes[bytes.length - 1] ^= 1;
    const upload = path.join(directory, uuid() + '.upload'); await fs.writeFile(upload, bytes);
    const service = destination('services/backup-restore-jobs');
    const created = await service.createUploadedRestoreJob(userId, upload, { sections: 'full' });
    await service.unlockRestoreJob(userId, created.id, encrypted.password);
    await waitFor(() => service.getRestoreJob(userId, created.id), (job: FixtureValue) => job?.status === 'failed', 'Damaged archive rejection', { allowFailure: true });
    for (const rows of Object.values(await snapshot(userId))) assert.equal((rows as FixtureValue).length, 0);
  });
  await t.test('a ZIP file changed after validation fails restore without deleting the retained archive', async () => {
    const userId = await newUser('changed-after-validation');
    const service = destination('services/backup-restore-jobs');
    const upload = path.join(directory, uuid() + '.upload');
    await fs.writeFile(upload, legacy.bytes);
    const created = await service.createUploadedRestoreJob(userId, upload, { sections: 'full', conflict_mode: 'replace' });
    const validated = await waitFor(() => service.getRestoreJob(userId, created.id), (job: FixtureValue) => job?.status === 'validated', 'Initial ZIP validation');
    assert.equal(validated.archive_sha256, sha256(legacy.bytes));
    const parsed = await destination('services/backup').backupFromZipFile(validated.archive_path);
    const recording = parsed.backup.files.find((file: FixtureValue) => file.kind === 'recording');
    assert.ok(recording);
    const range = parsed.fileSourcesByPath.get(recording.archive_path);
    assert.ok(range && range.size > 44, 'Use an actual file-backed WAV entry');
    // Change one PCM byte, preserving ZIP structure, WAV headers and the
    // archived checksums/metadata so apply must recheck the payload itself.
    const handle = await fs.open(validated.archive_path, 'r+');
    try {
      const changed = Buffer.alloc(1);
      const offset = range.start + range.size - 1;
      await handle.read(changed, 0, 1, offset);
      changed[0] ^= 1;
      await handle.write(changed, 0, 1, offset);
    } finally { await handle.close(); }
    const started = await service.startRestoreJob(userId, created.id);
    assert.equal(started.error, undefined);
    const failed = await waitFor(() => service.getRestoreJob(userId, created.id), (job: FixtureValue) => job?.status === 'failed', 'Changed ZIP rejection', { allowFailure: true });
    assert.match(failed.error, /checksum/i);
    assert.equal(failed.archive_path, validated.archive_path, 'A failed apply retains the uploaded archive');
    assert.equal((await fs.stat(failed.archive_path)).size, legacy.bytes.length);
    for (const rows of Object.values(await snapshot(userId))) assert.equal((rows as FixtureValue).length, 0, 'No section may be partially imported');
    const [[profile]] = await pool.execute<RowDataPacket[]>('SELECT full_name FROM users WHERE id = ?', [userId]);
    assert.equal(profile.full_name, 'changed-after-validation');
  });
  for (const format of ['plain', 'encrypted']) {
    await t.test(`frozen v0.9.23.0 ${format} export restores through the current production job`, async () => {
      const fixtureDirectory = path.join(__dirname, 'fixtures/backups/v1-0.9.23.0');
      const expected = JSON.parse(await fs.readFile(path.join(fixtureDirectory, 'expected.json'), 'utf8'));
      const archive = expected.archives[format];
      const bytes = await fs.readFile(path.join(fixtureDirectory, archive.filename));
      assert.equal(bytes.length, archive.size_bytes); assert.equal(sha256(bytes), archive.sha256);
      const runtime = format === 'plain'
        ? createBackupRuntime(path.join(directory, 'historical-same-key'), expected.source_encryption_key, pool)
        : destination;
      const userId = await newUser('historical-' + format);
      const completed = await uploadAndRestore(runtime, userId, { bytes, password: format === 'encrypted' ? expected.recovery_password : null });
      const restored = await snapshot(userId);
      // The archive's CalDAV event is the provider's copy: imported as a new
      // backup leaves it out, with its children. Its mail accounts predate
      // Sync mode, so all its mail is downloaded mail and stays.
      const leftOut = new Set(['calendar_events', 'calendar_event_subtasks', 'calendar_event_attendees', 'calendar_event_external_refs']);
      for (const [table, oldRows] of Object.entries(expected.data)) {
        if (!Array.isArray(oldRows)) continue;
        assert.equal(restored[table].length, leftOut.has(table) ? 0 : oldRows.length, `Historical ${table}: import what the rule keeps`);
        for (const row of restored[table]) {
          assert.equal(row.user_id, userId);
          if (row.id) assert.ok(!oldRows.some(old => old.id === row.id));
        }
      }
      // Old exports never contained provider-folder mappings. Do not invent a
      // mapping, and explain that limitation in the successful restore result.
      assert.equal(restored.mail_folder_remote_boxes.length, 0);
      const result = typeof completed.result_counts === 'string' ? JSON.parse(completed.result_counts) : completed.result_counts;
      assert.match(result.warnings.join(' '), /older backup.*provider.folder mappings/i);
      const ignored = new Set<FixtureValue>(['id', 'user_id', 'account_id', 'calendar_id', 'event_id', 'email_id', 'mail_account_id', 'recording_id', 'tag_id', 'created_at', 'updated_at', 'storage_path', 'raw_storage_path', 'encrypted_password', 'encrypted_access_token', 'encrypted_refresh_token', 'delete_emails_on_server', 'server_delete_enabled_at', 'server_delete_grace_until', 'server_delete_last_run_at', 'is_active', 'body_html', 'sync_status']);
      function normalized(field: FixtureValue, value: FixtureValue) {
        if (value === null || value === undefined) return value;
        if (field.endsWith('_at') || ['start_time', 'end_time'].includes(field)) return new Date(value).toISOString();
        if (['size_bytes', 'duration_seconds', 'total_score'].includes(field)) return Number(value);
        if (typeof value === 'string' && /^[[{]/.test(value)) {
          try { return JSON.parse(value); } catch { /* Ordinary text remains text. */ }
        }
        return value;
      }
      // The archive's fixed 3+3 contact fields are values now (upgrade 22):
      // compare them as the first three emails and phones by position.
      for (const contact of restored.contacts) {
        for (const kind of ['email', 'phone']) {
          const values = restored.contact_values.filter((value: FixtureValue) => value.contact_id === contact.id && value.kind === kind)
            .sort((a: FixtureValue, b: FixtureValue) => a.position - b.position).map((value: FixtureValue) => value.value);
          [contact[kind], contact[`${kind}2`], contact[`${kind}3`]] = [values[0], values[1], values[2]];
        }
      }
      for (const [table, oldRows] of Object.entries(expected.data)) {
        if (!Array.isArray(oldRows) || !oldRows.length || leftOut.has(table)) continue;
        const fields = Object.keys(oldRows[0]).filter(field => !ignored.has(field));
        const project = (row: FixtureValue) => Object.fromEntries(fields.map(field => [field, normalized(field, row[field])]));
        const ordered = (rows: FixtureValue) => rows.map(project).sort((a: FixtureValue, b: FixtureValue) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        assert.deepEqual(ordered(restored[table]), ordered(oldRows), `Historical ${table}: preserve archived content`);
      }
      const decrypt = runtime('security/encryption').decrypt;
      for (const credential of expected.credentials.mail_accounts) {
        const account = restored.mail_accounts.find((row: FixtureValue) => row.email_address === credential.email_address);
        assert.equal(decrypt(account.encrypted_password), credential.password);
        assert.equal(account.is_active, 0, 'Historical credentials do not auto-resume after restore');
        assert.equal(account.delete_emails_on_server, 0);
        const oldEmail = expected.data.emails.find((row: FixtureValue) => row.mail_account_id === credential.id);
        const email = restored.emails.find((row: FixtureValue) => row.mail_account_id === account.id && row.message_id === oldEmail.message_id);
        assert.ok(email);
        assert.equal(email.import_complete, 0, 'Old archives do not prove the newer complete-import flag');
        const oldAttachment = expected.data.email_attachments.find((row: FixtureValue) => row.email_id === oldEmail.id);
        const attachment = restored.email_attachments.find((row: FixtureValue) => row.email_id === email.id && row.filename === oldAttachment.filename);
        assert.ok(attachment);
        const sourceAttachment = expected.files.find((file: FixtureValue) => file.kind === 'email_attachment' && file.id === oldAttachment.id);
        const attachmentBytes = await fs.readFile(attachment.storage_path);
        assert.deepEqual(attachmentBytes, Buffer.from(sourceAttachment.bytes_base64, 'base64'));
        assert.equal(sha256(attachmentBytes), sourceAttachment.sha256);
        const sourceRaw = expected.files.find((file: FixtureValue) => file.kind === 'raw_email' && file.id === oldEmail.id);
        const rawBytes = await fs.readFile(email.raw_storage_path);
        assert.deepEqual(rawBytes, Buffer.from(sourceRaw.bytes_base64, 'base64')); assert.equal(sha256(rawBytes), email.raw_sha256);
        if (oldEmail.body_html.includes('/api/mail/attachments/')) {
          assert.ok(email.body_html.includes('/api/mail/attachments/' + attachment.id));
          assert.equal(email.body_html.includes(oldAttachment.id), false);
        }
        assert.ok(restored.mail_email_scores.some((row: FixtureValue) => row.email_id === email.id));
        assert.ok(restored.mail_sender_rules.some((row: FixtureValue) => row.mail_account_id === account.id));
      }
      const calendarAccount = restored.calendar_accounts[0], calendar = restored.calendar_calendars[0];
      const credential = expected.credentials.calendar_accounts[0];
      assert.equal(decrypt(calendarAccount.encrypted_password), credential.password);
      assert.equal(decrypt(calendarAccount.encrypted_access_token), credential.access_token);
      assert.equal(decrypt(calendarAccount.encrypted_refresh_token), credential.refresh_token);
      assert.equal(calendar.account_id, calendarAccount.id);
      // Its subtask waits for the event to sync again, matched by title and
      // start (the archive has no UIDs), for 30 days.
      const [overlays] = await pool.execute<RowDataPacket[]>(`SELECT calendar_id, match_kind, shape_title, shape_start, payload, TIMESTAMPDIFF(DAY, UTC_TIMESTAMP(), expires_at) AS days
        FROM calendar_overlay_restores WHERE user_id = ?`, [userId]);
      assert.equal(overlays.length, 1);
      const oldEvent = expected.data.calendar_events[0];
      assert.deepEqual([overlays[0].calendar_id, overlays[0].match_kind, overlays[0].shape_title, new Date(overlays[0].shape_start).toISOString()],
        [calendar.id, 'shape', oldEvent.title, new Date(oldEvent.start_time).toISOString()]);
      assert.ok(overlays[0].days >= 29 && overlays[0].days <= 30);
      const state = typeof overlays[0].payload === 'string' ? JSON.parse(overlays[0].payload) : overlays[0].payload;
      assert.deepEqual(state.subtasks.map((row: FixtureValue) => row.title), expected.data.calendar_event_subtasks.map((row: FixtureValue) => row.title));
      const outcome = typeof completed.result_counts === 'string' ? JSON.parse(completed.result_counts) : completed.result_counts;
      assert.deepEqual(outcome.contents.left_out.map((item: FixtureValue) => [item.what, item.count]), [['CalDAV and subscription events', 1]]);
      assert.ok(outcome.notes.some((note: string) => /when the calendar syncs/.test(note)));
      const sourceAudio = expected.files.find((file: FixtureValue) => file.kind === 'recording');
      const audioBytes = await fs.readFile(restored.recordings[0].storage_path);
      assert.deepEqual(audioBytes, Buffer.from(sourceAudio.bytes_base64, 'base64')); assert.equal(sha256(audioBytes), sourceAudio.sha256);
      assert.equal(restored.recording_tag_links[0].recording_id, restored.recordings[0].id);
      assert.equal(restored.recording_tag_links[0].tag_id, restored.recording_tags[0].id);
      if (format === 'plain') {
        // Historical producers represented unavailable files with missing=true.
        // Construct that valid legacy shape from the genuine fixture's data;
        // the frozen source archive itself remains untouched.
        const parsed = await runtime('services/backup').backupFromZipFile(path.join(fixtureDirectory, archive.filename));
        const payload = structuredClone(parsed.backup);
        payload.files = payload.files.map((file: FixtureValue) => ({ kind: file.kind, id: file.id, filename: file.filename, missing: true, sha256: null, size_bytes: 0 }));
        const dataBytes = Buffer.from(JSON.stringify(payload));
        const manifest = { ...parsed.manifest, file_count: 0, missing_files: payload.files.map((file: FixtureValue) => `${file.kind}:${file.id}`) };
        const missingPath = path.join(directory, uuid() + '-legacy-missing.zip');
        await runtime('services/export-jobs').writeZip([
          { name: 'manifest.json', data: JSON.stringify(manifest) },
          { name: 'data/backup.json', data: dataBytes },
          { name: 'checksums.json', data: JSON.stringify({ algorithm: 'sha256', entries: { 'data/backup.json': sha256(dataBytes) } }) },
        ], missingPath);
        const missingBytes = await fs.readFile(missingPath);
        const previousFileBytes = new Map();
        for (const [table, fileColumn] of [['emails', 'raw_storage_path'], ['email_attachments', 'storage_path'], ['recordings', 'storage_path']] as const) {
          for (const row of restored[table]) previousFileBytes.set(row[fileColumn], await fs.readFile(row[fileColumn]));
        }
        const repeated = await uploadAndRestore(runtime, userId, { bytes: missingBytes, password: null }, 'replace');
        assert.equal(repeated.status, 'completed');
        const preserved = await snapshot(userId);
        for (const [table, fileColumn] of [['emails', 'raw_storage_path'], ['email_attachments', 'storage_path'], ['recordings', 'storage_path']] as const) {
          assert.equal(preserved[table].length, restored[table].length);
          for (const old of restored[table]) {
            const row = preserved[table].find((item: FixtureValue) => item.id === old.id);
            assert.ok(row); assert.equal(row[fileColumn], old[fileColumn], `${table}: incomplete legacy replace retains the existing file path`);
            assert.deepEqual(await fs.readFile(row[fileColumn]), previousFileBytes.get(old[fileColumn]));
          }
        }
        assert.equal(preserved.recording_tag_links.length, restored.recording_tag_links.length);
        const emptyUser = await newUser('legacy-missing-recording');
        const incomplete = await uploadAndRestore(runtime, emptyUser, { bytes: missingBytes, password: null });
        const incompleteResult = typeof incomplete.result_counts === 'string' ? JSON.parse(incomplete.result_counts) : incomplete.result_counts;
        assert.match(incompleteResult.warnings.join(' '), /recording.*missing|missing.*recording/i);
        assert.equal((await rowsFor('contacts', emptyUser)).length, expected.data.contacts.length);
        assert.equal((await rowsFor('emails', emptyUser)).length, expected.data.emails.length);
        assert.equal((await rowsFor('recordings', emptyUser)).length, 0);
        assert.equal((await rowsFor('recording_tag_links', emptyUser)).length, 0, 'Missing tagged audio does not roll back other sections');
      }
    });
  }
  await t.test('equal-shape events and shared-identity contacts remain distinct through repeated schema 3 ZIP restores', async () => {
    const duplicateSource = await newUser('duplicate-source');
    for (const label of ['first', 'second']) {
      const eventId = uuid();
      await insertContact({ user_id: duplicateSource, first_name: 'Shared', last_name: 'Identity', notes: label }, [['email', 'shared@example.test']]);
      await insert('calendar_events', { id: eventId, user_id: duplicateSource, title: 'Equal shape', description: label,
        start_time: '2026-09-19 10:00:00', end_time: '2026-09-19 11:00:00' });
      await insert('calendar_event_subtasks', { id: uuid(), event_id: eventId, user_id: duplicateSource, title: 'Same child', position: 0, is_done: label === 'first' });
      await insert('calendar_event_attendees', { id: uuid(), event_id: eventId, user_id: duplicateSource, email: 'same@example.test', display_name: label });
    }
    const archivePath = path.join(directory, 'distinct-rows.zip');
    await source('services/export-jobs').writeZip(
      await source('services/backup').buildBackupArchiveEntriesForUser(duplicateSource, ['contacts', 'calendar']), archivePath);
    for (const conflictMode of ['keep_existing', 'replace']) {
      const userId = await newUser('duplicate-' + conflictMode);
      const options = { mode: 'apply', conflict_mode: conflictMode };
      const readMeaning = async () => {
        const events = await rowsFor('calendar_events', userId);
        const subtasks = await rowsFor('calendar_event_subtasks', userId);
        const attendees = await rowsFor('calendar_event_attendees', userId);
        const contacts = await rowsFor('contacts', userId);
        for (const rows of [events, subtasks, attendees, contacts]) assert.equal(rows.length, 2);
        const meaning = events.map((event) => ({ id: event.id, description: event.description,
          tasks: subtasks.filter((row) => row.event_id === event.id).map((row) => ({ id: row.id, is_done: row.is_done })),
          attendees: attendees.filter((row) => row.event_id === event.id).map((row) => ({ id: row.id, display_name: row.display_name })),
        })).sort((a, b) => a.description.localeCompare(b.description));
        for (const event of meaning) {
          assert.equal(event.tasks.length, 1); assert.equal(event.attendees.length, 1);
          assert.equal(event.tasks[0].is_done, event.description === 'first' ? 1 : 0);
          assert.equal(event.attendees[0].display_name, event.description);
        }
        return { events: meaning, contacts: contacts.map((row) => ({ id: row.id, notes: row.notes })).sort((a, b) => a.notes.localeCompare(b.notes)) };
      };
      await destination('services/backup').importBackupZipFileForUser(userId, archivePath, options);
      const first = await readMeaning();
      // Force the fallback order to disagree with source order on the next run.
      await pool.execute<ResultSetHeader>('UPDATE calendar_events SET created_at = ? WHERE id = ?', ['2000-01-01 00:00:00', first.events[1].id]);
      await pool.execute<ResultSetHeader>('UPDATE contacts SET created_at = ? WHERE id = ?', ['2000-01-01 00:00:00', first.contacts[1].id]);
      await destination('services/backup').importBackupZipFileForUser(userId, archivePath, options);
      assert.deepEqual(await readMeaning(), first);
    }
  });
  await t.test('Replace takes a synced task\'s archived state as it is, its empty fields too', async () => {
    const owner = await newUser('overlay-replace');
    const account = uuid(), calendar = uuid();
    await insert('calendar_accounts', { id: account, user_id: owner, provider: 'caldav', display_name: 'Team', account_email: 'replace-team@example.test', base_url: 'https://dav.example.test/', is_active: 1 });
    await insert('calendar_calendars', { id: calendar, user_id: owner, account_id: account, name: 'Team', external_id: 'https://dav.example.test/replace-team/', is_visible: 1 });
    const synced = async (title: string, row: FixtureValue = {}) => {
      const id = uuid();
      await insert('calendar_events', { id, user_id: owner, calendar_id: calendar, uid: `${title.replace(/\W+/g, '-')}@example.test`, title, start_time: '2030-04-01 09:00:00', end_time: '2030-04-01 10:00:00', ...row });
      await insert('calendar_event_external_refs', { id: uuid(), user_id: owner, event_id: id, calendar_id: calendar, account_id: account, provider: 'caldav', external_event_id: `${id}.ics`, external_etag: 'one' });
      return id;
    };
    // Archived: one with a subtask and no ToDo state or source email, one done without subtasks.
    const stepsOnly = await synced('Steps only');
    await insert('calendar_event_subtasks', { id: uuid(), user_id: owner, event_id: stepsOnly, title: 'Archived step', is_done: 0, position: 0 });
    const doneOnly = await synced('Done only', { todo_status: 'done', done_at: '2030-04-01 11:00:00' });
    // A reply to an invitation longer than any limit but the column's, spaces and all: it comes back exactly.
    const invited = await synced('Invited');
    const reply = `  ${'Long reply. '.repeat(1000)}TAIL  `;
    await insert('calendar_event_attendees', { id: uuid(), user_id: owner, event_id: invited, email: 'organizer@example.test', display_name: ' Organizer ', response_status: 'tentative', comment: reply });
    const archive = await source('services/backup').buildBackupForUser(owner, { sections: ['calendar'], includeFileData: true });
    // Changed since: done with a source email, and a subtask added.
    await pool.execute("UPDATE calendar_events SET todo_status = 'done', done_at = '2030-04-02 10:00:00', source_email_id = ?, source_email_json = ? WHERE id = ?",
      [uuid(), JSON.stringify({ subject: 'Newer mail' }), stepsOnly]);
    await insert('calendar_event_subtasks', { id: uuid(), user_id: owner, event_id: doneOnly, title: 'Added later', is_done: 0, position: 0 });
    await pool.execute("UPDATE calendar_event_attendees SET comment = 'Changed my mind' WHERE event_id = ?", [invited]);
    // An archive whose state its tables cannot hold is refused by name, not cut to fit, and changes nothing.
    const overlayOf = (copy: FixtureValue) => JSON.parse(copy.data.calendar_overlay_restores.find((row: FixtureValue) => row.uid === 'Invited@example.test').payload);
    for (const [change, refusal] of [
      [(state: FixtureValue) => { state.attendees[0].comment = 'é'.repeat(32768); }, /cannot store: a reply comment is longer than 65,535 bytes/],
      [(state: FixtureValue) => { state.attendees[0].display_name = 'n'.repeat(256); }, /cannot store: an attendee address or name is longer than 255 characters/],
      [(state: FixtureValue) => { state.subtasks = [{ title: 't'.repeat(256), is_done: false, position: 0 }]; }, /cannot store: a subtask title is longer than 255 characters/],
    ] as const) {
      const copy = structuredClone(archive);
      const state = overlayOf(copy);
      change(state);
      copy.data.calendar_overlay_restores.find((row: FixtureValue) => row.uid === 'Invited@example.test').payload = JSON.stringify(state);
      const refused = await source('services/backup').importBackupForUser(owner, copy, { mode: 'apply', sections: ['calendar'], conflict_mode: 'replace', startAccountSync: async () => {} });
      assert.equal(refused.valid, false);
      assert.match(refused.errors.join('\n'), refusal);
    }
    const [[untouched]] = await pool.execute<RowDataPacket[]>('SELECT comment FROM calendar_event_attendees WHERE event_id = ?', [invited]);
    assert.equal(untouched.comment, 'Changed my mind', 'a refused archive changes nothing');
    const result = await source('services/backup').importBackupForUser(owner, archive, { mode: 'apply', sections: ['calendar'], conflict_mode: 'replace', startAccountSync: async () => {} });
    assert.equal(result.valid, true, JSON.stringify(result));
    const stateOf = async (id: string) => {
      const [[row]] = await pool.execute<RowDataPacket[]>('SELECT todo_status, done_at, source_email_id, source_email_json FROM calendar_events WHERE id = ?', [id]);
      const [steps] = await pool.execute<RowDataPacket[]>('SELECT title FROM calendar_event_subtasks WHERE event_id = ? ORDER BY position', [id]);
      return [row.todo_status, row.done_at && new Date(row.done_at).toISOString(), row.source_email_id, row.source_email_json, steps.map(step => step.title)];
    };
    assert.deepEqual(await stateOf(stepsOnly), [null, null, null, null, ['Archived step']], 'no ToDo state and no source email, as archived');
    assert.deepEqual(await stateOf(doneOnly), ['done', '2030-04-01T11:00:00.000Z', null, null, []], 'no subtasks, as archived');
    assert.equal(overlayOf(archive).attendees[0].comment, reply, 'the archive holds the reply as stored');
    const [[restored]] = await pool.execute<RowDataPacket[]>('SELECT display_name, response_status, comment FROM calendar_event_attendees WHERE event_id = ?', [invited]);
    assert.deepEqual([restored.display_name, restored.response_status, restored.comment.length, restored.comment === reply], ['Organizer', 'tentative', reply.length, true], 'and Replace writes it back exactly');
  });

  await t.test('a binned task keeps its source email through a full restore into another person', async () => {
    const owner = await newUser('bin-mail-owner'), fresh = await newUser('bin-mail-fresh');
    const mailAccount = uuid(), email = uuid();
    await insert('mail_folders', { id: uuid(), user_id: owner, slug: 'inbox', display_name: 'Inbox', is_system: 1 });
    await insert('mail_accounts', { id: mailAccount, user_id: owner, email_address: 'bin-mail@example.test', provider: 'custom', imap_host: '8.8.8.8', smtp_host: '9.9.9.9', sync_mode: 'download' });
    await insert('emails', { id: email, user_id: owner, mail_account_id: mailAccount, subject: 'Source of a binned task', from_address: 'sender@example.test', to_addresses: '[]', folder: 'inbox', import_complete: 0 });
    const snapshot = JSON.stringify({ subject: 'Source of a binned task' });
    const localAccount = uuid(), list = uuid(), task = uuid();
    await insert('calendar_accounts', { id: localAccount, user_id: owner, provider: 'local', display_name: 'UniHub', is_active: 1 });
    await insert('calendar_calendars', { id: list, user_id: owner, account_id: localAccount, name: 'Mail list', is_visible: 1 });
    await insert('calendar_events', { id: task, user_id: owner, calendar_id: list, title: 'Answer the mail', start_time: '2030-05-01 09:00:00', end_time: '2030-05-01 10:00:00',
      is_todo_only: 1, source_email_id: email, source_email_json: snapshot });
    await source('services/transactions').withTransaction((cx: FixtureValue) => source('services/bin-calendar').binLocalEvents(cx, owner, [task]));
    // A binned synced task whose one date has its own source email (its state waits as an overlay when restored).
    const [[local]] = await pool.execute<RowDataPacket[]>("SELECT payload FROM bin_items WHERE user_id = ? AND item_type = 'task'", [owner]);
    const payload = JSON.parse(local.payload);
    await insert('bin_items', { id: uuid(), user_id: owner, module: 'calendar', item_type: 'task', item_id: uuid(), title: 'Synced date', reason: 'deleted', payload_version: 1,
      deleted_at: '2030-05-01 12:00:00', payload: JSON.stringify({ ...payload, provider: 'caldav', calendar: { id: null, account_id: null, external_id: null, name: 'Team' },
        object: { href: '/dav/team/synced-date.ics', uid: 'synced-date@example.test', ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' },
        occurrences: [{ recurrence_id: '20300501T090000Z', state: { todo_status: null, done_at: null, source_email_id: email, source_email_json: { subject: 'Source of a binned task' }, subtasks: [] } }] }) });
    const archive = await source('services/backup').buildBackupForUser(owner, { sections: 'full', includeFileData: true });
    const result = await destination('services/backup').importBackupForUser(fresh, archive, { mode: 'apply', sections: 'full', conflict_mode: 'keep_existing', startAccountSync: async () => {} });
    assert.equal(result.valid, true, JSON.stringify(result));
    const [[restoredMail]] = await pool.execute<RowDataPacket[]>("SELECT id FROM emails WHERE user_id = ? AND subject = 'Source of a binned task'", [fresh]);
    assert.notEqual(restoredMail.id, email, 'the email has an id of its own here');
    const [items] = await pool.execute<RowDataPacket[]>('SELECT id, payload FROM bin_items WHERE user_id = ? ORDER BY title', [fresh]);
    const payloads = items.map(row => JSON.parse(row.payload));
    assert.deepEqual(payloads.map(item => item.event.source_email_id), [restoredMail.id, restoredMail.id], 'each binned item names the restored email');
    assert.equal(payloads.find(item => item.provider === 'caldav').occurrences[0].state.source_email_id, restoredMail.id, 'and so does the synced date\'s own state');
    // Back from the bin: linked to the restored email, with its snapshot.
    const localItem = items[payloads.findIndex(item => item.provider !== 'caldav')];
    assert.deepEqual((await destination('services/bin').restoreFromBin(fresh, { ids: [localItem.id] })).failed, []);
    const [[back]] = await pool.execute<RowDataPacket[]>("SELECT source_email_id, source_email_json FROM calendar_events WHERE user_id = ? AND title = 'Answer the mail'", [fresh]);
    assert.deepEqual([back.source_email_id, typeof back.source_email_json === 'string' ? JSON.parse(back.source_email_json) : back.source_email_json], [restoredMail.id, JSON.parse(snapshot)]);
  });

  await t.test('the bin and synced-task state travel with their sections, for their owner only, and come back once', async () => {
    const owner = await newUser('bin-owner'), stranger = await newUser('bin-stranger');
    const contactMerge = source('services/contact-merge');
    // A contact with its photo, a task of a UniHub list and a recording with its file, each deleted into the bin.
    const photo = { full: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(200)]), thumb: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(30)]) };
    for (const bytes of Object.values(photo)) {
      const file = sourcePhotos.photoPath(owner, sha256(bytes));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes);
    }
    const contactId = await insertContact({ user_id: owner, first_name: 'Binned', last_name: 'Contact' }, [['email', 'binned@example.test']]);
    await insert('contact_photos', { contact_id: contactId, user_id: owner, sha256: sha256(photo.full), width: 512, height: 512, bytes: photo.full.length, thumb_sha256: sha256(photo.thumb), source: 'upload' });
    assert.equal((await contactMerge.moveContactsToBin(owner, [contactId])).deleted, 1);
    const theirs = await insertContact({ user_id: stranger, first_name: 'Not', last_name: 'Theirs' });
    await contactMerge.moveContactsToBin(stranger, [theirs]);
    const localAccount = uuid(), list = uuid(), task = uuid();
    await insert('calendar_accounts', { id: localAccount, user_id: owner, provider: 'local', display_name: 'UniHub', is_active: 1 });
    await insert('calendar_calendars', { id: list, user_id: owner, account_id: localAccount, name: 'Binned list', color: '#22c55e', is_visible: 1 });
    await insert('calendar_events', { id: task, user_id: owner, calendar_id: list, title: 'Binned task', start_time: '2030-03-01 09:00:00', end_time: '2030-03-01 10:00:00',
      is_todo_only: 1, todo_status: 'done', done_at: '2030-03-01 11:00:00' });
    await insert('calendar_event_subtasks', { id: uuid(), user_id: owner, event_id: task, title: 'Binned step', is_done: 1, position: 0 });
    await source('services/transactions').withTransaction((cx: FixtureValue) => source('services/bin-calendar').binLocalEvents(cx, owner, [task]));
    const recordingId = uuid(), audio = wav();
    const audioPath = path.join(sourceRoot, 'recordings', owner, `${recordingId}.wav`);
    await fs.mkdir(path.dirname(audioPath), { recursive: true });
    await fs.writeFile(audioPath, audio);
    await insert('recordings', { id: recordingId, user_id: owner, title: 'Binned memo', original_filename: 'memo.wav', content_type: 'audio/wav', size_bytes: audio.length, storage_path: audioPath, source: 'recorded', category: 'none' });
    assert.equal((await source('services/recordings').deleteRecording(owner, recordingId)).binned, true);
    // A synced task with UniHub state: its state travels as an overlay.
    const davAccount = uuid(), davCalendar = uuid(), synced = uuid();
    await insert('calendar_accounts', { id: davAccount, user_id: owner, provider: 'caldav', display_name: 'Team', account_email: 'bin-team@example.test', base_url: 'https://dav.example.test/', is_active: 1 });
    await insert('calendar_calendars', { id: davCalendar, user_id: owner, account_id: davAccount, name: 'Team', external_id: 'https://dav.example.test/bin-team/', color: '#2244ff', is_visible: 1 });
    await insert('calendar_events', { id: synced, user_id: owner, calendar_id: davCalendar, uid: 'Bin-Synced@example.test', title: 'Synced review', start_time: '2030-03-02 09:00:00', end_time: '2030-03-02 10:00:00',
      todo_status: 'done', done_at: '2030-03-02 11:00:00' });
    await insert('calendar_event_external_refs', { id: uuid(), user_id: owner, event_id: synced, calendar_id: davCalendar, account_id: davAccount, provider: 'caldav', external_event_id: 'bin-review.ics', external_etag: 'one' });
    // The person's reply to the invitation stays in UniHub (never written to the server), so it travels too.
    await insert('calendar_event_attendees', { id: uuid(), user_id: owner, event_id: synced, email: 'organizer@example.test', display_name: 'Organizer', response_status: 'tentative', comment: 'Maybe later' });
    const strangerBin = await rowsFor('bin_items', stranger);

    // The archive holds the owner's bin with its files, never another person's.
    const archive = await source('services/backup').buildBackupForUser(owner, { sections: 'full', includeFileData: false });
    assert.deepEqual(archive.data.bin_items.map((row: FixtureValue) => row.item_type).sort(), ['contact', 'recording', 'task']);
    assert.ok(archive.data.bin_items.every((row: FixtureValue) => row.user_id === owner));
    assert.ok(archive.files.some((file: FixtureValue) => file.kind === 'recording_bin' && !file.missing && file.sha256 === sha256(audio)));
    for (const bytes of Object.values(photo)) assert.ok(archive.files.some((file: FixtureValue) => file.kind === 'contact_photo' && file.id === sha256(bytes)), 'the binned contact\'s photo files');
    assert.deepEqual(archive.data.calendar_overlay_restores.map((row: FixtureValue) => row.uid), ['Bin-Synced@example.test']);

    // Through the export and restore jobs into a new person, twice: everything once.
    const started = await exportJobs.startDataExportJob(owner, { sections: 'full' });
    const ready = await waitFor(() => exportJobs.getDataExportJob(owner, started.id), (job: FixtureValue) => job?.status === 'ready', 'Bin export');
    const [[key]] = await pool.execute<RowDataPacket[]>('SELECT recovery_password_ciphertext FROM backup_archive_keys WHERE backup_uuid = ? AND user_id = ?', [ready.backup_uuid, owner]);
    const exported = { bytes: await fs.readFile(ready.file_path), password: source('services/backup-container').revealProtectedRecoveryPassword(key.recovery_password_ciphertext, ready.backup_uuid) };
    const fresh = await newUser('bin-fresh');
    for (let round = 0; round < 2; round++) await uploadAndRestore(destination, fresh, exported, 'keep_existing');
    const items = await rowsFor('bin_items', fresh);
    assert.deepEqual(items.map(row => row.item_type).sort(), ['contact', 'recording', 'task'], 'once, after two restores');
    const days = (row: FixtureValue) => (new Date(row.purge_after).getTime() - Date.now()) / 86400000;
    assert.ok(items.every(row => days(row) > 29 && days(row) <= 30.01), 'each keeps the time it had left');
    assert.deepEqual(await rowsFor('bin_items', stranger), strangerBin, 'the stranger\'s bin is untouched');
    const [overlays] = await pool.execute<RowDataPacket[]>('SELECT uid, payload FROM calendar_overlay_restores WHERE user_id = ?', [fresh]);
    assert.deepEqual(overlays.map(row => row.uid), ['Bin-Synced@example.test'], 'the synced task\'s state waits for its sync, once');
    const waiting = typeof overlays[0].payload === 'string' ? JSON.parse(overlays[0].payload) : overlays[0].payload;
    assert.deepEqual(waiting.attendees.map((row: FixtureValue) => [row.email, row.response_status, row.comment]), [['organizer@example.test', 'tentative', 'Maybe later']], 'with its reply');

    // Back from the bin as they were: the contact with its photo, the task in its list, the recording with its bytes.
    const back = await destination('services/bin').restoreFromBin(fresh, { ids: items.map(row => row.id) });
    assert.deepEqual(back.failed, []);
    const [[contact]] = await pool.execute<RowDataPacket[]>("SELECT c.id, p.sha256 FROM contacts c LEFT JOIN contact_photos p ON p.contact_id = c.id WHERE c.user_id = ? AND c.first_name = 'Binned'", [fresh]);
    assert.equal(contact.sha256, sha256(photo.full));
    assert.deepEqual(await fs.readFile(destination('services/contact-photos').photoPath(fresh, sha256(photo.full))), photo.full);
    const [[restoredTask]] = await pool.execute<RowDataPacket[]>(`SELECT e.todo_status, c.name, (SELECT COUNT(*) FROM calendar_event_subtasks s WHERE s.event_id = e.id) AS steps
      FROM calendar_events e JOIN calendar_calendars c ON c.id = e.calendar_id WHERE e.user_id = ? AND e.title = 'Binned task'`, [fresh]);
    assert.deepEqual([restoredTask.todo_status, restoredTask.name, Number(restoredTask.steps)], ['done', 'Binned list', 1]);
    const [[recording]] = await pool.execute<RowDataPacket[]>("SELECT storage_path FROM recordings WHERE user_id = ? AND title = 'Binned memo'", [fresh]);
    assert.deepEqual(await fs.readFile(recording.storage_path), audio);
    assert.ok(recording.storage_path.startsWith(destinationRoot + path.sep));

    // A restore of Contacts alone takes the contacts' bin and nothing else.
    const zip = path.join(directory, 'bin-legacy.zip');
    await exportJobs.writeZip(await source('services/backup').buildBackupArchiveEntriesForUser(owner, 'full', { workDirectory: directory }), zip);
    const contactsOnly = await newUser('bin-contacts-only');
    await destination('services/backup').importBackupZipFileForUser(contactsOnly, zip, { mode: 'apply', sections: ['contacts'], conflict_mode: 'keep_existing' });
    assert.deepEqual((await rowsFor('bin_items', contactsOnly)).map(row => row.item_type), ['contact']);
  });
  assert.deepEqual(await snapshot(sourceUser), original, 'Source data remains unchanged through every destination restore');
  assert.deepEqual(await snapshot(unrelatedUser), unrelated, 'An unrelated user remains unchanged through every export and restore');
});
