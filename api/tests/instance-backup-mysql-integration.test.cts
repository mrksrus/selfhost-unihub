import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test,
// and the MariaDB client tools (mariadb-dump, mariadb): on PATH, in
// UNIHUB_MARIADB_BIN_DIR, or in scripts/local-db.sh's tarball.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const { spawnSync } = require('node:child_process') as typeof import('node:child_process');

// The stored-file roots are read when the services load: point them at a
// scratch tree first (made by the test, so a skipped run leaves nothing).
// The dump connects like the app, through MYSQL_*.
const scratch = path.join(os.tmpdir(), `unihub-instance-backup-${crypto.randomUUID()}`);
const uploads = path.join(scratch, 'uploads');
const rootDirs = {
  attachments: path.join(uploads, 'attachments'), 'mail-raw': path.join(uploads, 'mail-raw'), recordings: path.join(uploads, 'recordings'),
  'contact-photos': path.join(uploads, 'contact-photos'), backups: path.join(uploads, 'backups'),
};
Object.assign(process.env, {
  MAIL_ATTACHMENT_UPLOAD_ROOT: rootDirs.attachments, MAIL_RAW_STORAGE_ROOT: rootDirs['mail-raw'], RECORDINGS_ROOT: rootDirs.recordings,
  CONTACT_PHOTOS_ROOT: rootDirs['contact-photos'], BACKUP_ARCHIVES_ROOT: rootDirs.backups, UPLOAD_SPOOL_ROOT: path.join(uploads, 'spool'),
  CONTACT_IMPORTS_ROOT: path.join(uploads, 'contacts', 'imports'),
});
if (process.env.MYSQL_TEST_HOST) {
  Object.assign(process.env, { MYSQL_HOST: process.env.MYSQL_TEST_HOST, MYSQL_PORT: process.env.MYSQL_TEST_PORT || '3306',
    MYSQL_DATABASE: process.env.MYSQL_TEST_DATABASE, MYSQL_USER: process.env.MYSQL_TEST_USER, MYSQL_PASSWORD: process.env.MYSQL_TEST_PASSWORD });
}
if (!process.env.UNIHUB_MARIADB_BIN_DIR && spawnSync('mariadb-dump', ['--version']).status !== 0) {
  const tarball = path.join(process.env.UNIHUB_DB_HOME || path.join(os.homedir(), '.local/opt/mariadb-11.8'), 'bin');
  if (fs.existsSync(path.join(tarball, 'mariadb-dump'))) process.env.UNIHUB_MARIADB_BIN_DIR = tarball;
}
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file: string, content: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };

