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

test('add mail account maps strict IMAP TLS failures to host trust confirmation', async (t) => {
  const routePath = require.resolve('../src/routes/mail');
  const mailServicePath = require.resolve('../src/services/mail');
  const statePath = require.resolve('../src/state');
  const encryptionPath = require.resolve('../src/security/encryption');
  const originalRoute = require.cache[routePath];
  const originalMailService = require.cache[mailServicePath];
  const originalState = require.cache[statePath];
  const originalEncryption = require.cache[encryptionPath];

  t.after(() => {
    if (originalRoute) require.cache[routePath] = originalRoute;
    else delete require.cache[routePath];
    if (originalMailService) require.cache[mailServicePath] = originalMailService;
    else delete require.cache[mailServicePath];
    if (originalState) require.cache[statePath] = originalState;
    else delete require.cache[statePath];
    if (originalEncryption) require.cache[encryptionPath] = originalEncryption;
    else delete require.cache[encryptionPath];
  });

  delete require.cache[routePath];
  setRequireStub(statePath, { db: { execute: async () => [[]] } });
  setRequireStub(encryptionPath, { encrypt: value => `encrypted:${value}` });
  setRequireStub(mailServicePath, {
    DEFAULT_MAIL_SYNC_FETCH_LIMIT: 'all',
    MAIL_SENDER_RULE_MATCH_TYPES: new Set(['domain', 'email']),
    SYSTEM_MAIL_FOLDER_SET: new Set(),
    normalizeMailSenderRuleInput: () => ({ matchType: 'domain', matchValue: 'example.com' }),
    normalizeMailFolderSlug: value => String(value || '').trim().toLowerCase(),
    normalizeMailFolderDisplayName: value => String(value || '').trim(),
    loadMailFoldersForUser: async () => [],
    mailFolderExists: async () => true,
    toBooleanFlag: value => value === true || value === 1 || value === '1',
    loadActiveMailSenderRules: async () => [],
    resolveMailSenderTargetFolder: async () => ({ folder: 'inbox' }),
    ensureDefaultMailFoldersForUser: async () => {},
    normalizeSyncFetchLimit: (value, fallback = 'all') => value || fallback,
    validateMailHostPolicy: async () => ({
      accepted: true,
      mailHostTrust: {
        blocked: false,
        requiresConfirmation: false,
        requiresInsecureTls: false,
        warnings: [],
        assessments: {},
        certificates: {},
      },
    }),
    buildMailHostTrustResult: async ({ imapTlsError }) => ({
      blocked: false,
      requiresConfirmation: true,
      requiresInsecureTls: true,
      warnings: [`IMAP certificate failed: ${imapTlsError}`],
      assessments: { imap: { host: 'mail.example.test', port: 993 }, smtp: { host: 'mail.example.test', port: 587 } },
      certificates: { imap: { authorized: false, error: imapTlsError } },
    }),
    testImapConnection: async () => ({
      success: false,
      error: 'IMAP certificate could not be verified.',
      details: 'self-signed certificate',
      tlsTrustError: true,
    }),
    syncMailAccount: async () => ({ success: true }),
    isAnyMailAccountSyncRunning: () => false,
    getRunningMailSyncAccountIds: () => [],
    sendEmail: async () => ({ success: true }),
    deleteStoredAttachmentFiles: async () => ({ deletedFiles: 0, failedFiles: 0 }),
  });

  const routes = require('../src/routes/mail');
  const result = await routes['POST /api/mail/accounts'](
    { headers: { host: 'localhost' }, url: '/api/mail/accounts' },
    'user-1',
    {
      email_address: 'user@example.test',
      provider: 'custom',
      username: 'user@example.test',
      encrypted_password: 'secret',
      imap_host: 'mail.example.test',
      imap_port: 993,
      smtp_host: 'mail.example.test',
      smtp_port: 587,
      sync_fetch_limit: 'all',
    }
  );

  assert.equal(result.status, 409);
  assert.equal(result.requiresHostTrustConfirmation, true);
  assert.equal(result.mailHostTrust.requiresConfirmation, true);
  assert.equal(result.mailHostTrust.requiresInsecureTls, true);
  assert.equal(result.mailHostTrust.certificates.imap.error, 'self-signed certificate');
});

