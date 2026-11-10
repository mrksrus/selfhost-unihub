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

test('the settings registry keeps scoped values with their owner and applies installation policies', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'registry-bootstrap@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-registry-bootstrap-password';
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const settings = require('../dist/src/services/settings') as typeof import('../src/services/settings');

  const owner = crypto.randomUUID(), stranger = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'reg-owner@example.test', 'x'), (?, 'reg-stranger@example.test', 'x')", [owner, stranger]);
  const ownAccount = crypto.randomUUID(), theirAccount = crypto.randomUUID();
  for (const [id, userId, address] of [[ownAccount, owner, 'reg-owner@example.test'], [theirAccount, stranger, 'reg-stranger@example.test']]) {
    await pool.execute(`INSERT INTO mail_accounts (id, user_id, email_address, provider, imap_host, smtp_host, encrypted_password)
      VALUES (?, ?, ?, 'custom', 'imap.example.test', 'smtp.example.test', 'x')`, [id, userId, address]);
  }
  const ownFolder = crypto.randomUUID(), theirFolder = crypto.randomUUID();
  await pool.execute("INSERT INTO mail_folders (id, user_id, slug, display_name, is_system, mail_account_id) VALUES (?, ?, 'projects', 'Projects', FALSE, ?), (?, ?, 'private', 'Private', FALSE, ?)",
    [ownFolder, owner, ownAccount, theirFolder, stranger, theirAccount]);

  // Defaults, by source; the stranger's account is not the owner's to read or write.
  const initial = await settings.getSettings('mail_account', owner, ownAccount);
  assert.deepEqual(initial.notify_detail, { value: 'full', source: 'default', locked: false });
  assert.deepEqual(initial.notify_folders.value, ['role:junk', 'role:sent', 'role:drafts', 'role:trash', 'role:archive']);
  await assert.rejects(settings.getSettings('mail_account', owner, theirAccount), { status: 404 });
  await assert.rejects(settings.updateSettings('mail_account', owner, theirAccount, { values: { notify_enabled: false } }), { status: 404 });
  assert.deepEqual(Object.keys(await settings.getScopedSettings('mail_account', owner)), [ownAccount]);

  // Every value is checked before any is written.
  await assert.rejects(settings.updateSettings('mail_account', owner, ownAccount, { values: { notify_enabled: false, notify_detail: 'everything' } }), { status: 400 });
  await assert.rejects(settings.updateSettings('mail_account', owner, ownAccount, { values: { notify_enabled: false, notify_folders: [`folder:${theirFolder}`] } }), { status: 400 });
  await assert.rejects(settings.updateSettings('user', owner, owner, { values: { week_start: 'sunday', unknown_key: 1 } }), { status: 400 });
  assert.equal((await settings.getSettings('mail_account', owner, ownAccount)).notify_enabled.value, true);
  assert.equal((await settings.getSettings('user', owner)).week_start.value, 'monday');

  const saved = await settings.updateSettings('mail_account', owner, ownAccount, { values: { notify_folder_mode: 'only', notify_folders: ['role:inbox', `folder:${ownFolder}`], notify_detail: 'sender' } });
  assert.deepEqual(saved.notify_folders, { value: ['role:inbox', `folder:${ownFolder}`], source: 'user', locked: false });
  assert.equal((await settings.updateSettings('user', owner, owner, { values: { default_event_reminder: null, mail_preview_lines: 3, snooze_choices: ['3h', 'tomorrow'] } })).default_event_reminder.value, null);
  await assert.rejects(settings.updateSettings('user', owner, owner, { values: { mail_preview_lines: 6 } }), { status: 400 });
  await assert.rejects(settings.updateSettings('user', owner, owner, { values: { snooze_choices: ['1h', '1h'] } }), { status: 400 });
  assert.equal((await settings.getSettings('user', stranger)).mail_preview_lines.value, 1, 'settings are per user');

  // An installation floor: less detail than the floor is refused, a stricter choice stays.
  await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', 'mail_account.notify_detail', 'sender', FALSE)");
  assert.deepEqual((await settings.getSettings('mail_account', owner, ownAccount)).notify_detail, { value: 'sender', source: 'user', locked: false, floor: 'sender' });
  const strangerDetail = (await settings.getSettings('mail_account', stranger, theirAccount)).notify_detail;
  assert.deepEqual(strangerDetail, { value: 'sender', source: 'policy', locked: false, floor: 'sender' }, 'the floor raises the default');
  await assert.rejects(settings.updateSettings('mail_account', owner, ownAccount, { values: { notify_detail: 'full' } }), { status: 403, code: 'POLICY_FLOOR' });
  assert.equal((await settings.updateSettings('mail_account', owner, ownAccount, { values: { notify_detail: 'none' } })).notify_detail.value, 'none');

  // A lock wins over the person's choice and refuses changes.
  await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', 'user.compose_format', 'plain', TRUE)");
  await pool.execute("INSERT INTO user_settings (user_id, setting_key, setting_value) VALUES (?, 'compose_format', 'rich')", [owner]);
  assert.deepEqual((await settings.getSettings('user', owner)).compose_format, { value: 'plain', source: 'policy', locked: true });
  await assert.rejects(settings.updateSettings('user', owner, owner, { values: { compose_format: 'rich' } }), { status: 403, code: 'POLICY_LOCKED' });

  // A stored or policy value no longer valid reads as absent.
  await pool.execute("UPDATE setting_policies SET setting_value = 'pigeon' WHERE setting_key = 'user.compose_format'");
  await pool.execute("INSERT INTO mail_account_settings (mail_account_id, user_id, setting_key, setting_value) VALUES (?, ?, 'notify_enabled', 'maybe')", [theirAccount, stranger]);
  assert.deepEqual((await settings.getSettings('user', owner)).compose_format, { value: 'rich', source: 'user', locked: false });
  assert.deepEqual((await settings.getSettings('mail_account', stranger, theirAccount)).notify_enabled, { value: true, source: 'default', locked: false });

  // Deleting the account deletes its settings with it.
  await pool.execute('DELETE FROM mail_accounts WHERE id = ?', [ownAccount]);
  const [[left]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM mail_account_settings WHERE mail_account_id = ?', [ownAccount]);
  assert.equal(Number(left.count), 0);
});