test('the instance backup copies the installation, keeps only verified runs, refuses changed files and restores into an empty installation', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  fs.mkdirSync(scratch, { mode: 0o700 });
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const backup = require('../dist/src/services/instance-backup') as typeof import('../src/services/instance-backup');
  const format = require('../dist/src/services/instance-backup-format') as typeof import('../src/services/instance-backup-format');
  const { restoreInstanceBackup } = require('../dist/src/services/instance-restore') as typeof import('../src/services/instance-restore');
  const { getDatabaseConfig } = require('../dist/src/services/database-config') as typeof import('../src/services/database-config');
  const { main: restoreCommand } = require('../dist/src/instance-restore') as typeof import('../src/instance-restore');

  const destination = path.join(scratch, 'destination');
  fs.mkdirSync(destination);
  const key = crypto.randomBytes(32);
  const keyFile = write(path.join(scratch, 'keys', 'instance.key'), `${key.toString('base64')}\n`);
  const settings = { dir: destination, key, timeUtc: '03:30', keep: 2, missing: [] as ('destination' | 'key')[], errors: [] as string[] };

  // Three people: the admin, alex with data and files, blair.
  const password = 'synthetic-instance-backup-password';
  const passwordHash = await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4);
  const users: Record<string, string> = {};
  for (const [name, role] of [['admin', 'admin'], ['alex', 'user'], ['blair', 'user']] as const) {
    users[name] = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)', [users[name], `${name}@example.test`, passwordHash, name, role]);
  }
  async function signIn(name: string) {
    const client = api.client();
    const reply = await client.request('POST', '/api/auth/signin', { email: `${name}@example.test`, password });
    assert.equal(reply.status, 200, String(reply.body.error));
    return client;
  }
  const admin = await signIn('admin'), alex = await signIn('alex');
  const contact = await alex.request('POST', '/api/contacts', { name: { given: 'Casey' }, emails: ['casey@example.test'] });
  assert.ok([200, 201].includes(contact.status), JSON.stringify(contact.body));
  // A contact photo through the real routes: its files are named by content and released after a commit.
  const sharp = require('sharp') as typeof import('sharp').default;
  const portrait = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#2050c0' } }).jpeg().toBuffer();
  const contactId = String((contact.body.contact as FixtureValue).id);
  const photoReply = await alex.request('PUT', `/api/contacts/${contactId}/photo`, portrait, { 'content-type': 'image/jpeg' });
  assert.equal(photoReply.status, 200, JSON.stringify(photoReply.body));
  const [[photoRow]] = await pool.query<RowDataPacket[]>('SELECT sha256, thumb_sha256 FROM contact_photos WHERE user_id = ?', [users.alex]);
  const photoFiles = [photoRow.sha256, photoRow.thumb_sha256].map(hash => path.join(rootDirs['contact-photos'], users.alex, `${hash}.jpg`));
  assert.ok(photoFiles.every(file => fs.existsSync(file)));

  // Provider work the installation had accepted: a move into Trash queued and
  // current with its engine job, provider deletion on with a deletion queued,
  // a scheduled send and one in progress, a calendar move half done.
  const mailAccount = crypto.randomUUID(), movedEmail = crypto.randomUUID(), move = crypto.randomUUID();
  await pool.execute(`INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active, delete_emails_on_server, sync_policy_confirmed_at)
    VALUES (?, ?, 'alex@example.test', 'custom', 'download', TRUE, TRUE, UTC_TIMESTAMP())`, [mailAccount, users.alex]);
  await pool.execute(`INSERT INTO emails (id, user_id, mail_account_id, from_address, to_addresses, folder, remote_folder, remote_uid, remote_uidvalidity)
    VALUES (?, ?, ?, 'casey@example.test', '[]', 'inbox', 'INBOX', 7, 1)`, [movedEmail, users.alex, mailAccount]);
  await pool.execute(`INSERT INTO mail_writebacks (id, user_id, mail_account_id, email_id, action, target_value, base_value, target_folder, remote_folder,
      remote_uid, remote_uidvalidity, status, state, is_current, available_at)
    VALUES (?, ?, ?, ?, 'move', 'trash', 'inbox', 'trash', 'INBOX', 7, 1, 'pending', 'queued', TRUE, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 SECOND))`,
  [move, users.alex, mailAccount, movedEmail]);
  const engine = require('../dist/src/services/mail-engine/runtime') as typeof import('../src/services/mail-engine/runtime');
  await engine.enqueueJob({ userId: users.alex, accountId: mailAccount, operationId: move, kind: 'operation', priority: 0 }, pool);
  await pool.execute(`INSERT INTO mail_server_messages (user_id, mail_account_id, email_id, source_folder, imap_uid, imap_uidvalidity, delete_status)
    VALUES (?, ?, ?, 'INBOX', 7, 1, 'pending')`, [users.alex, mailAccount, movedEmail]);
  const sends: Record<string, string> = {};
  for (const status of ['scheduled', 'sending']) {
    const draft = crypto.randomUUID();
    sends[status] = draft;
    await pool.execute(`INSERT INTO emails (id, user_id, mail_account_id, from_address, to_addresses, folder, is_draft)
      VALUES (?, ?, ?, 'alex@example.test', '["casey@example.test"]', 'drafts', TRUE)`, [draft, users.alex, mailAccount]);
    await pool.execute(`INSERT INTO mail_scheduled_sends (id, user_id, email_id, mail_account_id, send_at, status, client_key)
      VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), ?, ?)`, [crypto.randomUUID(), users.alex, draft, mailAccount, status, `synthetic-${status}-${draft}`]);
  }
  await pool.execute(`INSERT INTO calendar_event_moves (id, user_id, target_uid, state, next_attempt_at) VALUES (?, ?, 'synthetic-move@example.test', 'removing', UTC_TIMESTAMP())`,
    [crypto.randomUUID(), users.alex]);

  const recordingPath = write(path.join(rootDirs.recordings, users.alex, 'memo.webm'), crypto.randomBytes(300_000));
  await pool.execute("INSERT INTO recordings (id, user_id, title, content_type, storage_path) VALUES (?, ?, 'Synthetic memo', 'audio/webm', ?)", [crypto.randomUUID(), users.alex, recordingPath]);
  const uuid = () => crypto.randomUUID();
  const included = [
    recordingPath,
    ...photoFiles,
    // Stored names keep what a person called the file: none of these is work in progress.
    write(path.join(rootDirs.attachments, users.alex, `${uuid()}-${uuid()}-report.tmp`), 'an attachment named report.tmp'),
    write(path.join(rootDirs.attachments, users.alex, `${uuid()}-${uuid()}-draft.partial`), 'an attachment named draft.partial'),
    write(path.join(rootDirs.attachments, users.alex, `${uuid()}-${uuid()}-notes.tmp.txt`), 'an attachment named notes.tmp.txt'),
    // What a finished account restore wrote stays in its restores directory.
    write(path.join(rootDirs['mail-raw'], users.alex, 'restores', uuid(), `${uuid()}-restored.eml`), 'Subject: Restored\r\n\r\n'),
    write(path.join(rootDirs['mail-raw'], users.alex, 'message-1.eml'), 'From: casey@example.test\r\nSubject: Synthetic\r\n\r\nHello\r\n'),
    write(path.join(rootDirs.attachments, users.alex, 'a'.repeat(150) + '-attachment.bin'), crypto.randomBytes(5000)),
    write(path.join(rootDirs['contact-photos'], users.alex, `${'c'.repeat(64)}.jpg`), crypto.randomBytes(2000)),
    write(path.join(rootDirs.backups, users.alex, `${crypto.randomUUID()}.unihub-backup`), crypto.randomBytes(70_000)),
    write(path.join(rootDirs['mail-raw'], users.blair, 'leaves-during-copy.eml'), 'Subject: Removed after the dump\r\n\r\n'),
  ];
  const removedDuringCopy = included[included.length - 1];
  // Work in progress, by the names the app's writers give it.
  const leftOut = [
    write(path.join(rootDirs.backups, 'imports', users.alex, 'upload.bin'), 'staged upload'),
    write(path.join(rootDirs.backups, 'restores', users.alex, `${uuid()}.unihub-backup`), 'uploaded restore archive'),
    write(path.join(rootDirs.backups, 'restores', 'work', uuid(), 'manifest.json'), '{}'),
    write(path.join(rootDirs.backups, users.alex, `${uuid()}.zip.partial`), 'partial export'),
    write(path.join(rootDirs.recordings, '.tmp', users.alex, `${uuid()}.part`), 'chunk'),
    write(path.join(rootDirs.recordings, users.alex, `memo.mp3.${uuid()}.tmp.mp3`), 'conversion in progress'),
    write(path.join(rootDirs['mail-raw'], users.alex, `${uuid()}-${uuid()}.eml.part`), 'raw message being written'),
    write(path.join(rootDirs['contact-photos'], users.alex, `.${'d'.repeat(64)}.jpg.${uuid()}.tmp`), 'photo being written'),
  ];
  // Deployment secrets misplaced among the stored files: a Compose .env and a
  // configured secret file reached through a hard link.
  const deploymentSecret = write(path.join(scratch, 'secrets', 'jwt'), 'synthetic-deployment-secret');
  process.env.UNIHUB_SYNTHETIC_SECRET_FILE = deploymentSecret;
  t.after(() => { delete process.env.UNIHUB_SYNTHETIC_SECRET_FILE; });
  leftOut.push(write(path.join(rootDirs.backups, '.env'), 'UNIHUB_JWT_SECRET=synthetic-env-value\n'));
  const linkedSecret = path.join(rootDirs.attachments, users.alex, 'linked-secret');
  fs.linkSync(deploymentSecret, linkedSecret);
  leftOut.push(linkedSecret);
  const hashes = new Map(included.map(file => [file, sha(file)]));

  await t.test('admin-only routes, off without a configuration', async () => {
    assert.equal((await alex.request('GET', '/api/admin/instance-backup')).status, 403);
    assert.equal((await alex.request('POST', '/api/admin/instance-backup/run', {})).status, 403);
    assert.equal((await api.client().request('GET', '/api/admin/instance-backup')).status, 401);
    backup.useInstanceBackupConfig({ ...settings, dir: null, key: null, missing: ['destination', 'key'] });
    const off = await admin.request('GET', '/api/admin/instance-backup');
    assert.equal(off.status, 200);
    assert.deepEqual([off.body.enabled, off.body.missing, off.body.destination, off.body.key_fingerprint], [false, ['destination', 'key'], null, null]);
    const refused = await admin.request('POST', '/api/admin/instance-backup/run', {});
    assert.deepEqual([refused.status, refused.body.code], [409, 'INSTANCE_BACKUP_OFF']);
    backup.useInstanceBackupConfig({ ...settings, key: null, missing: ['key'] });
    const keyless = await admin.request('GET', '/api/admin/instance-backup');
    assert.deepEqual([keyless.body.enabled, keyless.body.missing, keyless.body.destination], [false, ['key'], destination]);
    backup.useInstanceBackupConfig(settings);
  });

  await t.test('startup refuses a secret file among the stored files, also through a link or an aliased path', () => {
    const inBackups = write(path.join(rootDirs.backups, users.alex, 'instance.key'), key.toString('base64'));
    const viaLink = path.join(scratch, 'keys', 'alias.key');
    fs.symlinkSync(inBackups, viaLink);
    const aliasedUploads = path.join(scratch, 'uploads-alias');
    fs.symlinkSync(uploads, aliasedUploads);
    try {
      for (const file of [inBackups, viaLink, path.join(aliasedUploads, 'backups', users.alex, 'instance.key')]) {
        assert.match(backup.instanceBackupSetupErrors(settings, { INSTANCE_BACKUP_KEY_FILE: file }).join('\n'), /INSTANCE_BACKUP_KEY_FILE .* is inside the stored files/, file);
      }
      assert.match(backup.instanceBackupSetupErrors(settings, { ENCRYPTION_KEY_FILE: inBackups }).join('\n'), /ENCRYPTION_KEY_FILE/);
      assert.match(backup.instanceBackupSetupErrors({ ...settings, dir: path.join(aliasedUploads, 'attachments') }, {}).join('\n'), /INSTANCE_BACKUP_DIR must be its own volume/);
      assert.deepEqual(backup.instanceBackupSetupErrors(settings, { INSTANCE_BACKUP_KEY_FILE: keyFile }), []);
    } finally {
      for (const file of [inBackups, viaLink, aliasedUploads]) fs.rmSync(file, { force: true });
    }
  });

  await t.test('a failed run removes its partial file and is never counted', async () => {
    const previous = process.env.UNIHUB_MARIADB_BIN_DIR;
    process.env.UNIHUB_MARIADB_BIN_DIR = path.join(scratch, 'no-client-here');
    try {
      const run = await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin });
      assert.equal(run!.status, 'failed');
      assert.match(String(run!.error), /mariadb-dump was not found/);
      assert.equal(run!.file_name, null);
    } finally {
      if (previous === undefined) delete process.env.UNIHUB_MARIADB_BIN_DIR; else process.env.UNIHUB_MARIADB_BIN_DIR = previous;
    }
    assert.deepEqual(fs.readdirSync(destination), []);
    const status = await admin.request('GET', '/api/admin/instance-backup');
    assert.deepEqual([status.body.kept, status.body.last_success, (status.body.last_run as FixtureValue).status], [{ count: 0, bytes: 0 }, null, 'failed']);
  });

  let first: { file: string; manifest: import('../src/services/instance-backup-format').InstanceBackupManifest };
  await t.test('a run: dump and files, removals after the dump wait at the gate, verified before it counts', async () => {
    await new Promise(resolve => setTimeout(resolve, 1100));
    let removal: unknown;
    const run = await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin, hooks: { afterDump: async () => {
      // blair's message row went after the dump: the file must stay until the copy has ended.
      removal = await backup.fileRemovalGate.run(() => fs.promises.rm(removedDuringCopy));
      assert.equal(removal, 'deferred');
      assert.ok(fs.existsSync(removedDuringCopy));
      // alex removes the contact photo after the dump: the dump still has its row, so its files stay for the copy.
      assert.equal((await alex.request('DELETE', `/api/contacts/${contactId}/photo`)).status, 200);
      assert.equal(Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM contact_photos WHERE user_id = ?', [users.alex]))[0][0].count), 0);
      assert.ok(photoFiles.every(file => fs.existsSync(file)), 'photo files wait at the gate');
    } } });
    assert.equal(run!.status, 'succeeded', String(run!.error));
    assert.equal(removal, 'deferred');
    assert.equal(fs.existsSync(removedDuringCopy), false, 'the queued removal ran once the copy ended');
    assert.ok(photoFiles.every(file => !fs.existsSync(file)), 'the queued photo release checked the references again and removed them');
    assert.match(run!.file_name!, /^unihub-instance-\d{8}T\d{6}Z-[0-9.]+\.uhib$/);
    assert.deepEqual(fs.readdirSync(destination), [run!.file_name]);
    const file = path.join(destination, run!.file_name!);
    assert.equal(sha(file), run!.sha256);
    assert.equal(Number(run!.size_bytes), fs.statSync(file).size);
    assert.equal(run!.key_fingerprint, format.keyFingerprint(key));
    // Nothing readable in the file: the dump's own words and a file's bytes stay encrypted.
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.includes('CREATE TABLE'), false);
    assert.equal(bytes.includes('casey@example.test'), false);
    const header = await format.readInstanceBackupHeader(file);
    assert.deepEqual([header.backup_id, header.key_fingerprint], [run!.id, format.keyFingerprint(key)]);

    const scanned: string[] = [];
    const { manifest } = await format.scanInstanceBackup(file, key, backup.INSTANCE_BACKUP_ROOTS, { onFile: entry => { scanned.push(path.join(uploads, entry.root, entry.path)); return null; } });
    assert.deepEqual(scanned.sort(), [...included].sort(), 'every stored file, none of the work in progress');
    assert.equal(manifest.files.count, included.length);
    assert.ok(manifest.database.tables.users >= 3);
    assert.equal(manifest.database.tables.contact_photos, 1, 'the dump came before the photo was removed');
    first = { file: path.join(scratch, 'first.uhib'), manifest };
    fs.copyFileSync(file, first.file);
  });

  await t.test('verification stops when the run is stopped', async () => {
    const controller = new AbortController();
    const stop = new Error('synthetic stop');
    let pieces = 0;
    await assert.rejects(format.scanInstanceBackup(first.file, key, backup.INSTANCE_BACKUP_ROOTS, {
      signal: controller.signal, onDatabase: () => { pieces++; controller.abort(stop); },
    }), error => error === stop);
    assert.equal(pieces, 1, 'nothing more was read after the stop');
    await assert.rejects(format.scanInstanceBackup(first.file, key, backup.INSTANCE_BACKUP_ROOTS, { signal: AbortSignal.abort(stop) }), error => error === stop);
  });

  await t.test('another key, a changed byte, a cut-off file and trailing bytes are refused', async () => {
    const roots = backup.INSTANCE_BACKUP_ROOTS;
    await assert.rejects(format.scanInstanceBackup(first.file, crypto.randomBytes(32), roots), /made with another key/);
    const bytes = fs.readFileSync(first.file);
    const changed = Buffer.from(bytes);
    changed[Math.floor(changed.length / 2)] ^= 0x01;
    write(path.join(scratch, 'changed.uhib'), changed);
    await assert.rejects(format.scanInstanceBackup(path.join(scratch, 'changed.uhib'), key, roots), /damaged or was changed|damaged/);
    write(path.join(scratch, 'cut.uhib'), bytes.subarray(0, bytes.length - 100));
    await assert.rejects(format.scanInstanceBackup(path.join(scratch, 'cut.uhib'), key, roots), /cut off|damaged/);
    write(path.join(scratch, 'longer.uhib'), Buffer.concat([bytes, Buffer.from('x')]));
    await assert.rejects(format.scanInstanceBackup(path.join(scratch, 'longer.uhib'), key, roots), /after its end/);
    assert.equal(await restoreCommand(['--file', path.join(scratch, 'changed.uhib'), '--key-file', keyFile, '--verify-only'], () => {}), 1);
    assert.equal(await restoreCommand(['--file', first.file, '--key-file', keyFile, '--verify-only'], () => {}), 0);
  });

  await t.test('Back up now through the route; retention keeps the newest after each verified success', async () => {
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 1100));
      // No body, as the admin page sends it.
      const started = await admin.request('POST', '/api/admin/instance-backup/run');
      assert.equal(started.status, 202, JSON.stringify(started.body));
      assert.equal((started.body.run as FixtureValue).status, 'running');
      assert.equal((started.body.run as FixtureValue).actor_email, 'admin@example.test');
      const again = await admin.request('POST', '/api/admin/instance-backup/run', {});
      assert.deepEqual([again.status, again.body.code], [409, 'INSTANCE_BACKUP_RUNNING']);
      let status: FixtureValue;
      for (let wait = 0; ; wait++) {
        status = (await admin.request('GET', '/api/admin/instance-backup')).body;
        if (!status.running) break;
        assert.ok(wait < 600, 'the run finishes');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(status.last_run.status, 'succeeded', JSON.stringify(status.last_run));
      names.push(status.last_run.file_name);
    }
    const status = (await admin.request('GET', '/api/admin/instance-backup')).body as FixtureValue;
    assert.deepEqual([status.enabled, status.destination, status.keep, status.time_utc, status.kept.count], [true, destination, 2, '03:30', 2]);
    assert.equal(status.kept.bytes, names.reduce((sum, name) => sum + fs.statSync(path.join(destination, name)).size, 0));
    assert.deepEqual(fs.readdirSync(destination).sort(), [...names].sort(), 'the oldest succeeded file is gone');
    const [[oldest]] = await pool.query<RowDataPacket[]>("SELECT removed_at FROM instance_backups WHERE status = 'succeeded' ORDER BY started_at LIMIT 1");
    assert.ok(oldest.removed_at, 'its run is marked removed');
    assert.equal(Number((await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'admin.instance_backup_started'"))[0][0].count), 2);
    assert.match(status.restore_command, /instance-restore\.js --file/);
  });

  await t.test('restore into an empty installation: refused while not empty, then the data, the files and no sessions', async () => {
    const database = getDatabaseConfig()!;
    await assert.rejects(restoreInstanceBackup({ file: first.file, key, database }), /is not empty/);
    // The empty installation: no tables, storage without files.
    const cx = await pool.getConnection();
    try {
      await cx.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const row of (await cx.query<RowDataPacket[]>('SHOW TABLES'))[0]) await cx.query('DROP TABLE ??', [Object.values(row)[0]]);
      await cx.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally { cx.release(); }
    write(path.join(rootDirs['mail-raw'], 'stray.eml'), 'not empty');
    await assert.rejects(restoreInstanceBackup({ file: first.file, key, database }), /holds files/);
    assert.equal((await pool.query<RowDataPacket[]>('SHOW TABLES'))[0].length, 0, 'a refusal writes nothing');
    fs.rmSync(uploads, { recursive: true, force: true });

    const lines: string[] = [];
    assert.equal(await restoreCommand(['--file', first.file, '--key-file', keyFile], line => lines.push(line)), 0, lines.join('\n'));
    // Every table as the dump had it, but for the running life of the old installation.
    const retired: Record<string, number> = { sessions: 0, file_tickets: 0, two_factor_challenges: 0, calendar_event_moves: 0,
      mail_scheduled_sends: first.manifest.database.tables.mail_scheduled_sends - 1, mail_server_messages: first.manifest.database.tables.mail_server_messages - 1 };
    for (const [table, count] of Object.entries(first.manifest.database.tables)) {
      const [[row]] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${pool.escapeId(table)}`);
      assert.equal(Number(row.count), table in retired ? retired[table] : count, table);
    }
    assert.ok(first.manifest.database.tables.sessions > 0, 'the source had sessions to leave behind');
    for (const file of included) assert.equal(sha(file), hashes.get(file), file);
    for (const file of leftOut) assert.equal(fs.existsSync(file), false, file);

    // The photo whose row the dump holds has its files.
    const [[restoredPhoto]] = await pool.query<RowDataPacket[]>('SELECT sha256, thumb_sha256 FROM contact_photos WHERE user_id = ?', [users.alex]);
    assert.deepEqual([restoredPhoto.sha256, restoredPhoto.thumb_sha256], [photoRow.sha256, photoRow.thumb_sha256]);
    assert.ok(photoFiles.every(file => fs.existsSync(file)), 'the restored photo row has its files');

    // Nothing the old server still had to do at a provider runs again (the account restore's policy).
    const [[account]] = await pool.query<RowDataPacket[]>('SELECT is_active, delete_emails_on_server, sync_policy_confirmed_at FROM mail_accounts WHERE id = ?', [mailAccount]);
    assert.deepEqual([Number(account.is_active), Number(account.delete_emails_on_server), account.sync_policy_confirmed_at], [0, 0, null]);
    const [[operation]] = await pool.query<RowDataPacket[]>('SELECT state, status, is_current FROM mail_writebacks WHERE id = ?', [move]);
    assert.deepEqual([operation.state, operation.status, Number(operation.is_current)], ['needs_attention', 'conflict', 0]);
    const [jobs] = await pool.query<RowDataPacket[]>('SELECT state FROM mail_engine_jobs WHERE operation_id = ?', [move]);
    assert.deepEqual(jobs.map(job => job.state), ['paused']);
    assert.equal(await engine.claimDueJob({ workerId: 'restored-installation', accountId: mailAccount }, pool), null, 'the scheduler claims nothing');
    const [schedules] = await pool.query<RowDataPacket[]>('SELECT email_id, status FROM mail_scheduled_sends WHERE user_id = ?', [users.alex]);
    assert.deepEqual(schedules.map(row => [row.email_id, row.status]), [[sends.sending, 'unknown']], 'the scheduled draft is unscheduled; the started send is never tried again');
    assert.equal(Number((await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM mail_server_messages WHERE delete_status = 'pending'"))[0][0].count), 0);
    assert.match(lines.join('\n'), /Mail accounts are paused/);
    const [runs] = await pool.query<RowDataPacket[]>('SELECT status, file_name FROM instance_backups ORDER BY started_at');
    assert.deepEqual(runs.map(run => run.status), ['failed', 'succeeded'], 'the run that wrote the backup shows as succeeded');
    assert.equal(runs[1].file_name, 'first.uhib');

    // The restored installation works: old sessions are gone, a sign-in works and alex's data is there.
    assert.equal((await alex.request('GET', '/api/contacts')).status, 401);
    const again = await signIn('alex');
    const contacts = await again.request('GET', '/api/contacts');
    assert.equal(contacts.status, 200);
    assert.match(JSON.stringify(contacts.body), /casey@example\.test/);
  });
});