test('add mail account keeps server deletion off by default and can enable grace period', async (t) => {
  const routePath = require.resolve('../src/routes/mail');
  const mailServicePath = require.resolve('../src/services/mail');
  const statePath = require.resolve('../src/state');
  const encryptionPath = require.resolve('../src/security/encryption');
  const originalRoute = require.cache[routePath];
  const originalMailService = require.cache[mailServicePath];
  const originalState = require.cache[statePath];
  const originalEncryption = require.cache[encryptionPath];
  const inserts = [];

  t.after(() => {
    if (originalRoute) require.cache[routePath] = originalRoute;
    else delete require.cache[routePath];
    if (originalMailService) require.cache[mailServicePath] = originalMailService;
    else delete require.cache[mailServicePath];
    if (originalState) require.cache[statePath] = originalState;
    else delete require.cache[statePath];
    if (originalEncryption) require.cache[encryptionPath] = originalEncryption;
    else delete require.cache[encryptionPath];
  });

  delete require.cache[routePath];
  setRequireStub(statePath, {
    db: {
      execute: async (sql, params = []) => {
        if (sql.includes('INSERT INTO mail_accounts')) {
          inserts.push({ sql, params });
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('SELECT id, user_id, email_address')) {
          const latest = inserts[inserts.length - 1];
          return [[{
            id: latest?.params[0] || 'account-1',
            user_id: 'user-1',
            email_address: latest?.params[2] || 'user@example.test',
            display_name: null,
            provider: 'custom',
            username: latest?.params[5] || 'user@example.test',
            imap_host: latest?.params[6] || 'mail.example.test',
            imap_port: 993,
            smtp_host: latest?.params[8] || 'mail.example.test',
            smtp_port: 587,
            sync_fetch_limit: 'all',
            delete_emails_on_server: latest?.params[14] || 0,
            is_active: 1,
          }]];
        }
        return [[]];
      },
    },
  });
  setRequireStub(encryptionPath, { encrypt: value => `encrypted:${value}` });
  setRequireStub(mailServicePath, {
    DEFAULT_MAIL_SYNC_FETCH_LIMIT: 'all',
    MAIL_SENDER_RULE_MATCH_TYPES: new Set(['domain', 'email']),
    SYSTEM_MAIL_FOLDER_SET: new Set(),
    normalizeMailSenderRuleInput: () => ({ matchType: 'domain', matchValue: 'example.com' }),
    normalizeMailFolderSlug: value => String(value || '').trim().toLowerCase(),
    normalizeMailFolderDisplayName: value => String(value || '').trim(),
    loadMailFoldersForUser: async () => [],
    mailFolderExists: async () => true,
    toBooleanFlag: value => value === true || value === 1 || value === '1',
    loadActiveMailSenderRules: async () => [],
    resolveMailSenderTargetFolder: async () => ({ folder: 'inbox' }),
    ensureDefaultMailFoldersForUser: async () => {},
    normalizeSyncFetchLimit: (value, fallback = 'all') => value || fallback,
    validateMailHostPolicy: async () => ({
      accepted: true,
      mailHostTrust: { blocked: false, requiresConfirmation: false, requiresInsecureTls: false, warnings: [], assessments: {}, certificates: {} },
    }),
    buildMailHostTrustResult: async () => ({}),
    testImapConnection: async () => ({ success: true }),
    syncMailAccount: async () => ({ success: true }),
    isAnyMailAccountSyncRunning: () => false,
    getRunningMailSyncAccountIds: () => [],
    getRunningMailServerDeleteAccountIds: () => [],
    sendEmail: async () => ({ success: true }),
    deleteStoredAttachmentFiles: async () => ({ deletedFiles: 0, failedFiles: 0 }),
  });

  const routes = require('../src/routes/mail');
  const baseBody = {
    email_address: 'user@example.test',
    provider: 'custom',
    username: 'user@example.test',
    encrypted_password: 'secret',
    imap_host: 'mail.example.test',
    imap_port: 993,
    smtp_host: 'mail.example.test',
    smtp_port: 587,
    sync_fetch_limit: 'all',
  };

  await routes['POST /api/mail/accounts']({ headers: { host: 'localhost' }, url: '/api/mail/accounts' }, 'user-1', baseBody);
  await routes['POST /api/mail/accounts'](
    { headers: { host: 'localhost' }, url: '/api/mail/accounts' },
    'user-1',
    { ...baseBody, email_address: 'enabled@example.test', username: 'enabled@example.test', delete_emails_on_server: true }
  );

  assert.equal(inserts[0].params[14], 0);
  assert.equal(inserts[0].sql.includes('DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)'), false);
  assert.equal(inserts[1].params[14], 1);
  assert.match(inserts[1].sql, /DATE_ADD\(UTC_TIMESTAMP\(\), INTERVAL 10 MINUTE\)/);
});

