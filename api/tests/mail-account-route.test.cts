import type { FixtureValue, With, RouteTable } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');

function setRequireStub(modulePath: string, exports: FixtureValue) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  } as NodeJS.Module;
}

test('add mail account maps strict IMAP TLS failures to host trust confirmation', async (t) => {
  const routePath = require.resolve('../dist/src/routes/mail');
  const mailServicePath = require.resolve('../dist/src/services/mail');
  const statePath = require.resolve('../dist/src/state');
  const encryptionPath = require.resolve('../dist/src/security/encryption');
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

  t.after(require('./helpers/mail-service-modules.cts').evictMailRouteModules());
  setRequireStub(statePath, { db: { execute: async () => [[]] } });
  setRequireStub(encryptionPath, { encrypt: (value: FixtureValue) => `encrypted:${value}` });
  setRequireStub(mailServicePath, {
    DEFAULT_MAIL_SYNC_FETCH_LIMIT: 'all',
    MAIL_SENDER_RULE_MATCH_TYPES: new Set<FixtureValue>(['domain', 'email']),
    SYSTEM_MAIL_FOLDER_SET: new Set<FixtureValue>(),
    normalizeMailSenderRuleInput: () => ({ matchType: 'domain', matchValue: 'example.com' }),
    normalizeMailFolderSlug: (value: FixtureValue) => String(value || '').trim().toLowerCase(),
    normalizeMailFolderDisplayName: (value: FixtureValue) => String(value || '').trim(),
    loadMailFoldersForUser: async () => [],
    mailFolderExists: async () => true,
    toBooleanFlag: (value: FixtureValue) => value === true || value === 1 || value === '1',
    loadActiveMailSenderRules: async () => [],
    resolveMailSenderTargetFolder: async () => ({ folder: 'inbox' }),
    ensureDefaultMailFoldersForUser: async () => {},
    normalizeSyncFetchLimit: (value: FixtureValue, fallback = 'all') => value || fallback,
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
    buildMailHostTrustResult: async ({ imapTlsError }: FixtureValue) => ({
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
    scheduleMailAccountSync: () => ({ started: true, promise: Promise.resolve({ success: true }) }),
    isAnyMailAccountSyncRunning: () => false,
    getRunningMailSyncAccountIds: () => [],
    sendEmail: async () => ({ success: true }),
    deleteStoredAttachmentFiles: async () => ({ deletedFiles: 0, failedFiles: 0 }),
  });

  const routes = require('../dist/src/routes/mail') as RouteTable<typeof import('../src/routes/mail')>;
  const result = await routes['POST /api/mail/accounts'](
    { headers: { host: 'localhost' }, url: '/api/mail/accounts' } as FixtureValue,
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
  assert.equal((result as With<typeof result, 'requiresHostTrustConfirmation'>).requiresHostTrustConfirmation, true);
  assert.equal(result.mailHostTrust!.requiresConfirmation, true);
  assert.equal(result.mailHostTrust!.requiresInsecureTls, true);
  assert.equal(result.mailHostTrust!.certificates.imap!.error, 'self-signed certificate');
});

test('add mail account keeps server deletion off by default and can enable grace period', async (t) => {
  const routePath = require.resolve('../dist/src/routes/mail');
  const mailServicePath = require.resolve('../dist/src/services/mail');
  const statePath = require.resolve('../dist/src/state');
  const encryptionPath = require.resolve('../dist/src/security/encryption');
  const originalRoute = require.cache[routePath];
  const originalMailService = require.cache[mailServicePath];
  const originalState = require.cache[statePath];
  const originalEncryption = require.cache[encryptionPath];
  const inserts: FixtureValue[] = [];

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

  t.after(require('./helpers/mail-service-modules.cts').evictMailRouteModules());
  setRequireStub(statePath, {
    db: {
      execute: async (sql: string, params: FixtureValue[] = []) => {
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
  setRequireStub(encryptionPath, { encrypt: (value: FixtureValue) => `encrypted:${value}` });
  setRequireStub(mailServicePath, {
    DEFAULT_MAIL_SYNC_FETCH_LIMIT: 'all',
    MAIL_SENDER_RULE_MATCH_TYPES: new Set<FixtureValue>(['domain', 'email']),
    SYSTEM_MAIL_FOLDER_SET: new Set<FixtureValue>(),
    normalizeMailSenderRuleInput: () => ({ matchType: 'domain', matchValue: 'example.com' }),
    normalizeMailFolderSlug: (value: FixtureValue) => String(value || '').trim().toLowerCase(),
    normalizeMailFolderDisplayName: (value: FixtureValue) => String(value || '').trim(),
    loadMailFoldersForUser: async () => [],
    mailFolderExists: async () => true,
    toBooleanFlag: (value: FixtureValue) => value === true || value === 1 || value === '1',
    loadActiveMailSenderRules: async () => [],
    resolveMailSenderTargetFolder: async () => ({ folder: 'inbox' }),
    ensureDefaultMailFoldersForUser: async () => {},
    normalizeSyncFetchLimit: (value: FixtureValue, fallback = 'all') => value || fallback,
    validateMailHostPolicy: async () => ({
      accepted: true,
      mailHostTrust: { blocked: false, requiresConfirmation: false, requiresInsecureTls: false, warnings: [], assessments: {}, certificates: {} },
    }),
    buildMailHostTrustResult: async () => ({}),
    testImapConnection: async () => ({ success: true }),
    syncMailAccount: async () => ({ success: true }),
    scheduleMailAccountSync: () => ({ started: true, promise: Promise.resolve({ success: true }) }),
    isAnyMailAccountSyncRunning: () => false,
    getRunningMailSyncAccountIds: () => [],
    getRunningMailServerDeleteAccountIds: () => [],
    sendEmail: async () => ({ success: true }),
    deleteStoredAttachmentFiles: async () => ({ deletedFiles: 0, failedFiles: 0 }),
  });

  const routes = require('../dist/src/routes/mail') as RouteTable<typeof import('../src/routes/mail')>;
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

  await routes['POST /api/mail/accounts']({ headers: { host: 'localhost' }, url: '/api/mail/accounts' } as FixtureValue, 'user-1', baseBody);
  await routes['POST /api/mail/accounts'](
    { headers: { host: 'localhost' }, url: '/api/mail/accounts' } as FixtureValue,
    'user-1',
    { ...baseBody, email_address: 'enabled@example.test', username: 'enabled@example.test', delete_emails_on_server: true }
  );

  assert.equal(inserts[0].params[14], 0);
  assert.equal(inserts[0].sql.includes('DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)'), false);
  assert.equal(inserts[1].params[14], 1);
  assert.match(inserts[1].sql, /DATE_ADD\(UTC_TIMESTAMP\(\), INTERVAL 10 MINUTE\)/);
});

test('update mail account can disable server deletion without password changes', async (t) => {
  const routePath = require.resolve('../dist/src/routes/mail');
  const mailServicePath = require.resolve('../dist/src/services/mail');
  const statePath = require.resolve('../dist/src/state');
  const encryptionPath = require.resolve('../dist/src/security/encryption');
  const originalRoute = require.cache[routePath];
  const originalMailService = require.cache[mailServicePath];
  const originalState = require.cache[statePath];
  const originalEncryption = require.cache[encryptionPath];
  const updates: FixtureValue[] = [];
  let imapTests = 0;
  let cancellations = 0;
  const queueUpdates = [];
  const resumes: FixtureValue[] = [];
  t.mock.method((require('../dist/src/services/mail-engine/runtime') as typeof import('../src/services/mail-engine/runtime')), 'resumeAccount', async (input: FixtureValue) => {
    resumes.push(input); return { resumed: 0, retired: 0 };
  });

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

  t.after(require('./helpers/mail-service-modules.cts').evictMailRouteModules());
  setRequireStub(statePath, {
    db: {
      execute: async (sql: string, params: FixtureValue[] = []) => {
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
            is_active: 1,
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
  setRequireStub(encryptionPath, { encrypt: (value: FixtureValue) => `encrypted:${value}` });
  setRequireStub(mailServicePath, {
    DEFAULT_MAIL_SYNC_FETCH_LIMIT: 'all',
    MAIL_SENDER_RULE_MATCH_TYPES: new Set<FixtureValue>(['domain', 'email']),
    SYSTEM_MAIL_FOLDER_SET: new Set<FixtureValue>(),
    normalizeMailSenderRuleInput: () => ({ matchType: 'domain', matchValue: 'example.com' }),
    normalizeMailFolderSlug: (value: FixtureValue) => String(value || '').trim().toLowerCase(),
    normalizeMailFolderDisplayName: (value: FixtureValue) => String(value || '').trim(),
    loadMailFoldersForUser: async () => [],
    mailFolderExists: async () => true,
    toBooleanFlag: (value: FixtureValue) => value === true || value === 1 || value === '1',
    loadActiveMailSenderRules: async () => [],
    resolveMailSenderTargetFolder: async () => ({ folder: 'inbox' }),
    ensureDefaultMailFoldersForUser: async () => {},
    normalizeSyncFetchLimit: (value: FixtureValue, fallback = 'all') => value || fallback,
    validateMailHostPolicy: async () => ({ accepted: true, mailHostTrust: {} }),
    buildMailHostTrustResult: async () => ({}),
    testImapConnection: async () => {
      imapTests++;
      return { success: true };
    },
    cancelMailAccountSync: () => { assert.fail('Settings changes must stop all account work, not merely scans'); },
    stopMailAccountWork: async (accountId: string, reason: FixtureValue) => {
      assert.equal(accountId, 'account-1'); assert.equal(reason, 'Account settings changing'); cancellations++;
    },
    syncMailAccount: async () => ({ success: true }),
    scheduleMailAccountSync: () => ({ started: true, promise: Promise.resolve({ success: true }) }),
    isAnyMailAccountSyncRunning: () => false,
    getRunningMailSyncAccountIds: () => [],
    getRunningMailServerDeleteAccountIds: () => [],
    seedMailServerDeletionQueueForAccount: async () => ({ queued: 0 }),
    sendEmail: async () => ({ success: true }),
    deleteStoredAttachmentFiles: async () => ({ deletedFiles: 0, failedFiles: 0 }),
  });

  const routes = require('../dist/src/routes/mail') as RouteTable<typeof import('../src/routes/mail')>;
  const result = await routes['PUT /api/mail/accounts/:id'](
    { headers: { host: 'localhost' }, url: '/api/mail/accounts/account-1' } as FixtureValue,
    'user-1',
    { delete_emails_on_server: false }
  );

  assert.equal(result.error, undefined);
  assert.equal(result.account!.delete_emails_on_server, false);
  assert.deepEqual(resumes, [{ userId: 'user-1', accountId: 'account-1' }]);
  assert.equal(imapTests, 0);
  assert.match(updates[0].sql, /delete_emails_on_server = FALSE/);
  assert.match(updates[0].sql, /server_delete_grace_until = NULL/);
  const put = (body: FixtureValue) => routes['PUT /api/mail/accounts/:id']({ headers: { host: 'localhost' }, url: '/api/mail/accounts/account-1' } as FixtureValue, 'user-1', body);
  const unconfirmed = await put({ sync_mode: 'sync', sync_mode_confirmed: true });
  assert.equal(unconfirmed.status, 400);
  assert.equal((unconfirmed as FixtureValue).requires_confirmation, true);
  assert.equal((await put({ sync_mode: 'sync', confirm_address: 'someone-else@example.test' })).status, 400);
  assert.equal((await put({ sync_window_days: 7 })).status, 400, 'Only the offered windows are accepted');
  assert.equal(updates.length, 1, 'Unconfirmed switch cannot write');
  const { withMailAccountLock } = require('../dist/src/services/mail-account-lock') as typeof import('../src/services/mail-account-lock');
  let release: FixtureValue;
  const holding = withMailAccountLock('account-1', () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const switching = put({ sync_mode: 'sync', sync_mode_confirmed: true, confirm_address: 'USER@example.test',
    sync_window_days: '', trash_window_days: '90' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1);
  assert.equal(updates.length, 1, 'Mode commit waits for the worker lock');
  release(); await holding;
  assert.ok(((await switching) as FixtureValue).account);
  assert.equal(cancellations, 2);
  assert.equal(resumes.length, 2);
  assert.match(updates[1].sql, /sync_mode = .*sync_status = .*delete_emails_on_server = FALSE/);
  assert.deepEqual(updates[1].params.slice(0, 2), ['sync', 'pending']);
  assert.match(updates[1].sql, /sync_policy_confirmed_at = UTC_TIMESTAMP\(\)/, 'The typed address confirms the Sync policy');
  assert.match(updates[1].sql, /sync_window_days = \?, trash_window_days = \?/);
  assert.deepEqual(updates[1].params.slice(2, 4), [null, 90], 'An empty window means all mail');
  assert.equal(queueUpdates.length, 1);
  assert.equal((await put({ imap_host: 'different.example.test' })).status, 409);
  assert.equal(imapTests, 0, 'Identity rejection precedes provider connection');

});

test('reconnect uses the saved password of an account a restore paused, never of a disconnected one', async (t) => {
  const routePath = require.resolve('../dist/src/routes/mail');
  const mailServicePath = require.resolve('../dist/src/services/mail');
  const statePath = require.resolve('../dist/src/state');
  const encryptionPath = require.resolve('../dist/src/security/encryption');
  const saved = Object.fromEntries([routePath, mailServicePath, statePath, encryptionPath].map(path => [path, require.cache[path]]));
  t.after(() => {
    for (const [path, entry] of Object.entries(saved)) { if (entry) require.cache[path] = entry; else delete require.cache[path]; }
  });
  t.after(require('./helpers/mail-service-modules.cts').evictMailRouteModules());
  const resumes: FixtureValue[] = [], updates: FixtureValue[] = [], loginTests: FixtureValue[] = [];
  t.mock.method((require('../dist/src/services/mail-engine/runtime') as typeof import('../src/services/mail-engine/runtime')), 'resumeAccount', async (input: FixtureValue) => { resumes.push(input); return { resumed: 0, retired: 0 }; });
  let row: FixtureValue;
  setRequireStub(statePath, { db: { execute: async (sql: string, params: FixtureValue[] = []) => {
    if (sql.includes('SELECT * FROM mail_accounts')) return [[{ id: 'account-1', user_id: 'user-1', email_address: 'user@example.test', username: 'user@example.test',
      imap_host: 'mail.example.test', imap_port: 993, smtp_host: 'mail.example.test', smtp_port: 587, allow_self_signed: 0, delete_emails_on_server: 0, sync_mode: 'download', ...row }]];
    if (sql.includes('UPDATE mail_accounts SET')) { updates.push({ sql, params }); return [{ affectedRows: 1 }]; }
    if (sql.includes('SELECT id, user_id, email_address')) return [[{ id: 'account-1', user_id: 'user-1', email_address: 'user@example.test', is_active: 1 }]];
    return [[]];
  } } });
  setRequireStub(encryptionPath, { encrypt: (value: FixtureValue) => `encrypted:${value}` });
  setRequireStub(mailServicePath, {
    DEFAULT_MAIL_SYNC_FETCH_LIMIT: 'all', MAIL_SENDER_RULE_MATCH_TYPES: new Set<FixtureValue>(['domain', 'email']), SYSTEM_MAIL_FOLDER_SET: new Set<FixtureValue>(),
    toBooleanFlag: (value: FixtureValue) => value === true || value === 1 || value === '1',
    ensureDefaultMailFoldersForUser: async () => {},
    normalizeSyncFetchLimit: (value: FixtureValue, fallback = 'all') => value || fallback,
    validateMailHostPolicy: async () => ({ accepted: true, mailHostTrust: {} }),
    buildMailHostTrustResult: async () => ({}),
    testImapConnection: async (account: FixtureValue) => { loginTests.push(account.encrypted_password); return { success: true }; },
    stopMailAccountWork: async () => {},
    scheduleMailAccountSync: () => ({ started: true, promise: Promise.resolve({ success: true }) }),
    syncMailAccount: async () => ({ success: true }),
    isAnyMailAccountSyncRunning: () => false, getRunningMailSyncAccountIds: () => [], getRunningMailServerDeleteAccountIds: () => [],
  });
  const routes = require('../dist/src/routes/mail') as RouteTable<typeof import('../src/routes/mail')>;
  const put = (body: FixtureValue) => routes['PUT /api/mail/accounts/:id']({ headers: { host: 'localhost' }, url: '/api/mail/accounts/account-1' } as FixtureValue, 'user-1', body);

  row = { is_active: 0, disconnected_at: null, encrypted_password: 'encrypted:restored' };
  const paused = await put({ is_active: true });
  assert.equal(paused.error, undefined);
  assert.deepEqual(loginTests, ['encrypted:restored'], 'The saved password is tested before the account is switched on');
  assert.match(updates[0].sql, /is_active = TRUE, disconnected_at = NULL/);
  assert.doesNotMatch(updates[0].sql, /encrypted_password/);
  assert.deepEqual(resumes, [{ userId: 'user-1', accountId: 'account-1' }]);

  for (const state of [{ is_active: 0, disconnected_at: null, encrypted_password: null },
    { is_active: 0, disconnected_at: '2026-10-04 09:00:00', encrypted_password: 'encrypted:left-over' }]) {
    row = state;
    const refused = await put({ is_active: true });
    assert.equal(refused.status, 400); assert.match(refused.error!, /credentials again/);
  }
  assert.equal(loginTests.length, 1); assert.equal(updates.length, 1);
});

// The database refuses an undefined bind like mysql2 does; every write,
// connection test and work stop is recorded.
function accountInputFixture(t: import('node:test').TestContext) {
  const routePath = require.resolve('../dist/src/routes/mail');
  const mailServicePath = require.resolve('../dist/src/services/mail');
  const statePath = require.resolve('../dist/src/state');
  const encryptionPath = require.resolve('../dist/src/security/encryption');
  const saved = Object.fromEntries([routePath, mailServicePath, statePath, encryptionPath].map(path => [path, require.cache[path]]));
  t.after(() => {
    for (const [path, entry] of Object.entries(saved)) { if (entry) require.cache[path] = entry; else delete require.cache[path]; }
  });
  t.after(require('./helpers/mail-service-modules.cts').evictMailRouteModules());
  t.mock.method((require('../dist/src/services/mail-engine/runtime') as typeof import('../src/services/mail-engine/runtime')), 'resumeAccount', async () => ({ resumed: 0, retired: 0 }));
  const inserts: FixtureValue[] = [], updates: FixtureValue[] = [], tested: FixtureValue[] = [];
  let stops = 0;
  const existing = { id: 'account-1', user_id: 'user-1', email_address: 'user@example.test', username: 'user@example.test', display_name: null,
    provider: 'custom', imap_host: 'mail.example.test', imap_port: 993, smtp_host: 'mail.example.test', smtp_port: 587,
    encrypted_password: 'encrypted:secret', allow_self_signed: 0, delete_emails_on_server: 0, sync_mode: 'download', is_active: 1 };
  setRequireStub(statePath, { db: { execute: async (sql: string, params: FixtureValue[] = []) => {
    if (params.some(value => value === undefined)) throw new Error('Bind parameters must not contain undefined. To pass SQL NULL specify JS null');
    if (sql.includes('SELECT * FROM mail_accounts')) return [[existing]];
    if (sql.includes('INSERT INTO mail_accounts')) { inserts.push({ sql, params }); return [{ affectedRows: 1 }]; }
    if (sql.includes('UPDATE mail_accounts SET')) { updates.push({ sql, params }); return [{ affectedRows: 1 }]; }
    if (sql.includes('SELECT id, user_id, email_address')) return [[existing]];
    return [[]];
  } } });
  setRequireStub(encryptionPath, { encrypt: (value: FixtureValue) => `encrypted:${value}` });
  setRequireStub(mailServicePath, {
    DEFAULT_MAIL_SYNC_FETCH_LIMIT: 'all', MAIL_SENDER_RULE_MATCH_TYPES: new Set<FixtureValue>(['domain', 'email']), SYSTEM_MAIL_FOLDER_SET: new Set<FixtureValue>(),
    toBooleanFlag: (value: FixtureValue) => value === true || value === 1 || value === '1',
    ensureDefaultMailFoldersForUser: async () => {},
    normalizeSyncFetchLimit: (value: FixtureValue, fallback = 'all') => value || fallback,
    validateMailHostPolicy: async () => ({ accepted: true, mailHostTrust: {} }),
    buildMailHostTrustResult: async () => ({}),
    testImapConnection: async (account: FixtureValue) => { tested.push(account); return { success: true }; },
    stopMailAccountWork: async () => { stops++; },
    scheduleMailAccountSync: () => ({ started: true, promise: Promise.resolve({ success: true }) }),
    syncMailAccount: async () => ({ success: true }),
    isAnyMailAccountSyncRunning: () => false, getRunningMailSyncAccountIds: () => [], getRunningMailServerDeleteAccountIds: () => [],
  });
  const routes = require('../dist/src/routes/mail') as RouteTable<typeof import('../src/routes/mail')>;
  const request = (url: string) => ({ headers: { host: 'localhost' }, url }) as FixtureValue;
  return { inserts, updates, tested, get stops() { return stops; },
    post: (body: FixtureValue): Promise<FixtureValue> => routes['POST /api/mail/accounts'](request('/api/mail/accounts'), 'user-1', body),
    put: (body: FixtureValue): Promise<FixtureValue> => routes['PUT /api/mail/accounts/:id'](request('/api/mail/accounts/account-1'), 'user-1', body) };
}

test('account fields are checked before anything is tested, stopped or stored', async (t) => {
  const h = accountInputFixture(t);
  const refused = await h.put({ imap_port: '993x' });
  assert.equal(refused.status, 400);
  assert.match(refused.error, /IMAP port must be a number/);
  assert.deepEqual([h.updates.length, h.tested.length, h.stops], [0, 0, 0], 'A refused port writes, tests and stops nothing');
  for (const bad of [0, 70000, '993.5', true]) assert.equal((await h.put({ smtp_port: bad })).status, 400, `smtp_port ${JSON.stringify(bad)}`);
  assert.equal((await h.put({ display_name: 'x'.repeat(256) })).status, 400);
  assert.equal(h.updates.length, 0);

  const moved = await h.put({ imap_port: '143' });
  assert.equal(moved.error, undefined);
  assert.equal(h.tested[0].imap_port, 143, 'The connection test sees a number');
  assert.match(h.updates[0].sql, /imap_port = \?/);
  assert.ok(h.updates[0].params.includes(143), 'The stored port is the tested port');

  const base = { email_address: 'new@example.test', provider: 'custom', encrypted_password: 'secret',
    imap_host: 'mail.example.test', imap_port: 993, smtp_host: 'mail.example.test', smtp_port: 587 };
  const noProvider = await h.post({ ...base, provider: undefined });
  assert.equal(noProvider.status, 400);
  assert.equal(noProvider.error, 'Mail provider is required.');
  const longName = await h.post({ ...base, display_name: 'x'.repeat(256) });
  assert.equal(longName.status, 400);
  assert.match(longName.error, /Display name must be 255/);
  assert.equal((await h.post({ ...base, email_address: 'not-an-address' })).status, 400);
  assert.equal((await h.post({ ...base, encrypted_password: '' })).error, 'Email address and password are required');
  assert.equal(h.inserts.length, 0, 'Nothing reached INSERT');

  const created = await h.post({ ...base, display_name: '', username: '', smtp_port: '465' });
  assert.equal(created.error, undefined);
  assert.equal(h.inserts.length, 1);
  assert.deepEqual(h.inserts[0].params.slice(2, 10), ['new@example.test', null, 'custom', 'new@example.test', 'mail.example.test', 993, 'mail.example.test', 465],
    'Stored values are the normalized ones: empty optional fields become null or the address, ports are numbers');
});
