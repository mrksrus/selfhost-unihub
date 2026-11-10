import type { FixtureValue } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http = require('node:http') as typeof import('node:http');
const fs = require('node:fs/promises') as typeof import('node:fs/promises');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime.cts');

// The app lock gate (0.29) through the real request handler and a disposable
// MariaDB, with the administrator, alex (the owner, on a laptop and a phone),
// blair (a second person) and casey (a stranger to the policies page):
// - only an administrator, with the password, sets app_lock.*; each change
//   is in the activity log, bumps the rules revision and names its rule
// - a device without the required lock gets 403 APP_LOCK_REQUIRED on the
//   locked areas and keeps the exempt routes; compliance is per device and
//   never for an administrator's own device by role
// - the Android app's own contacts sync and the recording uploads stay open,
//   and a disabled module or a running restore answers as before
// - no requirement, a maximum time in the background alone, or a screenshot
//   rule refuses nothing
test('app lock policy: the admin sets it, the gate refuses a device short of it on the locked areas only, per device', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async () => {
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  assert.match(process.env.MYSQL_TEST_DATABASE as string, /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE,
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, connectionLimit: 8, timezone: 'Z' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-app-lock-'));
  let server: FixtureValue; let owned = false; let runtime: FixtureValue;
  try {
    const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES'); assert.equal(tables.length, 0, 'Use an empty disposable test database'); owned = true;
    runtime = createBackupRuntime(directory, 'app-lock-synthetic-key', pool);
    await runtime('services/database').ensureSchema();
    const password = 'app-lock-fixture-password-2026';
    const passwordHash = await require('bcryptjs').hash(password, 10);
    const ids: Record<string, string> = {};
    for (const [name, role] of [['admin', 'admin'], ['alex', 'user'], ['blair', 'user'], ['casey', 'user']] as const) {
      ids[name] = crypto.randomUUID();
      await pool.execute<ResultSetHeader>('INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)', [ids[name], `${name}@example.test`, passwordHash, name, role]);
    }
    const { handleRequest } = runtime('request-handler');
    server = http.createServer((req, res) => handleRequest(req, res).catch((error: FixtureValue) => res.destroy(error)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
    const appPage = 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36 UniHubAndroid/0.28.2 (28020) UniHubBridge/2';
    // The app's own requests (AppSession.kt): its agent without the bridge, and the background header.
    const nativeHeaders = { 'User-Agent': 'UniHubAndroid/0.28.2 (28020)', 'X-Background-Sync': '1' };
    // One browser (or app) with its cookies, CSRF token and user agent; `expected` null skips the status check.
    function client(agent: string) {
      const cookies = new Map<string, string>(); let csrf: string | undefined;
      const request = async (method: string, route: string, body?: unknown, expected: number | null = 200, headers: Record<string, string> = {}) => {
        const response = await fetch(base + '/api' + route, { method, headers: {
          'User-Agent': agent,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
          ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
          ...headers,
        }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(';')[0]; const separator = pair.indexOf('=');
          if (/Expires=Thu, 01 Jan 1970/.test(cookie)) cookies.delete(pair.slice(0, separator)); else cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
        }
        const result = await response.json();
        if (expected !== null) assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result).slice(0, 400)}`);
        if (result?.csrfToken) csrf = result.csrfToken;
        return Object.assign(result ?? {}, { httpStatus: response.status });
      };
      request.signIn = async (email: string, kind = 'web') => {
        await request('POST', '/auth/signin', { email, password, device: { key: crypto.randomBytes(32).toString('base64url'), kind } });
        await request('GET', '/auth/me');
      };
      return request;
    }
    type Client = ReturnType<typeof client>;
    const rows = async (sql: string, values: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, values))[0];
    const capabilities = { lock: 'pin', secure_window: false, recents_hidden: false, device_lock_signal: false };
    const report = (person: Client, scope: string[], relock_after = '300') =>
      person('PUT', '/devices/current/lock', { applied: { scope, relock_after, on_device_lock: true, method: 'pin' }, capabilities });
    const setPolicies = (values: Record<string, unknown>, status = 200, by: Client = admin) =>
      by('PUT', '/admin/policies', { values, current_password: password }, status);
    const refused = async (person: Client, method: string, route: string, details: FixtureValue, body?: unknown, headers?: Record<string, string>) => {
      const reply = await person(method, route, body ?? (method === 'GET' ? undefined : {}), 403, headers);
      assert.deepEqual([reply.code, reply.error, reply.details], ['APP_LOCK_REQUIRED', details.reason, details], `${method} ${route}`);
    };
    const open = async (person: Client, method: string, route: string, body?: unknown, headers?: Record<string, string>) => {
      const reply = await person(method, route, body ?? (method === 'GET' ? undefined : {}), null, headers);
      assert.notEqual(reply.code, 'APP_LOCK_REQUIRED', `${method} ${route}: ${JSON.stringify(reply).slice(0, 300)}`);
      return reply;
    };

    const admin = client(browser), laptop = client(browser), phone = client(appPage), blair = client(browser), casey = client(browser);
    await admin.signIn('admin@example.test');
    await laptop.signIn('alex@example.test');
    await phone.signIn('alex@example.test', 'android');
    await blair.signIn('blair@example.test');
    await casey.signIn('casey@example.test');
    const contact = (await laptop('POST', '/contacts', { first_name: 'Robin', email: 'robin@example.test' })).contact;
    assert.ok(contact?.id);
    // A message of alex's with a task made from it: Calendar data inside a Mail answer.
    const account = crypto.randomUUID(), email = crypto.randomUUID();
    await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active) VALUES (?, ?, 'alex@example.test', 'custom', 'download', TRUE)", [account, ids.alex]);
    await pool.execute(`INSERT INTO emails (id, user_id, mail_account_id, subject, from_address, from_name, to_addresses, folder, received_at)
      VALUES (?, ?, ?, 'Invoice 4711', 'billing@power.example', 'Power Co', '[]', 'inbox', '2026-10-10 08:00:00')`, [email, ids.alex, account]);
    await laptop('POST', '/calendar/events', { title: 'Pay invoice 4711', is_todo_only: true, source_email_id: email });
    assert.deepEqual((await phone('GET', `/mail/emails/${email}`)).email.tasks.map((task: FixtureValue) => task.title), ['Pay invoice 4711']);

    // --- No requirement: nothing changes ------------------------------------
    for (const route of ['/mail/accounts', '/contacts', '/calendar/calendars', '/recordings', '/bin', '/stats']) await laptop('GET', route);

    // --- Only an administrator with the password sets the policy ------------
    await casey('GET', '/admin/policies', undefined, 403);
    await setPolicies({ 'app_lock.required': ['mail'] }, 403, casey);
    assert.equal((await admin('PUT', '/admin/policies', { values: { 'app_lock.required': ['mail'] } }, 400)).code, 'ADMIN_PASSWORD_REQUIRED');
    assert.equal((await admin('PUT', '/admin/policies', { values: { 'app_lock.required': ['mail'] }, current_password: 'wrong-password' }, 403)).code, 'ADMIN_PASSWORD_INCORRECT');
    assert.equal((await setPolicies({ 'app_lock.required': ['notes'] }, 400)).code, 'POLICY_INVALID', 'no such area');
    assert.equal((await setPolicies({ 'app_lock.max_background': '120' }, 400)).code, 'POLICY_INVALID');
    assert.deepEqual(await rows("SELECT setting_key FROM setting_policies WHERE setting_key LIKE 'policy.app_lock.%'"), [], 'nothing stored by a refusal');
    const before = (await admin('GET', '/policies/effective')).revision;
    const saved = await setPolicies({ 'app_lock.required': ['mail'], 'app_lock.max_background': '300' });
    assert.equal(saved.revision, before + 1);
    assert.deepEqual([saved.policies['app_lock.required'].value, saved.policies['app_lock.max_background'].value], [['mail'], '300']);
    const logged = (await rows("SELECT actor_id, details FROM audit_log WHERE action = 'admin.policy_changed' ORDER BY id"))
      .map(row => [row.actor_id, typeof row.details === 'string' ? JSON.parse(row.details) : row.details]);
    assert.deepEqual(logged.filter(([, details]) => String(details.key).startsWith('app_lock.')).sort((a, b) => a[1].key.localeCompare(b[1].key)), [
      [ids.admin, { key: 'app_lock.max_background', from: 'none', to: '300' }],
      [ids.admin, { key: 'app_lock.required', from: null, to: 'mail' }],
    ]);
    const mailReason = 'Your administrator requires the app lock for Mail.';
    const mailOnly = { required: ['mail'], max_background: '300', reason: mailReason };
    const rules = await laptop('GET', '/policies/effective');
    assert.deepEqual([rules.revision, rules.rules.includes(mailReason), rules.rules.includes('Your administrator allows at most 5 minutes in the background before UniHub locks again.')],
      [before + 1, true, true]);

    // --- alex's laptop without the lock: Mail and the cross-module routes go -
    await refused(laptop, 'GET', '/mail/accounts', mailOnly);
    await refused(laptop, 'POST', '/mail/accounts', mailOnly, { email: 'x@example.test' });
    await refused(laptop, 'GET', '/settings/values/mail-accounts', mailOnly);
    for (const route of ['/bin', '/stats', '/search?q=Robin', '/offline/snapshot', '/backup/jobs']) await refused(laptop, 'GET', route, mailOnly);
    await refused(laptop, 'POST', '/files/tickets', mailOnly, { kind: 'backup-archive', id: crypto.randomUUID() });
    for (const route of ['/contacts', `/contacts/${contact.id}`, '/calendar/calendars', '/recordings']) await laptop('GET', route);
    // The exempt routes: who is signed in, the rules, this device and its settings, sign-out of others.
    for (const route of ['/auth/me', '/auth/sessions', '/modules', '/settings/values', '/settings/preferences', '/settings/values/device', '/devices', '/notifications/config']) await laptop('GET', route);
    const current = await laptop('GET', '/devices/current');
    assert.deepEqual(current.compliance, { meets: false, ...mailOnly });
    await laptop('POST', '/policies/acknowledge', { revision: before + 1 });
    assert.equal((await laptop('PUT', '/settings/values/device', { values: { app_lock_scope: [] } }, 403)).code, 'POLICY_FLOOR');

    // --- A lock covering Mail, waiting at most 5 minutes, opens it -----------
    await report(laptop, ['mail'], '900');
    await refused(laptop, 'GET', '/mail/accounts', mailOnly);
    assert.equal((await laptop('PUT', '/settings/values/device', { values: { app_lock_relock_after: '900' } }, 403)).code, 'POLICY_FLOOR');
    const reported = await report(laptop, ['mail'], '300');
    assert.equal(reported.compliance.meets, true);
    await laptop('GET', '/mail/accounts');
    await laptop('GET', '/bin');
    await laptop('GET', '/stats');

    // --- Per device, per person, and no administrator by role ----------------
    // alex's phone is another device: it reported nothing, and the laptop's report is not its.
    await refused(phone, 'GET', '/mail/accounts', mailOnly);
    const lockOf = async (person: Client) => (await rows('SELECT lock_applied FROM devices WHERE id = ?', [(await person('GET', '/devices/current')).device.id]))[0].lock_applied;
    assert.equal(await lockOf(phone), null);
    assert.ok(await lockOf(laptop));
    await refused(blair, 'GET', '/mail/accounts', mailOnly);
    await blair('GET', '/contacts');
    await refused(admin, 'GET', '/mail/accounts', mailOnly);
    await refused(admin, 'GET', '/admin/policies', mailOnly);
    await refused(admin, 'GET', '/admin/users', mailOnly);
    await report(admin, ['app'], '0');
    await admin('GET', '/admin/policies');
    await admin('GET', '/mail/accounts');

    // --- The whole app; tightening makes a compliant device short again -------
    const appReason = 'Your administrator requires the app lock for the whole app.';
    await setPolicies({ 'app_lock.required': ['app'] });
    const whole = { required: ['app'], max_background: '300', reason: appReason };
    for (const route of ['/mail/accounts', '/contacts', '/calendar/calendars', '/recordings', '/bin', '/stats']) await refused(laptop, 'GET', route, whole);
    await refused(laptop, 'PUT', '/modules', whole, { modules: { mail: { enabled: true } } });
    for (const route of ['/auth/me', '/policies/effective', '/devices/current', '/settings/values/device', '/devices']) await laptop('GET', route);
    // A recording that exists only on the device still reaches the server.
    await open(phone, 'POST', '/recordings/uploads/start', { upload_id: crypto.randomUUID(), total_bytes: 4, title: 'Synthetic note', mime_type: 'audio/webm' });
    // The Android app's own contacts sync keeps working; the page does not.
    await refused(phone, 'GET', '/contacts', whole);
    const listed = await phone('GET', '/contacts?limit=50', undefined, 200, nativeHeaders);
    assert.deepEqual(listed.contacts.map((row: FixtureValue) => row.id), [contact.id]);
    const added = (await phone('POST', '/contacts', { first_name: 'Sasha', phone: '+1 555 0100' }, 200, nativeHeaders)).contact;
    await phone('PUT', `/contacts/${added.id}`, { first_name: 'Sasha', last_name: 'Doe', phone: '+1 555 0100' }, 200, nativeHeaders);
    await open(phone, 'GET', `/contacts/${contact.id}/photo?size=full`, undefined, nativeHeaders);
    await phone('DELETE', `/contacts/${added.id}`, undefined, 200, nativeHeaders);
    await refused(phone, 'GET', `/contacts/${contact.id}`, whole, undefined, nativeHeaders);
    await refused(phone, 'GET', '/mail/accounts', whole, undefined, nativeHeaders);
    await report(laptop, ['app'], '60');
    for (const route of ['/mail/accounts', '/contacts', '/bin']) await laptop('GET', route);

    // --- A disabled module and a running restore answer as before ------------
    await laptop('PUT', '/modules', { modules: { contacts: { enabled: false } } });
    for (const headers of [{}, nativeHeaders]) {
      assert.equal((await phone('GET', '/contacts?limit=50', undefined, 403, headers)).code, 'MODULE_DISABLED', 'the old app\'s "Contacts gone" answer');
    }
    await laptop('PUT', '/modules', { modules: { contacts: { enabled: true } } });
    const restoreId = crypto.randomUUID();
    await pool.execute("INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', ?)", [restoreId, ids.alex, JSON.stringify(['contacts'])]);
    for (const headers of [{}, nativeHeaders]) {
      assert.equal((await phone('POST', '/contacts', { first_name: 'Kim' }, 409, headers)).code, 'RESTORE_IN_PROGRESS');
    }
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreId]);

    // --- A device short of the lock still signs a lost device out ------------
    const laptopId = (await laptop('GET', '/devices/current')).device.id;
    await phone('DELETE', `/devices/${laptopId}`);
    await laptop('GET', '/auth/me', undefined, 401);

    // --- Calendar required: its data leaves the Mail answers too --------------
    await setPolicies({ 'app_lock.required': ['calendar'] });
    const calendarOnly = { required: ['calendar'], max_background: '300', reason: 'Your administrator requires the app lock for Calendar and ToDo.' };
    await refused(phone, 'GET', '/calendar/calendars', calendarOnly);
    await refused(phone, 'GET', `/mail/accounts/${account}/calendar`, calendarOnly);
    await refused(phone, 'PUT', `/mail/accounts/${account}/calendar`, calendarOnly, { enabled: false });
    await phone('GET', '/mail/accounts');
    const message = (await phone('GET', `/mail/emails/${email}`)).email;
    assert.deepEqual([message.subject, message.tasks], ['Invoice 4711', []]);
    await report(phone, ['calendar'], '60');
    assert.equal((await phone('GET', `/mail/emails/${email}`)).email.tasks.length, 1);
    await open(phone, 'GET', `/mail/accounts/${account}/calendar`);
    await phone('PUT', '/devices/current/lock', { applied: null, capabilities });

    // --- No requirement, a maximum alone, a screenshot rule: nothing refused --
    await setPolicies({ 'app_lock.required': [], 'app_lock.max_background': '60', 'app_lock.screenshots': 'forbidden' });
    for (const route of ['/mail/accounts', '/contacts', '/bin', '/stats']) await blair('GET', route);
    assert.equal((await blair('GET', '/devices/current')).compliance.meets, true);
    assert.equal((await blair('GET', '/policies/effective')).rules.includes('Your administrator does not allow screenshots in the UniHub app.'), true);
    await setPolicies({ 'app_lock.max_background': 'none', 'app_lock.screenshots': 'allowed' });
    assert.deepEqual(await rows("SELECT setting_key FROM setting_policies WHERE setting_key LIKE 'policy.app_lock.%'"), []);
    await phone('GET', '/mail/accounts');
  } finally {
    runtime?.('services/android-push').closeAndroidStreams();
    runtime?.('services/server-events').serverEvents?.closeAll?.({ reason: 'shutdown' });
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (owned) {
      const connection = await pool.getConnection();
      try {
        await connection.query('SET FOREIGN_KEY_CHECKS=0');
        const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES');
        for (const row of tables) await connection.query('DROP TABLE ??', [Object.values(row)[0]]);
      } finally { await connection.query('SET FOREIGN_KEY_CHECKS=1'); connection.release(); }
    }
    await pool.end();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
