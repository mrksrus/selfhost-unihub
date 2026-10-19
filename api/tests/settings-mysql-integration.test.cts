import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

test('preferences accept only offered values and the user\'s own mail accounts; sign-up mode reads closed when unreadable', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'settings-bootstrap@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-settings-bootstrap-password';
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const settings = require('../dist/src/services/settings') as typeof import('../src/services/settings');

  const owner = crypto.randomUUID(), stranger = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'owner@example.test', 'x'), (?, 'stranger@example.test', 'x')", [owner, stranger]);
  const ownAccount = crypto.randomUUID(), theirAccount = crypto.randomUUID();
  for (const [id, userId, address] of [[ownAccount, owner, 'owner@example.test'], [theirAccount, stranger, 'stranger@example.test']]) {
    await pool.execute(`INSERT INTO mail_accounts (id, user_id, email_address, provider, imap_host, smtp_host, encrypted_password)
      VALUES (?, ?, ?, 'custom', 'imap.example.test', 'smtp.example.test', 'x')`, [id, userId, address]);
  }

  assert.deepEqual(await settings.getUserPreferences(owner),
    { email_link_behavior: 'mailto', default_start_page: 'mail', default_mail_account_id: '', accent_color: 'blue' });
  assert.deepEqual((await settings.setUserPreferences(owner, { accent_color: 'teal', default_mail_account_id: ownAccount, unknown_key: 'x' })).preferences,
    { email_link_behavior: 'mailto', default_start_page: 'mail', default_mail_account_id: ownAccount, accent_color: 'teal' });

  // One refused value writes nothing of the request.
  assert.equal((await settings.setUserPreferences(owner, { accent_color: 'green', default_start_page: 'notes' })).status, 400);
  assert.equal((await settings.setUserPreferences(owner, { accent_color: 'green', default_mail_account_id: theirAccount })).status, 400, 'another user\'s mail account');
  assert.equal((await settings.getUserPreferences(owner)).accent_color, 'teal');
  assert.equal((await settings.getUserPreferences(stranger)).accent_color, 'blue', 'preferences are per user');
  const [[unknown]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM user_settings WHERE setting_key = 'unknown_key'");
  assert.equal(Number(unknown.count), 0);

  // A stored value no longer offered (the removed Notes page) reads as the default.
  await pool.execute("UPDATE user_settings SET setting_value = 'notes' WHERE user_id = ? AND setting_key = 'accent_color'", [owner]);
  assert.equal((await settings.getUserPreferences(owner)).accent_color, 'blue');

  assert.equal(await settings.getSignupMode(), 'disabled', 'a new server is closed');
  await settings.setSignupMode('approval');
  assert.equal(await settings.getSignupMode(), 'approval');
  await pool.execute("UPDATE system_settings SET setting_value = 'everyone' WHERE setting_key = 'signup_mode'");
  assert.equal(await settings.getSignupMode(), 'disabled');
});
