const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'destination-server-encryption-key';

const { decrypt, encrypt } = require('../src/security/encryption');
const { encryptPortableCredentialBundle } = require('../src/services/backup-container');
const {
  backupFromZipFile,
  buildBackupArchiveEntriesForUser,
  prepareCredentialsForRestore,
} = require('../src/services/backup');
const { writeZip } = require('../src/services/export-jobs');
const { setDb } = require('../src/state');

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

test('encrypted archive payload retains the filtered portable credential bundle', async (t) => {
  const dataKey = crypto.randomBytes(32);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unihub-portable-archive-'));
  const zipPath = path.join(dir, 'backup.zip');
  const mailPassword = encrypt('mail-password');
  const calendarPassword = encrypt('calendar-password');
  const accessToken = encrypt('access-token');
  const refreshToken = encrypt('refresh-token');
  setDb({
    async execute(sql) {
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
  });
  t.after(async () => {
    setDb(null);
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const entries = await buildBackupArchiveEntriesForUser('user-1', 'full', {
    portableCredentialKey: dataKey,
  });
  t.after(async () => {
    await Promise.all(entries
      .filter(entry => entry.cleanupAfterWrite && entry.filePath)
      .map(entry => fs.promises.rm(entry.filePath, { force: true })));
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
