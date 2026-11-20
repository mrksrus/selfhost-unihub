import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { chatPeople } = require('./helpers/chat.cts') as import('./helpers/chat.cts').ChatHelpers;

// Chat notifications through the real request handler and the delivery
// pass: Alex writes to Blair, who has two browsers subscribed to Web Push
// (captured here). The server cannot read a message; each of Blair's devices
// is sent only the preview Alex sealed to it, and only while the level is
// 'full' and the device may show content.
test('chat notifications: levels, the floor, previews per device, locked devices and the 2FA grace, cancelled when read or deleted', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const webPush = require('web-push');
  const pushed: { endpoint: string; payload: FixtureValue }[] = [];
  t.mock.method(webPush, 'sendNotification', async (subscription: FixtureValue, body: string) => { pushed.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) }); return { statusCode: 201 }; });
  const { ids, clients, password, call, enrol, signIn, group, message, send, pushKeys } = await chatPeople(t, pool);
  const { admin, manager: alex, member: blair } = clients;
  const { processNotificationJobs } = require('../dist/src/services/notifications') as typeof import('../src/services/notifications');

  const blairLaptop = await signIn('member');
  // Synthetic endpoints on a push service the server accepts; nothing is sent there (sendNotification is captured).
  const endpoints: Record<string, string> = Object.fromEntries(['alex', 'desk', 'laptop'].map(name => [name, `https://fcm.googleapis.com/fcm/send/chat-test-${name}`]));
  const chatDevices: Record<string, string> = {};
  for (const [name, client] of [['alex', alex], ['desk', blair], ['laptop', blairLaptop]] as const) {
    chatDevices[name] = await enrol(client);
    await call(client, 'POST', '/api/notifications/subscription', { subscription: { endpoint: endpoints[name], keys: pushKeys().keys } });
  }
  const conversation = (await call(alex, 'POST', '/api/chat/conversations', { user_id: ids.member })).conversation.id;
  const g1 = await group(alex, conversation, null, Object.values(chatDevices));
  const sealed = { desk: 'c2VhbGVkLWZvci10aGUtZGVzaw', laptop: 'c2VhbGVkLWZvci10aGUtbGFwdG9w' };
  const previews = [{ chat_device_id: chatDevices.desk, sealed: sealed.desk }, { chat_device_id: chatDevices.laptop, sealed: sealed.laptop }];

  // Every pass is held while the test prepares one, so a post's own pass cannot deliver early.
  const lock = await pool.getConnection();
  t.after(() => lock.release());
  const hold = () => lock.query("SELECT GET_LOCK(SHA2(CONCAT(DATABASE(), ':notification-jobs'), 256), 10)");
  const release = () => lock.query("SELECT RELEASE_LOCK(SHA2(CONCAT(DATABASE(), ':notification-jobs'), 256))");
  // A pass that meets another one running is skipped; run until one really ran, then read what each device was sent.
  const delivered = async () => {
    await release();
    for (;;) {
      if (!('skipped' in await processNotificationJobs())) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await hold();
    return Object.fromEntries(pushed.splice(0).map(push => [Object.keys(endpoints).find(name => endpoints[name] === push.endpoint), push.payload]));
  };
  const shown = (payload: FixtureValue) => payload && [payload.title, payload.body, payload.preview ?? null];
  await hold();

  // ── Full: the sender's name, and each device its own preview; never the sender, never another device's preview ──
  const first = await send(alex, conversation, message(g1, { previews }));
  let sent = await delivered();
  assert.deepEqual(Object.keys(sent).sort(), ['desk', 'laptop']);
  assert.deepEqual([shown(sent.desk), shown(sent.laptop)], [['Alex Manager', 'New message', sealed.desk], ['Alex Manager', 'New message', sealed.laptop]]);
  assert.deepEqual([sent.desk.module, sent.desk.tag, sent.desk.url, 'previews' in sent.desk], ['chat', `chat:${conversation}`, `/chat?c=${conversation}`, false]);
  assert.doesNotMatch(JSON.stringify(sent.desk), new RegExp(sealed.laptop));

  // ── An edit is not news ──
  await send(alex, conversation, message(g1, { replaces: first.id, previews }));
  assert.deepEqual(await delivered(), {});

  // ── A device whose app lock covers Chat and is not open gets "New message" without a preview ──
  await call(blairLaptop, 'PUT', '/api/devices/current/lock', { applied: { scope: ['chat'], relock_after: '60', on_device_lock: true, method: 'pin' },
    capabilities: { lock: 'pin', secure_window: false, recents_hidden: false, device_lock_signal: false } });
  await send(alex, conversation, message(g1, { previews }));
  sent = await delivered();
  assert.deepEqual([shown(sent.desk), shown(sent.laptop)], [['Alex Manager', 'New message', sealed.desk], ['New message', '', null]]);

  // ── The person's level: 'sender' shows the name without a preview, 'none' neither ──
  for (const [level, expected] of [['sender', ['Alex Manager', 'New message', null]], ['none', ['New message', '', null]]] as const) {
    await call(blair, 'PUT', '/api/settings/values', { values: { chat_notification_detail: level } });
    await send(alex, conversation, message(g1, { previews }));
    assert.deepEqual(shown((await delivered()).desk), expected, level);
  }
  await call(blair, 'PUT', '/api/settings/values', { values: { chat_notification_detail: 'full' } });

  // ── The administrator's floor ──
  await call(admin, 'PUT', '/api/admin/policies', { current_password: password, values: { 'notifications.detail': 'sender' } });
  await send(alex, conversation, message(g1, { previews }));
  assert.deepEqual(shown((await delivered()).desk), ['Alex Manager', 'New message', null]);
  await call(admin, 'PUT', '/api/admin/policies', { current_password: password, values: { 'notifications.detail': 'full' } });

  // ── Read on another device, or deleted, before delivery: nothing is sent, and a deleted message's previews go ──
  const read = await send(alex, conversation, message(g1, { previews }));
  await call(blair, 'PUT', `/api/chat/conversations/${conversation}/marks`, { read_seq: read.seq });
  const removed = await send(alex, conversation, message(g1, { previews }));
  await call(alex, 'DELETE', `/api/chat/messages/${removed.id}`);
  assert.deepEqual(await delivered(), {});
  const [[cancelled]] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
    WHERE e.source_id = ? AND d.status = 'cancelled'`, [read.id]);
  assert.equal(cancelled.n, 2, 'both devices\' deliveries of the read message are cancelled');
  const [[gone]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM notification_events WHERE source_id = ?', [removed.id]);
  assert.equal(gone.n, 0);

  // ── A person whose 2FA grace has ended is sent no content on any device ──
  await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', 'policy.auth.two_factor', 'required', FALSE)");
  await pool.execute('UPDATE users SET two_factor_required_since = UTC_TIMESTAMP() - INTERVAL 8 DAY WHERE id = ?', [ids.member]);
  await send(alex, conversation, message(g1, { previews }));
  sent = await delivered();
  assert.deepEqual([shown(sent.desk), shown(sent.laptop)], [['New message', '', null], ['New message', '', null]]);
});
