import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'destination-server-encryption-key';

const { decrypt, encrypt } = require('../dist/src/security/encryption');
const { encryptPortableCredentialBundle } = require('../dist/src/services/backup-container');
const {
  backupFromZipFile,
  buildBackupArchiveEntriesForUser,
  prepareCredentialsForRestore,
} = require('../dist/src/services/backup');
const { writeZip } = require('../dist/src/services/export-jobs');
const { setDb } = require('../dist/src/state');

test('portable backup credentials are re-encrypted for the destination server', () => {
  const dataKey = crypto.randomBytes(32);
  const backup = {
    portable_credentials: encryptPortableCredentialBundle({
      mail_accounts: [{ id: 'mail-account', password: 'mail-password' }],
      calendar_accounts: [{
        id: 'calendar-account',
        password: 'calendar-password',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      }],
    }, dataKey),
    data: {
      mail_accounts: [{ id: 'mail-account', encrypted_password: null, is_active: true }],
      calendar_accounts: [{
        id: 'calendar-account',
        provider: 'caldav',
        encrypted_password: null,
        encrypted_access_token: null,
        encrypted_refresh_token: null,
        is_active: true,
      }],
    },
  };

  prepareCredentialsForRestore(backup, dataKey, []);

  assert.equal(decrypt(backup.data.mail_accounts[0].encrypted_password), 'mail-password');
  assert.equal(decrypt(backup.data.calendar_accounts[0].encrypted_password), 'calendar-password');
  assert.equal(decrypt(backup.data.calendar_accounts[0].encrypted_access_token), 'access-token');
  assert.equal(decrypt(backup.data.calendar_accounts[0].encrypted_refresh_token), 'refresh-token');
});

test('a restored mail calendar without a password stays on; another calendar account without one is paused', () => {
  const dataKey = crypto.randomBytes(32);
  const calendar = (id: FixtureValue, providerConfig: FixtureValue) => ({ id, provider: 'caldav', provider_config: providerConfig, encrypted_password: null,
    encrypted_access_token: null, encrypted_refresh_token: null, is_active: true });
  const accounts = () => [calendar('mail-calendar', JSON.stringify({ mailLinked: true })), calendar('own-login', JSON.stringify({ server: {} })), calendar('unmarked', null)];
  const portable = { portable_credentials: encryptPortableCredentialBundle({ mail_accounts: [], calendar_accounts: [] }, dataKey),
    data: { mail_accounts: [], calendar_accounts: accounts() } };
  const legacy = { data: { mail_accounts: [], calendar_accounts: accounts() } };
  prepareCredentialsForRestore(portable, dataKey, []);
  prepareCredentialsForRestore(legacy, null, []);
  for (const backup of [portable, legacy]) {
    assert.deepEqual(backup.data.calendar_accounts.map(account => [account.id, account.is_active]),
      [['mail-calendar', true], ['own-login', false], ['unmarked', false]]);
  }
});

test('a mail calendar from an older backup comes back without the copied password, and on when only a mail disconnect paused it', () => {
  const dataKey = crypto.randomBytes(32);
  const message = 'The mail account is disconnected. Reconnect it to resume calendar sync.';
  const accounts = (copy: FixtureValue) => [
    { id: 'paused-by-mail', provider: 'caldav', provider_config: JSON.stringify({ mailLinked: true }), encrypted_password: copy, is_active: false, sync_status: 'paused', sync_error: message },
    { id: 'paused-by-user', provider: 'caldav', provider_config: JSON.stringify({ mailLinked: true }), encrypted_password: copy, is_active: false, sync_status: 'paused', sync_error: null },
    { id: 'own-login', provider: 'caldav', provider_config: JSON.stringify({ server: {} }), encrypted_password: copy, is_active: true },
  ];
  const portable = { portable_credentials: encryptPortableCredentialBundle({ mail_accounts: [], calendar_accounts: ['paused-by-mail', 'paused-by-user', 'own-login'].map(id => ({ id, password: 'copied' })) }, dataKey),
    data: { mail_accounts: [], calendar_accounts: accounts(null) } };
  const legacy = { data: { mail_accounts: [], calendar_accounts: accounts(encrypt('copied')) } };
  const warnings: FixtureValue[] = [];
  prepareCredentialsForRestore(portable, dataKey, warnings);
  prepareCredentialsForRestore(legacy, null, warnings);
  for (const backup of [portable, legacy]) {
    const [byMail, byUser, own] = backup.data.calendar_accounts;
    assert.deepEqual([byMail.encrypted_password, byMail.is_active, byMail.sync_status, byMail.sync_error], [null, true, 'pending', null]);
    assert.deepEqual([byUser.encrypted_password, byUser.is_active], [null, false], 'A pause of the user stays');
    assert.equal(decrypt(own.encrypted_password), 'copied');
  }
  assert.deepEqual(warnings, []);
});

test('encrypted archive payload retains the filtered portable credential bundle', async (t) => {
  const dataKey = crypto.randomBytes(32);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unihub-portable-archive-'));
  const zipPath = path.join(dir, 'backup.zip');
  const mailPassword = encrypt('mail-password');
  const calendarPassword = encrypt('calendar-password');
  const accessToken = encrypt('access-token');
  const refreshToken = encrypt('refresh-token');
  const connection = {
    async commit() {}, async rollback() {}, release() {},
    async query() { return [[]]; },
    async execute(sql: string) {
      if (sql.includes('FROM users ')) {
        return [[{
          id: 'user-1',
          email: 'user@example.com',
          full_name: 'User',
          role: 'user',
          is_active: 1,
          email_verified: 1,
        }]];
      }
      if (sql.includes('FROM mail_accounts ')) {
        return [[{
          id: 'mail-account',
          user_id: 'user-1',
          email_address: 'mail@example.com',
          provider: 'custom',
          encrypted_password: mailPassword,
        }]];
      }
      if (sql.includes('FROM calendar_accounts ')) {
        return [[{
          id: 'calendar-account',
          user_id: 'user-1',
          provider: 'caldav',
          encrypted_password: calendarPassword,
          encrypted_access_token: accessToken,
          encrypted_refresh_token: refreshToken,
        }]];
      }
      return [[]];
    },
  };
  setDb({ getConnection: async () => connection });
  t.after(async () => {
    setDb(null);
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const entries = await buildBackupArchiveEntriesForUser('user-1', 'full', {
    portableCredentialKey: dataKey,
  });
  t.after(async () => {
    await Promise.all(entries
      .filter((entry: FixtureValue) => entry.cleanupAfterWrite && entry.filePath)
      .map((entry: FixtureValue) => fs.promises.rm(entry.filePath, { force: true })));
  });
  await writeZip(entries, zipPath);
  const parsed = await backupFromZipFile(zipPath);
  const restored = parsed.backup;

  assert.ok(restored.portable_credentials);
  assert.equal(restored.data.mail_accounts[0].encrypted_password, null);
  assert.equal(restored.data.calendar_accounts[0].encrypted_password, null);
  prepareCredentialsForRestore(restored, dataKey, []);
  assert.equal(decrypt(restored.data.mail_accounts[0].encrypted_password), 'mail-password');
  assert.equal(decrypt(restored.data.calendar_accounts[0].encrypted_password), 'calendar-password');
  assert.equal(decrypt(restored.data.calendar_accounts[0].encrypted_access_token), 'access-token');
  assert.equal(decrypt(restored.data.calendar_accounts[0].encrypted_refresh_token), 'refresh-token');
});
