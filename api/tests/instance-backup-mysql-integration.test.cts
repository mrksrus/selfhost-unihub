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
  const recordingPath = write(path.join(rootDirs.recordings, users.alex, 'memo.webm'), crypto.randomBytes(300_000));
  await pool.execute("INSERT INTO recordings (id, user_id, title, content_type, storage_path) VALUES (?, ?, 'Synthetic memo', 'audio/webm', ?)", [crypto.randomUUID(), users.alex, recordingPath]);
  const included = [
    recordingPath,
    write(path.join(rootDirs['mail-raw'], users.alex, 'message-1.eml'), 'From: casey@example.test\r\nSubject: Synthetic\r\n\r\nHello\r\n'),
    write(path.join(rootDirs.attachments, users.alex, 'a'.repeat(150) + '-attachment.bin'), crypto.randomBytes(5000)),
    write(path.join(rootDirs['contact-photos'], users.alex, `${'c'.repeat(64)}.jpg`), crypto.randomBytes(2000)),
    write(path.join(rootDirs.backups, users.alex, `${crypto.randomUUID()}.unihub-backup`), crypto.randomBytes(70_000)),
    write(path.join(rootDirs['mail-raw'], users.blair, 'leaves-during-copy.eml'), 'Subject: Removed after the dump\r\n\r\n'),
  ];
  const removedDuringCopy = included[included.length - 1];
  const leftOut = [
    write(path.join(rootDirs.backups, 'imports', users.alex, 'upload.bin'), 'staged upload'),
    write(path.join(rootDirs.backups, users.alex, 'restores', 'job', 'work.json'), '{}'),
    write(path.join(rootDirs.backups, users.alex, 'job.zip.partial'), 'partial export'),
    write(path.join(rootDirs.recordings, '.tmp', users.alex, 'upload.part'), 'chunk'),
    write(path.join(rootDirs['contact-photos'], users.alex, '.photo.jpg.1234.tmp'), 'temporary'),
  ];
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

  let first: { file: string; counts: Record<string, number> };
  await t.test('a run: dump and files, a removal after the dump waits at the gate, verified before it counts', async () => {
    await new Promise(resolve => setTimeout(resolve, 1100));
    let removal: unknown;
    const run = await backup.runInstanceBackup({ trigger: 'manual', actorId: users.admin, hooks: { afterDump: async () => {
      // blair's message row went after the dump: the file must stay until the copy has ended.
      removal = await backup.fileRemovalGate.run(() => fs.promises.rm(removedDuringCopy));
      assert.equal(removal, 'deferred');
      assert.ok(fs.existsSync(removedDuringCopy));
    } } });
    assert.equal(run!.status, 'succeeded', String(run!.error));
    assert.equal(removal, 'deferred');
    assert.equal(fs.existsSync(removedDuringCopy), false, 'the queued removal ran once the copy ended');
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
    first = { file: path.join(scratch, 'first.uhib'), counts: {} };
    fs.copyFileSync(file, first.file);
    for (const row of (await pool.query<RowDataPacket[]>('SHOW TABLES'))[0]) {
      const name = String(Object.values(row)[0]);
      first.counts[name] = Number((await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${pool.escapeId(name)}`))[0][0].count);
    }
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
      assert.equal(status.last_run.status, 'succeeded', status.last_run.error);
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
    for (const [table, count] of Object.entries(first.counts)) {
      const [[row]] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${pool.escapeId(table)}`);
      const expected = ['sessions', 'file_tickets', 'two_factor_challenges'].includes(table) ? 0 : count;
      assert.equal(Number(row.count), expected, table);
    }
    assert.ok(first.counts.sessions > 0, 'the source had sessions to leave behind');
    for (const file of included) assert.equal(sha(file), hashes.get(file), file);
    for (const file of leftOut) assert.equal(fs.existsSync(file), false, file);
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
