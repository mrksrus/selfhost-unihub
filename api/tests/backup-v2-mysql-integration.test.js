const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime');

test('frozen actual 0.10.3 archive restores through the current reader with account/folder relationships', { skip: !process.env.MYSQL_TEST_HOST }, async () => {
  const mysql = require('mysql2/promise');
  const database = process.env.MYSQL_TEST_DATABASE;
  assert.match(database, /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database, user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, connectionLimit: 4 });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-v2-restore-'));
  let owned = false;
  try {
    const [tables] = await pool.query('SHOW TABLES');
    assert.equal(tables.length, 0, 'Use an empty disposable test database');
    owned = true;
    const runtime = createBackupRuntime(directory, 'v2-destination-test-key', pool);
    await runtime('services/database').ensureSchema();
    await runtime('services/notifications').ensureNotificationSchema();
    const user = crypto.randomUUID();
    await pool.execute("INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,'V2 destination')", [user,'v2-destination@example.test','synthetic-password-hash']);
    const fixture = path.join(__dirname, 'fixtures/backups/v2-0.10.3');
    const expected = JSON.parse(await fs.readFile(path.join(fixture, 'expected.json')));
    const bytes = await fs.readFile(path.join(fixture, 'plain.zip'));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected.sha256);
    const backup = runtime('services/backup');
    const parsed = await backup.backupFromZipFile(path.join(fixture, 'plain.zip'));
    assert.equal(parsed.backup.version, 2);
    const result = await backup.importBackupForUser(user, parsed.backup, { mode: 'apply', conflict_mode: 'replace', fileSourcesByPath: parsed.fileSourcesByPath });
    assert.equal(result.valid, true);
    const [[email]] = await pool.execute('SELECT * FROM emails WHERE user_id = ?', [user]);
    assert.equal(email.subject, expected.subject); assert.equal(email.body_text, expected.body);
    assert.equal(email.folder, 'important-v2'); assert.equal(email.filing_account_id, null);
    assert.notEqual(email.mail_account_id, expected.account);
    const [[mapping]] = await pool.execute('SELECT b.* FROM mail_folder_remote_boxes b JOIN mail_accounts a ON a.id=b.mail_account_id WHERE a.user_id=?', [user]);
    assert.equal(mapping.mail_account_id, email.mail_account_id); assert.equal(mapping.remote_name, expected.remote_name);
    assert.notEqual(mapping.folder_id, expected.folder);
  } finally {
    if (owned) {
      const connection = await pool.getConnection();
      try { await connection.query('SET FOREIGN_KEY_CHECKS=0'); const [tables] = await connection.query('SHOW TABLES'); for (const row of tables) await connection.query('DROP TABLE ??', [Object.values(row)[0]]); } finally { await connection.query('SET FOREIGN_KEY_CHECKS=1'); connection.release(); }
    }
    await pool.end(); await fs.rm(directory, { recursive: true, force: true });
  }
});
