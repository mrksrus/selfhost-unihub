const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime');

const uuid = () => crypto.randomUUID();
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const TABLES = ['user_settings', 'contacts', 'mail_folders', 'mail_accounts', 'mail_folder_remote_boxes', 'mail_sender_rules', 'emails', 'email_attachments', 'mail_email_scores', 'calendar_accounts', 'calendar_calendars', 'calendar_events', 'calendar_event_subtasks', 'calendar_event_attendees', 'calendar_event_external_refs', 'recordings', 'recording_tags', 'recording_tag_links'];

function wav() {
  const bytes = Buffer.alloc(76);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32, 40);
  for (let index = 0; index < 16; index++) bytes.writeInt16LE(Math.round(Math.sin(index) * 1000), 44 + index * 2);
  return bytes;
}

async function waitFor(read, wanted, description, { allowFailure = false } = {}) {
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

test('production export and restore jobs round-trip every section through encrypted and legacy archives', {
  skip: !process.env.MYSQL_TEST_HOST,
  timeout: 240000,
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
  const source = createBackupRuntime(sourceRoot, 'source-roundtrip-key', pool);
  const destination = createBackupRuntime(destinationRoot, 'different-destination-roundtrip-key', pool);
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
  async function rowsFor(table, userId) {
    const [rows] = table === 'mail_folder_remote_boxes'
      ? await pool.execute('SELECT boxes.* FROM mail_folder_remote_boxes boxes JOIN mail_folders folders ON folders.id = boxes.folder_id JOIN mail_accounts accounts ON accounts.id = boxes.mail_account_id WHERE folders.user_id = ? AND accounts.user_id = ?', [userId, userId])
      : await pool.execute(`SELECT * FROM ${table} WHERE user_id = ?`, [userId]);
    return rows.map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  async function snapshot(userId) {
    return Object.fromEntries(await Promise.all(TABLES.map(async table => [table, await rowsFor(table, userId)])));
  }
  const sourceUser = await newUser('roundtrip-source');
  const unrelatedUser = await newUser('roundtrip-unrelated');
  await insert('contacts', { id: uuid(), user_id: unrelatedUser, first_name: 'Do not export or change', notes: 'Unrelated private data' });
  await pool.execute('UPDATE users SET full_name = ?, timezone = ? WHERE id = ?', ['Grüße Roundtrip', 'Europe/Vienna', sourceUser]);
  await insert('user_settings', { user_id: sourceUser, setting_key: 'calendar_preferences', setting_value: JSON.stringify({ firstDay: 1, custom: 'Grüße\nTwo lines' }) });
  await insert('contacts', { id: uuid(), user_id: sourceUser, first_name: 'Zoë', last_name: 'Example', email: 'zoe@example.test', email2: 'second@example.test', phone: '+43 12345', notes: 'Unicode: Grüße\nSecond line', is_favorite: 1 });
  const folderIds = { research: uuid(), copies: uuid() };
  await insert('mail_folders', { id: folderIds.research, user_id: sourceUser, slug: 'research', display_name: 'Research & Notes', position: 7, is_system: 0 });
  await insert('mail_folders', { id: folderIds.copies, user_id: sourceUser, slug: 'copies', display_name: 'Archived Copies', position: 8, is_system: 0 });
  const originalFiles = new Map();
  const passwords = new Map();
  for (let index = 0; index < 2; index++) {
    const accountId = uuid();
    const emailAddress = `mail-${index}@example.test`;
    passwords.set(emailAddress, `synthetic-mail-password-${index}`);
    await insert('mail_accounts', { id: accountId, user_id: sourceUser, email_address: emailAddress, provider: 'custom', username: emailAddress, imap_host: '8.8.8.8', smtp_host: '9.9.9.9', encrypted_password: sourceCrypto.encrypt(passwords.get(emailAddress)), is_active: 1, delete_emails_on_server: 1 });
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
    await insert('emails', { id: emailId, user_id: sourceUser, mail_account_id: accountId, message_id: `<roundtrip-${index}@example.test>`, subject: 'Mail ' + index, from_address: 'sender@example.test', to_addresses: JSON.stringify([emailAddress]), body_text: 'Body Grüße ' + index + ':' + copy, body_html: `<p>Grüße ${index}:${copy}</p><img src="/api/mail/attachments/${attachmentId}">`, folder: folderSlug, source_folder: sourceFolder, imap_uid: 22 + index + copy * 10, imap_uidvalidity: 123, raw_storage_path: rawPath, raw_sha256: sha256(raw), received_at: '2030-01-02 12:34:56', is_starred: 1, has_attachments: 1, import_complete: 1 });
    await insert('email_attachments', { id: attachmentId, user_id: sourceUser, email_id: emailId, filename: 'data-' + index + '.bin', content_type: 'application/octet-stream', size_bytes: attachment.length, storage_path: attachmentPath, content_id: 'content-' + index });
    if (index === 0 && copy === 0) {
      const secondId = uuid();
      const secondBytes = Buffer.from(attachment); secondBytes[secondBytes.length - 1] ^= 127;
      const secondPath = path.join(sourceRoot, 'attachments', sourceUser, secondId + '.bin');
      await fs.writeFile(secondPath, secondBytes);
      // Same name and byte count are not proof that two attachments are equal.
      await insert('email_attachments', { id: secondId, user_id: sourceUser, email_id: emailId, filename: 'data-0.bin', content_type: 'application/octet-stream', size_bytes: secondBytes.length, storage_path: secondPath, content_id: 'second-content-0' });
      await pool.execute('UPDATE emails SET body_html = CONCAT(body_html, ?) WHERE id = ?', [`<img src="/api/mail/attachments/${secondId}">`, emailId]);
    }
    await insert('mail_email_scores', { id: uuid(), user_id: sourceUser, email_id: emailId, score_version: 'v1', total_score: 12.5, reasons: JSON.stringify(['synthetic reason']), metadata: JSON.stringify({ test: true }) });
    }
  }
  const calendarAccountId = uuid(), calendarId = uuid(), eventId = uuid();
  await insert('calendar_accounts', { id: calendarAccountId, user_id: sourceUser, provider: 'caldav', display_name: 'Roundtrip calendar', account_email: 'calendar@example.test', username: 'calendar-user', discovery_url: 'https://8.8.8.8/dav/', base_url: 'https://8.8.8.8/dav/', encrypted_password: sourceCrypto.encrypt('synthetic-calendar-password'), encrypted_access_token: sourceCrypto.encrypt('synthetic-access-token'), encrypted_refresh_token: sourceCrypto.encrypt('synthetic-refresh-token'), is_active: 1 });
  await insert('calendar_calendars', { id: calendarId, user_id: sourceUser, account_id: calendarAccountId, name: 'Research Calendar', external_id: 'https://8.8.8.8/dav/calendar/', color: '#2244ff', is_visible: 1 });
  await insert('calendar_events', { id: eventId, user_id: sourceUser, calendar_id: calendarId, title: 'Roundtrip event', description: 'Preserve Grüße\nSecond line', start_time: '2030-02-03 10:00:00', end_time: '2030-02-03 11:00:00', recurrence: 'FREQ=WEEKLY;COUNT=3', reminders: JSON.stringify([10, 60]), reminder_minutes: 10, todo_status: 'todo', location: 'Vienna' });
  await insert('calendar_event_subtasks', { id: uuid(), user_id: sourceUser, event_id: eventId, title: 'Keep this task', is_done: 1, position: 2 });
  await insert('calendar_event_attendees', { id: uuid(), user_id: sourceUser, event_id: eventId, email: 'attendee@example.test', display_name: 'Attendee', response_status: 'accepted' });
  await insert('calendar_event_external_refs', { id: uuid(), user_id: sourceUser, event_id: eventId, calendar_id: calendarId, account_id: calendarAccountId, provider: 'caldav', external_event_id: 'event.ics', external_etag: 'etag-one' });
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
  }
  const original = await snapshot(sourceUser);
  const unrelated = await snapshot(unrelatedUser);
  const exportJobs = source('services/export-jobs');
  async function exportArchive(encrypted) {
    const started = await exportJobs.startDataExportJob(sourceUser, { sections: 'full', encrypt: encrypted });
    const ready = await waitFor(() => exportJobs.getDataExportJob(sourceUser, started.id), job => job?.status === 'ready', 'Export');
    const bytes = await fs.readFile(ready.file_path);
    assert.equal(bytes.length, Number(ready.file_size)); assert.equal(sha256(bytes), ready.file_sha256);
    assert.ok(ready.file_path.startsWith(sourceRoot + path.sep));
    let password = null;
    if (encrypted) {
      const [[key]] = await pool.execute('SELECT recovery_password_ciphertext FROM backup_archive_keys WHERE backup_uuid = ? AND user_id = ?', [ready.backup_uuid, sourceUser]);
      password = source('services/backup-container').revealProtectedRecoveryPassword(key.recovery_password_ciphertext, ready.backup_uuid);
      assert.equal(bytes.includes(Buffer.from('synthetic-mail-password-0')), false);
    }
    return { ...ready, bytes, password };
  }
  const encrypted = await exportArchive(true);
  const legacy = await exportArchive(false);
  const legacyParsed = await source('services/backup').backupFromZipFile(legacy.file_path);
  assert.equal(legacyParsed.manifest.file_count, 11);
  assert.deepEqual(legacyParsed.manifest.missing_files, []);
  assert.equal(legacyParsed.backup.data.contacts.length, 1, 'Other users must not appear in an export');
  assert.deepEqual(await snapshot(sourceUser), original, 'Export must not mutate source rows');

  await t.test('export never advertises an archive larger than this deployment can upload for restore', async () => {
    const limited = createBackupRuntime(sourceRoot, 'source-roundtrip-key', pool);
    limited('config').BACKUP_UPLOAD_MAX_SIZE = 64;
    const service = limited('services/export-jobs');
    const started = await service.startDataExportJob(sourceUser, { sections: 'full', encrypt: true });
    const failed = await waitFor(() => service.getDataExportJob(sourceUser, started.id), job => job?.status === 'failed', 'Oversized archive rejection', { allowFailure: true });
    assert.match(failed.error, /exceeds the import upload limit/i);
    assert.equal(failed.file_path, null);
    const files = await fs.readdir(path.join(sourceRoot, 'backups', sourceUser));
    assert.equal(files.some(filename => filename.startsWith(started.id)), false, 'Remove unusable archive and temporary ZIP');
    const [[keys]] = await pool.execute('SELECT COUNT(*) AS total FROM backup_archive_keys WHERE export_job_id = ?', [started.id]);
    assert.equal(keys.total, 0, 'Remove unusable archive key metadata');
  });
  await t.test('a missing selected recording fails export clearly while an unrelated section can still export', async () => {
    const originalPath = original.recordings[0].storage_path;
    const heldPath = originalPath + '.held-by-test';
    await fs.rename(originalPath, heldPath);
    try {
      const started = await exportJobs.startDataExportJob(sourceUser, { sections: 'full', encrypt: true });
      const failed = await waitFor(() => exportJobs.getDataExportJob(sourceUser, started.id), job => job?.status === 'failed', 'Missing selected file rejection', { allowFailure: true });
      assert.match(failed.error, /referenced file.*missing|missing.*referenced file/i);
      assert.equal(failed.file_path, null);
      const partial = await exportJobs.startDataExportJob(sourceUser, { sections: ['contacts'], encrypt: false });
      const ready = await waitFor(() => exportJobs.getDataExportJob(sourceUser, partial.id), job => job?.status === 'ready', 'Unrelated contacts export');
      const parsed = await source('services/backup').backupFromZipFile(ready.file_path);
      assert.equal(parsed.backup.data.contacts.length, original.contacts.length);
      assert.equal(parsed.backup.data.recordings, undefined);
    } finally { await fs.rename(heldPath, originalPath); }
  });

  async function uploadAndRestore(runtime, userId, archive, conflictMode = 'replace', { wrongPasswordFirst = false } = {}) {
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
    const validated = await waitFor(() => service.getRestoreJob(userId, created.id), job => job?.status === 'validated', 'Restore validation');
    assert.equal(validated.archive_sha256, sha256(archive.bytes));
    const started = await service.startRestoreJob(userId, created.id);
    assert.equal(started.error, undefined);
    return waitFor(() => service.getRestoreJob(userId, created.id), job => job?.status === 'completed' && job.archive_path === null, 'Restore commit and upload cleanup');
  }

  async function assertRestored(runtime, userId, { credentialsAvailable = true } = {}) {
    const restored = await snapshot(userId);
    for (const table of TABLES) {
      assert.equal(restored[table].length, original[table].length, `${table}: preserve every row`);
      for (const row of restored[table]) {
        if (table !== 'mail_folder_remote_boxes') assert.equal(row.user_id, userId);
        if (row.id) assert.ok(!original[table].some(item => item.id === row.id), `${table}: new owner receives fresh IDs`);
      }
    }
    const compare = (table, fields) => {
      const select = row => Object.fromEntries(fields.map(field => [field, row[field]]));
      const order = rows => rows.map(select).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      assert.deepEqual(order(restored[table]), order(original[table]), `${table}: preserve content`);
    };
    compare('contacts', ['first_name', 'last_name', 'email', 'email2', 'phone', 'notes', 'is_favorite']);
    compare('user_settings', ['setting_key', 'setting_value']);
    compare('mail_folders', ['slug', 'display_name', 'position', 'is_system']);
    compare('emails', ['message_id', 'subject', 'from_address', 'to_addresses', 'body_text', 'folder', 'source_folder', 'imap_uid', 'imap_uidvalidity', 'is_starred', 'has_attachments', 'received_at', 'raw_sha256', 'import_complete']);
    compare('calendar_events', ['title', 'description', 'start_time', 'end_time', 'recurrence', 'reminders', 'reminder_minutes', 'todo_status', 'location']);
    compare('calendar_event_subtasks', ['title', 'is_done', 'position']);
    compare('calendar_event_attendees', ['email', 'display_name', 'response_status']);
    compare('mail_email_scores', ['score_version', 'total_score', 'reasons', 'metadata']);
    compare('recordings', ['title', 'description', 'original_filename', 'content_type', 'size_bytes', 'duration_seconds', 'metadata', 'recorded_at']);
    compare('recording_tags', ['name', 'color']);
    const decrypt = runtime('security/encryption').decrypt;
    for (const account of restored.mail_accounts) {
      assert.equal(decrypt(account.encrypted_password), credentialsAvailable ? passwords.get(account.email_address) : null);
      assert.equal(account.is_active, credentialsAvailable ? 1 : 0);
      assert.equal(account.delete_emails_on_server, 0, 'Restore must not reenable server deletion');
      const accountEmails = restored.emails.filter(row => row.mail_account_id === account.id);
      assert.equal(accountEmails.length, 2, 'Same Message-ID in distinct folders must not collapse');
      for (const email of accountEmails) {
      const fileKey = account.email_address + ':' + email.source_folder;
      const raw = await fs.readFile(email.raw_storage_path);
      assert.deepEqual(raw, originalFiles.get('raw:' + fileKey)); assert.equal(sha256(raw), email.raw_sha256);
      const oldAccount = original.mail_accounts.find(row => row.email_address === account.email_address);
      const oldEmail = original.emails.find(row => row.mail_account_id === oldAccount.id && row.source_folder === email.source_folder);
      const oldAttachments = original.email_attachments.filter(row => row.email_id === oldEmail.id);
      const attachments = restored.email_attachments.filter(row => row.email_id === email.id);
      assert.equal(attachments.length, oldAttachments.length, 'Same-name, same-size attachments remain separate');
      for (const attachment of attachments) {
        const oldAttachment = oldAttachments.find(row => row.content_id === attachment.content_id);
        assert.ok(oldAttachment);
        assert.deepEqual(await fs.readFile(attachment.storage_path), await fs.readFile(oldAttachment.storage_path));
        assert.ok(email.body_html.includes(`/api/mail/attachments/${attachment.id}`), 'Inline image URL follows the newly allocated attachment ID');
      }
      assert.ok(!original.email_attachments.some(row => email.body_html.includes(row.id)));
      assert.ok(restored.mail_email_scores.some(row => row.email_id === email.id));
      const mapping = restored.mail_folder_remote_boxes.find(row => row.mail_account_id === account.id && row.remote_name === email.source_folder);
      assert.ok(mapping, 'Both accounts retain their folder-to-IMAP mapping');
      assert.equal(mapping.folder_id, restored.mail_folders.find(folder => folder.slug === email.folder).id);
      }
      assert.ok(restored.mail_sender_rules.some(row => row.mail_account_id === account.id));
    }
    const calendarAccount = restored.calendar_accounts[0];
    for (const [field, expected] of [['encrypted_password', 'synthetic-calendar-password'], ['encrypted_access_token', 'synthetic-access-token'], ['encrypted_refresh_token', 'synthetic-refresh-token']]) assert.equal(decrypt(calendarAccount[field]), credentialsAvailable ? expected : null);
    assert.equal(calendarAccount.is_active, credentialsAvailable ? 1 : 0);
    const calendar = restored.calendar_calendars[0], event = restored.calendar_events[0], ref = restored.calendar_event_external_refs[0];
    assert.equal(calendar.account_id, calendarAccount.id); assert.equal(event.calendar_id, calendar.id);
    assert.equal(restored.calendar_event_subtasks[0].event_id, event.id); assert.equal(restored.calendar_event_attendees[0].event_id, event.id);
    assert.equal(ref.event_id, event.id); assert.equal(ref.calendar_id, calendar.id); assert.equal(ref.account_id, calendarAccount.id);
    for (const recording of restored.recordings) {
      assert.deepEqual(await fs.readFile(recording.storage_path), audioByTitle.get(recording.title));
      assert.ok(restored.recording_tag_links.some(link => link.recording_id === recording.id && link.tag_id === restored.recording_tags[0].id));
    }
    const [[profile]] = await pool.execute('SELECT full_name, timezone, role FROM users WHERE id = ?', [userId]);
    assert.deepEqual(profile, { full_name: 'Grüße Roundtrip', timezone: 'Europe/Vienna', role: 'user' });
    return restored;
  }

  const encryptedUser = await newUser('encrypted-destination');
  await t.test('encrypted production archive restores all data and portable passwords under a different server key', async () => {
    const completed = await uploadAndRestore(destination, encryptedUser, encrypted, 'replace', { wrongPasswordFirst: true });
    assert.equal(completed.is_encrypted, 1);
    const restored = await assertRestored(destination, encryptedUser);
    assert.equal(sourceCrypto.decrypt(restored.mail_accounts[0].encrypted_password), null, 'Destination credentials use the destination key');
    assert.equal(destinationCrypto.decrypt(original.mail_accounts[0].encrypted_password), null, 'Source ciphertext cannot be read directly on the destination');
  });
  await t.test('unencrypted legacy ZIP restores every section with the original deployment key', async () => {
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
    destination('state').setDb({
      execute: (...args) => pool.execute(...args),
      async getConnection() {
        const connection = await pool.getConnection();
        let completesRestore = false;
        return {
          async execute(sql, params) {
            if (/UPDATE backup_restore_jobs\s+SET status = 'completed'/.test(sql)) completesRestore = true;
            return connection.execute(sql, params);
          },
          query: (...args) => connection.query(...args),
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
    });
    try {
      const userId = await newUser('commit-acknowledgement-lost');
      await uploadAndRestore(destination, userId, encrypted);
      assert.equal(injected, true, 'Failure must occur after the restore transaction really commits');
      await assertRestored(destination, userId);
    } finally { destination('state').setDb(pool); }
  });
  await t.test('repeated complete archives honor keep-existing, replace and keep-both without detaching children', async () => {
    await pool.execute('UPDATE contacts SET notes = ? WHERE user_id = ?', ['Local edit', encryptedUser]);
    await uploadAndRestore(destination, encryptedUser, encrypted, 'keep_existing');
    assert.equal((await rowsFor('contacts', encryptedUser))[0].notes, 'Local edit');
    assert.equal((await rowsFor('emails', encryptedUser)).length, original.emails.length);
    await uploadAndRestore(destination, encryptedUser, encrypted, 'replace');
    await assertRestored(destination, encryptedUser);
    await uploadAndRestore(destination, encryptedUser, encrypted, 'keep_both');
    const doubled = await snapshot(encryptedUser);
    assert.equal(doubled.contacts.length, 2); assert.equal(doubled.emails.length, original.emails.length * 2); assert.equal(doubled.recordings.length, original.recordings.length * 2);
    assert.equal(doubled.email_attachments.length, original.email_attachments.length * 2); assert.equal(doubled.recording_tag_links.length, original.recording_tag_links.length * 2);
    for (const email of doubled.emails) assert.ok(doubled.email_attachments.some(row => row.email_id === email.id));
    for (const recording of doubled.recordings) {
      assert.ok(doubled.recording_tag_links.some(row => row.recording_id === recording.id));
      assert.deepEqual(await fs.readFile(recording.storage_path), audioByTitle.get(recording.title));
    }
    for (const event of doubled.calendar_events) assert.ok(doubled.calendar_event_subtasks.some(row => row.event_id === event.id));
  });
  await t.test('damaged encrypted archive fails before importing any rows', async () => {
    const userId = await newUser('damaged-destination');
    const bytes = Buffer.from(encrypted.bytes); bytes[bytes.length - 1] ^= 1;
    const upload = path.join(directory, uuid() + '.upload'); await fs.writeFile(upload, bytes);
    const service = destination('services/backup-restore-jobs');
    const created = await service.createUploadedRestoreJob(userId, upload, { sections: 'full' });
    await service.unlockRestoreJob(userId, created.id, encrypted.password);
    await waitFor(() => service.getRestoreJob(userId, created.id), job => job?.status === 'failed', 'Damaged archive rejection', { allowFailure: true });
    for (const rows of Object.values(await snapshot(userId))) assert.equal(rows.length, 0);
  });
  await t.test('a ZIP file changed after validation fails restore without deleting the retained archive', async () => {
    const userId = await newUser('changed-after-validation');
    const service = destination('services/backup-restore-jobs');
    const upload = path.join(directory, uuid() + '.upload');
    await fs.writeFile(upload, legacy.bytes);
    const created = await service.createUploadedRestoreJob(userId, upload, { sections: 'full', conflict_mode: 'replace' });
    const validated = await waitFor(() => service.getRestoreJob(userId, created.id), job => job?.status === 'validated', 'Initial ZIP validation');
    assert.equal(validated.archive_sha256, sha256(legacy.bytes));
    const parsed = await destination('services/backup').backupFromZipFile(validated.archive_path);
    const recording = parsed.backup.files.find(file => file.kind === 'recording');
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
    const failed = await waitFor(() => service.getRestoreJob(userId, created.id), job => job?.status === 'failed', 'Changed ZIP rejection', { allowFailure: true });
    assert.match(failed.error, /checksum/i);
    assert.equal(failed.archive_path, validated.archive_path, 'A failed apply retains the uploaded archive');
    assert.equal((await fs.stat(failed.archive_path)).size, legacy.bytes.length);
    for (const rows of Object.values(await snapshot(userId))) assert.equal(rows.length, 0, 'No section may be partially imported');
    const [[profile]] = await pool.execute('SELECT full_name FROM users WHERE id = ?', [userId]);
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
      for (const [table, oldRows] of Object.entries(expected.data)) {
        if (!Array.isArray(oldRows)) continue;
        assert.equal(restored[table].length, oldRows.length, `Historical ${table}: preserve every row`);
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
      const ignored = new Set(['id', 'user_id', 'account_id', 'calendar_id', 'event_id', 'email_id', 'mail_account_id', 'recording_id', 'tag_id', 'created_at', 'updated_at', 'storage_path', 'raw_storage_path', 'encrypted_password', 'encrypted_access_token', 'encrypted_refresh_token', 'delete_emails_on_server', 'server_delete_enabled_at', 'server_delete_grace_until', 'server_delete_last_run_at', 'is_active', 'body_html']);
      function normalized(field, value) {
        if (value === null || value === undefined) return value;
        if (field.endsWith('_at') || ['start_time', 'end_time'].includes(field)) return new Date(value).toISOString();
        if (['size_bytes', 'duration_seconds', 'total_score'].includes(field)) return Number(value);
        if (typeof value === 'string' && /^[\[{]/.test(value)) {
          try { return JSON.parse(value); } catch { /* Ordinary text remains text. */ }
        }
        return value;
      }
      for (const [table, oldRows] of Object.entries(expected.data)) {
        if (!Array.isArray(oldRows) || !oldRows.length) continue;
        const fields = Object.keys(oldRows[0]).filter(field => !ignored.has(field));
        const project = row => Object.fromEntries(fields.map(field => [field, normalized(field, row[field])]));
        const ordered = rows => rows.map(project).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        assert.deepEqual(ordered(restored[table]), ordered(oldRows), `Historical ${table}: preserve archived content`);
      }
      const decrypt = runtime('security/encryption').decrypt;
      for (const credential of expected.credentials.mail_accounts) {
        const account = restored.mail_accounts.find(row => row.email_address === credential.email_address);
        assert.equal(decrypt(account.encrypted_password), credential.password);
        assert.equal(account.is_active, 1); assert.equal(account.delete_emails_on_server, 0);
        const oldEmail = expected.data.emails.find(row => row.mail_account_id === credential.id);
        const email = restored.emails.find(row => row.mail_account_id === account.id && row.message_id === oldEmail.message_id);
        assert.ok(email);
        assert.equal(email.import_complete, 0, 'Old archives do not prove the newer complete-import flag');
        const oldAttachment = expected.data.email_attachments.find(row => row.email_id === oldEmail.id);
        const attachment = restored.email_attachments.find(row => row.email_id === email.id && row.filename === oldAttachment.filename);
        assert.ok(attachment);
        const sourceAttachment = expected.files.find(file => file.kind === 'email_attachment' && file.id === oldAttachment.id);
        const attachmentBytes = await fs.readFile(attachment.storage_path);
        assert.deepEqual(attachmentBytes, Buffer.from(sourceAttachment.bytes_base64, 'base64'));
        assert.equal(sha256(attachmentBytes), sourceAttachment.sha256);
        const sourceRaw = expected.files.find(file => file.kind === 'raw_email' && file.id === oldEmail.id);
        const rawBytes = await fs.readFile(email.raw_storage_path);
        assert.deepEqual(rawBytes, Buffer.from(sourceRaw.bytes_base64, 'base64')); assert.equal(sha256(rawBytes), email.raw_sha256);
        if (oldEmail.body_html.includes('/api/mail/attachments/')) {
          assert.ok(email.body_html.includes('/api/mail/attachments/' + attachment.id));
          assert.equal(email.body_html.includes(oldAttachment.id), false);
        }
        assert.ok(restored.mail_email_scores.some(row => row.email_id === email.id));
        assert.ok(restored.mail_sender_rules.some(row => row.mail_account_id === account.id));
      }
      const calendarAccount = restored.calendar_accounts[0], calendar = restored.calendar_calendars[0], event = restored.calendar_events[0];
      const credential = expected.credentials.calendar_accounts[0];
      assert.equal(decrypt(calendarAccount.encrypted_password), credential.password);
      assert.equal(decrypt(calendarAccount.encrypted_access_token), credential.access_token);
      assert.equal(decrypt(calendarAccount.encrypted_refresh_token), credential.refresh_token);
      assert.equal(calendar.account_id, calendarAccount.id); assert.equal(event.calendar_id, calendar.id);
      assert.equal(restored.calendar_event_subtasks[0].event_id, event.id); assert.equal(restored.calendar_event_attendees[0].event_id, event.id);
      assert.equal(restored.calendar_event_external_refs[0].event_id, event.id);
      assert.equal(restored.calendar_event_external_refs[0].calendar_id, calendar.id);
      assert.equal(restored.calendar_event_external_refs[0].account_id, calendarAccount.id);
      const sourceAudio = expected.files.find(file => file.kind === 'recording');
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
        payload.files = payload.files.map(file => ({ kind: file.kind, id: file.id, filename: file.filename, missing: true, sha256: null, size_bytes: 0 }));
        const dataBytes = Buffer.from(JSON.stringify(payload));
        const manifest = { ...parsed.manifest, file_count: 0, missing_files: payload.files.map(file => `${file.kind}:${file.id}`) };
        const missingPath = path.join(directory, uuid() + '-legacy-missing.zip');
        await runtime('services/export-jobs').writeZip([
          { name: 'manifest.json', data: JSON.stringify(manifest) },
          { name: 'data/backup.json', data: dataBytes },
          { name: 'checksums.json', data: JSON.stringify({ algorithm: 'sha256', entries: { 'data/backup.json': sha256(dataBytes) } }) },
        ], missingPath);
        const missingBytes = await fs.readFile(missingPath);
        const previousFileBytes = new Map();
        for (const [table, fileColumn] of [['emails', 'raw_storage_path'], ['email_attachments', 'storage_path'], ['recordings', 'storage_path']]) {
          for (const row of restored[table]) previousFileBytes.set(row[fileColumn], await fs.readFile(row[fileColumn]));
        }
        const repeated = await uploadAndRestore(runtime, userId, { bytes: missingBytes, password: null }, 'replace');
        assert.equal(repeated.status, 'completed');
        const preserved = await snapshot(userId);
        for (const [table, fileColumn] of [['emails', 'raw_storage_path'], ['email_attachments', 'storage_path'], ['recordings', 'storage_path']]) {
          assert.equal(preserved[table].length, restored[table].length);
          for (const old of restored[table]) {
            const row = preserved[table].find(item => item.id === old.id);
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
  assert.deepEqual(await snapshot(sourceUser), original, 'Source data remains unchanged through every destination restore');
  assert.deepEqual(await snapshot(unrelatedUser), unrelated, 'An unrelated user remains unchanged through every export and restore');
});
