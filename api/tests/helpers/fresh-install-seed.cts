import type { ResultSetHeader } from 'mysql2/promise';
// Piped into the source installation by scripts/recovery-fresh-install.mts and
// run there as its API user, with its database, keys and /app/uploads. Adds the
// synthetic data the public API cannot create without a live provider: synced
// mail with stored files, provider credentials, folder history, a CalDAV
// account, completed transcripts and data saved by older releases.
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const fs = (require('node:fs') as typeof import('node:fs'));
const path = (require('node:path') as typeof import('node:path'));
const apiRoot = process.env.UNIHUB_API_ROOT!;
const mysql = require(require.resolve('mysql2/promise', { paths: [apiRoot] })) as typeof import('mysql2/promise');
const { encrypt } = require(path.join(apiRoot, 'src/security/encryption')) as typeof import('../../src/security/encryption');

const userId = process.env.SEED_USER_ID!;
const recordingId = process.env.SEED_RECORDING_ID!;
const peer = { host: process.env.SEED_PEER_HOST!, imapPort: Number(process.env.SEED_IMAP_PORT), davPort: Number(process.env.SEED_DAV_PORT) };
const secrets = JSON.parse(process.env.SEED_SECRETS!) as { mail: string[]; calendar: string };
const uuid = () => crypto.randomUUID();
const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

