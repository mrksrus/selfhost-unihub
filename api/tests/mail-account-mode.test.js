const test = require('node:test');
const assert = require('node:assert/strict');
const { mailAccountModeChange: change } = require('../src/services/mail-account-mode');
const { readV3 } = require('../src/services/backup-formats/v3');
const { validateRestoreRows } = require('../src/services/backup-ownership');

test('mode switches require confirmation and never carry deletion across modes', () => {
  const download = { sync_mode: 'download', delete_emails_on_server: 1 };
  assert.throws(() => change(download, { sync_mode: 'sync' }), /Confirm/);
  assert.throws(() => change(download, { sync_mode: 'sync', sync_mode_confirmed: true, delete_emails_on_server: true }), /unavailable/);
  assert.deepEqual(change(download, { sync_mode: 'sync', sync_mode_confirmed: true }), { mode: 'sync', changed: true, deleteSettingProvided: true, deleteEnabled: false });
  assert.equal(change({ sync_mode: 'sync' }, { sync_mode: 'download' }).deleteEnabled, false);
  assert.throws(() => change({ sync_mode: 'sync' }, { sync_mode: 'download', delete_emails_on_server: true }), /Save Download/);
  assert.equal(change(download, {}).deleteEnabled, true);
  assert.equal(change(null, {}).deleteEnabled, false);
  assert.equal(change(null, { delete_emails_on_server: true }).deleteEnabled, true);
  assert.throws(() => change(download, { sync_mode: 'bogus' }), /Mail mode/);
});

test('old archives default to Download; current archives retain identity and restart reconciliation', () => {
  const archive = { data: { mail_accounts: [{}, { sync_mode: 'sync', sync_status: 'running' }], emails: [
    { source_folder: 'Original', imap_uid: 1, imap_uidvalidity: 2 },
    { source_folder: 'Original', imap_uid: 1, remote_folder: 'Moved', remote_uid: 42, remote_uidvalidity: 3, remote_missing: true },
    { source_folder: 'Original', remote_folder: null, remote_uid: null, remote_uidvalidity: null },
  ] } };
  readV3(archive);
  assert.deepEqual(archive.data.mail_accounts, [{ sync_mode: 'download', sync_status: 'idle' }, { sync_mode: 'sync', sync_status: 'pending' }]);
  assert.equal(archive.data.emails[0].remote_uid, 1);
  assert.equal(archive.data.emails[1].remote_folder, 'Moved');
  assert.equal(archive.data.emails[1].source_folder, 'Original');
  assert.equal(archive.data.emails[1].remote_missing, true);
  assert.equal(archive.data.emails[2].remote_folder, null);
  assert.ok(validateRestoreRows({ mail_accounts: [{ id: 'a', sync_mode: 'invalid' }] }).some(error => /mode/.test(error)));
});


test('provider mailbox comparisons allow credential rotation but separate UID namespaces', () => {
  const { sameProviderMailbox } = require('../src/services/mail-account-mode');
  const account = { email_address: 'a@example.test', username: 'Login', imap_host: 'MAIL.EXAMPLE.TEST', imap_port: 993 };
  assert.equal(sameProviderMailbox(account, { ...account, imap_host: 'mail.example.test', encrypted_password: 'rotated', smtp_host: 'elsewhere' }), true);
  for (const changed of [{ username: 'login' }, { imap_host: 'other.test' }, { imap_port: 143 }, { email_address: 'b@example.test' }]) assert.equal(sameProviderMailbox(account, { ...account, ...changed }), false);
});
