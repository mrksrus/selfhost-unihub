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

test('server deletion worker stops after setting is disabled between messages', async (t) => {
  const mailPath = require.resolve('../src/services/mail');
  const statePath = require.resolve('../src/state');
  const encryptionPath = require.resolve('../src/security/encryption');
  const imapSimplePath = require.resolve('imap-simple');
  const originalMail = require.cache[mailPath];
  const originalState = require.cache[statePath];
  const originalEncryption = require.cache[encryptionPath];
  const originalImapSimple = require.cache[imapSimplePath];

  t.after(() => {
    if (originalMail) require.cache[mailPath] = originalMail;
    else delete require.cache[mailPath];
    if (originalState) require.cache[statePath] = originalState;
    else delete require.cache[statePath];
    if (originalEncryption) require.cache[encryptionPath] = originalEncryption;
    else delete require.cache[encryptionPath];
    if (originalImapSimple) require.cache[imapSimplePath] = originalImapSimple;
    else delete require.cache[imapSimplePath];
  });

  delete require.cache[mailPath];
  let enabledChecks = 0;
  const statusUpdates = [];
  const imapCalls = [];
  const db = {
    execute: async (sql, params = []) => {
      if (sql.includes('FROM mail_accounts') && sql.includes('SELECT *')) {
        return [[{
          id: 'account-1',
          user_id: 'user-1',
          email_address: 'person@example.com',
          username: 'person@example.com',
          imap_host: 'imap.example.com',
          imap_port: 993,
          encrypted_password: 'encrypted-secret',
          allow_self_signed: 0,
        }]];
      }
      if (sql.includes('FROM mail_server_messages')) {
        return [[
          { id: 'queue-1', user_id: 'user-1', mail_account_id: 'account-1', email_id: 'email-1', source_folder: 'INBOX', imap_uid: 10, imap_uidvalidity: 123 },
          { id: 'queue-2', user_id: 'user-1', mail_account_id: 'account-1', email_id: 'email-2', source_folder: 'INBOX', imap_uid: 11, imap_uidvalidity: 123 },
        ]];
      }
      if (sql.includes('SELECT delete_emails_on_server')) {
        enabledChecks++;
        return [[{
          delete_emails_on_server: enabledChecks === 1 ? 1 : 0,
          is_active: 1,
          server_delete_grace_until: new Date(Date.now() - 60_000),
        }]];
      }
      if (sql.includes('UPDATE mail_server_messages')) {
        statusUpdates.push({ status: params[0], id: params[4] });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('UPDATE mail_accounts SET server_delete_last_run_at')) {
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
  };

  setRequireStub(statePath, { db });
  setRequireStub(encryptionPath, { decrypt: value => value === 'encrypted-secret' ? 'secret' : null });
  setRequireStub(imapSimplePath, {
    connect: async () => ({
      imap: {
        _box: { uidvalidity: 123 },
        serverSupports: capability => capability === 'UIDPLUS',
        addFlags: (uid, flag, callback) => {
          imapCalls.push(['addFlags', uid, flag]);
          callback(null);
        },
        delFlags: (uid, flag, callback) => {
          imapCalls.push(['delFlags', uid, flag]);
          callback(null);
        },
        expunge: (uid, callback) => {
          imapCalls.push(['expunge', uid]);
          callback(null);
        },
      },
      on: () => {},
      openBox: async () => {},
      search: async () => [{}],
      end: () => {},
    }),
  });

  const { processMailServerDeletionForAccount } = require('../src/services/mail');
  const result = await processMailServerDeletionForAccount('account-1');

  assert.equal(result.processed, 1);
  assert.equal(result.deleted, 1);
  assert.equal(result.stopped, true);
  assert.deepEqual(statusUpdates, [{ status: 'deleted', id: 'queue-1' }]);
  assert.deepEqual(imapCalls, [
    ['addFlags', 10, '\\Deleted'],
    ['expunge', 10],
  ]);
});
