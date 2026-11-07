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
type RunOptions = Partial<Parameters<typeof import('../src/services/instance-backup').runInstanceBackup>[0]>;
const write = (file: string, content: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };

test('the instance backup copies the installation, keeps only verified runs, refuses changed files and restores into an empty installation', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 900000,
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
    // What the copy finds after the dump, recorded in the hook and checked after the run.
    const during: Record<string, unknown> = {};
    const run = await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin, hooks: { afterDump: async () => {
      // blair's message row went after the dump: the file must stay until the copy has ended.
      during.removal = await backup.fileRemovalGate.run(() => fs.promises.rm(removedDuringCopy));
      during.messageKept = fs.existsSync(removedDuringCopy);
      // alex removes the contact photo after the dump: the dump still has its row, so its files stay for the copy.
      during.photoDelete = (await alex.request('DELETE', `/api/contacts/${contactId}/photo`)).status;
      during.photoRows = Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM contact_photos WHERE user_id = ?', [users.alex]))[0][0].count);
      during.photoFilesKept = photoFiles.map(file => fs.existsSync(file));
    } } });
    assert.equal(run!.status, 'succeeded', String(run!.error));
    assert.deepEqual(during, { removal: 'deferred', messageKept: true, photoDelete: 200, photoRows: 0, photoFilesKept: [true, true] }, 'removals after the dump wait at the gate');
    assert.equal(fs.existsSync(removedDuringCopy), false, 'the queued removal ran once the copy ended');
    assert.ok(photoFiles.every(file => !fs.existsSync(file)), 'the queued photo release checked the references again and removed them');
    assert.equal(run!.file_name, `unihub-instance-${run!.file_name!.slice(16, 32)}-${run!.app_version}-${run!.id}.uhib`, 'time, version and run id');
    assert.match(run!.file_name!, /^unihub-instance-\d{8}T\d{6}Z-/);
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

  const backupFiles = () => fs.readdirSync(destination).filter(name => name.endsWith('.uhib')).sort();
  // The completion contract: once the status says nothing runs, the run's
  // row, the kept count and the files at the destination agree.
  async function finished() {
    for (let wait = 0; ; wait++) {
      const status = (await admin.request('GET', '/api/admin/instance-backup')).body as FixtureValue;
      if (!status.running) {
        assert.notEqual(status.last_run?.status, 'running', 'not running, yet the last run still runs');
        assert.ok(status.kept.count <= status.keep, `${status.kept.count} kept, ${status.keep} to keep`);
        assert.equal(backupFiles().length, status.kept.count, 'files at the destination');
        return status;
      }
      assert.ok(wait < 600, 'the run finishes');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

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
      const status = await finished();
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

  await t.test('D35: the schedule and the count an administrator sets are picked up without a restart', async () => {
    const put = (body: Record<string, unknown>, status: number) => admin.request('PUT', '/api/admin/instance-backup/settings', body)
      .then(reply => { assert.equal(reply.status, status, JSON.stringify(reply.body)); return reply.body as FixtureValue; });
    assert.equal((await put({ time_utc: '11:00', keep: 1, current_password: 'wrong-password' }, 403)).code, 'ADMIN_PASSWORD_INCORRECT');
    assert.equal((await put({ time_utc: '25:00', keep: 1, current_password: password }, 400)).code, 'INSTANCE_BACKUP_TIME_INVALID');
    assert.equal((await put({ time_utc: '11:00', keep: 0, current_password: password }, 400)).code, 'INSTANCE_BACKUP_KEEP_INVALID');
    assert.equal((await alex.request('PUT', '/api/admin/instance-backup/settings', { time_utc: '11:00', keep: 1, current_password: password })).status, 403);
    const unchanged = (await admin.request('GET', '/api/admin/instance-backup')).body as FixtureValue;
    assert.deepEqual([unchanged.time_utc, unchanged.keep, unchanged.schedule_source, unchanged.schedule_defaults], ['03:30', 2, 'environment', { time_utc: '03:30', keep: 2 }]);

    // A day far from the real runs: its scheduled run at 03:30 has happened (failed), so at 12:00 nothing is due.
    const now = new Date('2030-01-15T12:00:00Z');
    const earlier = crypto.randomUUID();
    await pool.execute("INSERT INTO instance_backups (id, trigger_kind, status, app_version, migration_id, started_at, finished_at, error) VALUES (?, 'schedule', 'failed', '0.0.0', 0, '2030-01-15 04:00:00', '2030-01-15 04:01:00', 'synthetic')", [earlier]);
    assert.equal(await backup.runDueInstanceBackup(now), null);
    const saved = await put({ time_utc: '11:00', keep: 1, current_password: password }, 200);
    assert.deepEqual([saved.time_utc, saved.keep, saved.schedule_source], ['11:00', 1, 'admin']);
    const [[entry]] = await pool.query<RowDataPacket[]>("SELECT actor_id, details FROM audit_log WHERE action = 'admin.instance_backup_settings_changed'");
    assert.deepEqual([entry.actor_id, typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details], [users.admin, { from_time_utc: '03:30', time_utc: '11:00', from_keep: 2, keep: 1 }]);
    // The same process, no new configuration: the 11:00 run of that day is due now, and its success keeps one backup.
    const run = await backup.runDueInstanceBackup(now);
    assert.ok(run, 'the new time is due');
    assert.equal((run as FixtureValue).status, 'succeeded');
    assert.equal(Number((await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM instance_backups WHERE status = 'succeeded' AND removed_at IS NULL"))[0][0].count), 1);
    assert.equal(fs.readdirSync(destination).length, 1);
    await pool.execute("DELETE FROM system_settings WHERE setting_key IN ('instance_backup_time_utc', 'instance_backup_keep')");
    await pool.execute('DELETE FROM instance_backups WHERE id = ?', [earlier]);
    assert.equal(((await admin.request('GET', '/api/admin/instance-backup')).body as FixtureValue).keep, 2, 'the environment\'s again');
  });

  await t.test('the status is one snapshot, and a run is running until its retention has removed the old files', async () => {
    backup.useInstanceBackupConfig({ ...settings, keep: 1 });
    const holder = await pool.getConnection();
    try {
      // Hold the kept runs' rows: the next run's retention has to wait for them.
      await holder.beginTransaction();
      const [held] = await holder.query<RowDataPacket[]>("SELECT id FROM instance_backups WHERE status = 'succeeded' AND removed_at IS NULL");
      assert.ok(held.length >= 1);
      await holder.query(`SELECT id FROM instance_backups WHERE id IN (${held.map(() => '?').join(', ')}) FOR UPDATE`, held.map(row => row.id));
      const started = await admin.request('POST', '/api/admin/instance-backup/run');
      assert.equal(started.status, 202, JSON.stringify(started.body));
      for (let wait = 0; ; wait++) {
        // The test user sees its own threads (INNODB_TRX needs PROCESS). A statement on
        // the runs executing for half a second is blocked by the holder: the run's retention.
        const [[waiting]] = await holder.query<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM information_schema.PROCESSLIST
          WHERE ID <> CONNECTION_ID() AND COMMAND <> 'Sleep' AND INFO LIKE '%instance_backups%' AND TIME_MS > 500`);
        if (Number(waiting.count) > 0) break;
        assert.ok(wait < 600, 'the run reaches its retention');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const during = (await admin.request('GET', '/api/admin/instance-backup')).body as FixtureValue;
      assert.deepEqual({ running: during.running, refused: (await admin.request('POST', '/api/admin/instance-backup/run')).body.code },
        { running: true, refused: 'INSTANCE_BACKUP_RUNNING' }, `while retention waits: ${JSON.stringify({ last: during.last_run?.status, kept: during.kept })}`);
      await holder.commit();
    } finally {
      await holder.rollback().catch(() => {});
      holder.release();
    }
    const after = await finished();
    assert.equal(after.last_run.status, 'succeeded');
    assert.deepEqual([after.kept.count, backupFiles()], [1, [after.last_run.file_name]]);
    backup.useInstanceBackupConfig(settings);
  });

  await t.test('a failed status read hands no connection back inside its read-only transaction', async () => {
    const state = require('../dist/src/state') as typeof import('../src/state');
    const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
    const shared = state.getDb()!;
    const single = mysql.createPool({ ...getDatabaseConfig()!, connectionLimit: 1, timezone: '+00:00' });
    // The first statement after the snapshot fails, as a statement timeout would.
    let failNext = true;
    const bound = (target: object, prop: string | symbol) => { const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; };
    state.setDb(new Proxy(single, { get: (pool, prop) => prop !== 'getConnection' ? bound(pool, prop) : async () => {
      const connection = await pool.getConnection();
      return new Proxy(connection, { get: (target, name) => name === 'execute' && failNext
        ? async () => { failNext = false; throw new Error('synthetic status failure'); }
        : bound(target, name) });
    } }));
    try {
      await assert.rejects(backup.getInstanceBackupStatus(), /synthetic status failure/);
      const next = await single.getConnection();
      try {
        const [[row]] = await next.query<RowDataPacket[]>('SELECT @@in_transaction AS open');
        assert.equal(Number(row.open), 0, 'the next user of the pool is outside any transaction');
      } finally { next.release(); }
    } finally {
      state.setDb(shared);
      await single.end();
    }
  });

  await t.test('a run whose new row cannot be read back frees its slot and is recorded as failed', async () => {
    const state = require('../dist/src/state') as typeof import('../src/state');
    const shared = state.getDb()!;
    // The insert goes through; the first read of the new row fails once.
    let failNext = true;
    state.setDb(new Proxy(shared, { get: (pool, prop) => {
      const value = Reflect.get(pool, prop);
      if (prop !== 'execute') return typeof value === 'function' ? value.bind(pool) : value;
      return async (sql: string, ...rest: unknown[]) => {
        if (failNext && /WHERE b\.id = \?/.test(sql)) {
          failNext = false;
          throw Object.assign(new Error('synthetic: connection reset'), { code: 'ECONNRESET' });
        }
        return (value as (...args: unknown[]) => unknown).call(pool, sql, ...rest);
      };
    } }));
    try {
      await assert.rejects(backup.startInstanceBackup({ trigger: 'manual', actorId: users.admin }), /connection reset/);
    } finally {
      state.setDb(shared);
    }
    const [[stranded]] = await pool.query<RowDataPacket[]>('SELECT status, error FROM instance_backups ORDER BY started_at DESC, id DESC LIMIT 1');
    assert.deepEqual([stranded.status, /could not start/.test(String(stranded.error))], ['failed', true]);
    assert.equal(((await admin.request('GET', '/api/admin/instance-backup')).body as FixtureValue).running, false);
    const next = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
    assert.equal(next.status, 'succeeded', String(next.error));
  });

  await t.test('each run writes a file of its own, never over another, and retention keeps the latest', async () => {
    backup.useInstanceBackupConfig({ ...settings, keep: 1 });
    try {
      // Back to back, also within one second.
      const a = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
      const b = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
      assert.deepEqual([a.status, b.status], ['succeeded', 'succeeded'], String(a.error || b.error));
      assert.ok(a.file_name!.includes(a.id) && b.file_name!.includes(b.id) && a.file_name !== b.file_name, 'each name holds its run id');
      assert.ok(b.id > a.id, 'run ids follow the order of the runs');
      const [kept] = await pool.query<RowDataPacket[]>("SELECT id FROM instance_backups WHERE status = 'succeeded' AND removed_at IS NULL");
      assert.deepEqual([kept.map(row => row.id), backupFiles()], [[b.id], [b.file_name]], 'the latest run and its file are kept');

      // A file already at the name is never replaced.
      let planted = '';
      const c = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin, hooks: { afterDump: async () => {
        const partial = fs.readdirSync(destination).find(name => name.endsWith('.partial'))!;
        planted = path.join(destination, partial.slice(0, -'.partial'.length));
        fs.writeFileSync(planted, 'synthetic file that is not this run');
      } } }))!;
      assert.equal(c.status, 'failed');
      assert.match(String(c.error), /already exists/);
      assert.equal(fs.readFileSync(planted, 'utf8'), 'synthetic file that is not this run');
      assert.deepEqual(fs.readdirSync(destination).filter(name => name.endsWith('.partial')), []);
      fs.rmSync(planted);
      assert.deepEqual(backupFiles(), [b.file_name]);

      // Runs finished in the same second: the later run stays.
      backup.useInstanceBackupConfig({ ...settings, keep: 3 });
      const d = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
      const e = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
      assert.deepEqual([d.status, e.status], ['succeeded', 'succeeded']);
      await pool.query("UPDATE instance_backups SET started_at = '2030-01-01 00:00:00', finished_at = '2030-01-01 00:00:00' WHERE id IN (?, ?, ?)", [b.id, d.id, e.id]);
      assert.equal(await backup.applyRetention({ dir: destination, keep: 1 }), 2);
      const [latest] = await pool.query<RowDataPacket[]>("SELECT id FROM instance_backups WHERE status = 'succeeded' AND removed_at IS NULL");
      assert.deepEqual([latest.map(row => row.id), backupFiles()], [[e.id], [e.file_name]]);

      // The clock was ahead when e finished and is set back, or a restart after
      // that gives later runs smaller ids: the run that counts last stays.
      await pool.query("UPDATE instance_backups SET finished_at = '2031-01-01 00:00:00', id = 'ffffffff-ffff-7fff-bfff-ffffffffffff' WHERE id = ?", [e.id]);
      backup.useInstanceBackupConfig({ ...settings, keep: 1 });
      const f = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
      assert.equal(f.status, 'succeeded', String(f.error));
      const [newest] = await pool.query<RowDataPacket[]>("SELECT id FROM instance_backups WHERE status = 'succeeded' AND removed_at IS NULL");
      assert.deepEqual([newest.map(row => row.id), backupFiles()], [[f.id], [f.file_name]], 'the newest backup is kept');
      assert.equal(((await admin.request('GET', '/api/admin/instance-backup')).body as FixtureValue).last_success.id, f.id);
    } finally {
      backup.useInstanceBackupConfig(settings);
    }
  });

  await t.test('a destination without hard links publishes by a rename once the name is checked to be free', async () => {
    const link = fs.promises.link;
    let refused = 0;
    fs.promises.link = async () => { refused++; throw Object.assign(new Error('synthetic: operation not supported'), { code: 'EOPNOTSUPP' }); };
    try {
      const run = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
      assert.equal(run.status, 'succeeded', String(run.error));
      assert.ok(refused > 0, 'the link was tried');
      assert.ok(backupFiles().includes(run.file_name!));
      assert.deepEqual(fs.readdirSync(destination).filter(name => name.endsWith('.partial')), []);
      assert.equal(sha(path.join(destination, run.file_name!)), run.sha256);

      let planted = '';
      const clash = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin, hooks: { afterDump: async () => {
        const partial = fs.readdirSync(destination).find(name => name.endsWith('.partial'))!;
        planted = write(path.join(destination, partial.slice(0, -'.partial'.length)), 'synthetic file that is not this run');
      } } }))!;
      assert.equal(clash.status, 'failed');
      assert.match(String(clash.error), /already exists/);
      assert.equal(fs.readFileSync(planted, 'utf8'), 'synthetic file that is not this run');
      fs.rmSync(planted);
    } finally {
      fs.promises.link = link;
    }
  });

  await t.test('a secret file read at the start stays out after it is replaced, and a run refuses when one cannot be checked', async () => {
    const config = require('../dist/src/config') as typeof import('../src/config');
    const loaded = write(path.join(scratch, 'secrets', 'loaded.key'), `synthetic-loaded-secret-${crypto.randomBytes(16).toString('hex')}`);
    process.env.UNIHUB_LOADED_SECRET_FILE = loaded;
    const link = path.join(rootDirs.attachments, users.alex, 'loaded-secret-link');
    try {
      assert.equal(config.readSecret('UNIHUB_LOADED_SECRET'), fs.readFileSync(loaded, 'utf8'));
      fs.linkSync(loaded, link);
      // Replaced atomically after it was read: what was read survives only as the link.
      write(`${loaded}.next`, 'synthetic-rotated-secret');
      fs.renameSync(`${loaded}.next`, loaded);
      const replaced = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
      assert.equal(replaced.status, 'succeeded', String(replaced.error));
      const copied: string[] = [];
      await format.scanInstanceBackup(path.join(destination, replaced.file_name!), key, backup.INSTANCE_BACKUP_ROOTS, { onFile: entry => { copied.push(path.join(uploads, entry.root, entry.path)); return null; } });
      assert.equal(copied.includes(link), false, 'the file read at the start is left out');
      // Removed: the run cannot tell which file to leave out, so it does not run.
      fs.rmSync(loaded);
      const before = backupFiles();
      const refused = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
      assert.equal(refused.status, 'failed');
      assert.match(String(refused.error), /UNIHUB_LOADED_SECRET_FILE .* cannot be checked now/);
      assert.deepEqual(backupFiles(), before);
    } finally {
      delete process.env.UNIHUB_LOADED_SECRET_FILE;
      fs.rmSync(link, { force: true });
    }
  });

  await t.test('a secret rotated during a run makes that run not count; the next one leaves the new file out', async () => {
    // A projected secret: key -> ..data/key, ..data -> a generation directory
    // replaced as a whole on rotation, and a hard link of the new generation
    // among the stored files (an aliased mount).
    const projected = path.join(scratch, 'projected');
    write(path.join(projected, 'gen-1', 'key'), `synthetic-generation-1-${crypto.randomBytes(16).toString('hex')}`);
    fs.symlinkSync('gen-1', path.join(projected, '..data'));
    fs.symlinkSync('..data/key', path.join(projected, 'key'));
    process.env.UNIHUB_ROTATING_SECRET_FILE = path.join(projected, 'key');
    const alias = path.join(rootDirs.attachments, users.alex, 'rotated-alias');
    try {
      const before = backupFiles();
      const rotated = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin, hooks: { afterDump: async () => {
        write(path.join(projected, 'gen-2', 'key'), `synthetic-generation-2-${crypto.randomBytes(16).toString('hex')}`);
        fs.linkSync(path.join(projected, 'gen-2', 'key'), alias);
        fs.symlinkSync('gen-2', path.join(projected, '..data.next'));
        fs.renameSync(path.join(projected, '..data.next'), path.join(projected, '..data'));
      } } }))!;
      assert.equal(rotated.status, 'failed');
      assert.match(String(rotated.error), /UNIHUB_ROTATING_SECRET_FILE .* changed during the run/);
      assert.deepEqual(backupFiles(), before, 'nothing published');

      const next = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
      assert.equal(next.status, 'succeeded', String(next.error));
      const copied: string[] = [];
      await format.scanInstanceBackup(path.join(destination, next.file_name!), key, backup.INSTANCE_BACKUP_ROOTS, { onFile: entry => { copied.push(path.join(uploads, entry.root, entry.path)); return null; } });
      assert.equal(copied.includes(alias), false, 'the new generation is left out');
    } finally {
      delete process.env.UNIHUB_ROTATING_SECRET_FILE;
      fs.rmSync(alias, { force: true });
    }
  });

  await t.test('a secret generation one run left out stays out of every later run', async () => {
    // A projected secret read at startup as generation A, rotated to B before
    // a run (B has a hard link among the stored files), then to C between runs.
    const projected = path.join(scratch, 'projected-generations');
    const generation = (name: string) => write(path.join(projected, name, 'key'), `synthetic-${name}-${crypto.randomBytes(16).toString('hex')}`);
    const point = (name: string) => {
      fs.symlinkSync(name, path.join(projected, '..data.next'));
      fs.renameSync(path.join(projected, '..data.next'), path.join(projected, '..data'));
    };
    generation('gen-a');
    point('gen-a');
    fs.symlinkSync('..data/key', path.join(projected, 'key'));
    process.env.UNIHUB_GENERATION_SECRET_FILE = path.join(projected, 'key');
    const config = require('../dist/src/config') as typeof import('../src/config');
    const alias = path.join(rootDirs.attachments, users.alex, 'generation-b-alias');
    const copiedBy = async (run: { file_name: string | null }) => {
      const copied: string[] = [];
      await format.scanInstanceBackup(path.join(destination, run.file_name!), key, backup.INSTANCE_BACKUP_ROOTS, { onFile: entry => { copied.push(path.join(uploads, entry.root, entry.path)); return null; } });
      return copied;
    };
    try {
      assert.ok(config.readSecret('UNIHUB_GENERATION_SECRET'));
      fs.linkSync(generation('gen-b'), alias);
      point('gen-b');
      const first = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
      assert.equal(first.status, 'succeeded', String(first.error));
      assert.equal((await copiedBy(first)).includes(alias), false, 'B is left out while it is the secret');
      generation('gen-c');
      point('gen-c');
      fs.rmSync(path.join(projected, 'gen-b'), { recursive: true });
      const second = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
      assert.equal(second.status, 'succeeded', String(second.error));
      assert.equal((await copiedBy(second)).includes(alias), false, 'B stays out after the secret moved on');
      // A stored file that only shares a secret's size is copied, with its own bytes.
      const lookalike = write(path.join(rootDirs.attachments, users.alex, 'same-size'), 'x'.repeat(fs.statSync(alias).size));
      const third = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
      const pieces: Buffer[] = [];
      await format.scanInstanceBackup(path.join(destination, third.file_name!), key, backup.INSTANCE_BACKUP_ROOTS, { onFile: entry => (
        path.join(uploads, entry.root, entry.path) === lookalike ? { write: async (buffer: Buffer) => { pieces.push(Buffer.from(buffer)); }, end: async () => {} } : null) });
      assert.equal(Buffer.concat(pieces).toString(), fs.readFileSync(lookalike, 'utf8'));
      fs.rmSync(lookalike);
    } finally {
      delete process.env.UNIHUB_GENERATION_SECRET_FILE;
      fs.rmSync(alias, { force: true });
    }
  });

  await t.test('however a run ends, it remembers the secret as it ended, so its copy stays out of the next run', async () => {
    // A at the start, B (with a copy among the stored files) when the run
    // ends, C before the next run: the copy of B must stay out of that one.
    const secretFile = path.join(scratch, 'run-exits', 'key');
    process.env.UNIHUB_RUN_EXIT_SECRET_FILE = secretFile;
    const copy = path.join(rootDirs.attachments, users.alex, 'run-exit-copy');
    const config = require('../dist/src/config') as typeof import('../src/config');
    const link = fs.promises.link;
    let b = Buffer.alloc(0);
    const rotateToB = () => {
      b = Buffer.from(`synthetic-b-${crypto.randomBytes(16).toString('hex')}`);
      fs.writeFileSync(`${secretFile}.next`, b);
      fs.renameSync(`${secretFile}.next`, secretFile);
      write(copy, b);
    };
    // Each exit: how the run gets to B, and the status it ends with.
    const exits: [string, string, () => RunOptions][] = [
      ['the copy fails', 'failed', () => ({ hooks: { afterDump: async () => { rotateToB(); throw new Error('synthetic failure after the rotation'); } } })],
      ['publication fails', 'failed', () => {
        fs.promises.link = async () => { rotateToB(); throw Object.assign(new Error('synthetic: permission denied'), { code: 'EACCES' }); };
        return {};
      }],
      ['the run succeeds', 'succeeded', () => {
        fs.promises.link = async (...args: Parameters<typeof link>) => { rotateToB(); return link(...args); };
        return {};
      }],
    ];
    try {
      for (const [exit, status, arrange] of exits) {
        write(secretFile, `synthetic-a-${crypto.randomBytes(16).toString('hex')}`);
        let ended;
        try {
          ended = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin, ...arrange() }))!;
        } finally {
          fs.promises.link = link;
        }
        assert.equal(ended.status, status, `${exit}: ${String(ended.error)}`);
        assert.ok(config.secretGenerationNames(b.length, crypto.createHash('sha256').update(b).digest('hex')), `${exit}: B is remembered`);
        write(secretFile, `synthetic-c-${crypto.randomBytes(16).toString('hex')}`);
        const next = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
        assert.equal(next.status, 'succeeded', `${exit}: ${String(next.error)}`);
        const copied: string[] = [];
        await format.scanInstanceBackup(path.join(destination, next.file_name!), key, backup.INSTANCE_BACKUP_ROOTS, { onFile: entry => { copied.push(path.join(uploads, entry.root, entry.path)); return null; } });
        assert.equal(copied.includes(copy), false, `${exit}: the copy of B is left out`);
        fs.rmSync(copy, { force: true });
      }
    } finally {
      fs.promises.link = link;
      delete process.env.UNIHUB_RUN_EXIT_SECRET_FILE;
      fs.rmSync(copy, { force: true });
    }
  });

  await t.test('a run remembers the secret as it is when its slot is freed, after its last database statement', async () => {
    // As above, with the rotation to B during one of the last statements a
    // start or a run waits for; B is configured when the call returns.
    const state = require('../dist/src/state') as typeof import('../src/state');
    const config = require('../dist/src/config') as typeof import('../src/config');
    const shared = state.getDb()!;
    const secretFile = path.join(scratch, 'last-statement', 'key');
    process.env.UNIHUB_LAST_STATEMENT_SECRET_FILE = secretFile;
    const copy = path.join(rootDirs.attachments, users.alex, 'last-statement-copy');
    let b = Buffer.alloc(0);
    const rotateToB = () => {
      b = Buffer.from(`synthetic-b-${crypto.randomBytes(16).toString('hex')}`);
      fs.writeFileSync(`${secretFile}.next`, b);
      fs.renameSync(`${secretFile}.next`, secretFile);
      write(copy, b);
    };
    // The statement to rotate during: its pattern, which match of it, and whether it then fails.
    let armed: { pattern: RegExp; nth: number; fail: boolean; act?: () => void } | null = null;
    let seen = 0;
    const during = async (sql: string) => {
      if (!armed || !armed.pattern.test(sql) || ++seen !== armed.nth) return;
      const { fail, act = rotateToB } = armed;
      armed = null;
      act();
      if (fail) throw Object.assign(new Error('synthetic: connection reset'), { code: 'ECONNRESET' });
    };
    const intercept = <T extends object>(target: T): T => new Proxy(target, { get: (object, prop) => {
      const value = Reflect.get(object, prop);
      if (typeof value !== 'function') return value;
      if (prop === 'execute') return async (sql: string, ...rest: unknown[]) => { await during(sql); return value.call(object, sql, ...rest); };
      if (prop === 'getConnection') return async () => intercept(await value.call(object));
      return value.bind(object);
    } });
    const finalRead = /WHERE b\.id = \?/;
    const exits: [string, { pattern: RegExp; nth: number; fail: boolean }, RunOptions, 'succeeded' | 'failed' | 'rejected' | null][] = [
      ['the final row read of a success', { pattern: finalRead, nth: 2, fail: false }, {}, 'succeeded'],
      ['the final row read of a failure', { pattern: finalRead, nth: 2, fail: false }, { hooks: { afterDump: async () => { throw new Error('synthetic copy failure'); } } }, 'failed'],
      ['a final row read that fails', { pattern: finalRead, nth: 2, fail: true }, {}, null],
      ['the success transaction', { pattern: /SET status = 'succeeded'/, nth: 1, fail: false }, {}, 'succeeded'],
      ['the failure recording', { pattern: /SET status = 'failed'/, nth: 1, fail: false }, { hooks: { afterDump: async () => { throw new Error('synthetic copy failure'); } } }, 'failed'],
      ['the record of a start that failed', { pattern: /SET status = 'failed'/, nth: 1, fail: false }, {}, 'rejected'],
    ];
    // Every exit is tried, each on its own: the failures are listed together.
    const failures: string[] = [];
    try {
      for (const [exit, statement, options, outcome] of exits) try {
        write(secretFile, `synthetic-a-${crypto.randomBytes(16).toString('hex')}`);
        seen = 0;
        armed = statement;
        let startFails = outcome === 'rejected';
        state.setDb(intercept(new Proxy(shared, { get: (pool, prop) => {
          const value = Reflect.get(pool, prop);
          if (prop !== 'execute' || !startFails) return typeof value === 'function' ? value.bind(pool) : value;
          // A start that fails: its first read of the new row is lost.
          return async (sql: string, ...rest: unknown[]) => {
            if (finalRead.test(sql)) { startFails = false; throw Object.assign(new Error('synthetic: connection reset'), { code: 'ECONNRESET' }); }
            return (value as (...args: unknown[]) => unknown).call(pool, sql, ...rest);
          };
        } })));
        try {
          if (outcome === 'rejected') {
            await assert.rejects(backup.startInstanceBackup({ trigger: 'manual', actorId: users.admin }), /connection reset/, exit);
          } else {
            const ended = await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin, ...options });
            assert.equal(ended?.status ?? null, outcome, `${exit}: ${String(ended?.error)}`);
          }
        } finally {
          state.setDb(shared);
          armed = null;
        }
        assert.ok(b.length && config.secretGenerationNames(b.length, crypto.createHash('sha256').update(b).digest('hex')), `${exit}: B is remembered`);
        write(secretFile, `synthetic-c-${crypto.randomBytes(16).toString('hex')}`);
        const next = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
        assert.equal(next.status, 'succeeded', `${exit}: ${String(next.error)}`);
        const copied: string[] = [];
        await format.scanInstanceBackup(path.join(destination, next.file_name!), key, backup.INSTANCE_BACKUP_ROOTS, { onFile: entry => { copied.push(path.join(uploads, entry.root, entry.path)); return null; } });
        assert.equal(copied.includes(copy), false, `${exit}: the copy of B is left out`);
      } catch (error) {
        failures.push((error as Error).message.split('\n')[0]);
      } finally {
        fs.rmSync(copy, { force: true });
        b = Buffer.alloc(0);
      }
      assert.deepEqual(failures, []);

      // Removed during the final row read: the run's outcome stands, and a
      // warning names the setting it could not read, never a value.
      const value = `synthetic-removed-${crypto.randomBytes(16).toString('hex')}`;
      write(secretFile, value);
      seen = 0;
      armed = { pattern: finalRead, nth: 2, fail: false, act: () => fs.rmSync(secretFile) };
      const warnings: string[] = [];
      const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
      const restoreLog = captureLog((level, line) => { if (level === 'warn') warnings.push(line); });
      state.setDb(intercept(shared));
      let removed;
      try {
        removed = await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin });
      } finally {
        state.setDb(shared);
        restoreLog();
        armed = null;
      }
      assert.equal(removed?.status, 'succeeded', String(removed?.error));
      const warning = warnings.find(line => /Could not read secret files as the run ended/.test(line));
      assert.ok(warning, warnings.join('\n'));
      assert.match(warning, /UNIHUB_LAST_STATEMENT_SECRET_FILE/);
      assert.equal(warning.includes(value), false, 'no value in the log');
    } finally {
      state.setDb(shared);
      delete process.env.UNIHUB_LAST_STATEMENT_SECRET_FILE;
      fs.rmSync(copy, { force: true });
    }
  });

  await t.test('a secret file that grows past the bound after its size was checked is not taken as a secret', async () => {
    // The file is small when its size is looked up and large when it is read.
    const secretFile = write(path.join(scratch, 'growing', 'key'), Buffer.alloc(128 * 1024, 'g'));
    process.env.UNIHUB_GROWING_SECRET_FILE = secretFile;
    const config = require('../dist/src/config') as typeof import('../src/config');
    const statSync = fs.statSync;
    fs.statSync = ((target: import('node:fs').PathLike, ...rest: unknown[]) => {
      const stat = (statSync as (...args: unknown[]) => import('node:fs').Stats)(target, ...rest);
      return String(target) === secretFile ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: 16 }) : stat;
    }) as typeof fs.statSync;
    try {
      const run = (await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin }))!;
      assert.equal(run.status, 'failed');
      assert.match(String(run.error), /UNIHUB_GROWING_SECRET_FILE .* cannot be checked now/);
      assert.equal(config.mayBeSecretGeneration(128 * 1024), false, 'nothing past the bound is remembered');
    } finally {
      fs.statSync = statSync;
      delete process.env.UNIHUB_GROWING_SECRET_FILE;
    }
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
    // Nothing the old server still had to do at a provider runs again (the account restore's policy).
    const [[account]] = await pool.query<RowDataPacket[]>('SELECT is_active, delete_emails_on_server, sync_policy_confirmed_at FROM mail_accounts WHERE id = ?', [mailAccount]);
    const [[operation]] = await pool.query<RowDataPacket[]>('SELECT state, status, is_current FROM mail_writebacks WHERE id = ?', [move]);
    const [jobs] = await pool.query<RowDataPacket[]>('SELECT state FROM mail_engine_jobs WHERE operation_id = ?', [move]);
    const [schedules] = await pool.query<RowDataPacket[]>('SELECT email_id, status FROM mail_scheduled_sends WHERE user_id = ? ORDER BY status', [users.alex]);
    const count = async (sql: string) => Number((await pool.query<RowDataPacket[]>(sql))[0][0].count);
    assert.deepEqual({
      account: [Number(account.is_active), Number(account.delete_emails_on_server), account.sync_policy_confirmed_at],
      move: [operation.state, operation.status, Number(operation.is_current)],
      jobs: jobs.map(job => job.state),
      claimed: !!await engine.claimDueJob({ workerId: 'restored-installation', accountId: mailAccount }, pool),
      // The scheduled draft is unscheduled; the started send is never tried again.
      sends: schedules.map(row => [row.email_id, row.status]),
      deletionsQueued: await count("SELECT COUNT(*) AS count FROM mail_server_messages WHERE delete_status = 'pending'"),
      calendarMoves: await count('SELECT COUNT(*) AS count FROM calendar_event_moves'),
    }, {
      account: [0, 0, null], move: ['needs_attention', 'conflict', 0], jobs: ['paused'], claimed: false,
      sends: [[sends.sending, 'unknown']], deletionsQueued: 0, calendarMoves: 0,
    });

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

    assert.match(lines.join('\n'), /Mail accounts are paused/);
    const [runs] = await pool.query<RowDataPacket[]>('SELECT status, file_name, completion_seq FROM instance_backups ORDER BY started_at');
    assert.deepEqual(runs.map(run => run.status), ['failed', 'succeeded'], 'the run that wrote the backup shows as succeeded');
    assert.deepEqual([runs[1].file_name, Number(runs[1].completion_seq)], ['first.uhib', 1], 'and counts after the runs before it');

    // The restored installation works: old sessions are gone, a sign-in works and alex's data is there.
    assert.equal((await alex.request('GET', '/api/contacts')).status, 401);
    const again = await signIn('alex');
    const contacts = await again.request('GET', '/api/contacts');
    assert.equal(contacts.status, 200);
    assert.match(JSON.stringify(contacts.body), /casey@example\.test/);
  });
});
