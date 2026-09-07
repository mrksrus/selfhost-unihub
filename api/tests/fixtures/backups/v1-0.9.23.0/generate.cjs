#!/usr/bin/env node
'use strict';

// Explicit maintenance operation. Normal tests consume the frozen artifacts.
// All contents and credentials below are invented test data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const TAG = 'v0.9.23.0';
const COMMIT = 'e8813669c75ada5bad870d0f9c380083934ed291';
const SOURCE_FILES = [
  'api/src/security/encryption.js',
  'api/src/services/backup-container.js',
  'api/src/services/backup.js',
  'api/src/services/export-jobs.js',
];
const SOURCE_KEY = 'synthetic-legacy-0.9.23-encryption-key-not-a-secret';
const MASTER_KEY = 'synthetic-legacy-0.9.23-backup-master-not-a-secret';
const RECOVERY_PASSWORD = 'Synthetic-0.9.23-Fixture-Recovery-Only-2026';
const DATA_KEY = Buffer.from('0923092309230923092309230923092309230923092309230923092309230923', 'hex');
const timestamp = '2026-01-02T12:34:56.000Z';
const id = number => '09230000-0000-4000-8000-' + number.toString(16).padStart(12, '0');
const userId = id(1);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function makeWav() {
  const bytes = Buffer.alloc(76);
  bytes.write('RIFF'); bytes.writeUInt32LE(68, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(32, 40);
  for (let index = 0; index < 16; index++) bytes.writeInt16LE(Math.round(Math.sin(index) * 1000), 44 + 2 * index);
  return bytes;
}

async function main() {
  assert.ok(process.argv.includes('--write'), 'Use --write only to deliberately regenerate the frozen fixtures.');
  const repository = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dirname, encoding: 'utf8' }).trim();
  const tagCommit = execFileSync('git', ['rev-parse', TAG + '^{commit}'], { cwd: repository, encoding: 'utf8' }).trim();
  assert.equal(tagCommit, COMMIT, 'Historical tag must resolve to the documented immutable commit.');
  const sources = new Map(SOURCE_FILES.map(filename => [filename, execFileSync('git', ['show', COMMIT + ':' + filename], { cwd: repository, encoding: 'utf8' })]));
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unihub-legacy-fixture-'));
  const sourceUploads = path.join(temporary, 'uploads');
  const files = [];
  const tables = {};
  const loaded = new Map();

  // Preserve historical paths in the serialized rows. Only filesystem calls
  // are redirected; no historical source text or archive bytes are rewritten.
  function remap(value) {
    if (typeof value !== 'string') return value;
    if (value === '/app/uploads' || value.startsWith('/app/uploads/')) {
      const relative = path.relative('/app/uploads', value);
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
      return path.join(sourceUploads, relative);
    }
    return value;
  }
  function filesystemAdapter(target) {
    return new Proxy(target, {
      get(object, property) {
        if (property === 'promises') return filesystemAdapter(fs.promises);
        const value = Reflect.get(object, property);
        return typeof value === 'function' ? (...args) => value.apply(object, args.map(remap)) : value;
      },
    });
  }
  const virtualFs = filesystemAdapter(fs);
  const database = {
    async execute(sql, parameters) {
      assert.match(sql, /^SELECT /);
      assert.deepEqual(parameters, [userId]);
      const table = /FROM ([a-z_]+) WHERE user_id = \?|FROM (users) WHERE id = \?/.exec(sql);
      assert.ok(table, 'Only the old exporter SELECTs may run: ' + sql);
      const name = table[1] || table[2];
      assert.ok(Object.hasOwn(tables, name), 'Unexpected source table: ' + name);
      return [structuredClone(tables[name])];
    },
  };
  function load(filename) {
    if (loaded.has(filename)) return loaded.get(filename).exports;
    assert.ok(sources.has(filename), 'Unapproved historical dependency: ' + filename);
    const instance = new Module(path.join(repository, filename), module);
    loaded.set(filename, instance);
    instance.require = request => {
      if (request === 'fs') return virtualFs;
      if (request === 'os') return { ...os, tmpdir: () => temporary };
      if (request === '../config') return { ENCRYPTION_KEY: SOURCE_KEY, BACKUP_MASTER_KEY: MASTER_KEY };
      if (request === '../state') return { db: database };
      if (request === './mail') return { MAIL_RAW_STORAGE_ROOT: '/app/uploads/mail-raw', DEFAULT_MAIL_SYNC_FETCH_LIMIT: 'all', normalizeSyncFetchLimit: value => value || 'all' };
      if (request === './recordings') return { RECORDINGS_ROOT: '/app/uploads/recordings' };
      if (request === './backup-archive-keys') return { pruneArchiveKeyIfUnreferenced() { throw new Error('Fixture generation must not run background jobs.'); } };
      if (request.startsWith('.')) return load(path.posix.normalize(path.posix.join(path.posix.dirname(filename), request + '.js')));
      assert.ok(Module.builtinModules.includes(request), 'No installed package or network dependency may load: ' + request);
      return require(request);
    };
    instance._compile(sources.get(filename), instance.id);
    instance.loaded = true;
    return instance.exports;
  }
  async function addFile(kind, recordId, filename, bytes) {
    const directory = kind === 'raw_email' ? 'mail-raw' : kind === 'recording' ? 'recordings' : 'attachments';
    const storagePath = '/app/uploads/' + directory + '/' + userId + '/' + filename;
    await fs.promises.mkdir(path.dirname(remap(storagePath)), { recursive: true });
    await fs.promises.writeFile(remap(storagePath), bytes);
    files.push({ kind, id: recordId, filename, sha256: sha256(bytes), size_bytes: bytes.length, bytes_base64: bytes.toString('base64') });
    return storagePath;
  }

  try {
    const encryption = load('api/src/security/encryption.js');
    const backup = load('api/src/services/backup.js');
    const container = load('api/src/services/backup-container.js');
    const { writeZip } = load('api/src/services/export-jobs.js');
    const row = fields => ({ user_id: userId, created_at: timestamp, updated_at: timestamp, ...fields });
    const credentials = { mail_accounts: [], calendar_accounts: [] };
    tables.users = [{ id: userId, email: 'legacy-owner@example.test', full_name: 'Legacy Grüße Owner', avatar_url: null, role: 'user', is_active: 1, email_verified: 1, timezone: 'Europe/Vienna', created_at: timestamp, updated_at: timestamp }];
    tables.user_settings = [row({ setting_key: 'calendar_preferences', setting_value: JSON.stringify({ firstDay: 1, custom: 'Grüße\nTwo lines' }) })];
    tables.contacts = [row({ id: id(2), first_name: 'Zoë', last_name: 'Legacy', email: 'zoe@example.test', email2: 'zoe-second@example.test', phone: '+43 12345', notes: 'Original Unicode Grüße\nSecond line', is_favorite: 1 })];
    tables.mail_folders = [row({ id: id(3), slug: 'research', display_name: 'Research & Notes', position: 7, is_system: 0 })];
    tables.mail_accounts = []; tables.emails = []; tables.email_attachments = []; tables.mail_sender_rules = []; tables.mail_email_scores = [];
    for (let index = 0; index < 2; index++) {
      const accountId = id(4 + index), emailId = id(6 + index), attachmentId = id(8 + index);
      const address = 'legacy-mail-' + index + '@example.test';
      const password = 'synthetic-legacy-mail-password-' + index;
      credentials.mail_accounts.push({ id: accountId, email_address: address, password });
      tables.mail_accounts.push(row({ id: accountId, email_address: address, display_name: 'Legacy account ' + index, provider: 'custom', username: address, imap_host: '8.8.8.8', imap_port: 993, smtp_host: '9.9.9.9', smtp_port: 587, encrypted_password: encryption.encrypt(password), sync_fetch_limit: 'all', is_active: 1, delete_emails_on_server: 1 }));
      const attachment = index === 0
        ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY4kAAAAASUVORK5CYII=', 'base64')
        : Buffer.from([0, 255, 17, 128, 1, 10, 13, 0]);
      const filename = index === 0 ? 'legacy-inline.png' : 'legacy-data.bin';
      const contentType = index === 0 ? 'image/png' : 'application/octet-stream';
      const attachmentPath = await addFile('email_attachment', attachmentId, filename, attachment);
      const bodyHtml = index === 0
        ? '<p>Legacy inline Grüße</p><img src="/api/mail/attachments/' + attachmentId + '"><img src="cid:legacy-inline@example.test">'
        : '<p>Legacy second account Grüße</p>';
      const raw = Buffer.from([
        'From: sender@example.test', 'To: ' + address, 'Message-ID: <legacy-' + index + '@example.test>',
        'Subject: Legacy message ' + index, 'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary="legacy-fixture"', '',
        '--legacy-fixture', 'Content-Type: text/html; charset=utf-8', '', bodyHtml, '',
        '--legacy-fixture', 'Content-Type: ' + contentType, 'Content-ID: <legacy-inline@example.test>',
        'Content-Disposition: ' + (index === 0 ? 'inline' : 'attachment') + '; filename="' + filename + '"',
        'Content-Transfer-Encoding: base64', '', attachment.toString('base64'), '--legacy-fixture--', '',
      ].join('\r\n'));
      const rawPath = await addFile('raw_email', emailId, 'legacy-message-' + index + '.eml', raw);
      tables.emails.push(row({ id: emailId, mail_account_id: accountId, message_id: '<legacy-' + index + '@example.test>', subject: 'Legacy message ' + index, from_address: 'sender@example.test', to_addresses: JSON.stringify([address]), body_text: 'Legacy body Grüße ' + index, body_html: bodyHtml, folder: 'research', source_folder: 'INBOX/Research', imap_uid: 22 + index, imap_uidvalidity: 123, raw_storage_path: rawPath, raw_sha256: sha256(raw), received_at: timestamp, is_starred: 1, has_attachments: 1 }));
      tables.email_attachments.push(row({ id: attachmentId, email_id: emailId, filename, content_type: contentType, size_bytes: attachment.length, storage_path: attachmentPath, content_id: 'legacy-inline@example.test' }));
      tables.mail_sender_rules.push(row({ id: id(10 + index), mail_account_id: accountId, match_type: 'address', match_value: 'sender@example.test', target_folder: 'research' }));
      tables.mail_email_scores.push(row({ id: id(12 + index), email_id: emailId, score_version: 'v1', total_score: 12.5, reasons: JSON.stringify(['legacy synthetic reason']), metadata: JSON.stringify({ fixture: true }), scored_at: timestamp }));
    }
    credentials.calendar_accounts.push({ id: id(14), password: 'synthetic-legacy-calendar-password', access_token: 'synthetic-legacy-access-token', refresh_token: 'synthetic-legacy-refresh-token' });
    tables.calendar_accounts = [row({ id: id(14), provider: 'caldav', display_name: 'Legacy Calendar Account', account_email: 'legacy-calendar@example.test', username: 'legacy-calendar', discovery_url: 'https://8.8.8.8/dav/', base_url: 'https://8.8.8.8/dav/', encrypted_password: encryption.encrypt(credentials.calendar_accounts[0].password), encrypted_access_token: encryption.encrypt(credentials.calendar_accounts[0].access_token), encrypted_refresh_token: encryption.encrypt(credentials.calendar_accounts[0].refresh_token), is_active: 1 })];
    tables.calendar_calendars = [row({ id: id(15), account_id: id(14), name: 'Legacy Research', external_id: 'https://8.8.8.8/dav/legacy/', color: '#2244ff', is_visible: 1 })];
    tables.calendar_events = [row({ id: id(16), calendar_id: id(15), title: 'Legacy event Grüße', description: 'Original notes\nSecond line', start_time: '2030-02-03T10:00:00.000Z', end_time: '2030-02-03T11:00:00.000Z', recurrence: 'FREQ=WEEKLY;COUNT=3', reminders: JSON.stringify([10, 60]), reminder_minutes: 10, todo_status: 'todo', location: 'Vienna' })];
    tables.calendar_event_subtasks = [row({ id: id(17), event_id: id(16), title: 'Legacy completed subtask', is_done: 1, position: 2 })];
    tables.calendar_event_attendees = [row({ id: id(18), event_id: id(16), email: 'legacy-attendee@example.test', display_name: 'Legacy Attendee', response_status: 'accepted' })];
    tables.calendar_event_external_refs = [row({ id: id(19), event_id: id(16), calendar_id: id(15), account_id: id(14), provider: 'caldav', external_event_id: 'legacy-event.ics', external_etag: 'legacy-etag' })];
    const audio = makeWav();
    const audioPath = await addFile('recording', id(20), 'legacy-tone.wav', audio);
    tables.recordings = [row({ id: id(20), title: 'Legacy synthetic PCM', description: 'Preserve exact original bytes', original_filename: 'legacy-tone.wav', content_type: 'audio/wav', size_bytes: audio.length, duration_seconds: 0.002, storage_path: audioPath, source: 'recorded', category: 'none', recorded_at: timestamp, metadata: JSON.stringify({ sampleRate: 8000 }) })];
    tables.recording_tags = [row({ id: id(21), name: 'Legacy Research', color: '#2244ff' })];
    tables.recording_tag_links = [row({ recording_id: id(20), tag_id: id(21) })];
    // These timestamp columns do not exist in the historical table schemas.
    delete tables.user_settings[0].created_at;
    for (const name of ['emails', 'email_attachments', 'recording_tag_links']) {
      for (const item of tables[name]) delete item.updated_at;
    }

    const plainPath = path.join(__dirname, 'plain.zip');
    const encryptedPath = path.join(__dirname, 'encrypted.unihub-backup');
    const portablePath = path.join(temporary, 'portable.zip');
    await fs.promises.rm(plainPath, { force: true });
    await fs.promises.rm(encryptedPath, { force: true });
    await writeZip(await backup.buildBackupArchiveEntriesForUser(userId, 'full'), plainPath);
    await writeZip(await backup.buildBackupArchiveEntriesForUser(userId, 'full', { portableCredentialKey: DATA_KEY }), portablePath);
    await container.encryptBackupFile(portablePath, encryptedPath, {
      backupUuid: id(22), dataKey: DATA_KEY, recoveryPassword: RECOVERY_PASSWORD,
    });
    const plain = backup.backupFromZipBuffer(await fs.promises.readFile(plainPath));
    const portable = backup.backupFromZipBuffer(await fs.promises.readFile(portablePath));
    assert.equal(plain.manifest.version, 1); assert.equal(plain.manifest.format_version, 1);
    assert.equal(plain.backup.portable_credentials, null);
    assert.equal(plain.manifest.missing_files.length, 0); assert.equal(plain.manifest.file_count, 5);
    assert.ok(portable.backup.portable_credentials);
    const unlocked = await container.unlockContainerWithPassword(encryptedPath, RECOVERY_PASSWORD);
    assert.deepEqual(unlocked.dataKey, DATA_KEY);
    const decryptedPath = path.join(temporary, 'verified.zip');
    await container.decryptBackupFile(encryptedPath, decryptedPath, DATA_KEY);
    assert.equal(sha256(await fs.promises.readFile(decryptedPath)), sha256(await fs.promises.readFile(portablePath)));
    const archives = {};
    for (const [name, filePath] of [['plain', plainPath], ['encrypted', encryptedPath]]) {
      const bytes = await fs.promises.readFile(filePath);
      archives[name] = { filename: path.basename(filePath), sha256: sha256(bytes), size_bytes: bytes.length };
    }
    const expected = {
      fixture_schema_version: 1,
      provenance: { tag: TAG, commit: COMMIT, source_sha256: Object.fromEntries([...sources].map(([name, source]) => [name, sha256(source)])), generator_sha256: sha256(await fs.promises.readFile(__filename)), generated_at: new Date().toISOString(), node: process.version },
      source_user_id: userId, source_encryption_key: SOURCE_KEY, source_backup_master_key: MASTER_KEY,
      recovery_password: RECOVERY_PASSWORD, data_key_hex: DATA_KEY.toString('hex'),
      container_version: 1, format_version: 1, row_counts: plain.manifest.row_counts,
      data: plain.backup.data, credentials, files, archives,
    };
    await fs.promises.writeFile(path.join(__dirname, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ provenance: expected.provenance, row_counts: expected.row_counts, files: files.length, archives }, null, 2) + '\n');
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
