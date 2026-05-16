const test = require('node:test');
const assert = require('node:assert/strict');

function setRequireStub(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

test('backup import maps restored mail to existing account and email sync identity', async (t) => {
  const backupPath = require.resolve('../src/services/backup');
  const statePath = require.resolve('../src/state');
  const mailPath = require.resolve('../src/services/mail');
  const originalBackup = require.cache[backupPath];
  const originalState = require.cache[statePath];
  const originalMail = require.cache[mailPath];
  const calls = [];

  t.after(() => {
    if (originalBackup) require.cache[backupPath] = originalBackup;
    else delete require.cache[backupPath];
    if (originalState) require.cache[statePath] = originalState;
    else delete require.cache[statePath];
    if (originalMail) require.cache[mailPath] = originalMail;
    else delete require.cache[mailPath];
  });

  delete require.cache[backupPath];
  setRequireStub(mailPath, {
    MAIL_RAW_STORAGE_ROOT: '/tmp/unihub-test-mail-raw',
    DEFAULT_MAIL_SYNC_FETCH_LIMIT: 'all',
    normalizeSyncFetchLimit: (value, fallback = 'all') => value || fallback,
  });

  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    execute: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT id FROM mail_accounts WHERE user_id = ? AND email_address = ?')) {
        return [[{ id: 'existing-account' }]];
      }
      if (sql.includes('SELECT id FROM emails WHERE id = ? AND user_id = ?')) {
        return [[]];
      }
      if (sql.includes('SELECT id FROM emails WHERE user_id = ? AND mail_account_id = ? AND message_id = ?')) {
        return [[{ id: 'existing-email' }]];
      }
      if (sql.includes('SELECT id FROM email_attachments WHERE id = ? AND user_id = ?')) {
        return [[]];
      }
      if (sql.includes('SELECT id FROM email_attachments WHERE user_id = ? AND email_id = ? AND content_id = ?')) {
        return [[]];
      }
      if (sql.includes('FROM email_attachments')) {
        return [[]];
      }
      return [[]];
    },
  };

  setRequireStub(statePath, {
    db: {
      getConnection: async () => connection,
      execute: async () => [[]],
    },
  });

  const { importBackupForUser } = require('../src/services/backup');
  const backup = {
    app: 'unihub',
    version: 1,
    files: [],
    data: {
      mail_accounts: [{
        id: 'backup-account',
        user_id: 'old-user',
        email_address: 'person@example.com',
        provider: 'custom',
        username: 'person@example.com',
        imap_host: 'imap.example.com',
        imap_port: 993,
        smtp_host: 'smtp.example.com',
        smtp_port: 587,
        encrypted_password: 'encrypted-secret',
        sync_fetch_limit: 'all',
        delete_emails_on_server: true,
        server_delete_enabled_at: '2026-05-15T09:30:00.000Z',
        server_delete_grace_until: '2026-05-15T09:40:00.000Z',
        last_synced_at: '2026-05-15T10:00:00.000Z',
      }],
      emails: [{
        id: 'backup-email',
        user_id: 'old-user',
        mail_account_id: 'backup-account',
        message_id: '<message@example.com>',
        subject: 'Existing message',
        from_address: 'sender@example.com',
        to_addresses: ['person@example.com'],
        folder: 'inbox',
        source_folder: 'INBOX',
        imap_uid: 42,
        imap_uidvalidity: 123,
        is_read: true,
        received_at: '2026-05-15T09:00:00.000Z',
      }],
      email_attachments: [{
        id: 'backup-attachment',
        user_id: 'old-user',
        email_id: 'backup-email',
        filename: 'invoice.pdf',
        size_bytes: 10,
      }],
    },
  };

  const result = await importBackupForUser('new-user', backup, {
    mode: 'apply',
    conflict_mode: 'replace',
    credentials_mode: 'restore',
  });

  assert.equal(result.valid, true);
  const accountWrite = calls.find(call => call.sql.includes('UPDATE mail_accounts'));
  assert.equal(accountWrite.params[0], 'person@example.com');
  assert.equal(accountWrite.params[15], '2026-05-15 10:00:00');
  assert.equal(accountWrite.params[16], 'existing-account');
  assert.match(accountWrite.sql, /delete_emails_on_server = FALSE/);
  assert.match(accountWrite.sql, /server_delete_grace_until = NULL/);

  const emailWrite = calls.find(call => call.sql.includes('INSERT INTO emails'));
  assert.equal(emailWrite.params[0], 'existing-email');
  assert.equal(emailWrite.params[2], 'existing-account');
  assert.equal(emailWrite.params[13], 'INBOX');
  assert.equal(emailWrite.params[14], 42);
  assert.equal(emailWrite.params[15], 123);
  assert.equal(emailWrite.params[22], '2026-05-15 09:00:00');

  const attachmentWrite = calls.find(call => call.sql.includes('INSERT INTO email_attachments'));
  assert.equal(attachmentWrite.params[1], 'existing-email');
});
