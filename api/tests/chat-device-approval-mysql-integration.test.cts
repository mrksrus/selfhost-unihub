import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { chatPeople } = require('./helpers/chat.cts') as import('./helpers/chat.cts').ChatHelpers;

// Device approval through the real request handler with the shared people.
// Alex and Blair enrol before Blair chooses a passphrase, so both join at
// once; every device Blair signs in afterwards waits until it proves the
// history key or another of her devices approves it. The history key is a
// real P-256 key here, so the test opens the server's challenge as a device would.
test('chat device approval: waiting devices, the proof, approvals, the new-key rule, notifications, hints and presence', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const webPush = require('web-push');
  const pushed: { endpoint: string; payload: FixtureValue }[] = [];
  t.mock.method(webPush, 'sendNotification', async (subscription: FixtureValue, body: string) => { pushed.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) }); return { statusCode: 201 }; });
  const { ids, clients, password, call, refused, random, enrol, signIn, group, message, send, stream, until, pushKeys } = await chatPeople(t, pool);
  const { manager: alex, member: blair, stranger: casey } = clients;
  type Client = typeof alex;
  const { processNotificationJobs } = require('../dist/src/services/notifications') as typeof import('../src/services/notifications');
  const rows = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0];
  const state = async (client: Client) => (await call(client, 'GET', '/api/chat/devices/current')).state;

  // RFC 8291 opening, as the page's seal.ts does it, with the history key's fixed auth secret.
  const history = crypto.createECDH('prime256v1');
  history.generateKeys();
  const open = (sealed: string) => {
    const data = Buffer.from(sealed, 'base64url');
    const salt = data.subarray(0, 16);
    const sender = data.subarray(21, 21 + data[20]);
    const record = data.subarray(21 + data[20]);
    const hkdf = (key: Buffer, ikm: Buffer, info: Buffer, length: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, key, info, length));
    const ikm = hkdf(Buffer.alloc(16), history.computeSecret(sender), Buffer.concat([Buffer.from('WebPush: info\0'), history.getPublicKey(), sender]), 32);
    const decipher = crypto.createDecipheriv('aes-128-gcm', hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12));
    decipher.setAuthTag(record.subarray(record.length - 16));
    const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
    return padded.subarray(0, padded.lastIndexOf(2)).toString('base64url');
  };
  const challenge = async (client: Client) => open((await call(client, 'POST', '/api/chat/devices/current/challenge')).sealed);
  const oneTime = () => { const key = crypto.createECDH('prime256v1'); return key.generateKeys().toString('base64url'); };

  // ── Before the passphrase a device joins at enrolment; after it, a new device waits ──
  const a1 = await enrol(alex);
  const b1 = await enrol(blair);
  assert.equal(await state(blair), 'joined', 'no chat account yet: joined at once');
  const backup = { format: 1, salt: random(16), rounds: 600000, wrapped: random(60) };
  await call(blair, 'POST', '/api/chat/account', { history_public: history.getPublicKey().toString('base64url'), key_backup: backup });
  const laptop = await signIn('member');
  const b2 = await enrol(laptop);
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
  await enrol(tablet);
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
  assert.equal((await call(laptop, 'POST', '/api/chat/devices/current/proof', { value: await challenge(laptop) })).state, 'joined');
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
  await call(signedOut, 'POST', '/api/chat/devices/current/proof', { value: await challenge(signedOut) });
  await call(signedOut, 'POST', '/api/auth/signout', {});
  assert.equal((await refused(signedOut, 'POST', `/api/chat/devices/${tabletId}/approve`, { public_key: key, sealed_key: sealedKey }))[0], 401, 'a signed-out device');
  assert.deepEqual(await refused(blair, 'POST', `/api/chat/devices/${tabletId}/approve`, { public_key: oneTime(), sealed_key: sealedKey }), [404, 'CHAT_APPROVAL_NOT_FOUND'], 'another key');

  // ── A message to Blair reaches only her joined devices, by notification and by hint, and the tablet does not make her online ──
  const peerOnline = async () => (await call(alex, 'GET', '/api/chat/conversations')).conversations[0].peer.online;
  assert.equal(await peerOnline(), true);
  deskPage.close();
  await until(peerOnline, online => online === false, "only the waiting tablet's page is open");
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
  const answered = await call(tablet, 'GET', '/api/chat/devices/current');
  assert.deepEqual([answered.state, answered.sealed_key], ['joined', sealedKey]);
  assert.equal((await call(tablet, 'GET', '/api/chat/devices/current')).sealed_key, null, 'the sealed key is handed out once');

  // ── A new key is refused while another joined device is signed in, and allowed once it is gone ──
  const phone = await signIn('member');
  await enrol(phone);
  const newKey = () => ({ history_public: oneTime(), key_backup: { ...backup, salt: random(16) }, current_password: password });
  const blocked = await phone.request('POST', '/api/chat/account/new-key', newKey());
  assert.deepEqual([blocked.status, blocked.body.code, (blocked.body.details as FixtureValue).devices.length], [409, 'CHAT_DEVICE_SIGNED_IN', 3]);
  for (const client of [blair, laptop, tablet]) await call(phone, 'DELETE', `/api/devices/${(await call(client, 'GET', '/api/devices/current')).device.id}`);
  await call(phone, 'POST', '/api/chat/account/new-key', newKey());
  assert.equal(await state(phone), 'joined', 'a new key joins the device that made it');
  assert.equal((await rows("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'chat.new_key' AND actor_id = ?", [ids.member]))[0].n, 1);

  // ── A chat device from before the upgrade step is joined ──
  const { addChatDeviceApproval } = require('../dist/src/services/chat-device-approval-migration') as typeof import('../src/services/chat-device-approval-migration');
  await pool.execute('UPDATE chat_devices SET approved_at = NULL WHERE id = ?', [a1]);
  await addChatDeviceApproval(pool);
  assert.deepEqual((await rows('SELECT approved_at = created_at AS same FROM chat_devices WHERE id = ?', [a1]))[0].same, 1);
});
