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
