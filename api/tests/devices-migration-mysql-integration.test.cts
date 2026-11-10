import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// Upgrade step 26 (0.29, devices as records) on a database of 0.28 (step 25)
// with people signed in through the real request handler: in a browser, in
// the Android app of 0.28.2 and in an app of 0.24 (no bridge level). Every
// session gets a device of its own, also when the step runs again after an
// interruption; every push channel follows its session's device, a session's
// stale second channel of one transport goes; and nobody is signed out.
test('upgrade 26 gives every session a device and every push channel its device, and signs nobody out', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t, { migrate: false });
  const { runMigrations } = require('../dist/src/services/database-migrations') as typeof import('../src/services/database-migrations');
  const { MIGRATIONS } = require('../dist/src/services/database') as typeof import('../src/services/database');
  const { BASELINE } = require('../dist/src/services/database-baseline') as typeof import('../src/services/database-baseline');
  const { addDevices } = require('../dist/src/services/devices-migration') as typeof import('../src/services/devices-migration');
  const { deviceForSession } = require('../dist/src/services/devices') as typeof import('../src/services/devices');
  await runMigrations(pool, MIGRATIONS.filter(step => step.id <= 25), BASELINE);

  const password = 'devices-upgrade-fixture-password';
  const passwordHash = await require('bcryptjs').hash(password, 10);
  const users: Record<string, string> = {};
  for (const name of ['alex', 'blair']) {
    users[name] = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)', [users[name], `${name}@example.test`, passwordHash, name]);
  }
  const api = await startTestApi(t);
  const agents = {
    browser: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    app: 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36 UniHubAndroid/0.28.2 (28002) UniHubBridge/2',
    oldApp: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36 UniHubAndroid/0.24.3 (24003)',
  };
  async function signIn(name: string, agent: string) {
    const client = api.client();
    const reply = await client.request('POST', '/api/auth/signin', { email: `${name}@example.test`, password }, { 'user-agent': agent });
    assert.equal(reply.status, 200, String(reply.body.error));
    return { client, agent };
  }
  const people = {
    alexBrowser: await signIn('alex', agents.browser),
    alexApp: await signIn('alex', agents.app),
    blairOldApp: await signIn('blair', agents.oldApp),
  };
  const [sessions] = await pool.query<RowDataPacket[]>('SELECT id, user_id, user_agent, expires_at FROM sessions ORDER BY user_agent');
  assert.equal(sessions.length, 3);
  const sessionOf = (agent: string) => sessions.find(row => row.user_agent === agent)!;

  // Push channels as 0.28 kept them: the browser session has a replaced
  // endpoint beside its current one; each app session has its registration.
  const channel = async (session: RowDataPacket, transport: string, updated: string) => {
    const id = crypto.randomUUID();
    const endpoint = transport === 'android' ? `unihub-android:${id}` : `https://fcm.googleapis.com/fcm/send/${id}`;
    await pool.execute(`INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, endpoint_hash, p256dh, auth, transport, updated_at)
      VALUES (?, ?, ?, ?, ?, 'BKey', 'auth', ?, ?)`, [id, session.user_id, session.id, endpoint, crypto.createHash('sha256').update(endpoint).digest('hex'), transport, updated]);
    return id;
  };
  const replaced = await channel(sessionOf(agents.browser), 'webpush', '2026-10-01 08:00:00');
  const current = await channel(sessionOf(agents.browser), 'webpush', '2026-11-01 08:00:00');
  const appChannel = await channel(sessionOf(agents.app), 'android', '2026-11-02 08:00:00');
  const oldAppChannel = await channel(sessionOf(agents.oldApp), 'android', '2026-11-03 08:00:00');

  // An interrupted step 26: its work ran, the step was not recorded; the
  // next start runs it again and must not make a second device per session.
  const interrupted = await pool.getConnection();
  try { await addDevices(interrupted); } finally { interrupted.release(); }
  await runMigrations(pool, MIGRATIONS, BASELINE);

  const [[step]] = await pool.query<RowDataPacket[]>('SELECT name FROM schema_migrations WHERE id = 26');
  assert.equal(step.name, 'devices-and-app-lock');
  const [devices] = await pool.query<RowDataPacket[]>(`SELECT d.*, s.id AS session_id,
      DATE_FORMAT(d.last_seen_at, '%Y-%m-%d %H:%i:%s') AS seen, DATE_FORMAT(GREATEST(s.created_at, s.expires_at - INTERVAL 21 DAY), '%Y-%m-%d %H:%i:%s') AS last_use
    FROM devices d JOIN sessions s ON s.device_id = d.id ORDER BY d.user_agent`);
  assert.equal(devices.length, 3, 'one device per session');
  assert.equal(Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM devices'))[0][0].n), 3, 'the second run made no device of its own');
  const deviceOf = (agent: string) => devices.find(row => row.user_agent === agent)!;
  for (const agent of Object.values(agents)) {
    const device = deviceOf(agent);
    assert.equal(device.session_id, sessionOf(agent).id);
    assert.equal(device.user_id, sessionOf(agent).user_id, 'a device belongs to its session\'s person');
    assert.equal(device.key_hash, null, 'a device from before 0.29 has no key until its page names one');
    assert.equal(device.seen, device.last_use, 'its last use is its session\'s');
    assert.equal(device.lock_applied, null);
    assert.equal(device.open_until, null);
  }
  assert.deepEqual([deviceOf(agents.browser).kind, deviceOf(agents.browser).app_version, deviceOf(agents.browser).bridge_level], ['web', null, null]);
  assert.deepEqual([deviceOf(agents.app).kind, deviceOf(agents.app).app_version, Number(deviceOf(agents.app).bridge_level)], ['android', '0.28.2', 2]);
  assert.deepEqual([deviceOf(agents.oldApp).kind, deviceOf(agents.oldApp).app_version, Number(deviceOf(agents.oldApp).bridge_level)], ['android', '0.24.3', 1],
    'an app before bridge levels counts as level 1');

  // Each channel follows its session's device; the replaced one is gone.
  const [channels] = await pool.query<RowDataPacket[]>("SELECT id, device_id, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated FROM push_subscriptions ORDER BY updated_at");
  assert.deepEqual(channels.map(row => [row.id, row.device_id, row.updated]), [
    [current, deviceOf(agents.browser).id, '2026-11-01 08:00:00'],
    [appChannel, deviceOf(agents.app).id, '2026-11-02 08:00:00'],
    [oldAppChannel, deviceOf(agents.oldApp).id, '2026-11-03 08:00:00'],
  ], 'binding a channel to its device is no change of the channel');
  assert.ok(!channels.some(row => row.id === replaced));
  // One channel per device and transport from now on.
  await assert.rejects(pool.execute(`INSERT INTO push_subscriptions (id, user_id, session_id, device_id, endpoint, endpoint_hash, p256dh, auth, transport)
    VALUES (?, ?, ?, ?, 'https://fcm.googleapis.com/fcm/send/second', ?, 'BKey', 'auth', 'webpush')`,
  [crypto.randomUUID(), users.alex, sessionOf(agents.browser).id, deviceOf(agents.browser).id, crypto.createHash('sha256').update('second').digest('hex')]), /Duplicate entry/);

  // Nobody is signed out: every session still authenticates through the
  // real boundary, and the read helper finds its device.
  for (const { client, agent } of Object.values(people)) {
    const reply = await client.request('GET', '/api/auth/sessions', undefined, { 'user-agent': agent });
    assert.equal(reply.status, 200, `${agent}: ${String(reply.body.error)}`);
    assert.equal((await deviceForSession(sessionOf(agent).id))?.id, deviceOf(agent).id);
  }
  assert.equal(Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM sessions'))[0][0].n), 3);

  // Removing a device ends its sessions, their push channels and its settings.
  await pool.execute("INSERT INTO device_settings (device_id, user_id, setting_key, setting_value) VALUES (?, ?, 'app_lock_scope', '[\"mail\"]')", [deviceOf(agents.app).id, users.alex]);
  await pool.execute('DELETE FROM devices WHERE id = ?', [deviceOf(agents.app).id]);
  const left = async (sql: string, id: string) => Number((await pool.query<RowDataPacket[]>(sql, [id]))[0][0].n);
  assert.equal(await left('SELECT COUNT(*) AS n FROM sessions WHERE id = ?', sessionOf(agents.app).id), 0);
  assert.equal(await left('SELECT COUNT(*) AS n FROM push_subscriptions WHERE id = ?', appChannel), 0);
  assert.equal(await left('SELECT COUNT(*) AS n FROM device_settings WHERE device_id = ?', deviceOf(agents.app).id), 0);
  assert.equal((await people.alexApp.client.request('GET', '/api/auth/sessions', undefined, { 'user-agent': agents.app })).status, 401, 'the removed device is signed out');
  assert.equal((await people.alexBrowser.client.request('GET', '/api/auth/sessions', undefined, { 'user-agent': agents.browser })).status, 200, 'the person\'s other device is not');
});
