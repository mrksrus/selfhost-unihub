const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'destination-server-encryption-key';

const { decrypt } = require('../src/security/encryption');
const { encryptPortableCredentialBundle } = require('../src/services/backup-container');
const { prepareCredentialsForRestore } = require('../src/services/backup');

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