// The device scope (0.29): the app lock of one of the person's devices,
// under the administrator's requirement as floors. The scope is a list whose
// strictness is containment: the floor is a union, and the whole app stands
// alone.
test('a device\'s app lock is the person\'s own, and the administrator\'s requirement is its floor', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'device-bootstrap@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-device-bootstrap-password';
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const settings = require('../dist/src/services/settings') as typeof import('../src/services/settings');

  const owner = crypto.randomUUID(), stranger = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'dev-owner@example.test', 'x'), (?, 'dev-stranger@example.test', 'x')", [owner, stranger]);
  const [phone, laptop, theirs] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await pool.execute("INSERT INTO devices (id, user_id, kind) VALUES (?, ?, 'android'), (?, ?, 'web'), (?, ?, 'web')", [phone, owner, laptop, owner, theirs, stranger]);

  assert.deepEqual(await settings.getSettings('device', owner, phone), {
    app_lock_scope: { value: [], source: 'default', locked: false },
    app_lock_relock_after: { value: '60', source: 'default', locked: false },
    app_lock_on_device_lock: { value: true, source: 'default', locked: false },
  });
  await assert.rejects(settings.getSettings('device', owner, theirs), { status: 404 });
  await assert.rejects(settings.updateSettings('device', owner, theirs, { values: { app_lock_scope: ['app'] } }), { status: 404 });
  await assert.rejects(settings.updateSettings('device', owner, phone, { values: { app_lock_scope: ['mail', 'notes'] } }), { status: 400 });
  // Stored in its plain form: the catalog's order, the whole app alone.
  assert.deepEqual((await settings.updateSettings('device', owner, phone, { values: { app_lock_scope: ['contacts', 'mail'] } })).app_lock_scope.value, ['mail', 'contacts']);
  assert.deepEqual((await settings.updateSettings('device', owner, laptop, { values: { app_lock_scope: ['recordings', 'app'], app_lock_relock_after: '900' } })).app_lock_scope.value, ['app']);
  const [[stored]] = await pool.query<RowDataPacket[]>("SELECT setting_value FROM device_settings WHERE device_id = ? AND setting_key = 'app_lock_scope'", [laptop]);
  assert.equal(stored.setting_value, '["app"]');
  assert.deepEqual(Object.keys(await settings.getScopedSettings('device', owner)).sort(), [phone, laptop].sort(), 'each device of the person, nobody else\'s');

  // The administrator requires Mail at least, and at most 5 minutes in the background.
  await pool.execute(`INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES
    ('installation', '', 'policy.app_lock.required', '["mail"]', FALSE), ('installation', '', 'policy.app_lock.max_background', '300', FALSE)`);
  const mailReason = 'Your administrator requires the app lock for Mail.';
  assert.deepEqual(await settings.appLockRequirementFor(owner), { required: ['mail'], max_background: '300', reason: mailReason });
  const phoneNow = await settings.getSettings('device', owner, phone);
  assert.deepEqual(phoneNow.app_lock_scope, { value: ['mail', 'contacts'], source: 'user', locked: false, floor: ['mail'] }, 'a choice covering the requirement stays the person\'s');
  assert.deepEqual(phoneNow.app_lock_relock_after, { value: '60', source: 'default', locked: false, floor: '300' }, 'the default is within the maximum');
  const theirsNow = await settings.getSettings('device', stranger, theirs);
  assert.deepEqual(theirsNow.app_lock_scope, { value: ['mail'], source: 'policy', locked: false, floor: ['mail'] }, 'the requirement turns the lock on where it was off');
  // Dropping a required area or waiting longer is refused with the administrator's words; covering more is not.
  await assert.rejects(settings.updateSettings('device', owner, phone, { values: { app_lock_scope: ['contacts'] } }), { status: 403, code: 'POLICY_FLOOR', message: mailReason });
  await assert.rejects(settings.updateSettings('device', owner, phone, { values: { app_lock_relock_after: '900' } }), { status: 403, code: 'POLICY_FLOOR' });
  assert.equal((await settings.updateSettings('device', owner, phone, { values: { app_lock_relock_after: '0' } })).app_lock_relock_after.value, '0');
  const laptopNow = await settings.getSettings('device', owner, laptop);
  assert.deepEqual([laptopNow.app_lock_scope.value, laptopNow.app_lock_scope.source], [['app'], 'user'], 'the whole app covers Mail');
  assert.deepEqual([laptopNow.app_lock_relock_after.value, laptopNow.app_lock_relock_after.source], ['300', 'policy'], 'a stored longer time reads as the maximum');

  // Removing a device removes its settings.
  await pool.execute('DELETE FROM devices WHERE id = ?', [phone]);
  const [[gone]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM device_settings WHERE device_id = ?', [phone]);
  assert.equal(Number(gone.count), 0);
});
