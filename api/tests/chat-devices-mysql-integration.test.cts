import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople, PEOPLE } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// Chat accounts, chat devices and key packages through the real request
// handler with the shared people. Alex (two devices) and Blair have a
// conversation; Casey, Drew and the administrator are in none. The server
// handles opaque bytes, so synthetic random ones stand in for MLS key
// packages and sealed keys.
test('chat devices: enrolment, key packages, device lists, removal, the module and app lock gates, and the key backup', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, groups, clients, password, api } = await seedPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey, revoked: drew } = clients;
  type Client = typeof admin;
  const call = async (client: Client, method: string, url: string, body?: unknown, status = 200): Promise<FixtureValue> => {
    const reply = await client.request(method, url, body);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    return reply.body;
  };
  const refused = async (client: Client, method: string, url: string, body?: unknown) => {
    const reply = await client.request(method, url, body);
    return [reply.status, reply.body.code ?? null];
  };
  const random = (length: number) => crypto.randomBytes(length).toString('base64url');
  const pointKey = () => { const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); return ecdh.getPublicKey().toString('base64url'); };
  const preview = () => ({ p256dh: pointKey(), auth: random(16) });
  const packages = (count: number) => Array.from({ length: count }, () => random(313));
  const enrol = (client: Client, count: number, withPreview = true) =>
    call(client, 'POST', '/api/chat/devices', { preview: withPreview ? preview() : null, key_packages: packages(count), last_resort: random(313) });
  const signIn = async (who: keyof typeof PEOPLE) => {
    const client = api.client();
    await call(client, 'POST', '/api/auth/signin', { email: PEOPLE[who].email, password, device: { key: random(32), kind: 'web' } });
    return client;
  };
  const deviceOf = async (client: Client) => (await call(client, 'GET', '/api/devices/current')).device as FixtureValue;
  const count = async (sql: string, params: unknown[] = []) => Number((await pool.query<RowDataPacket[]>(sql, params))[0][0].n);

  // ── Enrolment: Alex's browser with a preview key, Alex's phone without one, Blair's browser ──
  const alexPhone = await signIn('manager');
  const a1 = await enrol(alex, 3);
  assert.deepEqual(await call(alex, 'GET', '/api/chat/devices/current'), a1);
  assert.equal(a1.key_packages, 3);
  const a2 = await enrol(alexPhone, 2, false);
  const b1 = await enrol(blair, 1);
  assert.deepEqual(await refused(casey, 'GET', '/api/chat/devices/current'), [404, 'CHAT_DEVICE_NOT_ENROLLED']);
  assert.deepEqual(await refused(casey, 'POST', '/api/chat/devices', { preview: null, key_packages: [], last_resort: random(313) }), [400, 'CHAT_KEY_PACKAGES_INVALID']);
  assert.deepEqual(await refused(casey, 'POST', '/api/chat/devices', { preview: null, key_packages: ['not base64!'], last_resort: random(313) }), [400, 'CHAT_KEY_PACKAGES_INVALID']);
  assert.deepEqual([(await deviceOf(alex)).chat, (await deviceOf(casey)).chat], [true, false], 'the device list marks a device that holds chat keys');
  // The phone's previews are sealed to its push channel's key.
  const phone = await deviceOf(alexPhone);
  const push = preview();
  const [[session]] = await pool.query<RowDataPacket[]>('SELECT id FROM sessions WHERE device_id = ?', [phone.id]);
  await pool.execute(`INSERT INTO push_subscriptions (id, user_id, session_id, device_id, endpoint, endpoint_hash, p256dh, auth, transport)
    VALUES (UUID(), ?, ?, ?, 'unihub-android://synthetic', SHA2('synthetic', 256), ?, ?, 'android')`, [ids.manager, session.id, phone.id, push.p256dh, push.auth]);

  // ── A conversation of Alex and Blair (its routes come later; written as rows here) ──
  const conversation = crypto.randomUUID();
  await pool.execute("INSERT INTO chat_conversations (id, kind, direct_key, created_by) VALUES (?, 'direct', ?, ?)", [conversation, [ids.manager, ids.member].sort().join(':'), ids.manager]);
  await pool.execute(`INSERT INTO grants (id, resource_kind, resource_id, principal_kind, principal_id, permission, granted_by)
    VALUES (UUID(), 'conversation', ?, 'user', ?, 'member', ?), (UUID(), 'conversation', ?, 'user', ?, 'member', ?)`, [conversation, ids.manager, ids.manager, conversation, ids.member, ids.manager]);
  const devicesUrl = `/api/chat/conversations/${conversation}/devices`;
  const claimUrl = `/api/chat/conversations/${conversation}/key-packages`;
  const listed = async (client: Client) => (await call(client, 'GET', devicesUrl)).devices as FixtureValue[];
  const devices = await listed(blair);
  assert.deepEqual(devices.map(device => device.chat_device_id).sort(), [a1.chat_device_id, a2.chat_device_id, b1.chat_device_id].sort());
  assert.deepEqual(devices.find(device => device.chat_device_id === a2.chat_device_id).preview, push);
  assert.ok(devices.every(device => device.preview?.auth), 'every device has a preview key');

  // ── Nobody outside the conversation reads its devices or claims their packages, from a device in Chat ──
  const outsiders = { stranger: await signIn('stranger'), revoked: await signIn('revoked'), admin: await signIn('admin') };
  for (const [name, client] of [['Casey', outsiders.stranger], ['Drew', outsiders.revoked], ['the administrator', outsiders.admin]] as const) {
    await enrol(client, 1);
    assert.deepEqual(await refused(client, 'GET', devicesUrl), [404, 'CONVERSATION_NOT_FOUND'], name);
    assert.deepEqual(await refused(client, 'POST', claimUrl), [404, 'CONVERSATION_NOT_FOUND'], name);
  }
  assert.deepEqual(await refused(alex, 'GET', `/api/chat/conversations/${crypto.randomUUID()}/devices`), [404, 'CONVERSATION_NOT_FOUND']);

  // ── Key packages: each claimed once, the last resort reused, never the claimer's own ──
  const claim = async (client: Client) => Object.fromEntries(((await call(client, 'POST', claimUrl)).key_packages as FixtureValue[])
    .map(item => [item.chat_device_id, [item.key_package, item.last_resort]]));
  const first = await claim(alex);
  assert.deepEqual(Object.keys(first).sort(), [a2.chat_device_id, b1.chat_device_id].sort(), 'one package of every other device');
  const second = await claim(alex);
  const third = await claim(alex);
  assert.notEqual(first[a2.chat_device_id][0], second[a2.chat_device_id][0], 'a claimed package is handed out once');
  assert.deepEqual([first[b1.chat_device_id][1], second[b1.chat_device_id][1], third[b1.chat_device_id][1]], [false, true, true]);
  assert.equal(second[b1.chat_device_id][0], third[b1.chat_device_id][0], 'the last resort stays for the next claim');
  assert.equal(third[a2.chat_device_id][1], true, "the phone's two packages are gone");
  assert.equal((await call(blair, 'GET', '/api/chat/devices/current')).key_packages, 0);
  assert.ok(!Object.keys(await claim(blair)).includes(b1.chat_device_id));
  assert.deepEqual(await refused(await signIn('member'), 'POST', claimUrl), [403, 'CHAT_DEVICE_WAITING'], 'only a device in Chat makes groups');

  // ── Topping up: at most 100 unclaimed, a new last resort replaces the old ──
  assert.equal((await call(blair, 'POST', '/api/chat/devices/current/key-packages', { key_packages: packages(60) })).key_packages, 60);
  assert.deepEqual(await refused(blair, 'POST', '/api/chat/devices/current/key-packages', { key_packages: packages(41) }), [400, 'CHAT_KEY_PACKAGES_LIMIT']);
  const lastResort = random(313);
  assert.equal((await call(blair, 'POST', '/api/chat/devices/current/key-packages', { key_packages: [], last_resort: lastResort })).key_packages, 60);
  assert.deepEqual(await pool.query<RowDataPacket[]>('SELECT key_package FROM chat_key_packages WHERE chat_device_id = ? AND last_resort = TRUE', [b1.chat_device_id])
    .then(([rows]) => rows.map(row => row.key_package)), [lastResort]);
  assert.deepEqual(await refused(casey, 'POST', '/api/chat/devices/current/key-packages', { key_packages: packages(1) }), [404, 'CHAT_DEVICE_NOT_ENROLLED']);

  // ── Removed chat devices are listed nowhere: enrolled again, signed out, removed by the person, by an administrator, pruned ──
  const removed = async (chatDeviceId: string) => count('SELECT COUNT(*) AS n FROM chat_devices WHERE id = ? AND device_id IS NULL', [chatDeviceId]);
  const gone = async (chatDeviceId: string, why: string) => {
    assert.equal(await removed(chatDeviceId), 1, `${why}: marked removed`);
    assert.ok(!(await listed(alex)).some(device => device.chat_device_id === chatDeviceId), `${why}: not listed`);
    assert.ok(!Object.keys(await claim(alex)).includes(chatDeviceId), `${why}: no package handed out`);
  };
  const b2 = await enrol(blair, 1);
  await gone(b1.chat_device_id, 'enrolled again');
  assert.ok((await listed(alex)).some(device => device.chat_device_id === b2.chat_device_id));
  const blairTablet = await signIn('member');
  const b3 = await enrol(blairTablet, 1);
  await call(blairTablet, 'POST', '/api/auth/signout', {});
  await gone(b3.chat_device_id, 'signed out');
  await call(alex, 'DELETE', `/api/devices/${phone.id}`);
  await gone(a2.chat_device_id, 'removed by its person');
  const blairPhone = await signIn('member');
  const b4 = await enrol(blairPhone, 1);
  await call(admin, 'DELETE', `/api/admin/users/${ids.member}/devices/${(await deviceOf(blairPhone)).id}`, { current_password: password });
  await gone(b4.chat_device_id, 'removed by an administrator');
  const blairLaptop = await signIn('member');
  const b5 = await enrol(blairLaptop, 1);
  const laptop = (await deviceOf(blairLaptop)).id;
  await pool.execute('DELETE FROM sessions WHERE device_id = ?', [laptop]);
  await pool.execute('UPDATE devices SET last_seen_at = UTC_TIMESTAMP() - INTERVAL 31 DAY WHERE id = ?', [laptop]);
  const { pruneIdleDevices } = require('../dist/src/services/devices') as typeof import('../src/services/devices');
  assert.equal(await pruneIdleDevices(), 1);
  await gone(b5.chat_device_id, 'pruned with its idle device');

  // ── Clean-up: removed chat devices go unless the current group still names one ──
  const group = crypto.randomUUID();
  await pool.execute('INSERT INTO chat_groups (id, conversation_id, welcome) VALUES (?, ?, ?)', [group, conversation, random(900)]);
  await pool.execute('INSERT INTO chat_group_devices (group_id, chat_device_id) VALUES (?, ?), (?, ?), (?, ?)',
    [group, a1.chat_device_id, group, b2.chat_device_id, group, a2.chat_device_id]);
  await pool.execute('UPDATE chat_conversations SET current_group_id = ? WHERE id = ?', [group, conversation]);
  const { pruneRemovedChatDevices } = require('../dist/src/services/chat-devices') as typeof import('../src/services/chat-devices');
  assert.equal(await pruneRemovedChatDevices(), 4);
  assert.deepEqual((await pool.query<RowDataPacket[]>('SELECT id FROM chat_devices WHERE device_id IS NULL'))[0].map(row => row.id), [a2.chat_device_id],
    'the phone stays while the current group names it, so the group is known to be out of date');

  // ── Chat off, by the person's switch or a group's policy: every chat route refuses ──
  const routes = require('../dist/src/routes') as Record<string, { module?: string | null }>;
  const chatRoutes = Object.keys(routes).filter(key => routes[key].module === 'chat');
  assert.ok(chatRoutes.length >= 9);
  const everyRoute = async (client: Client, expected: [number, string]) => {
    for (const key of chatRoutes) {
      const [method, path] = key.split(' ');
      assert.deepEqual(await refused(client, method, path.replace(/:\w+/g, conversation), method === 'GET' ? undefined : {}), expected, key);
    }
  };
  await call(blair, 'PUT', '/api/modules', { modules: { chat: { enabled: false } } });
  await everyRoute(blair, [403, 'MODULE_DISABLED']);
  await call(blair, 'PUT', '/api/modules', { modules: { chat: { enabled: true } } });
  await call(admin, 'PUT', `/api/admin/groups/${groups.finance}/policies`, { current_password: password, values: { 'modules.chat': 'forbidden' } });
  await everyRoute(alex, [403, 'MODULE_DISABLED']);
  await call(blair, 'GET', devicesUrl);
  await call(admin, 'PUT', `/api/admin/groups/${groups.finance}/policies`, { current_password: password, clear: ['modules.chat'] });

  // ── The app lock: a device short of a lock required for Chat is refused Chat, not Mail ──
  const chatLock = (client: Client) => call(client, 'PUT', '/api/devices/current/lock', { applied: { scope: ['chat'], relock_after: '60', on_device_lock: true, method: 'pin' },
    capabilities: { lock: 'pin', secure_window: false, recents_hidden: false, device_lock_signal: false } });
  // The administrator's pages show several modules' data, so their device needs the lock too.
  await chatLock(admin);
  await call(admin, 'PUT', '/api/admin/policies', { current_password: password, values: { 'app_lock.required': ['chat'] } });
  await everyRoute(blair, [403, 'APP_LOCK_REQUIRED']);
  await call(blair, 'GET', '/api/mail/accounts');
  await chatLock(blair);
  await call(blair, 'GET', devicesUrl);
  await call(admin, 'PUT', '/api/admin/policies', { current_password: password, values: { 'app_lock.required': [] } });

  // ── The key backup: only its person reads it; a new passphrase or key needs the account password ──
  const backup = () => ({ format: 1, salt: random(16), rounds: 600000, wrapped: random(60) });
  const history = pointKey();
  assert.deepEqual(await call(blair, 'GET', '/api/chat/account'), { account: null });
  const made = (await call(blair, 'POST', '/api/chat/account', { history_public: history, key_backup: backup() })).account;
  assert.equal(made.history_public, history);
  assert.deepEqual(await refused(blair, 'POST', '/api/chat/account', { history_public: history, key_backup: backup() }), [409, 'CHAT_ACCOUNT_EXISTS']);
  assert.deepEqual(await refused(blair, 'POST', '/api/chat/account', { history_public: history, key_backup: { ...backup(), rounds: 1000 } }), [400, 'CHAT_ACCOUNT_INVALID']);
  for (const client of [alex, casey, admin]) assert.deepEqual(await call(client, 'GET', '/api/chat/account'), { account: null });
  assert.deepEqual((await call(blair, 'GET', '/api/chat/account')).account, made);
  const rewrap = { history_public: history, key_backup: backup() };
  assert.deepEqual(await refused(blair, 'PUT', '/api/chat/account/key-backup', rewrap), [400, 'PASSWORD_REQUIRED']);
  assert.deepEqual(await refused(blair, 'PUT', '/api/chat/account/key-backup', { ...rewrap, current_password: 'not the password' }), [403, 'PASSWORD_INCORRECT']);
  assert.deepEqual(await refused(blair, 'POST', '/api/chat/account/new-key', { ...rewrap, current_password: 'not the password' }), [403, 'PASSWORD_INCORRECT']);
  assert.deepEqual((await call(blair, 'GET', '/api/chat/account')).account.key_backup, made.key_backup, 'a refused change changes nothing');
  assert.deepEqual((await call(blair, 'PUT', '/api/chat/account/key-backup', { ...rewrap, current_password: password })).account.key_backup, rewrap.key_backup);
  assert.deepEqual(await refused(blair, 'PUT', '/api/chat/account/key-backup', { history_public: pointKey(), key_backup: backup(), current_password: password }), [409, 'CHAT_KEY_CHANGED']);
  assert.deepEqual(await refused(outsiders.stranger, 'PUT', '/api/chat/account/key-backup', { ...rewrap, current_password: password }), [404, 'CHAT_ACCOUNT_NOT_FOUND']);
  // A new key drops the copies only the old one opens.
  const message = crypto.randomUUID();
  await pool.execute("INSERT INTO chat_messages (id, conversation_id, seq, group_id, sender_user_id, ciphertext) VALUES (?, ?, 1, ?, ?, ?)", [message, conversation, group, ids.member, random(400)]);
  await pool.execute('INSERT INTO chat_archive (user_id, message_id, sealed) VALUES (?, ?, ?), (?, ?, ?)', [ids.member, message, random(500), ids.manager, message, random(500)]);
  const fresh = { history_public: pointKey(), key_backup: backup(), current_password: password };
  assert.equal((await call(blair, 'POST', '/api/chat/account/new-key', fresh)).account.history_public, fresh.history_public);
  assert.deepEqual([await count('SELECT COUNT(*) AS n FROM chat_archive WHERE user_id = ?', [ids.member]), await count('SELECT COUNT(*) AS n FROM chat_archive WHERE user_id = ?', [ids.manager])], [0, 1]);
});