async function main() {
  if (!/^[0-9a-f-]{36}$/.test(userId) || !/^[0-9a-f-]{36}$/.test(recordingId)) throw new Error('SEED_USER_ID and SEED_RECORDING_ID are required');
  const db = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, timezone: '+00:00' });
  const insert = (table: string, row: Record<string, unknown>) => db.execute<ResultSetHeader>(
    `INSERT INTO ${table} (${Object.keys(row).map(name => '`' + name + '`').join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`,
    Object.values(row) as (string | number | null)[]);
  const store = (kind: string, name: string, bytes: Buffer) => {
    const file = path.join('/app/uploads', kind, userId, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  try {
    // Choices and an order saved by older releases still name removed modules.
    await insert('user_settings', { user_id: userId, setting_key: 'calendar_preferences', setting_value: JSON.stringify({ firstDay: 1, custom: 'Grüße\nTwo lines' }) });
    await insert('user_settings', { user_id: userId, setting_key: 'module_preferences', setting_value: JSON.stringify({ notes: { visible: false, enabled: false, background: false }, games: { visible: false }, recordings: { visible: false } }) });
    await insert('user_settings', { user_id: userId, setting_key: 'module_order', setting_value: JSON.stringify(['notes', 'recordings', 'mail', 'calendar', 'contacts']) });
    // Legacy row from the removed Games module: kept in place, never exported.
    await insert('tetris_scores', { user_id: userId, score: 13500, lines: 42, level: 5, achieved_at: '2030-01-01 11:00:00' });

    const folders = { research: uuid(), copies: uuid() };
    await insert('mail_folders', { id: folders.research, user_id: userId, slug: 'research', display_name: 'Research & Notes', position: 7, is_system: 0 });
    await insert('mail_folders', { id: folders.copies, user_id: userId, slug: 'copies', display_name: 'Archived Copies', position: 8, is_system: 0 });
    const accounts: string[] = [], emails: string[] = [];
    for (const [index, password] of secrets.mail.entries()) {
      const accountId = uuid(), address = `fresh-mail-${index}@example.test`;
      accounts.push(accountId);
      // The source mailbox is not reachable while the source runs: the peer starts only after it is gone.
      await insert('mail_accounts', { id: accountId, user_id: userId, email_address: address, display_name: `Fresh ${index}`, provider: 'custom', username: address,
        imap_host: peer.host, imap_port: peer.imapPort, smtp_host: peer.host, smtp_port: peer.imapPort, encrypted_password: encrypt(password),
        is_active: 1, sync_mode: index ? 'sync' : 'download', sync_status: 'idle', delete_emails_on_server: index ? 0 : 1 });
      await insert('mail_sender_rules', { id: uuid(), user_id: userId, mail_account_id: accountId, match_type: 'email', match_value: `sender-${index}@example.test`, target_folder: 'research' });
      for (const [copy, remote] of ['INBOX/Research', 'Archive/Copies'].entries()) {
        const emailId = uuid(), attachmentId = uuid(), slug = copy ? 'copies' : 'research';
        emails.push(emailId);
        await insert('mail_folder_remote_boxes', { folder_id: folders[slug], mail_account_id: accountId, remote_name: remote });
        // The Message-ID repeats within one account; folder, UID, body and files tell the copies apart.
        const raw = Buffer.from(`From: Sender <sender-${index}@example.test>\r\nTo: ${address}\r\nMessage-ID: <fresh-${index}@example.test>\r\nSubject: Fresh mail ${index}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nGrüße from message ${index}, copy ${copy}.\r\n`);
        const attachment = Buffer.from([0, 255, 17, 128, index, copy, 10, 13, 0]);
        const rawPath = store('mail-raw', `${emailId}.eml`, raw);
        await insert('emails', { id: emailId, user_id: userId, mail_account_id: accountId, message_id: `<fresh-${index}@example.test>`, subject: `Fresh mail ${index}`,
          from_address: `sender-${index}@example.test`, from_name: 'Sender', to_addresses: JSON.stringify([address]), body_text: `Body Grüße ${index}:${copy}`,
          body_html: `<p>Grüße ${index}:${copy}</p><img src="/api/mail/attachments/${attachmentId}">`, folder: slug, source_folder: remote,
          imap_uid: 22 + index + copy * 10, imap_uidvalidity: 123, remote_folder: copy ? 'Moved/Current' : remote, remote_uid: 100 + index + copy,
          remote_uidvalidity: 456, remote_missing: copy, raw_storage_path: rawPath, raw_sha256: sha256(raw), received_at: `2030-01-0${2 + index} 12:3${copy}:56`,
          is_starred: 1, has_attachments: 1, import_complete: 1 });
        await insert('email_attachments', { id: attachmentId, user_id: userId, email_id: emailId, filename: `data-${index}.bin`, content_type: 'application/octet-stream',
          size_bytes: attachment.length, storage_path: store('attachments', `${attachmentId}.bin`, attachment), content_id: `content-${index}-${copy}` });
        if (index === 0 && copy === 0) {
          // Same name and size, different bytes: restore must not merge them.
          const secondId = uuid(), second = Buffer.from(attachment);
          second[second.length - 1] ^= 127;
          await insert('email_attachments', { id: secondId, user_id: userId, email_id: emailId, filename: 'data-0.bin', content_type: 'application/octet-stream',
            size_bytes: second.length, storage_path: store('attachments', `${secondId}.bin`, second), content_id: 'second-content-0' });
          await db.execute('UPDATE emails SET body_html = CONCAT(body_html, ?) WHERE id = ?', [`<img src="/api/mail/attachments/${secondId}">`, emailId]);
        }
        await insert('mail_email_scores', { id: uuid(), user_id: userId, email_id: emailId, score_version: 'v1', total_score: 12.5, reasons: JSON.stringify(['synthetic reason']), metadata: JSON.stringify({ test: true }) });
      }
    }
    await db.execute('UPDATE mail_folders SET mail_account_id = ?, special_use = ? WHERE id = ?', [accounts[1], 'archive', folders.research]);
    await db.execute('UPDATE emails SET filing_account_id = ? WHERE id = ?', [accounts[1], emails[0]]);
    await db.execute('UPDATE emails SET is_legacy = TRUE WHERE id = ?', [emails[1]]);
    await insert('user_settings', { user_id: userId, setting_key: 'default_mail_account_id', setting_value: accounts[1] });
    for (const accountId of accounts) {
      const [mappings] = await db.execute('SELECT * FROM mail_folder_remote_boxes WHERE mail_account_id = ?', [accountId]);
      await insert('mail_folder_reconciliations', { mail_account_id: accountId, user_id: userId, inventory: JSON.stringify(['INBOX/Research', 'Archive/Copies']),
        previous_mappings: JSON.stringify(mappings), completed_at: '2030-01-01 11:00:00' });
    }
    await insert('mail_folder_recovery_items', { email_id: emails[0], user_id: userId, source_account_id: accounts[0], original_folder: 'old-research',
      original_filing_account_id: accounts[0], target_folder: 'research', target_account_id: accounts[1], action: 'manual', created_at: '2030-01-01 11:00:00' });
    const [[rule]] = await db.execute<import('mysql2/promise').RowDataPacket[]>('SELECT id FROM mail_sender_rules WHERE mail_account_id = ?', [accounts[0]]);
    await insert('mail_folder_rule_overrides', { rule_id: rule.id, mail_account_id: accounts[1], target_folder: 'research' });
    // An accepted provider change that never ran. A restore must keep it for
    // inspection but never send it to the provider again.
    await insert('mail_writebacks', { id: uuid(), user_id: userId, mail_account_id: accounts[0], email_id: emails[0], action: 'read',
      target_value: '1', base_value: '0', remote_folder: 'INBOX/Research', remote_uid: 22, remote_uidvalidity: 123 });

    const calendarAccountId = uuid(), calendarId = uuid(), eventId = uuid();
    const dav = `https://${peer.host}:${peer.davPort}/dav/`;
    await insert('calendar_accounts', { id: calendarAccountId, user_id: userId, provider: 'caldav', display_name: 'Fresh calendar', account_email: 'calendar@example.test',
      username: 'calendar-user', discovery_url: dav, base_url: dav, encrypted_password: encrypt(secrets.calendar), is_active: 1 });
    await insert('calendar_calendars', { id: calendarId, user_id: userId, account_id: calendarAccountId, name: 'Research Calendar', external_id: `${dav}calendar/`, color: '#2244ff', is_visible: 1 });
    await insert('calendar_events', { id: eventId, user_id: userId, calendar_id: calendarId, title: 'Remote weekly event', description: 'Preserve Grüße\nSecond line',
      start_time: '2030-02-03 10:00:00', end_time: '2030-02-03 11:00:00', recurrence: 'FREQ=WEEKLY;COUNT=3', reminders: JSON.stringify([10, 60]), reminder_minutes: 10, location: 'Vienna' });
    await insert('calendar_event_attendees', { id: uuid(), user_id: userId, event_id: eventId, email: 'attendee@example.test', display_name: 'Attendee', response_status: 'accepted' });
    await insert('calendar_event_external_refs', { id: uuid(), user_id: userId, event_id: eventId, calendar_id: calendarId, account_id: calendarAccountId,
      provider: 'caldav', external_event_id: 'event.ics', external_etag: 'etag-one' });

    const tagId = uuid(), secondRecording = uuid();
    await insert('recording_tags', { id: tagId, user_id: userId, name: 'Research', color: '#2244ff' });
    const audio = Buffer.alloc(76);
    audio.write('RIFF'); audio.writeUInt32LE(68, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(32, 40);
    for (let index = 0; index < 16; index++) audio.writeInt16LE(Math.round(Math.sin(index) * 1000), 44 + index * 2);
    await insert('recordings', { id: secondRecording, user_id: userId, title: 'Recorded on a phone', description: 'Keep original audio bytes', original_filename: 'tone.wav',
      content_type: 'audio/wav', size_bytes: audio.length, duration_seconds: 0.002, storage_path: store('recordings', `${secondRecording}.wav`, audio), source: 'recorded',
      category: 'none', recorded_at: '2030-01-01 10:00:00', metadata: JSON.stringify({ sampleRate: 8000 }) });
    for (const [index, id] of [recordingId, secondRecording].entries()) {
      await insert('recording_tag_links', { user_id: userId, recording_id: id, tag_id: tagId });
      await insert('recording_transcription_jobs', { id: uuid(), user_id: userId, recording_id: id, status: 'completed', provider: 'synthetic', model: 'test',
        language: 'de', transcript_text: `Saved Grüße transcript ${index}`, created_at: '2030-01-01 11:00:00', updated_at: '2030-01-01 11:01:00' });
    }
    // A failed transcription is not recovery data.
    await insert('recording_transcription_jobs', { id: uuid(), user_id: userId, recording_id: secondRecording, status: 'failed', provider: 'synthetic', model: 'test', error: 'synthetic failure' });
    console.log(JSON.stringify({ emails, accounts, calendarAccountId }));
  } finally { await db.end(); }
}
main().catch((error: Error) => { console.error(error.stack || error.message); process.exit(1); });
