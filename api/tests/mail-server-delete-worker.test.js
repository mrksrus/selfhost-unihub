const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function setRequireStub(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

for (const scenario of ['disabled-between-messages', 'already-sync', 'sync-during-search', 'lifecycle-stop-during-search', 'module-paused', 'module-paused-during-search', 'legacy-raw', 'unknown-epoch', 'no-uidplus']) {
test(`server deletion worker: ${scenario}`, async (t) => {
  const oldRoot = process.env.MAIL_RAW_STORAGE_ROOT;
  const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'mail-delete-'));
  process.env.MAIL_RAW_STORAGE_ROOT = root;
  const raw = Buffer.from([0xff, 0x0d, 0x0a, 0]);
  const archived = path.join(root, 'u1', 'email-1.eml');
  await fs.mkdir(path.dirname(archived), { recursive: true });
  await fs.writeFile(archived, raw);
  const archiveFields = { raw_storage_path: archived, raw_sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    raw_bytes: raw.length, raw_format: 'exact_octets', raw_verified: 1, import_complete: 1,
    email_source_folder: 'INBOX', email_imap_uid: 10, email_imap_uidvalidity: 123 };
  if (scenario === 'legacy-raw') { archiveFields.raw_format = 'legacy_normalized'; archiveFields.raw_verified = 0; }
  const queuedEpoch = scenario === 'unknown-epoch' ? null : 123;
  t.after(async () => { if (oldRoot === undefined) delete process.env.MAIL_RAW_STORAGE_ROOT;
    else process.env.MAIL_RAW_STORAGE_ROOT = oldRoot;
    await fs.rm(root, { recursive: true, force: true }); });
  const mailPath = require.resolve('../dist/src/services/mail');
  const statePath = require.resolve('../dist/src/state');
  const encryptionPath = require.resolve('../dist/src/security/encryption');
  const imapClientPath = require.resolve('../dist/src/services/mail-imap-client');
  const modulesPath = require.resolve('../dist/src/services/module-settings');
  const originalModules = require.cache[modulesPath];
  delete require.cache[modulesPath];
  const originalMail = require.cache[mailPath];
  const originalState = require.cache[statePath];
  const originalEncryption = require.cache[encryptionPath];
  const originalImapClient = require.cache[imapClientPath];

  t.after(() => {
    if (originalModules) require.cache[modulesPath] = originalModules; else delete require.cache[modulesPath];
    if (originalMail) require.cache[mailPath] = originalMail;
    else delete require.cache[mailPath];
    if (originalState) require.cache[statePath] = originalState;
    else delete require.cache[statePath];
    if (originalEncryption) require.cache[encryptionPath] = originalEncryption;
    else delete require.cache[encryptionPath];
    if (originalImapClient) require.cache[imapClientPath] = originalImapClient;
    else delete require.cache[imapClientPath];
  });

  t.after(require('./helpers/mail-service-modules').evictMailServiceModules());
  let enabledChecks = 0;
  let modulePaused = scenario === 'module-paused';
  const statusUpdates = [];
  const imapCalls = [];
  const db = {
    execute: async (sql, params = []) => {
      if (sql.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify({ mail: { background: !modulePaused } }) }]];
      if (sql.includes('SELECT user_id FROM mail_accounts WHERE id = ?')) return [[{ user_id: 'user-1' }]];
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
      if (sql.includes('FROM mail_server_messages m JOIN emails e')) {
        if (sql.includes('m.id=?')) return [[{ id: 'queue-1', source_folder: 'INBOX', imap_uid: 10, imap_uidvalidity: queuedEpoch,
          ...archiveFields }]];
        return [[
          { id: 'queue-1', user_id: 'user-1', mail_account_id: 'account-1', email_id: 'email-1', source_folder: 'INBOX', imap_uid: 10, imap_uidvalidity: queuedEpoch, ...archiveFields },
          { id: 'queue-2', user_id: 'user-1', mail_account_id: 'account-1', email_id: 'email-2', source_folder: 'INBOX', imap_uid: 11, imap_uidvalidity: queuedEpoch,
            ...archiveFields, email_imap_uid: 11 },
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
  // Stands in for an authenticated ImapFlow client with INBOX selected.
  const flat = node => Array.isArray(node) ? node.flatMap(flat) : [node.value];
  setRequireStub(imapClientPath, {
    connectImap: async () => Object.assign(new (require('node:events'))(), {
      usable: true, isClosed: false, states: { SELECTED: 3 }, state: 3,
      mailbox: { path: 'INBOX', uidValidity: 123n },
      capabilities: new Map([['IMAP4REV1', true], ...(scenario === 'no-uidplus' ? [] : [['UIDPLUS', true]])]),
      close() {},
      mailboxOpen: async () => ({ path: 'INBOX', uidValidity: 123n }),
      search: async query => {
        if (scenario === 'module-paused-during-search') modulePaused = true;
        if (scenario === 'lifecycle-stop-during-search') {
          const runtime = require('../dist/src/services/mail-engine/runtime');
          t.mock.method(runtime, 'pauseAccount', async () => {});
          await require('../dist/src/services/mail').stopMailAccountWork('account-1', 'Disconnected');
        }
        return [Number(query.uid)];
      },
      exec: async (command, attributes) => {
        imapCalls.push([command, ...attributes.flatMap(flat)]);
        return { next() {}, response: {} };
      },
    }),
  });

  const { processMailServerDeletionForAccount } = require('../dist/src/services/mail');
  const result = await processMailServerDeletionForAccount('account-1');

  if (['already-sync', 'module-paused'].includes(scenario)) {
    assert.equal(result.skipped, true);
    assert.deepEqual(imapCalls, []);
    assert.deepEqual(statusUpdates, []);
    return;
  }
  if (scenario === 'no-uidplus') {
    // Without UIDPLUS only a mailbox-wide EXPUNGE exists: nothing is flagged or expunged.
    assert.equal(result.deleted, 0);
    assert.deepEqual(imapCalls, []);
    assert.equal(statusUpdates[0].status, 'failed');
    return;
  }
  if (['legacy-raw', 'unknown-epoch'].includes(scenario)) {
    assert.equal(result.deleted, 0);
    assert.equal(result.skipped, 2);
    assert.deepEqual(imapCalls, []);
    assert.deepEqual(statusUpdates.map(row => row.status), ['skipped', 'skipped']);
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
    ['UID STORE', '10', '+FLAGS.SILENT', '\\Deleted'],
    ['UID EXPUNGE', '10'],
  ]);
});

}
