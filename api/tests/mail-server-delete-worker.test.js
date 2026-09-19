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

for (const scenario of ['disabled-between-messages', 'already-sync', 'sync-during-search', 'cancel-during-search', 'module-paused', 'module-paused-during-search']) {
test(`server deletion worker: ${scenario}`, async (t) => {
  const mailPath = require.resolve('../src/services/mail');
  const statePath = require.resolve('../src/state');
  const encryptionPath = require.resolve('../src/security/encryption');
  const imapSimplePath = require.resolve('imap-simple');
  const modulesPath = require.resolve('../src/services/module-settings');
  const originalModules = require.cache[modulesPath];
  delete require.cache[modulesPath];
  const originalMail = require.cache[mailPath];
  const originalState = require.cache[statePath];
  const originalEncryption = require.cache[encryptionPath];
  const originalImapSimple = require.cache[imapSimplePath];

  t.after(() => {
    if (originalModules) require.cache[modulesPath] = originalModules; else delete require.cache[modulesPath];
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
  let modulePaused = scenario === 'module-paused';
  const statusUpdates = [];
  const imapCalls = [];
  const db = {
    execute: async (sql, params = []) => {
      if (sql.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify({ mail: { background: !modulePaused } }) }]];
      if (sql.includes('FROM mail_accounts') && sql.includes('SELECT *')) {
        return [[{
          id: 'account-1',
          sync_mode: scenario === 'already-sync' ? 'sync' : 'download',
          user_id: 'user-1',
          email_address: 'person@example.com',
          username: 'person@example.com',
          imap_host: '93.184.216.34', // Public literal; the mocked transport never connects.
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
      if (sql.includes('SELECT user_id, delete_emails_on_server')) {
        enabledChecks++;
        return [[{
          user_id: 'user-1',
          delete_emails_on_server: enabledChecks <= 2 ? 1 : 0,
          sync_mode: scenario === 'sync-during-search' && enabledChecks >= 2 ? 'sync' : 'download',
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
      search: async () => {
        if (scenario === 'module-paused-during-search') modulePaused = true;
        if (scenario === 'cancel-during-search') require('../src/services/mail').cancelMailAccountSync('account-1');
        return [{}];
      },
      end: () => {},
    }),
  });

  const { processMailServerDeletionForAccount } = require('../src/services/mail');
  const result = await processMailServerDeletionForAccount('account-1');

  if (['already-sync', 'module-paused'].includes(scenario)) {
    assert.equal(result.skipped, true);
    assert.deepEqual(imapCalls, []);
    assert.deepEqual(statusUpdates, []);
    return;
  }
  if (scenario !== 'disabled-between-messages') {
    assert.equal(result.deleted, 0);
    assert.equal(result.stopped, true);
    assert.deepEqual(imapCalls, []);
    assert.deepEqual(statusUpdates, []);
    return;
  }
  assert.equal(result.processed, 1);
  assert.equal(result.deleted, 1);
  assert.equal(result.stopped, true);
  assert.deepEqual(statusUpdates, [{ status: 'deleted', id: 'queue-1' }]);
  assert.deepEqual(imapCalls, [
    ['addFlags', 10, '\\Deleted'],
    ['expunge', 10],
  ]);
});

}
