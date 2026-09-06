const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { loadMailFoldersForUser, loadExistingImportedUidSet } = require('../src/services/mail');
const { loadFolderSyncState, saveFolderSyncState } = require('../src/services/mail-sync-state');
const { persistImportedMessage } = require('../src/services/mail-import');

test('MySQL mail defaults, folder checkpoints and atomic import rollback', { skip: !process.env.MYSQL_TEST_HOST }, async (t) => {
  const connection = await mysql.createConnection({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
    database: process.env.MYSQL_TEST_DATABASE || 'unihub_test' });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-mysql-'));
  const previousRoot = process.env.MAIL_ATTACHMENT_UPLOAD_ROOT;
  process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = root;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.MAIL_ATTACHMENT_UPLOAD_ROOT;
    else process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = previousRoot;
    await connection.end();
    await fs.rm(root, { recursive: true, force: true });
  });
  // Temporary tables are connection-local and never modify a deployment schema.
  await connection.execute("SET SESSION sql_mode = 'STRICT_TRANS_TABLES'");
  await connection.execute(`CREATE TEMPORARY TABLE mail_folders (id CHAR(36) PRIMARY KEY, user_id CHAR(36), slug VARCHAR(64),
    display_name VARCHAR(128), is_system BOOLEAN, position INT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY(user_id, slug)) ENGINE=InnoDB`);
  await connection.execute(`CREATE TEMPORARY TABLE mail_sync_state (mail_account_id CHAR(36), source_folder VARCHAR(255), uidvalidity BIGINT,
    last_uid BIGINT NOT NULL DEFAULT 0, initialized BOOLEAN NOT NULL DEFAULT FALSE, last_synced_at TIMESTAMP NULL,
    PRIMARY KEY(mail_account_id, source_folder)) ENGINE=InnoDB`);
  await connection.execute(`CREATE TEMPORARY TABLE emails (id CHAR(36) PRIMARY KEY, user_id CHAR(36), mail_account_id CHAR(36),
    message_id VARCHAR(500), subject TEXT, from_address VARCHAR(255), from_name VARCHAR(255), to_addresses JSON,
    body_text LONGTEXT, body_html LONGTEXT, has_attachments BOOLEAN, received_at TIMESTAMP NULL, folder VARCHAR(64),
    source_folder VARCHAR(255), imap_uid BIGINT, imap_uidvalidity BIGINT, raw_storage_path TEXT, raw_sha256 CHAR(64),
    is_read BOOLEAN, import_complete BOOLEAN NOT NULL DEFAULT FALSE) ENGINE=InnoDB`);
  await connection.execute(`CREATE TEMPORARY TABLE email_attachments (id CHAR(36) PRIMARY KEY, email_id CHAR(36), user_id CHAR(36),
    filename VARCHAR(255), content_type VARCHAR(100), size_bytes BIGINT, storage_path TEXT, content_id VARCHAR(255)) ENGINE=InnoDB`);
  const userId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  await loadMailFoldersForUser(userId, connection);
  await connection.execute("UPDATE mail_folders SET display_name = 'Personal Inbox', position = 777 WHERE user_id = ? AND slug = 'inbox'", [userId]);
  const folders = await loadMailFoldersForUser(userId, connection);
  assert.equal(folders.length, 10);
  assert.equal(folders.find(row => row.slug === 'inbox').display_name, 'Personal Inbox');
  assert.equal(folders.find(row => row.slug === 'inbox').position, 777);
  await saveFolderSyncState(connection, accountId, 'INBOX', 123, 5);
  assert.deepEqual(await loadFolderSyncState(connection, accountId, 'INBOX', 123), { incremental: true, lastUid: 5 });
  assert.deepEqual(await loadFolderSyncState(connection, accountId, 'INBOX', 124), { incremental: false, lastUid: 0 });
  assert.deepEqual(await loadFolderSyncState(connection, accountId, 'New Folder', 123), { incremental: false, lastUid: 0 });
  const db = { async getConnection() { return {
    execute: (...args) => connection.execute(...args), beginTransaction: () => connection.beginTransaction(),
    commit: () => connection.commit(), rollback: () => connection.rollback(), release() {},
  }; } };
  const args = { db, account: { user_id: userId }, accountId, folderName: 'INBOX', uid: 6, uidValidity: 123,
    messageId: '<valid@example.test>', fullEmail: 'raw', parsed: { subject: 'Imported', text: 'hello', attachments: [
      { filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('hello') },
    ] }, fromAddress: 'sender@example.test', fromName: 'Sender', toAddresses: ['recipient@example.test'], folder: 'inbox', isRead: false,
    suppressNotifications: true, enqueueDeletion: async () => {}, async archiveRaw({ emailId }) {
      const rawStoragePath = path.join(root, `${emailId}.eml`);
      await fs.writeFile(rawStoragePath, 'raw');
      return { rawStoragePath, rawSha256: 'a'.repeat(64) };
    },
  };
  await persistImportedMessage(args);
  assert.deepEqual([...await loadExistingImportedUidSet({ connection, accountId, folderName: 'INBOX', uidValidity: 123, uids: [6] })], [6]);
  const beforeFiles = await fs.readdir(root, { recursive: true });
  await assert.rejects(persistImportedMessage({ ...args, uid: 7, messageId: '<invalid@example.test>', parsed: {
    ...args.parsed, attachments: [{ filename: 'b.txt', contentType: 'x'.repeat(101), content: Buffer.from('invalid') }],
  } }), error => error.code === 'ER_DATA_TOO_LONG');
  const [[counts]] = await connection.execute('SELECT COUNT(*) AS total FROM emails');
  assert.equal(counts.total, 1);
  assert.deepEqual((await fs.readdir(root, { recursive: true })).sort(), beforeFiles.sort());
});
