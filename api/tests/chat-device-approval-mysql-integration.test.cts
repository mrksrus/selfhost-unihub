import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { chatPeople } = require('./helpers/chat.cts') as import('./helpers/chat.cts').ChatHelpers;
const { PEOPLE } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// Device approval through the real request handler with the shared people.
// Every device waits from its enrolment: Blair's first joins when she sets
// Chat up on it, and every later one when it proves the history key or
// another of her devices approves it. The history key is a real P-256 key
// here, so the test opens the server's challenge as a device would.
test('chat device approval: waiting devices, the proof, approvals, the new-key rule, notifications, hints and presence', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const webPush = require('web-push');
  const pushed: { endpoint: string; payload: FixtureValue }[] = [];
  t.mock.method(webPush, 'sendNotification', async (subscription: FixtureValue, body: string) => { pushed.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) }); return { statusCode: 201 }; });
  const { ids, clients, password, call, refused, random, enrol, setUpChat, challenge, historyKey, signIn, group, message, send, stream, until, pushKeys } = await chatPeople(t, pool);
  const { manager: alex, member: blair, stranger: casey } = clients;
  type Client = typeof alex;
  const { processNotificationJobs } = require('../dist/src/services/notifications') as typeof import('../src/services/notifications');
  const rows = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0];
  const state = async (client: Client) => (await call(client, 'GET', '/api/chat/devices/current')).state;

  const oneTime = () => { const key = crypto.createECDH('prime256v1'); return key.generateKeys().toString('base64url'); };

  // ── A new device waits, also before the person set Chat up: until then they cannot be written to ──
  const a1 = await enrol(alex);
  const b1 = await enrol(blair, undefined, { waiting: true });
  assert.equal(await state(blair), 'waiting', 'no chat account yet: it waits');
  const started = (await call(alex, 'POST', '/api/chat/conversations', { user_id: ids.member })).conversation;
  assert.equal(started.peer.reason, `${PEOPLE.member.name} has not set up Chat yet.`);
  // Two of her devices choose a first passphrase at once: one sets Chat up and joins; the other is refused, waits, and proves that passphrase's key.
  const rival = await signIn('member');
  await enrol(rival, undefined, { waiting: true });
  const history = historyKey();
  const chosen = await Promise.all([blair, rival].map(async client => [(await setUpChat(client, history)).status, client] as const));
  assert.deepEqual(chosen.map(([status]) => status).sort(), [200, 409]);
  const [winner, loser] = [chosen.find(([status]) => status === 200)![1], chosen.find(([status]) => status === 409)![1]];
  assert.deepEqual([await state(winner), await state(loser)], ['joined', 'waiting'], 'the one refused CHAT_ACCOUNT_EXISTS waits');
  assert.equal((await call(loser, 'POST', '/api/chat/devices/current/proof', { value: await challenge(loser) })).state, 'joined');
  await call(rival, 'POST', '/api/auth/signout', {});
  const backup = (await call(blair, 'GET', '/api/chat/account')).account.key_backup;
  const laptop = await signIn('member');
  const b2 = await enrol(laptop, undefined, { waiting: true });
  const laptopDevice = (await call(laptop, 'GET', '/api/devices/current')).device;
  assert.deepEqual([await state(laptop), laptopDevice.chat, laptopDevice.chat_waiting], ['waiting', true, true]);

  // ── A waiting device gets nothing of Chat and is in no group; the others write past it ──
  const conversation = (await call(alex, 'POST', '/api/chat/conversations', { user_id: ids.member })).conversation.id as string;
  const devices = async () => ((await call(alex, 'GET', `/api/chat/conversations/${conversation}/devices`)).devices as FixtureValue[]).map(device => device.chat_device_id).sort();
  assert.deepEqual(await devices(), [a1, b1].sort());
  const g1 = await group(alex, conversation, null, [a1, b1]);
  const file = crypto.randomUUID();
  const sent = await send(alex, conversation, message(g1));
  // The file's row only: the refusal comes before its bytes are read.
  await pool.execute("INSERT INTO chat_attachments (id, conversation_id, message_id, uploader_user_id, size_bytes, storage_path) VALUES (?, ?, ?, ?, 64, 'synthetic')",
    [file, conversation, sent.id, ids.manager]);
  for (const [method, path] of [['GET', '/api/chat/conversations'], ['GET', `/api/chat/conversations/${conversation}/messages`], ['GET', `/api/chat/attachments/${file}`],
    ['POST', '/api/chat/archive'], ['GET', '/api/chat/devices/approvals'], ['POST', `/api/chat/conversations/${conversation}/key-packages`]]) {
    assert.deepEqual(await refused(laptop, method, path, method === 'POST' ? { copies: [] } : undefined), [403, 'CHAT_DEVICE_WAITING'], `${method} ${path}`);
  }
  assert.equal((await call(laptop, 'GET', '/api/chat/account')).account.key_backup.wrapped, backup.wrapped, 'it can fetch the key backup to check a passphrase');

  // ── The proof: a wrong value, one for another device, one older than five minutes are refused ──
  const tablet = await signIn('member');
  await enrol(tablet, undefined, { waiting: true });
  const forTablet = await challenge(tablet);
  for (const [value, why] of [[random(40), 'a wrong value'], [forTablet, "another device's value"]] as const) {
    assert.deepEqual(await refused(laptop, 'POST', '/api/chat/devices/current/proof', { value }), [403, 'CHAT_PROOF_INVALID'], why);
  }
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now - 6 * 60 * 1000);
  const stale = await challenge(laptop);
  clock.mock.restore();
  assert.deepEqual(await refused(laptop, 'POST', '/api/chat/devices/current/proof', { value: stale }), [403, 'CHAT_PROOF_INVALID'], 'older than five minutes');
  assert.deepEqual(await refused(casey, 'POST', '/api/chat/devices/current/challenge'), [404, 'CHAT_DEVICE_NOT_ENROLLED']);
  assert.equal(await state(laptop), 'waiting');
  const proven = await challenge(laptop);
  assert.equal((await call(laptop, 'POST', '/api/chat/devices/current/proof', { value: proven })).state, 'joined');
  // The same value again is answered as it is and changes nothing.
  await pool.execute('UPDATE chat_devices SET approved_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = ?', [b2]);
  assert.equal((await call(laptop, 'POST', '/api/chat/devices/current/proof', { value: proven })).state, 'joined');
  assert.equal((await rows('SELECT approved_at < UTC_TIMESTAMP() - INTERVAL 30 MINUTE AS kept FROM chat_devices WHERE id = ?', [b2]))[0].kept, 1);
  assert.deepEqual(await devices(), [a1, b1, b2].sort(), 'joined: it is in the next group');
  assert.deepEqual(await refused(alex, 'POST', `/api/chat/conversations/${conversation}/messages`, message(g1)), [409, 'CHAT_GROUP_STALE']);
  const g2 = await group(alex, conversation, g1, [a1, b1, b2]);
  await send(alex, conversation, message(g2));
  assert.equal((await call(laptop, 'GET', '/api/chat/conversations')).conversations.length, 1);

  // ── Approval: the tablet asks; only Blair's joined devices list and answer it ──
  const blairPush = { desk: pushKeys().keys, tablet: pushKeys().keys };
  const endpoints = { desk: 'https://fcm.googleapis.com/fcm/send/approval-desk', tablet: 'https://fcm.googleapis.com/fcm/send/approval-tablet' };
  await call(blair, 'POST', '/api/notifications/subscription', { subscription: { endpoint: endpoints.desk, keys: blairPush.desk } });
  await call(tablet, 'POST', '/api/notifications/subscription', { subscription: { endpoint: endpoints.tablet, keys: blairPush.tablet } });
  const delivered = async () => {
    while ('skipped' in await processNotificationJobs()) await new Promise(resolve => setTimeout(resolve, 50));
    return pushed.splice(0).map(push => [push.endpoint === endpoints.desk ? 'desk' : 'tablet', push.payload.kind]);
  };
  const alexPage = await stream(alex, '/api/events');
  const deskPage = await stream(blair, '/api/events');
  const tabletPage = await stream(tablet, '/api/events');
  const tabletId = (await call(tablet, 'GET', '/api/chat/devices/current')).chat_device_id as string;
  const key = oneTime();
  const asked = await call(tablet, 'POST', '/api/chat/devices/current/approval', { public_key: key });
  assert.ok(asked.approval_requested_at && asked.state === 'waiting');
  assert.deepEqual(await deskPage.next('chat.device'), { chat_device_id: tabletId });
  assert.deepEqual(await delivered(), [['desk', 'chat_device']], 'the request is notified to joined devices only');
  const listed = (await call(blair, 'GET', '/api/chat/devices/approvals')).approvals;
  assert.deepEqual(listed.map((item: FixtureValue) => [item.chat_device_id, item.public_key, item.device.kind]), [[tabletId, key, 'web']]);
  await enrol(casey);
  assert.deepEqual((await call(casey, 'GET', '/api/chat/devices/approvals')).approvals, [], "Casey sees none of Blair's");
  const sealedKey = random(200);
  assert.deepEqual(await refused(casey, 'POST', `/api/chat/devices/${tabletId}/approve`, { public_key: key, sealed_key: sealedKey }), [404, 'CHAT_APPROVAL_NOT_FOUND'], 'another person');
  assert.deepEqual(await refused(tablet, 'POST', `/api/chat/devices/${tabletId}/approve`, { public_key: key, sealed_key: sealedKey }), [403, 'CHAT_DEVICE_WAITING'], 'a waiting device');
  const signedOut = await signIn('member');
  await enrol(signedOut);
  await call(signedOut, 'POST', '/api/auth/signout', {});
  assert.equal((await refused(signedOut, 'POST', `/api/chat/devices/${tabletId}/approve`, { public_key: key, sealed_key: sealedKey }))[0], 401, 'a signed-out device');
  assert.deepEqual(await refused(blair, 'POST', `/api/chat/devices/${tabletId}/approve`, { public_key: oneTime(), sealed_key: sealedKey }), [404, 'CHAT_APPROVAL_NOT_FOUND'], 'another key');
  const tabletSession = 'UPDATE sessions SET expires_at = expires_at + INTERVAL ? DAY WHERE device_id = (SELECT device_id FROM chat_devices WHERE id = ?)';
  await pool.execute(tabletSession, [-400, tabletId]);
  assert.deepEqual(await refused(blair, 'POST', `/api/chat/devices/${tabletId}/approve`, { public_key: key, sealed_key: sealedKey }), [404, 'CHAT_APPROVAL_NOT_FOUND'], 'an asking device whose session ended');
  await pool.execute(tabletSession, [400, tabletId]);

  // ── A message to Blair reaches only her joined devices, by notification and by hint, and the tablet does not make her online ──
  const peerOnline = async () => (await call(alex, 'GET', '/api/chat/conversations')).conversations[0].peer.online;
  const presence = async () => alexPage.next('chat.presence', 15000);
  assert.equal(await peerOnline(), true);
  assert.deepEqual(await presence(), { user_id: ids.member, online: true });
  deskPage.close();
  await until(peerOnline, online => online === false, "only the waiting tablet's page is open");
  assert.deepEqual(await presence(), { user_id: ids.member, online: false }, 'closing the page of her device in Chat, beside the waiting one');
  const deskAgain = await stream(blair, '/api/events');
  assert.deepEqual(await presence(), { user_id: ids.member, online: true }, 'opening one beside the waiting one');
  deskAgain.close();
  await send(alex, conversation, message(g2));
  assert.deepEqual(await delivered(), [['desk', 'chat']]);

  // ── Older than ten minutes, or dropped ("This was not me"): refused; asked again and approved: joined, the key read once ──
  await pool.execute('UPDATE chat_devices SET pair_requested_at = UTC_TIMESTAMP() - INTERVAL 11 MINUTE WHERE id = ?', [tabletId]);
  assert.deepEqual(await refused(blair, 'POST', `/api/chat/devices/${tabletId}/approve`, { public_key: key, sealed_key: sealedKey }), [404, 'CHAT_APPROVAL_NOT_FOUND'], 'expired');
  await call(tablet, 'POST', '/api/chat/devices/current/approval', { public_key: key });
  assert.deepEqual(await call(blair, 'DELETE', `/api/chat/devices/${tabletId}/approval`), { dropped: true });
  assert.deepEqual([(await call(blair, 'GET', '/api/chat/devices/approvals')).approvals, await state(tablet)], [[], 'waiting']);
  assert.deepEqual(await refused(blair, 'POST', `/api/chat/devices/${tabletId}/approve`, { public_key: key, sealed_key: sealedKey }), [404, 'CHAT_APPROVAL_NOT_FOUND'], 'dropped');
  await call(tablet, 'POST', '/api/chat/devices/current/approval', { public_key: key });
  assert.deepEqual(await call(blair, 'POST', `/api/chat/devices/${tabletId}/approve`, { public_key: key, sealed_key: sealedKey }), { approved: true });
  assert.deepEqual(await tabletPage.next('chat.device'), { chat_device_id: tabletId }, 'the asking device hears the answer');
  assert.equal(await tabletPage.next('chat.changed', 0), null, 'and no chat hint while it waited');
  await group(alex, conversation, g2, await devices());
  assert.ok(await tabletPage.next('chat.changed'), 'joined, its page takes chat hints at once');
  const answered = await call(tablet, 'GET', '/api/chat/devices/current');
  assert.deepEqual([answered.state, answered.sealed_key], ['joined', sealedKey]);
  assert.equal((await call(tablet, 'GET', '/api/chat/devices/current')).sealed_key, null, 'the sealed key is handed out once');

  // ── Signing out ends a request and drops a sealed key not yet read ──
  const leaver = await signIn('member');
  const leaverId = await enrol(leaver, undefined, { waiting: true });
  const leaverKey = oneTime();
  await call(leaver, 'POST', '/api/chat/devices/current/approval', { public_key: leaverKey });
  await call(blair, 'POST', `/api/chat/devices/${leaverId}/approve`, { public_key: leaverKey, sealed_key: sealedKey });
  const pairing = async () => (await rows('SELECT device_id IS NULL AS removed, pair_public, pair_sealed, pair_requested_at FROM chat_devices WHERE id = ?', [leaverId]))[0];
  assert.deepEqual(await pairing(), { removed: 0, pair_public: leaverKey, pair_sealed: sealedKey, pair_requested_at: null });
  await call(leaver, 'POST', '/api/auth/signout', {});
  assert.deepEqual(await pairing(), { removed: 1, pair_public: null, pair_sealed: null, pair_requested_at: null });

  // ── A new key is refused while another joined device is signed in, and allowed once it is gone; a value of the old key is refused after it ──
  const phone = await signIn('member');
  await enrol(phone, undefined, { waiting: true });
  const spare = await signIn('member');
  await enrol(spare, undefined, { waiting: true });
  const oldKeyValue = await challenge(spare);
  const newKey = () => ({ history_public: oneTime(), key_backup: { ...backup, salt: random(16) }, current_password: password });
  const blocked = await phone.request('POST', '/api/chat/account/new-key', newKey());
  assert.deepEqual([blocked.status, blocked.body.code, (blocked.body.details as FixtureValue).devices.length], [409, 'CHAT_DEVICE_SIGNED_IN', 3]);
  for (const client of [blair, laptop, tablet]) await call(phone, 'DELETE', `/api/devices/${(await call(client, 'GET', '/api/devices/current')).device.id}`);
  await call(phone, 'POST', '/api/chat/account/new-key', newKey());
  assert.equal(await state(phone), 'joined', 'a new key joins the device that made it');
  assert.equal((await rows("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'chat.new_key' AND actor_id = ?", [ids.member]))[0].n, 1);
  assert.deepEqual(await refused(spare, 'POST', '/api/chat/devices/current/proof', { value: oldKeyValue }), [403, 'CHAT_PROOF_INVALID'], 'made under the old key');

  // ── Set up, but no device in Chat now: the reason says so ──
  await call(phone, 'POST', '/api/auth/signout', {});
  assert.equal((await call(alex, 'GET', '/api/chat/conversations')).conversations[0].peer.reason, `${PEOPLE.member.name} is not signed in to Chat on any device.`);

  // ── A chat device from before the upgrade step is joined ──
  const { addChatDeviceApproval } = require('../dist/src/services/chat-device-approval-migration') as typeof import('../src/services/chat-device-approval-migration');
  await pool.execute('UPDATE chat_devices SET approved_at = NULL WHERE id = ?', [a1]);
  await addChatDeviceApproval(pool);
  assert.deepEqual((await rows('SELECT approved_at = created_at AS same FROM chat_devices WHERE id = ?', [a1]))[0].same, 1);
});