test('update mail account can disable server deletion without password changes', async (t) => {
  const routePath = require.resolve('../src/routes/mail');
  const mailServicePath = require.resolve('../src/services/mail');
  const statePath = require.resolve('../src/state');
  const encryptionPath = require.resolve('../src/security/encryption');
  const originalRoute = require.cache[routePath];
  const originalMailService = require.cache[mailServicePath];
  const originalState = require.cache[statePath];
  const originalEncryption = require.cache[encryptionPath];
  const updates = [];
  let imapTests = 0;
  let cancellations = 0;
  const queueUpdates = [];

  t.after(() => {
    if (originalRoute) require.cache[routePath] = originalRoute;
    else delete require.cache[routePath];
    if (originalMailService) require.cache[mailServicePath] = originalMailService;
    else delete require.cache[mailServicePath];
    if (originalState) require.cache[statePath] = originalState;
    else delete require.cache[statePath];
    if (originalEncryption) require.cache[encryptionPath] = originalEncryption;
    else delete require.cache[encryptionPath];
  });

  delete require.cache[routePath];
  setRequireStub(statePath, {
    db: {
      execute: async (sql, params = []) => {
        if (sql.includes('SELECT * FROM mail_accounts')) {
          return [[{
            id: 'account-1',
            user_id: 'user-1',
            email_address: 'user@example.test',
            username: 'user@example.test',
            imap_host: 'mail.example.test',
            imap_port: 993,
            smtp_host: 'mail.example.test',
            smtp_port: 587,
            encrypted_password: 'encrypted:secret',
            allow_self_signed: 0,
            delete_emails_on_server: 1,
          }]];
        }
        if (sql.includes('UPDATE mail_server_messages')) { queueUpdates.push(sql); return [{ affectedRows: 1 }]; }
        if (sql.includes('SELECT id FROM emails')) return [[{ id: 'protected-message' }]];
        if (sql.includes('UPDATE mail_accounts SET')) {
          updates.push({ sql, params });
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('SELECT id, user_id, email_address')) {
          return [[{
            id: 'account-1',
            user_id: 'user-1',
            email_address: 'user@example.test',
            username: 'user@example.test',
            delete_emails_on_server: 0,
          }]];
        }
        return [[]];
      },
    },
  });
  setRequireStub(encryptionPath, { encrypt: value => `encrypted:${value}` });
  setRequireStub(mailServicePath, {
    DEFAULT_MAIL_SYNC_FETCH_LIMIT: 'all',
    MAIL_SENDER_RULE_MATCH_TYPES: new Set(['domain', 'email']),
    SYSTEM_MAIL_FOLDER_SET: new Set(),
    normalizeMailSenderRuleInput: () => ({ matchType: 'domain', matchValue: 'example.com' }),
    normalizeMailFolderSlug: value => String(value || '').trim().toLowerCase(),
    normalizeMailFolderDisplayName: value => String(value || '').trim(),
    loadMailFoldersForUser: async () => [],
    mailFolderExists: async () => true,
    toBooleanFlag: value => value === true || value === 1 || value === '1',
    loadActiveMailSenderRules: async () => [],
    resolveMailSenderTargetFolder: async () => ({ folder: 'inbox' }),
    ensureDefaultMailFoldersForUser: async () => {},
    normalizeSyncFetchLimit: (value, fallback = 'all') => value || fallback,
    validateMailHostPolicy: async () => ({ accepted: true, mailHostTrust: {} }),
    buildMailHostTrustResult: async () => ({}),
    testImapConnection: async () => {
      imapTests++;
      return { success: true };
    },
    cancelMailAccountSync: () => { cancellations++; },
    syncMailAccount: async () => ({ success: true }),
    isAnyMailAccountSyncRunning: () => false,
    getRunningMailSyncAccountIds: () => [],
    getRunningMailServerDeleteAccountIds: () => [],
    seedMailServerDeletionQueueForAccount: async () => ({ queued: 0 }),
    sendEmail: async () => ({ success: true }),
    deleteStoredAttachmentFiles: async () => ({ deletedFiles: 0, failedFiles: 0 }),
  });

  const routes = require('../src/routes/mail');
  const result = await routes['PUT /api/mail/accounts/:id'](
    { headers: { host: 'localhost' }, url: '/api/mail/accounts/account-1' },
    'user-1',
    { delete_emails_on_server: false }
  );

  assert.equal(result.account.delete_emails_on_server, false);
  assert.equal(imapTests, 0);
  assert.match(updates[0].sql, /delete_emails_on_server = FALSE/);
  assert.match(updates[0].sql, /server_delete_grace_until = NULL/);
  const put = body => routes['PUT /api/mail/accounts/:id']({ headers: { host: 'localhost' }, url: '/api/mail/accounts/account-1' }, 'user-1', body);
  assert.equal((await put({ sync_mode: 'sync' })).status, 400);
  assert.equal(updates.length, 1, 'Unconfirmed switch cannot write');
  const { withMailAccountLock } = require('../src/services/mail-account-lock');
  let release;
  const holding = withMailAccountLock('account-1', () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const switching = put({ sync_mode: 'sync', sync_mode_confirmed: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1);
  assert.equal(updates.length, 1, 'Mode commit waits for the worker lock');
  release(); await holding;
  assert.ok((await switching).account);
  assert.match(updates[1].sql, /sync_mode = .*sync_status = .*delete_emails_on_server = FALSE/);
  assert.deepEqual(updates[1].params.slice(0, 2), ['sync', 'pending']);
  assert.equal(queueUpdates.length, 1);
  assert.equal((await put({ imap_host: 'different.example.test' })).status, 409);
  assert.equal(imapTests, 0, 'Identity rejection precedes provider connection');

});
