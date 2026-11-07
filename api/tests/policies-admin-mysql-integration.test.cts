import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// Data-safety policies set by an administrator (0.28 C2), through the real
// request handler and MariaDB, with three people: the administrator, alex
// (whose data the rules and the administrator's path act on) and blair (a
// stranger to both). Covers the policies page with its password, activity
// log and notice revision; the rules people are told about and confirm; the
// administrator's path for alex; the service checks that depend on a body;
// the bin's minimum while deleting for good is forbidden (D33, D34); the
// minimum age of a backup (D36); and the two fixes of D41.
test('policies, notices and the administrator\'s path for a person, with an owner, a stranger and an administrator', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const { POLICIES } = require('../dist/src/services/settings') as typeof import('../src/services/settings');
  const { BIN_MIN_RETENTION } = require('../dist/src/services/settings-registry') as typeof import('../src/services/settings-registry');

  const password = 'synthetic-policies-password';
  const passwordHash = await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4);
  const users: Record<string, string> = {};
  for (const [name, role] of [['admin', 'admin'], ['alex', 'user'], ['blair', 'user']] as const) {
    users[name] = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)', [users[name], `${name}@example.test`, passwordHash, name, role]);
  }
  async function signIn(name: string) {
    const client = api.client();
    const reply = await client.request('POST', '/api/auth/signin', { email: `${name}@example.test`, password });
    assert.equal(reply.status, 200, String(reply.body.error));
    return client;
  }
  type Client = Awaited<ReturnType<typeof signIn>>;
  const admin = await signIn('admin'), alex = await signIn('alex'), blair = await signIn('blair');
  async function call(client: Client, method: string, url: string, body: unknown = {}, status = 200) {
    const reply = await client.request(method, url, method === 'GET' ? undefined : body);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 500)}`);
    return reply.body as FixtureValue;
  }
  const count = async (sql: string, params: unknown[] = []) => Number(((await pool.query<RowDataPacket[]>(sql, params))[0][0]).count);
  const audit = (action: string) => pool.query<RowDataPacket[]>('SELECT actor_id, target_user_id, details FROM audit_log WHERE action = ? ORDER BY created_at, id', [action])
    .then(([rows]) => rows.map(row => ({ actor: row.actor_id, target: row.target_user_id, details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details })));
  const setPolicies = (values: Record<string, unknown>, extra: Record<string, unknown> = {}, status = 200, client = admin) =>
    call(client, 'PUT', '/api/admin/policies', { values, current_password: password, ...extra }, status);
  const forbids = (reply: FixtureValue, policy: string) => assert.deepEqual([reply.code, reply.details?.policy], ['POLICY_FORBIDS', policy]);

  await t.test('the policies page: password, activity log, conflicts, and a revision only when the rules people see change', async () => {
    // Every key at its default, nothing to tell anyone.
    const fresh = await call(admin, 'GET', '/api/admin/policies');
    assert.equal(fresh.revision, 0);
    assert.deepEqual(Object.keys(fresh.policies).sort(), Object.keys(POLICIES).sort());
    assert.deepEqual(fresh.policies['backup.server_retention_days'], { value: null, source: 'default', default: null, values: [null, 30, 90, 365],
      effect: 'A backup younger than this cannot be deleted by its owner; nothing is deleted automatically.' });
    assert.deepEqual([fresh.bin_min_retention.value, fresh.bin_min_retention.applies, fresh.bin_min_retention.values], ['forever', false, ['30', '90', 'forever']]);
    assert.deepEqual((await call(alex, 'GET', '/api/policies/effective')).rules, []);
    assert.deepEqual(await call(api.client(), 'GET', '/api/auth/signup-mode'), { signup_mode: 'disabled', data_rules: [] });

    // Refused without a change or an entry: a stranger, no password, a wrong one, a key or value the server does not know, a conflict.
    await call(blair, 'PUT', '/api/admin/policies', { values: { 'bin.delete': 'forbidden' }, current_password: password }, 403);
    assert.equal((await call(admin, 'PUT', '/api/admin/policies', { values: { 'bin.delete': 'forbidden' } }, 400)).code, 'ADMIN_PASSWORD_REQUIRED');
    assert.equal((await call(admin, 'PUT', '/api/admin/policies', { values: { 'bin.delete': 'forbidden' }, current_password: 'wrong-password' }, 403)).code, 'ADMIN_PASSWORD_INCORRECT');
    assert.equal((await setPolicies({ 'bin.purge': 'forbidden' }, {}, 400)).code, 'POLICY_UNKNOWN');
    assert.equal((await setPolicies({ 'bin.delete': 'sometimes' }, {}, 400)).code, 'POLICY_INVALID');
    assert.equal((await setPolicies({ 'backup.server_retention_days': 45 }, {}, 400)).code, 'POLICY_INVALID');
    assert.equal((await setPolicies({ 'mail.mode.sync': 'forbidden', 'mail.mode.new_accounts': 'sync' }, {}, 400)).code, 'POLICY_CONFLICT');
    assert.equal((await setPolicies({ 'mail.provider_delete': 'forbidden', 'mail.mode.new_accounts': 'download_delete' }, {}, 400)).code, 'POLICY_CONFLICT');
    assert.equal((await setPolicies({ 'mail.mode.sync': 'forbidden', 'mail.mode.download': 'forbidden' }, {}, 400)).code, 'POLICY_CONFLICT');
    assert.deepEqual([await count('SELECT COUNT(*) AS count FROM setting_policies'), await count('SELECT COUNT(*) AS count FROM audit_log WHERE action = ?', ['admin.policy_changed'])], [0, 0]);

    // Changing a policy deletes nothing: every table but the policy, revision, notice, log and session ones stays as it was.
    const skipped = new Set(['setting_policies', 'system_settings', 'policy_notices', 'audit_log', 'sessions']);
    const tables = ((await pool.query<RowDataPacket[]>('SHOW TABLES'))[0]).map(row => String(Object.values(row)[0])).filter(name => !skipped.has(name));
    const checksums = async () => (await pool.query<RowDataPacket[]>(`CHECKSUM TABLE ${tables.map(name => pool.escapeId(name)).join(', ')}`))[0].map(row => `${row.Table}=${row.Checksum}`).join('\n');
    const before = await checksums();
    const saved = await setPolicies({ 'bin.delete': 'forbidden', 'backup.server_retention_days': 30 });
    assert.equal(await checksums(), before);
    assert.deepEqual([saved.revision, saved.policies['bin.delete'].value, saved.policies['bin.delete'].source, saved.bin_min_retention.applies], [1, 'forbidden', 'policy', true]);
    assert.deepEqual((await audit('admin.policy_changed')).map(entry => [entry.actor, entry.details.key, entry.details.from, entry.details.to]).sort(),
      [[users.admin, 'backup.server_retention_days', null, 30], [users.admin, 'bin.delete', 'allowed', 'forbidden']]);

    // The same values again: nothing recorded, the revision stays.
    assert.equal((await setPolicies({ 'bin.delete': 'forbidden' })).revision, 1);
    assert.equal((await audit('admin.policy_changed')).length, 2);
    // The bin's minimum is its own field; changing it changes the rules people see.
    const minimum = await setPolicies({}, { bin_min_retention: '90' });
    assert.deepEqual([minimum.revision, minimum.bin_min_retention.value], [2, '90']);
    assert.deepEqual((await audit('admin.policy_changed')).at(-1)!.details, { key: 'bin.min_retention', from: 'forever', to: '90' });
    // Back to the default removes the row; a value nobody sees (the minimum while deleting is allowed) moves no revision.
    await setPolicies({ 'backup.server_retention_days': null });
    assert.equal(await count("SELECT COUNT(*) AS count FROM setting_policies WHERE setting_key = 'policy.backup.server_retention_days'"), 0);
    await setPolicies({ 'bin.delete': 'allowed' });
    const quiet = await call(admin, 'GET', '/api/admin/policies');
    assert.equal((await setPolicies({}, { bin_min_retention: '30' })).revision, quiet.revision, 'the minimum alone shows nobody anything');
  });

  await t.test('the rules people are told about: effective policies, the notice revision and its confirmation, sign-up', async () => {
    await setPolicies({ 'bin.delete': 'forbidden', 'accounts.remove': 'forbidden' }, { bin_min_retention: 'forever' });
    const effective = await call(alex, 'GET', '/api/policies/effective');
    const revision = effective.revision as number;
    assert.ok(revision > 0);
    assert.equal(effective.acknowledged_revision, 0, 'alex has not confirmed any rules');
    assert.deepEqual(effective.policies['bin.delete'], { value: 'forbidden', source: 'policy', allowed: false, reason: POLICIES['bin.delete'].reasons.forbidden });
    // data.clear follows bin.delete, with its own words.
    assert.deepEqual(effective.policies['data.clear'], { value: 'allowed', source: 'policy', allowed: false, reason: POLICIES['data.clear'].reasons.forbidden });
    assert.deepEqual(effective.rules, [POLICIES['accounts.remove'].reasons.forbidden, POLICIES['data.clear'].reasons.forbidden, POLICIES['bin.delete'].reasons.forbidden, BIN_MIN_RETENTION.reasons.forever]);
    // The administrator who saved them has seen them.
    assert.equal((await call(admin, 'GET', '/api/policies/effective')).acknowledged_revision, revision);

    assert.equal((await call(alex, 'POST', '/api/policies/acknowledge', { revision: revision + 1 }, 400)).code, 'POLICY_REVISION_INVALID');
    assert.equal((await call(alex, 'POST', '/api/policies/acknowledge', { revision: 'latest' }, 400)).code, 'POLICY_REVISION_INVALID');
    assert.deepEqual(await call(alex, 'POST', '/api/policies/acknowledge', { revision }), { acknowledged_revision: revision });
    assert.equal((await call(alex, 'GET', '/api/policies/effective')).acknowledged_revision, revision);
    assert.equal((await call(blair, 'GET', '/api/policies/effective')).acknowledged_revision, 0, 'only alex confirmed');
    // A new rule makes the notice due again.
    await setPolicies({ 'account.delete': 'forbidden' });
    const next = await call(alex, 'GET', '/api/policies/effective');
    assert.deepEqual([next.revision, next.acknowledged_revision], [revision + 1, revision]);
    assert.ok(next.rules.includes(POLICIES['account.delete'].reasons.forbidden));

    // Sign-up lists the same rules; a person who signs up has seen them.
    await pool.execute("INSERT INTO system_settings (setting_key, setting_value) VALUES ('signup_mode', 'open') ON DUPLICATE KEY UPDATE setting_value = 'open'");
    const signup = await call(api.client(), 'GET', '/api/auth/signup-mode');
    assert.deepEqual(signup, { signup_mode: 'open', data_rules: next.rules });
    const newcomer = api.client();
    const created = await newcomer.request('POST', '/api/auth/signup', { email: 'casey@example.test', password, full_name: 'Casey' });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    assert.equal((await call(newcomer, 'GET', '/api/policies/effective')).acknowledged_revision, next.revision);
    await pool.execute("UPDATE system_settings SET setting_value = 'disabled' WHERE setting_key = 'signup_mode'");
    await pool.execute("DELETE FROM users WHERE email = 'casey@example.test'");
    await setPolicies({ 'bin.delete': 'allowed', 'accounts.remove': 'allowed', 'account.delete': 'allowed' });
  });

  await t.test('D41: deleting one\'s own account asks for the password', async () => {
    const dana = crypto.randomUUID();
    await pool.execute("INSERT INTO users (id, email, password_hash, full_name) VALUES (?, 'dana@example.test', ?, 'Dana')", [dana, passwordHash]);
    const client = await signIn('dana');
    assert.equal((await call(client, 'DELETE', '/api/settings/account', {}, 400)).code, 'PASSWORD_REQUIRED');
    assert.equal((await call(client, 'DELETE', '/api/settings/account', { current_password: 'wrong-password' }, 403)).code, 'PASSWORD_INCORRECT');
    assert.equal(await count('SELECT COUNT(*) AS count FROM users WHERE id = ?', [dana]), 1, 'still there');
    assert.deepEqual(await call(client, 'DELETE', '/api/settings/account', { current_password: password }), { deleted: true });
    assert.equal(await count('SELECT COUNT(*) AS count FROM users WHERE id = ?', [dana]), 0);
  });

  // alex's and blair's mail accounts, with a message each.
  const mail = { alex: crypto.randomUUID(), blair: crypto.randomUUID(), alexEmail: crypto.randomUUID() };
  await pool.execute(`INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active, sync_policy_confirmed_at)
    VALUES (?, ?, 'alex@mail.example.test', 'custom', 'download', TRUE, UTC_TIMESTAMP()), (?, ?, 'blair@mail.example.test', 'custom', 'download', TRUE, UTC_TIMESTAMP())`,
  [mail.alex, users.alex, mail.blair, users.blair]);
  await pool.execute(`INSERT INTO emails (id, user_id, mail_account_id, from_address, to_addresses, folder, remote_folder, remote_uid, remote_uidvalidity)
    VALUES (?, ?, ?, 'casey@example.test', '[]', 'inbox', 'INBOX', 7, 1)`, [mail.alexEmail, users.alex, mail.alex]);
  const unresolved = crypto.randomUUID();
  const addUnresolved = () => pool.execute(`INSERT INTO mail_writebacks (id, user_id, mail_account_id, email_id, action, target_value, base_value, target_folder, remote_folder,
      remote_uid, remote_uidvalidity, status, state, is_current, dispatched, available_at)
    VALUES (?, ?, ?, ?, 'move', 'trash', 'inbox', 'trash', 'INBOX', 7, 1, 'pending', 'executing', TRUE, TRUE, UTC_TIMESTAMP())`, [unresolved, users.alex, mail.alex, mail.alexEmail]);

  await t.test('D41: clearing mail accounts waits, as purging one does, while a provider change has an unresolved outcome', async () => {
    await addUnresolved();
    const refused = await call(alex, 'POST', '/api/settings/clear-mail-accounts', {}, 409);
    assert.equal(refused.code, 'MAIL_OPERATIONS_UNRESOLVED');
    assert.equal(await count('SELECT COUNT(*) AS count FROM mail_accounts WHERE user_id = ?', [users.alex]), 1, 'nothing deleted');
    assert.equal(await count('SELECT COUNT(*) AS count FROM emails WHERE user_id = ?', [users.alex]), 1);
    // The administrator's path waits for it too.
    assert.equal((await call(admin, 'POST', `/api/admin/users/${users.alex}/clear/mail-accounts`, { current_password: password }, 409)).code, 'MAIL_OPERATIONS_UNRESOLVED');
  });

  await t.test('the mode and the provider deletion switch are checked in their service, before anything is contacted or stored', async () => {
    const before = await count('SELECT COUNT(*) AS count FROM mail_accounts');
    const body = { email_address: 'new@mail.example.test', provider: 'custom', encrypted_password: 'synthetic-mail-password', imap_host: 'imap.mail.example.test', imap_port: 993,
      smtp_host: 'smtp.mail.example.test', smtp_port: 465 };
    await setPolicies({ 'mail.mode.sync': 'forbidden' });
    forbids(await call(alex, 'POST', '/api/mail/accounts', { ...body, sync_mode: 'sync' }, 403), 'mail.mode.sync');
    // Switching an existing account to a forbidden mode; the account keeps working otherwise (D39).
    forbids(await call(alex, 'PUT', `/api/mail/accounts/${mail.alex}`, { sync_mode: 'sync', confirm_address: 'alex@mail.example.test' }, 403), 'mail.mode.sync');
    await setPolicies({ 'mail.mode.sync': 'allowed', 'mail.provider_delete': 'forbidden' });
    forbids(await call(alex, 'POST', '/api/mail/accounts', { ...body, delete_emails_on_server: true }, 403), 'mail.provider_delete');
    forbids(await call(alex, 'PUT', `/api/mail/accounts/${mail.alex}`, { delete_emails_on_server: true }, 403), 'mail.provider_delete');
    await setPolicies({ 'mail.provider_delete': 'user_choice', 'mail.mode.new_accounts': 'download_delete' });
    forbids(await call(alex, 'POST', '/api/mail/accounts', { ...body, sync_mode: 'sync' }, 403), 'mail.mode.new_accounts');
    forbids(await call(alex, 'POST', '/api/mail/accounts', { ...body, delete_emails_on_server: false }, 403), 'mail.mode.new_accounts');
    await setPolicies({ 'mail.mode.new_accounts': 'user_choice', 'mail.provider_delete': 'required' });
    forbids(await call(alex, 'POST', '/api/mail/accounts', { ...body, delete_emails_on_server: false }, 403), 'mail.provider_delete');
    assert.equal(await count('SELECT COUNT(*) AS count FROM mail_accounts'), before, 'no account was stored');
    const [[account]] = await pool.query<RowDataPacket[]>('SELECT sync_mode, delete_emails_on_server FROM mail_accounts WHERE id = ?', [mail.alex]);
    assert.deepEqual([account.sync_mode, Number(account.delete_emails_on_server)], ['download', 0]);
    // Turning a linked calendar on adds an account.
    await setPolicies({ 'mail.provider_delete': 'user_choice', 'accounts.add': 'forbidden' });
    forbids(await call(alex, 'PUT', `/api/mail/accounts/${mail.alex}/calendar`, { enabled: true }, 403), 'accounts.add');
    await setPolicies({ 'accounts.add': 'allowed' });
  });

  await t.test('the provider deletion worker queues and deletes nothing while deleting at the provider is forbidden', async () => {
    const worker = require('../dist/src/services/mail-server-delete') as typeof import('../src/services/mail-server-delete');
    await pool.execute(`UPDATE mail_accounts SET delete_emails_on_server = TRUE, server_delete_enabled_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR,
      server_delete_grace_until = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE id = ?`, [mail.blair]);
    await setPolicies({ 'mail.provider_delete': 'forbidden' });
    const skipped = await worker.runMailServerDeletionPass({ accountId: mail.blair });
    assert.deepEqual(skipped.accounts.map(result => (result as FixtureValue).reason), ['policy_forbids']);
    assert.deepEqual(await worker.seedMailServerDeletionQueueForAccount({ userId: users.blair, accountId: mail.blair }), { queued: 0 });
    // Allowed again, the same account goes on to the provider (here: without a password, so it stops there).
    await setPolicies({ 'mail.provider_delete': 'user_choice' });
    const attempted = await worker.runMailServerDeletionPass({ accountId: mail.blair });
    assert.equal((attempted.accounts[0] as FixtureValue).reason, undefined);
    assert.match(String((attempted.accounts[0] as FixtureValue).error), /No password/);
    await pool.execute('UPDATE mail_accounts SET delete_emails_on_server = FALSE, server_delete_enabled_at = NULL, server_delete_grace_until = NULL WHERE id = ?', [mail.blair]);
  });

  await t.test('the administrator\'s path: a stranger is refused, the password is asked, the person\'s scope, switch and restore lock hold, and the log names both', async () => {
    // Everything alex may not do; none of it stops the administrator.
    await setPolicies({ 'accounts.remove': 'forbidden', 'accounts.reset': 'forbidden', 'backup.delete': 'forbidden', 'bin.delete': 'forbidden' });
    const accounts = await call(admin, 'GET', `/api/admin/users/${users.alex}/accounts`);
    assert.deepEqual(accounts.mail_accounts.map((row: FixtureValue) => [row.id, row.email_address, row.sync_mode]), [[mail.alex, 'alex@mail.example.test', 'download']]);
    assert.ok(!JSON.stringify(accounts).includes('password'), 'no credentials');
    for (const [method, url] of [['GET', `/api/admin/users/${users.alex}/accounts`], ['DELETE', `/api/admin/users/${users.alex}/mail-accounts/${mail.alex}`],
      ['POST', `/api/admin/users/${users.alex}/clear/contacts`], ['POST', `/api/admin/users/${users.alex}/bin/empty`]] as const) {
      await call(blair, method, url, { current_password: password }, 403);
    }
    assert.equal((await call(admin, 'DELETE', `/api/admin/users/${users.alex}/mail-accounts/${mail.alex}`, { current_password: 'wrong-password' }, 403)).code, 'ADMIN_PASSWORD_INCORRECT');
    assert.equal((await call(admin, 'DELETE', `/api/admin/users/${users.alex}/mail-accounts/${mail.alex}`, {}, 400)).code, 'ADMIN_PASSWORD_REQUIRED');
    // blair's account under alex's path is not alex's.
    await call(admin, 'DELETE', `/api/admin/users/${users.alex}/mail-accounts/${mail.blair}`, { current_password: password }, 404);
    await call(admin, 'DELETE', `/api/admin/users/${crypto.randomUUID()}/mail-accounts/${mail.alex}`, { current_password: password }, 404);
    // alex's own switch and restore lock, not the administrator's.
    await call(alex, 'PUT', '/api/modules', { modules: { mail: { enabled: false } } });
    assert.equal((await call(admin, 'DELETE', `/api/admin/users/${users.alex}/mail-accounts/${mail.alex}`, { current_password: password }, 403)).code, 'MODULE_DISABLED');
    await call(alex, 'PUT', '/api/modules', { modules: { mail: { enabled: true } } });
    const restoreJob = crypto.randomUUID();
    await pool.execute(`INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '["mail"]')`, [restoreJob, users.alex]);
    assert.equal((await call(admin, 'DELETE', `/api/admin/users/${users.alex}/mail-accounts/${mail.alex}`, { current_password: password }, 409)).code, 'RESTORE_IN_PROGRESS');
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreJob]);
    assert.equal(await count('SELECT COUNT(*) AS count FROM audit_log WHERE action LIKE ?', ['admin.mail_account_%']), 0, 'nothing refused was recorded');

    // alex is refused, the administrator disconnects; the purge waits for the unresolved change, then goes.
    forbids(await call(alex, 'DELETE', `/api/mail/accounts/${mail.alex}`, {}, 403), 'accounts.remove');
    const removed = await call(admin, 'DELETE', `/api/admin/users/${users.alex}/mail-accounts/${mail.alex}`, { current_password: password });
    assert.equal(removed.deleted, 1);
    const [[disconnected]] = await pool.query<RowDataPacket[]>('SELECT is_active, disconnected_at FROM mail_accounts WHERE id = ?', [mail.alex]);
    assert.ok(disconnected.disconnected_at && !Number(disconnected.is_active));
    await call(admin, 'DELETE', `/api/admin/users/${users.alex}/mail-accounts/${mail.alex}?purge=true`, { current_password: password }, 409);
    await pool.execute("UPDATE mail_writebacks SET state = 'confirmed', status = 'done' WHERE id = ?", [unresolved]);
    assert.equal((await call(admin, 'DELETE', `/api/admin/users/${users.alex}/mail-accounts/${mail.alex}?purge=true`, { current_password: password })).deleted, 1);
    assert.deepEqual([await count('SELECT COUNT(*) AS count FROM mail_accounts WHERE user_id = ?', [users.alex]), await count('SELECT COUNT(*) AS count FROM emails WHERE user_id = ?', [users.alex])], [0, 0]);
    assert.equal(await count('SELECT COUNT(*) AS count FROM mail_accounts WHERE id = ?', [mail.blair]), 1, 'blair keeps theirs');
    for (const action of ['admin.mail_account_removed', 'admin.mail_account_reset']) {
      assert.deepEqual((await audit(action)).map(entry => [entry.actor, entry.target, entry.details.mail_account]), [[users.admin, users.alex, mail.alex]], action);
    }
    assert.equal(await count("SELECT COUNT(*) AS count FROM audit_log WHERE action IN ('mail.account_disconnected', 'mail.account_purged')"), 0, 'recorded as the administrator\'s');

    // A calendar account: added, changed and removed for alex (beside the default one a first look creates).
    await call(alex, 'GET', '/api/calendar/accounts');
    const local = await call(admin, 'POST', `/api/admin/users/${users.alex}/calendar-accounts`, { provider: 'local', display_name: 'Team', current_password: password });
    const calendarAccount = local.account.id as string;
    assert.equal(await count('SELECT COUNT(*) AS count FROM calendar_accounts WHERE id = ? AND user_id = ?', [calendarAccount, users.alex]), 1);
    await call(admin, 'PUT', `/api/admin/users/${users.alex}/calendar-accounts/${calendarAccount}`, { display_name: 'Team calendar', current_password: password });
    await call(admin, 'DELETE', `/api/admin/users/${users.blair}/calendar-accounts/${calendarAccount}`, { current_password: password }, 404);
    forbids(await call(alex, 'DELETE', `/api/calendar/accounts/${calendarAccount}`, {}, 403), 'accounts.remove');
    assert.equal((await call(admin, 'DELETE', `/api/admin/users/${users.alex}/calendar-accounts/${calendarAccount}`, { current_password: password })).deleted, 1);
    for (const action of ['admin.calendar_account_added', 'admin.calendar_account_changed', 'admin.calendar_account_removed']) {
      assert.deepEqual((await audit(action)).map(entry => [entry.actor, entry.target, entry.details.calendar_account]), [[users.admin, users.alex, calendarAccount]], action);
    }

    // A backup alex may not delete; the administrator may, also before the minimum age (D36).
    await setPolicies({ 'backup.delete': 'allowed', 'backup.server_retention_days': 30 });
    const [young, old] = [crypto.randomUUID(), crypto.randomUUID()];
    await pool.execute(`INSERT INTO data_export_jobs (id, user_id, status, phase, progress, created_at, completed_at)
      VALUES (?, ?, 'ready', 'complete', 100, UTC_TIMESTAMP() - INTERVAL 3 DAY, UTC_TIMESTAMP() - INTERVAL 3 DAY), (?, ?, 'ready', 'complete', 100, UTC_TIMESTAMP() - INTERVAL 40 DAY, UTC_TIMESTAMP() - INTERVAL 40 DAY)`,
    [young, users.alex, old, users.alex]);
    const refusedYoung = await call(alex, 'DELETE', `/api/backup/jobs/${young}`, {}, 403);
    forbids(refusedYoung, 'backup.server_retention_days');
    assert.match(refusedYoung.error, /at least 30 days\. This one can be deleted from \d{4}-\d{2}-\d{2}\./);
    await call(alex, 'DELETE', `/api/backup/jobs/${old}`);
    await call(blair, 'DELETE', `/api/backup/jobs/${young}`, {}, 404);
    assert.deepEqual((await call(admin, 'GET', `/api/admin/users/${users.alex}/backups`)).jobs.map((job: FixtureValue) => job.id), [young]);
    assert.equal((await call(admin, 'DELETE', `/api/admin/users/${users.alex}/backups/${young}`, { current_password: password })).deleted, 1);
    assert.equal(await count('SELECT COUNT(*) AS count FROM data_export_jobs WHERE user_id = ?', [users.alex]), 0);
    assert.deepEqual((await audit('admin.backup_deleted')).map(entry => [entry.target, entry.details.backup_job]), [[users.alex, young]]);
    // backup.delete forbidden refuses every delete of the person's.
    await pool.execute(`INSERT INTO data_export_jobs (id, user_id, status, phase, progress, created_at) VALUES (?, ?, 'ready', 'complete', 100, UTC_TIMESTAMP() - INTERVAL 400 DAY)`, [old, users.alex]);
    await setPolicies({ 'backup.delete': 'forbidden' });
    forbids(await call(alex, 'DELETE', `/api/backup/jobs/${old}`, {}, 403), 'backup.delete');
    await setPolicies({ 'backup.delete': 'allowed', 'backup.server_retention_days': null });

    // The bin, while alex may not delete from it for good.
    const binned = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of binned) {
      await pool.execute(`INSERT INTO bin_items (id, user_id, module, item_type, item_id, title, reason, payload, deleted_at, purge_after)
        VALUES (?, ?, 'contacts', 'contact', ?, 'Synthetic contact', 'deleted', '{}', UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 30 DAY)`, [id, users.alex, crypto.randomUUID()]);
    }
    forbids(await call(alex, 'DELETE', `/api/bin/${binned[0]}`, {}, 403), 'bin.delete');
    assert.deepEqual((await call(admin, 'GET', `/api/admin/users/${users.alex}/bin`)).items.map((item: FixtureValue) => item.id).sort(), [...binned].sort());
    await call(admin, 'DELETE', `/api/admin/users/${users.blair}/bin/${binned[0]}`, { current_password: password }, 404);
    assert.equal((await call(admin, 'DELETE', `/api/admin/users/${users.alex}/bin/${binned[0]}`, { current_password: password })).deleted, 1);
    assert.equal((await call(admin, 'POST', `/api/admin/users/${users.alex}/bin/empty`, { module: 'contacts', current_password: password })).deleted, 1);
    assert.equal(await count('SELECT COUNT(*) AS count FROM bin_items WHERE user_id = ?', [users.alex]), 0);
    assert.deepEqual((await audit('admin.bin_item_deleted')).map(entry => [entry.target, entry.details.bin_item]), [[users.alex, binned[0]]]);
    assert.deepEqual((await audit('admin.bin_emptied')).map(entry => [entry.target, entry.details.deleted, entry.details.module]), [[users.alex, 1, 'contacts']]);

    // Delete data for alex: alex's contacts go, blair's stay; data.clear (implied by bin.delete) stops only alex.
    await call(alex, 'POST', '/api/contacts', { name: { given: 'Robin' } });
    await call(blair, 'POST', '/api/contacts', { name: { given: 'Sky' } });
    forbids(await call(alex, 'POST', '/api/settings/clear-contacts', {}, 403), 'data.clear');
    await call(admin, 'POST', `/api/admin/users/${users.alex}/clear/everything`, { current_password: password }, 404);
    const cleared = await call(admin, 'POST', `/api/admin/users/${users.alex}/clear/contacts`, { current_password: password });
    assert.equal(cleared.deleted, 1);
    assert.deepEqual([await count('SELECT COUNT(*) AS count FROM contacts WHERE user_id = ?', [users.alex]), await count('SELECT COUNT(*) AS count FROM contacts WHERE user_id = ?', [users.blair])], [0, 1]);
    assert.deepEqual((await audit('admin.data_cleared')).map(entry => [entry.actor, entry.target, entry.details.module, entry.details.deleted]), [[users.admin, users.alex, 'contacts', 1]]);
    await setPolicies({ 'accounts.remove': 'allowed', 'accounts.reset': 'allowed', 'bin.delete': 'allowed' });
  });

  await t.test('D33, D34: the bin keeps 30 days by default; while deleting for good is forbidden the purge keeps the administrator\'s minimum', async () => {
    const { purgeBin } = require('../dist/src/services/bin') as typeof import('../src/services/bin');
    assert.deepEqual((await call(blair, 'GET', '/api/settings/values')).settings.bin_retention, { value: '30', source: 'default', locked: false });
    await call(alex, 'PUT', '/api/settings/values', { values: { bin_retention: '7' } });
    // Deleted 40 and 20 days ago, both past alex's 7 days.
    const [forty, twenty] = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [id, days] of [[forty, 40], [twenty, 20]] as const) {
      await pool.execute(`INSERT INTO bin_items (id, user_id, module, item_type, item_id, title, reason, payload, deleted_at, purge_after)
        VALUES (?, ?, 'contacts', 'contact', ?, 'Synthetic contact', 'deleted', '{}', UTC_TIMESTAMP() - INTERVAL ? DAY, UTC_TIMESTAMP() - INTERVAL ? DAY)`, [id, users.alex, crypto.randomUUID(), days, days - 7]);
    }
    const open = async () => ((await pool.query<RowDataPacket[]>('SELECT id FROM bin_items WHERE user_id = ? ORDER BY deleted_at', [users.alex]))[0]).map(row => row.id);

    // Forbidden, no minimum chosen: forever. alex's 7 days read as forever, a shorter choice is refused, nothing goes.
    await setPolicies({ 'bin.delete': 'forbidden' }, { bin_min_retention: 'forever' });
    assert.deepEqual((await call(alex, 'GET', '/api/settings/values')).settings.bin_retention, { value: 'forever', source: 'policy', locked: false, floor: 'forever' });
    const floor = await call(alex, 'PUT', '/api/settings/values', { values: { bin_retention: '90' } }, 403);
    assert.deepEqual([floor.code, floor.error], ['POLICY_FLOOR', BIN_MIN_RETENTION.reasons.forever]);
    assert.deepEqual((await call(alex, 'GET', '/api/bin')).items.map((item: FixtureValue) => item.purge_after), [null, null], 'nothing will take them');
    await purgeBin();
    assert.deepEqual(await open(), [forty, twenty]);

    // A minimum of 30 days: the item of 40 days goes, the one of 20 stays although alex chose 7.
    await setPolicies({}, { bin_min_retention: '30' });
    const shown = (await call(alex, 'GET', '/api/bin')).items.find((item: FixtureValue) => item.id === twenty);
    assert.ok(Date.parse(shown.purge_after) - Date.now() > 9 * 86400000, `shown no sooner than the minimum: ${shown.purge_after}`);
    await purgeBin();
    assert.deepEqual(await open(), [twenty]);

    // Allowed again: alex's own 7 days hold once more.
    await setPolicies({ 'bin.delete': 'allowed' });
    assert.equal((await call(alex, 'GET', '/api/settings/values')).settings.bin_retention.value, '7');
    await purgeBin();
    assert.deepEqual(await open(), []);
  });
});
