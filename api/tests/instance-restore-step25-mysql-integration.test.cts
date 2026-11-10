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

// An instance backup of a 0.28 installation (upgrade step 25: no devices
// table yet) restores with this release, and the next start's upgrade adds
// the devices. The stored-file roots point at a scratch tree first, as in
// instance-backup-mysql-integration.
const scratch = path.join(os.tmpdir(), `unihub-instance-restore-25-${crypto.randomUUID()}`);
const uploads = path.join(scratch, 'uploads');
Object.assign(process.env, {
  MAIL_ATTACHMENT_UPLOAD_ROOT: path.join(uploads, 'attachments'), MAIL_RAW_STORAGE_ROOT: path.join(uploads, 'mail-raw'),
  RECORDINGS_ROOT: path.join(uploads, 'recordings'), CONTACT_PHOTOS_ROOT: path.join(uploads, 'contact-photos'),
  BACKUP_ARCHIVES_ROOT: path.join(uploads, 'backups'), UPLOAD_SPOOL_ROOT: path.join(uploads, 'spool'),
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
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

test('an instance backup of 0.28 (step 25, no devices) restores into an empty installation, and the next start adds the devices', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  fs.mkdirSync(scratch, { mode: 0o700 });
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t, { migrate: false });
  const { runMigrations } = require('../dist/src/services/database-migrations') as typeof import('../src/services/database-migrations');
  const { MIGRATIONS } = require('../dist/src/services/database') as typeof import('../src/services/database');
  const { BASELINE } = require('../dist/src/services/database-baseline') as typeof import('../src/services/database-baseline');
  const backup = require('../dist/src/services/instance-backup') as typeof import('../src/services/instance-backup');
  const format = require('../dist/src/services/instance-backup-format') as typeof import('../src/services/instance-backup-format');
  const { restoreInstanceBackup } = require('../dist/src/services/instance-restore') as typeof import('../src/services/instance-restore');
  const { getDatabaseConfig } = require('../dist/src/services/database-config') as typeof import('../src/services/database-config');
  await runMigrations(pool, MIGRATIONS.filter(step => step.id <= 25), BASELINE);

  // A 0.28 installation: a person signed in (a session without a device).
  const admin = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, 'admin@example.test', 'not-a-hash', 'Admin', 'admin')", [admin]);
  await pool.execute("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, REPEAT('a', 64), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY))", [admin]);
  const tables = async () => (await pool.query<RowDataPacket[]>('SHOW TABLES'))[0].map(row => String(Object.values(row)[0]));
  assert.equal((await tables()).includes('devices'), false, 'a 0.28 schema');
  const people = Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM users'))[0][0].count);

  const destination = path.join(scratch, 'destination');
  fs.mkdirSync(destination);
  const key = crypto.randomBytes(32);
  backup.useInstanceBackupConfig({ dir: destination, key, timeUtc: '03:30', keep: 2, missing: [], errors: [] });
  const run = await backup.runInstanceBackup({ trigger: 'manual', actorId: admin });
  assert.equal(run?.status, 'succeeded', String(run?.error));
  const file = path.join(destination, String(run!.file_name));
  assert.equal((await format.readInstanceBackupHeader(file)).migration_id, 25);

  // The empty installation it goes into.
  const cx = await pool.getConnection();
  try {
    await cx.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const name of await tables()) await cx.query('DROP TABLE ??', [name]);
    await cx.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally { cx.release(); }
  fs.rmSync(uploads, { recursive: true, force: true });

  const restored = await restoreInstanceBackup({ file, key, database: getDatabaseConfig()! });
  assert.equal(restored.restored, true);
  const count = async (sql: string) => Number((await pool.query<RowDataPacket[]>(sql))[0][0].count);
  assert.deepEqual([await count('SELECT COUNT(*) AS count FROM users'), await count('SELECT COUNT(*) AS count FROM sessions')], [people, 0],
    'the people are back and everyone signs in again');
  assert.equal((await tables()).includes('devices'), false);

  // The next start upgrades the restored installation.
  await runMigrations(pool, MIGRATIONS, BASELINE);
  assert.equal(await count('SELECT MAX(id) AS count FROM schema_migrations'), MIGRATIONS[MIGRATIONS.length - 1].id);
  assert.equal(await count('SELECT COUNT(*) AS count FROM devices'), 0);
});
