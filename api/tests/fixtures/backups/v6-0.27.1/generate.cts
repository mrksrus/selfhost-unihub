import type { FixtureValue } from '../../../helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Maintenance only: pass an untouched `git archive v0.27.1 api package.json`
// extraction, built with its own `node scripts/build.cts`, as argument 1.
// Runs its real export job (encrypted, every section) on an empty disposable
// MariaDB test database; nothing of the current source is loaded.
const path = (require('node:path') as typeof import('node:path'));
const fs = (require('node:fs') as typeof import('node:fs'));
const os = (require('node:os') as typeof import('node:os'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const Module: FixtureValue = require('node:module');
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');

const KEYS = { ENCRYPTION_KEY: 'v6-fixture-encryption-key-not-a-secret', BACKUP_MASTER_KEY: 'v6-fixture-backup-master-key-not-a-secret', JWT_SECRET: 'v6-fixture-jwt-secret-not-used-anywhere-else' };
const id = (n: number) => `02710000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = id(1);
const sha = (bytes: FixtureValue) => crypto.createHash('sha256').update(bytes).digest('hex');

function wav() {
  const bytes = Buffer.alloc(76);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32, 40);
  for (let index = 0; index < 16; index++) bytes.writeInt16LE(Math.round(Math.sin(index) * 1000), 44 + index * 2);
  return bytes;
}

// The extraction's compiled modules with /app/uploads moved to a scratch root
// and the keys above (as tests/helpers/isolated-backup-runtime.cts does).
function extractionRuntime(distRoot: string, uploadsRoot: string) {
  const cache = new Map();
  function load(filename: string) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const loaded: FixtureValue = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    cache.set(filename, loaded);
    const parent = Module.createRequire(filename);
    loaded.require = (request: string) => { const resolved = parent.resolve(request); return resolved.startsWith(distRoot + path.sep) ? load(resolved) : parent(request); };
    loaded._compile(fs.readFileSync(filename, 'utf8').replaceAll("'/app/uploads", "'" + uploadsRoot), filename);
    if (filename === path.join(distRoot, 'config.js')) Object.assign(loaded.exports, KEYS, { TRUSTED_MAIL_HOSTS: [] });
    loaded.loaded = true;
    return loaded.exports;
  }
  return (relative: string) => load(path.join(distRoot, relative + '.js'));
}

(async () => {
  const source = path.resolve(process.argv[2], 'api');
  Object.assign(process.env, { NODE_ENV: 'test', ...KEYS, BOOTSTRAP_ADMIN_EMAIL: 'v6-bootstrap@example.test', BOOTSTRAP_ADMIN_PASSWORD: 'v6-bootstrap-password-not-a-secret' });
  assert.match(String(process.env.MYSQL_TEST_DATABASE), /_test$/);
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-v6-fixture-'));
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT), user: process.env.MYSQL_TEST_USER,
    password: process.env.MYSQL_TEST_PASSWORD, database: process.env.MYSQL_TEST_DATABASE, timezone: 'Z', connectionLimit: 6 });
  try {
    const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES');
    assert.equal(tables.length, 0, 'Fixture generator needs an empty test database');
    const runtime = extractionRuntime(path.join(source, 'dist/src'), uploads);
    runtime('state').setDb(pool);
    await runtime('services/database').ensureSchema();
    const { encrypt } = runtime('security/encryption');
    const insert = async (table: string, row: Record<string, unknown>) => {
      const columns = Object.keys(row);
      await pool.query(`INSERT INTO ${table} (${columns.map(name => '`' + name + '`').join(', ')}) VALUES (?)`, [Object.values(row)]);
    };
    const file = (relative: string, bytes: Buffer) => {
      const target = path.join(uploads, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      return target;
    };

    await insert('users', { id: USER, email: 'v6-fixture@example.test', password_hash: 'not-a-real-password-hash', full_name: 'Schema six fixture', timezone: 'Europe/Vienna' });
    await insert('contacts', { id: id(10), user_id: USER, first_name: 'Zoë', last_name: 'Example', uid: `urn:uuid:${id(10)}`, uid_hash: sha(`urn:uuid:${id(10)}`) });
    await insert('contact_values', { id: id(11), contact_id: id(10), user_id: USER, kind: 'email', position: 0, value: 'zoe@example.test', value_key: 'zoe@example.test' });

    // Local lists and tasks, one of them done with a subtask and a hand order.
    await insert('calendar_accounts', { id: id(20), user_id: USER, provider: 'local', display_name: 'UniHub', is_active: 1 });
    await insert('calendar_calendars', { id: id(21), user_id: USER, account_id: id(20), name: 'Errands', color: '#22c55e', is_primary: 1 });
    await insert('calendar_calendars', { id: id(22), user_id: USER, account_id: id(20), name: 'Work', color: '#2563eb' });
    await insert('calendar_events', { id: id(23), user_id: USER, calendar_id: id(21), title: 'Buy stamps', start_time: '2030-02-01 09:00:00', end_time: '2030-02-01 09:30:00', todo_status: 'done', done_at: '2030-02-01 10:00:00', created_at: '2030-01-20 08:00:00' });
    await insert('calendar_event_subtasks', { id: id(24), event_id: id(23), user_id: USER, title: 'Find the envelope', is_done: 1, position: 0 });
    await insert('calendar_events', { id: id(25), user_id: USER, calendar_id: id(21), title: 'Pay invoice', start_time: '2030-02-02 09:00:00', end_time: '2030-02-02 09:30:00', created_at: '2030-01-21 08:00:00' });
    await insert('calendar_events', { id: id(26), user_id: USER, calendar_id: id(22), title: 'Quarterly plan', start_time: '2030-02-03 09:00:00', end_time: '2030-02-03 10:00:00', created_at: '2030-01-22 08:00:00' });

    // A CalDAV account: a done task with two subtasks and a source email, an
    // open task and an event. Their server copies are not archived.
    await insert('calendar_accounts', { id: id(30), user_id: USER, provider: 'caldav', account_email: 'dav-user@example.test', display_name: 'Team DAV', username: 'dav-user', encrypted_password: encrypt('synthetic-dav-password'),
      base_url: 'https://dav.example.test/', discovery_url: 'https://dav.example.test/', provider_config: JSON.stringify({ server: 'https://dav.example.test/' }), is_active: 1, sync_status: 'idle' });
    await insert('calendar_calendars', { id: id(31), user_id: USER, account_id: id(30), name: 'Team', external_id: 'https://dav.example.test/dav/team/', color: '#a855f7' });
    const synced = [
      { event: id(32), title: 'Review draft', start: '2030-02-04 09:00:00', uid: 'review-draft@example.test', done: true },
      { event: id(33), title: 'Prepare slides', start: '2030-02-05 09:00:00', uid: 'prepare-slides@example.test', done: false },
      { event: id(34), title: 'Planning meeting', start: '2030-02-06 13:00:00', uid: 'planning@example.test', done: false },
    ];
    for (const [index, item] of synced.entries()) {
      const objectId = id(40 + index);
      const href = `/dav/team/${item.uid}.ics`;
      await insert('calendar_remote_objects', { id: objectId, user_id: USER, account_id: id(30), calendar_id: id(31), href, href_hash: sha(href), etag: `"etag-${index}"`, uid: item.uid,
        ics: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:${item.uid}\r\nSUMMARY:${item.title}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n` });
      await insert('calendar_events', { id: item.event, user_id: USER, calendar_id: id(31), title: item.title, start_time: item.start, end_time: item.start, created_at: '2030-01-23 08:00:00',
        ...(item.done ? { todo_status: 'done', done_at: '2030-02-04 11:00:00', source_email_json: JSON.stringify({ subject: 'Draft for review', from: 'colleague@example.test' }) } : {}) });
      await insert('calendar_event_external_refs', { id: id(45 + index), user_id: USER, event_id: item.event, calendar_id: id(31), account_id: id(30), provider: 'caldav',
        external_event_id: objectId, external_etag: `"etag-${index}"`, remote_object_id: objectId });
    }
    await insert('calendar_event_subtasks', { id: id(35), event_id: id(32), user_id: USER, title: 'Read section one', is_done: 1, position: 0 });
    await insert('calendar_event_subtasks', { id: id(36), event_id: id(32), user_id: USER, title: 'Write comments', is_done: 0, position: 1 });
    await insert('calendar_event_attendees', { id: id(37), user_id: USER, event_id: id(34), email: 'colleague@example.test', display_name: 'Colleague', response_status: 'accepted' });

    // A Sync-mode account: one message with its server copy (raw file,
    // attachment, provider evidence) and UniHub's own sent copy without one.
    // A Download-mode account that deletes mail at the provider.
    await insert('mail_accounts', { id: id(50), user_id: USER, email_address: 'sync@example.test', provider: 'custom', username: 'sync@example.test', imap_host: 'imap.example.test', smtp_host: 'smtp.example.test',
      encrypted_password: encrypt('synthetic-sync-password'), sync_mode: 'sync', sync_status: 'idle', is_active: 1, sync_policy_confirmed_at: '2030-01-01 00:00:00' });
    await insert('mail_accounts', { id: id(60), user_id: USER, email_address: 'download@example.test', provider: 'custom', username: 'download@example.test', imap_host: 'imap.example.test', smtp_host: 'smtp.example.test',
      encrypted_password: encrypt('synthetic-download-password'), sync_mode: 'download', sync_status: 'idle', is_active: 1, delete_emails_on_server: 1 });
    const message = (n: number, subject: string) => Buffer.from(`From: sender@example.test\r\nTo: someone@example.test\r\nMessage-ID: <v6-${n}@example.test>\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nGrüße ${n}\r\n`);
    const emails = [
      { id: id(51), account: id(50), subject: 'Synced message', folder: 'inbox', source: 'INBOX', uid: 7, linked: true },
      { id: id(52), account: id(50), subject: 'My own sent copy', folder: 'sent', source: null, uid: null, linked: false },
      { id: id(61), account: id(60), subject: 'Downloaded message', folder: 'inbox', source: 'INBOX', uid: 9, linked: false },
    ];
    for (const [index, email] of emails.entries()) {
      const raw = message(index, email.subject);
      const rawPath = file(`mail-raw/${USER}/${email.id}.eml`, raw);
      await insert('emails', { id: email.id, user_id: USER, mail_account_id: email.account, message_id: `<v6-${index}@example.test>`, subject: email.subject, from_address: 'sender@example.test',
        to_addresses: JSON.stringify(['someone@example.test']), body_text: `Grüße ${index}`, folder: email.folder, source_folder: email.source, imap_uid: email.uid, imap_uidvalidity: email.uid ? 1001 : null,
        remote_folder: email.linked ? 'INBOX' : null, remote_uid: email.linked ? email.uid : null, remote_uidvalidity: email.linked ? 1001 : null,
        raw_storage_path: rawPath, raw_sha256: sha(raw), received_at: '2030-02-07 12:00:00', has_attachments: index === 0 ? 1 : 0, import_complete: 1 });
    }
    const attachment = Buffer.from([0, 255, 17, 128, 10, 13, 0]);
    await insert('email_attachments', { id: id(53), email_id: id(51), user_id: USER, filename: 'notes.bin', content_type: 'application/octet-stream', size_bytes: attachment.length,
      storage_path: file(`attachments/${USER}/${id(53)}.bin`, attachment) });
    await insert('mail_remote_mailboxes', { id: id(54), user_id: USER, mail_account_id: id(50), remote_name: 'INBOX', delimiter: '/', uidvalidity: 1001, state: 'active' });
    await insert('mail_remote_occurrences', { id: id(55), user_id: USER, mail_account_id: id(50), mailbox_id: id(54), uidvalidity: 1001, uid: 7, email_id: id(51), presence: 'present', observed_at: '2030-02-07 12:00:00' });

    const recording = wav();
    await insert('recordings', { id: id(70), user_id: USER, title: 'Interview', original_filename: 'interview.wav', content_type: 'audio/wav', size_bytes: recording.length,
      storage_path: file(`recordings/${USER}/${id(70)}.wav`, recording), recorded_at: '2030-02-08 10:00:00' });

    const jobs = runtime('services/export-jobs');
    const job = await jobs.startDataExportJob(USER, { sections: 'full', encrypt: true });
    await jobs.runDataExportJob(job.id);
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT j.status, j.error, j.file_path, j.backup_uuid, k.recovery_password_ciphertext FROM data_export_jobs j JOIN backup_archive_keys k ON k.export_job_id = j.id WHERE j.id = ?', [job.id]);
    assert.equal(row.status, 'ready', row.error);
    const password = runtime('services/backup-container').revealProtectedRecoveryPassword(row.recovery_password_ciphertext, row.backup_uuid);
    const output = path.join(__dirname, 'full.unihub-backup');
    fs.copyFileSync(row.file_path, output);
    const hashes: Record<string, string> = {};
    for (const name of ['services/backup-export.ts', 'services/backup-format.ts', 'services/export-jobs.ts', 'services/backup-catalog.ts', 'services/backup-container.ts']) hashes[name] = sha(fs.readFileSync(path.join(source, 'src', name)));
    fs.writeFileSync(path.join(__dirname, 'expected.json'), JSON.stringify({ tag: 'v0.27.1', commit: 'ba80ca202adb250cb3ea4e50c6f0a44b17a798ac', version: 6, sha256: sha(fs.readFileSync(output)),
      // Synthetic: the archive's own recovery password, needed to read it.
      recovery_password: password, source_sha256: hashes, user: USER,
      rows: { contacts: 1, calendar_events: 6, local_events: 3, synced_events: 3, synced_done: 1, emails: 3, sync_linked_emails: 1, sync_local_emails: 1, download_emails: 1, recordings: 1 } }, null, 2) + '\n');
    console.log(output);
  } finally {
    await pool.end();
    fs.rmSync(uploads, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
