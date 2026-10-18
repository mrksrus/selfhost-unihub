import type { FixtureValue, RouteTable } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs') as typeof import('node:fs'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));

// This file runs in its own test process against an empty disposable _test DB.
// ensureSchema needs synthetic first-run bootstrap inputs, and the storage roots
// are module constants, so everything is set before the first dist require.
process.env.BOOTSTRAP_ADMIN_EMAIL = 'lifecycle-fixture-admin@example.test';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-lifecycle-fixture-admin-2026';
process.env.ENCRYPTION_KEY ||= 'user-lifecycle-mysql-test-key';
process.env.JWT_SECRET ||= 'user-lifecycle-mysql-test-jwt-secret';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-user-lifecycle-'));
const ROOTS = {
  attachments: path.join(storage, 'attachments'),
  raw: path.join(storage, 'mail-raw'),
  recordings: path.join(storage, 'recordings'),
  backups: path.join(storage, 'backups'),
};
process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = ROOTS.attachments;
process.env.MAIL_RAW_STORAGE_ROOT = ROOTS.raw;
process.env.RECORDINGS_ROOT = ROOTS.recordings;
process.env.BACKUP_ARCHIVES_ROOT = ROOTS.backups;

const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
const { getDb, setDb } = require('../dist/src/state') as typeof import('../src/state');

function response() {
  const headers = new Map<string, FixtureValue>();
  return { headers, setHeader(key: string, value: FixtureValue) { headers.set(key, value); }, getHeader(key: string) { return headers.get(key); } };
}

test('deleting a user removes their rows and files under every root, nothing of another user, and never during their restore',
  { skip: !process.env.MYSQL_TEST_HOST, timeout: 120000 }, async (t) => {
    const options = { host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
      user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
      database: process.env.MYSQL_TEST_DATABASE || 'unihub_test', timezone: '+00:00' };
    const connection = await mysql.createConnection(options);
    const pool = mysql.createPool({ ...options, connectionLimit: 4 });
    const previous = getDb();
    let ownsDatabase = false;
    t.after(async () => {
      setDb(previous);
      try {
        if (ownsDatabase) {
          await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
          try {
            const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES');
            for (const row of tables) {
              const table = Object.values(row)[0];
              assert.match((table as string), /^[a-z_]+$/);
              await connection.execute(`DROP TABLE \`${table}\``);
            }
          } finally { await connection.execute('SET FOREIGN_KEY_CHECKS = 1'); }
        }
      } finally {
        await pool.end(); await connection.end();
        fs.rmSync(storage, { recursive: true, force: true });
      }
    });
    assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Use an empty disposable test database');
    const [existing] = await connection.query<RowDataPacket[]>('SHOW TABLES');
    assert.equal(existing.length, 0, 'Refusing to change a nonempty database');
    ownsDatabase = true;
    setDb(pool);
    await (require('../dist/src/services/database') as typeof import('../src/services/database')).ensureSchema();

    const { encrypt } = require('../dist/src/security/encryption') as typeof import('../src/security/encryption');
    const adminRoutes = require('../dist/src/routes/admin') as RouteTable<typeof import('../src/routes/admin')>;
    const settingsRoutes = require('../dist/src/routes/settings') as RouteTable<typeof import('../src/routes/settings')>;

    const admin = crypto.randomUUID();
    await connection.execute<ResultSetHeader>("INSERT INTO users (id, email, password_hash, role, is_active) VALUES (?, 'admin@example.test', 'synthetic-hash', 'admin', TRUE)", [admin]);

    // Each person owns a mail account with two messages (raw copy and one
    // attachment each), a recording with its converted copy, a finished backup
    // archive and a file in their attachment directory that no row names.
    const write = (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'synthetic'); return file; };
    const seed = async (name: string) => {
      const user = crypto.randomUUID(), mail = crypto.randomUUID();
      await connection.execute<ResultSetHeader>("INSERT INTO users (id, email, password_hash, role, is_active) VALUES (?, ?, 'synthetic-hash', 'user', TRUE)", [user, `${name}@example.test`]);
      await connection.execute<ResultSetHeader>(`INSERT INTO mail_accounts (id, user_id, email_address, provider, username, imap_host, encrypted_password, is_active)
        VALUES (?, ?, ?, 'custom', ?, 'imap.example.test', ?, TRUE)`, [mail, user, `${name}@example.test`, `${name}@example.test`, encrypt('synthetic-password')]);
      const files: string[] = [];
      for (const subject of ['First', 'Second']) {
        const email = crypto.randomUUID();
        const raw = write(path.join(ROOTS.raw, user, `${email}-${subject}.eml`));
        await connection.execute<ResultSetHeader>(`INSERT INTO emails (id, user_id, mail_account_id, from_address, to_addresses, subject, raw_storage_path)
          VALUES (?, ?, ?, 'sender@example.test', '[]', ?, ?)`, [email, user, mail, subject, raw]);
        const attachment = write(path.join(ROOTS.attachments, user, email, `${subject}.pdf`));
        await connection.execute<ResultSetHeader>(`INSERT INTO email_attachments (id, email_id, user_id, filename, content_type, size_bytes, storage_path)
          VALUES (?, ?, ?, ?, 'application/pdf', 9, ?)`, [crypto.randomUUID(), email, user, `${subject}.pdf`, attachment]);
        files.push(raw, attachment);
      }
      const recording = write(path.join(ROOTS.recordings, user, 'talk.webm'));
      const converted = write(path.join(ROOTS.recordings, user, 'talk.converted-v2.mp3'));
      await connection.execute<ResultSetHeader>(`INSERT INTO recordings (id, user_id, title, content_type, size_bytes, storage_path)
        VALUES (?, ?, 'Talk', 'audio/webm', 9, ?)`, [crypto.randomUUID(), user, recording]);
      const archive = write(path.join(ROOTS.backups, user, 'full.unihub-backup'));
      await connection.execute<ResultSetHeader>(`INSERT INTO data_export_jobs (id, user_id, scope, status, phase, progress, file_path)
        VALUES (?, ?, 'full', 'completed', 'completed', 100, ?)`, [crypto.randomUUID(), user, archive]);
      const stray = write(path.join(ROOTS.attachments, user, 'unreferenced.bin'));
      files.push(recording, converted, archive, stray);
      return { user, mail, files };
    };
    const a = await seed('a');
    const b = await seed('b');

    const count = async (table: string, userId: string) => Number((await connection.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, [userId]))[0][0].n);
    const userExists = async (userId: string) => (await connection.execute<RowDataPacket[]>('SELECT id FROM users WHERE id = ?', [userId]))[0].length === 1;
    const present = (files: readonly string[]) => files.filter(file => fs.existsSync(file));
    const everythingOf = async (who: { user: string; files: string[] }) => ({
      user: await userExists(who.user),
      rows: [await count('mail_accounts', who.user), await count('emails', who.user), await count('email_attachments', who.user), await count('recordings', who.user), await count('data_export_jobs', who.user)],
      files: present(who.files).length,
    });
    const intact = { user: true, rows: [1, 2, 2, 1, 1], files: 8 };
    assert.deepEqual(await everythingOf(a), intact);
    assert.deepEqual(await everythingOf(b), intact);

    const adminDelete = (actor: string, target: string) =>
      adminRoutes['DELETE /api/admin/users/:id']({ url: `/api/admin/users/${target}`, headers: {}, params: { id: target } } as FixtureValue, actor);

    // A restore writing for A: the admin's request is refused and nothing of A changes.
    const restore = crypto.randomUUID();
    await connection.execute<ResultSetHeader>(`INSERT INTO backup_restore_jobs (id, user_id, status, operation, phase, requested_sections)
      VALUES (?, ?, 'running', 'restore', 'running', '["mail"]')`, [restore, a.user]);
    const refused = await adminDelete(admin, a.user);
    assert.equal(refused.status, 409);
    assert.equal(refused.code, 'RESTORE_IN_PROGRESS');
    assert.deepEqual(await everythingOf(a), intact);

    // Another user is not an administrator, whatever the URL says.
    assert.equal((await adminDelete(b.user, a.user)).status, 403);
    assert.deepEqual(await everythingOf(a), intact);

    await connection.execute<ResultSetHeader>("UPDATE backup_restore_jobs SET status = 'completed' WHERE id = ?", [restore]);
    assert.deepEqual(await adminDelete(admin, a.user), { message: 'User deleted' });
    assert.deepEqual(await everythingOf(a), { user: false, rows: [0, 0, 0, 0, 0], files: 0 });
    for (const root of Object.values(ROOTS)) assert.equal(fs.existsSync(path.join(root, a.user)), false, `${root} still has A's directory`);
    assert.deepEqual(await everythingOf(b), intact, 'B keeps every row and file');

    // B deletes their own account: same removal, and the browser's cookies are cleared.
    const res = response();
    const self = await settingsRoutes['DELETE /api/settings/account']({ url: '/api/settings/account', headers: {} } as FixtureValue, b.user, {}, res as FixtureValue);
    assert.deepEqual(self, { deleted: true });
    const cookies = (res.headers.get('Set-Cookie') as string[]).join('\n');
    assert.match(cookies, /auth-token=;/);
    assert.match(cookies, /csrf-token=;/);
    assert.deepEqual(await everythingOf(b), { user: false, rows: [0, 0, 0, 0, 0], files: 0 });
    assert.equal(await userExists(admin), true);
  });
