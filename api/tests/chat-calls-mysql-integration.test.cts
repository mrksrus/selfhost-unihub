import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { chatPeople } = require('./helpers/chat.cts') as import('./helpers/chat.cts').ChatHelpers;

// Voice calls through the real request handler: Alex calls Blair, who has a
// desk and a laptop browser and a phone whose app can ring, and later a
// waiting tablet. The ring time and the sign of life are driven by ageing the
// rows and running the sweep, never by waiting.
test('chat calls: ringing, the first answer, signals, endings and entries, busy, policy, sweeps, the phone, retention and deletion', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, clients, password, call, refused, random, enrol, signIn, stream, pushKeys, ANDROID_AGENT, groups } = await chatPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey } = clients;
  type Client = typeof alex;
  const { processNotificationJobs } = require('../dist/src/services/notifications') as typeof import('../src/services/notifications');
  const { sweepCalls } = require('../dist/src/services/chat-calls') as typeof import('../src/services/chat-calls');
  const { runChatRetention } = require('../dist/src/services/chat-retention') as typeof import('../src/services/chat-retention');
  const rows = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0];
  const start = (client: Client, body: unknown) => call(client, 'POST', '/api/chat/calls', body);
  const route = (id: string, action: string) => `/api/chat/calls/${id}/${action}`;
  const age = (id: string, column: 'created_at' | 'alive_at', seconds: number) =>
    pool.execute(`UPDATE chat_calls SET ${column} = UTC_TIMESTAMP() - INTERVAL ? SECOND WHERE id = ?`, [seconds, id]);
  const conversationOf = async (client: Client, id: string) =>
    (await call(client, 'GET', '/api/chat/conversations')).conversations.find((item: FixtureValue) => item.id === id);
  const lastEntry = async (client: Client, conversation: string) => (await call(client, 'GET', `/api/chat/conversations/${conversation}/messages`)).messages.at(-1);
  const missedTitles = async (callId: string) =>
    (await rows("SELECT JSON_VALUE(payload, '$.title') AS title FROM notification_events WHERE kind = 'call_missed' AND source_id = ?", [callId])).map(row => row.title);

  // Blair's phone: its app reports that it can ring, and holds its notification stream.
  const phone = await signIn('member', ANDROID_AGENT);
  const phoneKeys = pushKeys();
  const registration = await call(phone, 'POST', '/api/notifications/android/devices', { keys: phoneKeys.keys });
  await call(phone, 'PUT', '/api/devices/current/lock', { applied: null, capabilities: { lock: 'none', secure_window: true, recents_hidden: true, device_lock_signal: true, calls: true } });
  const phoneStream = await stream(phone, `/api/notifications/android/stream?device=${registration.device}`, ANDROID_AGENT);
  assert.ok(await phoneStream.next('ready'));
  // An app that cannot ring yet: it gets no call notification.
  const oldPhone = await signIn('member', ANDROID_AGENT);
  await call(oldPhone, 'POST', '/api/notifications/android/devices', { keys: pushKeys().keys });
  const laptop = await signIn('member');
  const [a1, desk, lap, phoneChat, oldChat] = [await enrol(alex), await enrol(blair), await enrol(laptop), await enrol(phone), await enrol(oldPhone)];
  // A device that has not joined Chat yet.
  const tablet = await signIn('member');
  await enrol(tablet, undefined, { waiting: true });
  const pages = { desk: await stream(blair, '/api/events'), laptop: await stream(laptop, '/api/events'), tablet: await stream(tablet, '/api/events'), alex: await stream(alex, '/api/events') };

  // The phone's notifications as the app opens them (RFC 8291).
  const open = (body: string) => {
    const data = Buffer.from(body, 'base64url');
    const salt = data.subarray(0, 16);
    const sender = data.subarray(21, 21 + data[20]);
    const record = data.subarray(21 + data[20]);
    const hkdf = (key: Buffer, ikm: Buffer, info: Buffer, length: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, key, info, length));
    const ikm = hkdf(Buffer.from(phoneKeys.auth, 'base64url'), phoneKeys.ecdh.computeSecret(sender),
      Buffer.concat([Buffer.from('WebPush: info\0'), phoneKeys.ecdh.getPublicKey(), sender]), 32);
    const decipher = crypto.createDecipheriv('aes-128-gcm', hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12));
    decipher.setAuthTag(record.subarray(record.length - 16));
    const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
    return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString('utf8'));
  };
  const rang = async () => {
    await processNotificationJobs();
    const frame = await phoneStream.next('notification');
    return frame && open(frame.body);
  };

  // ── A callee without a joined device is refused; so is a call to oneself ──
  assert.deepEqual(await refused(alex, 'POST', '/api/chat/calls', { user_id: ids.stranger }), [403, 'CHAT_UNAVAILABLE']);
  const directChats = async (client: Client) => (await call(client, 'GET', '/api/chat/conversations')).conversations.filter((item: FixtureValue) => item.kind === 'direct').length;
  assert.equal(await directChats(alex), 0, 'a refused call leaves no empty chat behind');
  assert.deepEqual(await refused(alex, 'POST', '/api/chat/calls', { user_id: ids.manager }), [400, 'CHAT_SELF']);

  // ── Alex calls Blair: Blair's joined pages and the phone that can ring are told; the waiting tablet and the old app are not ──
  const started = await start(alex, { user_id: ids.member });
  const first = started.call.id as string;
  const chat = started.call.conversation_id as string;
  assert.deepEqual([started.call.kind, started.call.name, started.call.members], ['direct', null, []]);
  assert.deepEqual([started.started, started.call.state, started.call.this_device, started.call.callee_name, started.ice_servers], [true, 'ringing', true, 'Blair Member', []]);
  for (const page of [pages.desk, pages.laptop, pages.alex]) assert.deepEqual(await page.next('chat.call'), { call_id: first });
  assert.equal(await pages.tablet.next('chat.call', 300), null, 'a waiting device hears nothing of a call');
  assert.deepEqual(await refused(tablet, 'GET', '/api/chat/calls/current'), [403, 'CHAT_DEVICE_WAITING']);
  const ring = await rang();
  assert.deepEqual([ring.kind, ring.call, ring.title, ring.module], ['call', { id: first, event: 'ring' }, 'Alex Manager', 'chat']);
  const sentTo = await rows(`SELECT d.subscription_id FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id WHERE e.kind = 'call'`);
  assert.deepEqual(sentTo.map(row => row.subscription_id), [registration.device], 'only the app that can ring');
  assert.deepEqual((await call(laptop, 'GET', '/api/chat/calls/current')).call.this_device, false);

  // ── Casey, not in the call, gets 404 on every route of it ──
  await enrol(casey);
  for (const [method, path, body] of [['POST', route(first, 'answer')], ['POST', route(first, 'end'), {}], ['POST', route(first, 'signals'), { payload: 'x' }],
    ['GET', route(first, 'signals')], ['POST', route(first, 'alive')], ['GET', route(first, 'ice')]] as [string, string, unknown?][]) {
    assert.deepEqual(await refused(casey, method, path, body), [404, 'CHAT_CALL_NOT_FOUND'], `${method} ${path}`);
  }
  assert.equal((await call(casey, 'GET', '/api/chat/calls/current')).call, null);

  // ── The offer while it rings; a device of Blair cannot signal before it answered; the first answer wins ──
  const offer = (await call(alex, 'POST', route(first, 'signals'), { payload: 'offer' })).id;
  assert.deepEqual(await refused(laptop, 'POST', route(first, 'signals'), { payload: 'candidates' }), [403, 'CHAT_CALL_DEVICE']);
  assert.deepEqual(await refused(alex, 'POST', route(first, 'answer')), [403, 'CHAT_CALL_DEVICE'], 'the caller cannot answer');
  const answers = await Promise.all([blair, laptop].map(client => client.request('POST', route(first, 'answer'))));
  assert.deepEqual(answers.map(reply => reply.status).sort(), [200, 409]);
  const [winner, loser] = answers[0].status === 200 ? [blair, laptop] : [laptop, blair];
  assert.equal(answers.find(reply => reply.status === 409)!.body.code, 'CHAT_CALL_ANSWERED');
  assert.deepEqual([(await call(winner, 'GET', '/api/chat/calls/current')).call.this_device, (await call(loser, 'GET', '/api/chat/calls/current')).call.this_device], [true, false]);
  assert.deepEqual((await rang()).call, { id: first, event: 'end' }, 'the phone stops ringing');
  assert.deepEqual(await refused(loser, 'POST', route(first, 'signals'), { payload: 'candidates' }), [403, 'CHAT_CALL_DEVICE'], 'a device that is neither end');
  assert.deepEqual(await refused(loser, 'POST', route(first, 'end'), {}), [403, 'CHAT_CALL_DEVICE'], 'only an end hangs up an answered call');

  // ── Signals go between the two ends, each reads only the other's, after its cursor ──
  const read = await call(winner, 'GET', `${route(first, 'signals')}?after=0`);
  assert.deepEqual([read.signals.map((item: FixtureValue) => [item.payload, item.from]), read.after], [[['offer', a1]], offer]);
  await call(winner, 'POST', route(first, 'signals'), { payload: 'answer' });
  await call(winner, 'POST', route(first, 'signals'), { payload: 'x'.repeat(16384) });
  assert.deepEqual(await refused(winner, 'POST', route(first, 'signals'), { payload: 'x'.repeat(16385) }), [400, 'CHAT_CALL_SIGNAL_INVALID']);
  assert.deepEqual((await call(alex, 'GET', `${route(first, 'signals')}?after=${offer}`)).signals.map((item: FixtureValue) => item.payload.length), [6, 16384]);
  assert.equal((await call(winner, 'GET', `${route(first, 'signals')}?after=${read.after}`)).signals.length, 0);
  await call(alex, 'POST', route(first, 'alive'));

  // ── While Alex and Blair talk: Alex cannot start another, and Casey calling Blair gets busy, Blair a missed call ──
  assert.deepEqual(await refused(alex, 'POST', '/api/chat/calls', { user_id: ids.stranger }), [409, 'CHAT_CALL_IN_PROGRESS']);
  assert.deepEqual(await refused(casey, 'POST', '/api/chat/calls', { user_id: ids.member }), [409, 'CHAT_CALL_BUSY']);
  const [busy] = await rows("SELECT id, conversation_id, outcome FROM chat_calls WHERE caller_user_id = ? AND state = 'ended'", [ids.stranger]);
  assert.equal(busy.outcome, 'busy');
  assert.deepEqual([(await conversationOf(blair, busy.conversation_id)).unread, (await conversationOf(casey, busy.conversation_id)).unread], [1, 0]);
  assert.deepEqual(await missedTitles(busy.id), ['Missed call from Casey Stranger']);
  assert.deepEqual(await rows("SELECT id FROM notification_events WHERE kind = 'call' AND source_id = ?", [busy.id]), [], 'a busy call never rang, so no phone is told to stop');

  // ── Hanging up: the signals go, one entry with its length, read for both ──
  const hung = await call(alex, 'POST', route(first, 'end'), {});
  assert.deepEqual([hung.call.state, hung.call.outcome], ['ended', 'answered']);
  assert.deepEqual((await call(winner, 'POST', route(first, 'end'), {})).call.outcome, 'answered', 'an ended call is answered as it is');
  assert.deepEqual(await rows('SELECT id FROM chat_call_signals WHERE call_id = ?', [first]), []);
  assert.deepEqual(await refused(alex, 'POST', route(first, 'signals'), { payload: 'late' }), [409, 'CHAT_CALL_ENDED']);
  const entry = await lastEntry(blair, chat);
  assert.deepEqual([entry.kind, entry.group_id, entry.ciphertext, entry.sender_user_id, entry.call.call_id, entry.call.outcome], ['call', null, null, ids.manager, first, 'answered']);
  assert.ok(entry.call.answered_at && entry.call.ended_at >= entry.call.answered_at);
  assert.deepEqual([(await conversationOf(alex, chat)).unread, (await conversationOf(blair, chat)).unread], [0, 0]);
  assert.deepEqual(await refused(alex, 'DELETE', `/api/chat/messages/${entry.id}`), [404, 'CHAT_MESSAGE_NOT_FOUND'], 'nobody deletes a call entry');
  assert.equal((await call(blair, 'POST', '/api/chat/archive', { copies: [{ message_id: entry.id, sealed: random(80) }] })).stored, 1, 'a device archives the entry');

  // ── Unanswered: missed after the ring time, unread for Blair only, with the missed-call text of each detail level ──
  for (const [level, title] of [['full', 'Missed call from Alex Manager'], ['sender', 'Missed call from Alex Manager'], ['none', 'Missed call']]) {
    await call(blair, 'PUT', '/api/settings/values', { values: { chat_notification_detail: level } });
    const missed = (await start(alex, { conversation_id: chat })).call.id;
    await age(missed, 'created_at', 50);
    assert.equal(await sweepCalls(), 1);
    assert.deepEqual([(await call(alex, 'GET', '/api/chat/calls/current')).call, (await lastEntry(alex, chat)).call.outcome], [null, 'missed']);
    assert.deepEqual(await missedTitles(missed), [title], level);
  }
  await call(blair, 'PUT', '/api/settings/values', { values: { chat_notification_detail: 'full' } });
  assert.deepEqual([(await conversationOf(alex, chat)).unread, (await conversationOf(blair, chat)).unread], [0, 3]);
  // Read in the chat: its missed-call notification is no longer due.
  await call(blair, 'PUT', `/api/chat/conversations/${chat}/marks`, { read_seq: (await lastEntry(blair, chat)).seq });
  assert.equal((await conversationOf(blair, chat)).unread, 0);

  // ── Declined by Blair, cancelled by Alex: only the cancelled one is a missed call ──
  const declined = (await start(alex, { conversation_id: chat })).call.id;
  assert.equal((await call(laptop, 'POST', route(declined, 'end'), {})).call.outcome, 'declined', 'any of the callee\'s devices declines');
  const cancelled = (await start(alex, { conversation_id: chat })).call.id;
  assert.equal((await call(alex, 'POST', route(cancelled, 'end'), {})).call.outcome, 'cancelled');
  assert.deepEqual([await missedTitles(declined), await missedTitles(cancelled), (await conversationOf(blair, chat)).unread], [[], ['Missed call from Alex Manager'], 1]);

  // ── Both call each other at once: one call, the second start answers with it ──
  const both = await Promise.all([start(alex, { user_id: ids.member }), start(blair, { user_id: ids.manager })]);
  assert.equal(both[0].call.id, both[1].call.id);
  assert.deepEqual(both.map(item => item.started).sort(), [false, true]);
  const mutual = both[0].call.id;
  const callee = both[0].started ? blair : alex;
  await call(callee, 'POST', route(mutual, 'answer'));

  // ── An active call without a sign of life for 90 seconds ends as failed ──
  await age(mutual, 'alive_at', 100);
  assert.equal(await sweepCalls(), 1);
  assert.equal((await lastEntry(alex, chat)).call.outcome, 'failed');

  // ── The phone answers: it is not told to stop ringing ──
  await processNotificationJobs();
  while (await phoneStream.next('notification', 300));
  const onPhone = (await start(alex, { conversation_id: chat })).call.id;
  assert.equal((await rang()).call.event, 'ring');
  await call(phone, 'POST', route(onPhone, 'answer'));
  assert.deepEqual(await rows(`SELECT e.id FROM notification_events e WHERE e.kind = 'call' AND e.source_id = ? AND JSON_VALUE(e.payload, '$.call.event') = 'end'`, [onPhone]), [],
    'no stop for the phone that answered');
  assert.equal((await call(phone, 'POST', route(onPhone, 'end'), { failed: true })).call.outcome, 'failed');

  // ── calls forbidden for Blair's group: nobody calls Blair, Blair calls nobody, each with the reason ──
  await call(admin, 'PUT', `/api/admin/groups/${groups.support}/policies`, { current_password: password, values: { 'chat.calls': 'forbidden' } });
  const toBlair = await casey.request('POST', '/api/chat/calls', { user_id: ids.member });
  assert.deepEqual([toBlair.status, toBlair.body.code, toBlair.body.details], [403, 'POLICY_FORBIDS', { policy: 'chat.calls', reason: 'Calls are off for Blair Member.' }]);
  const fromBlair = await blair.request('POST', '/api/chat/calls', { user_id: ids.stranger });
  assert.deepEqual([fromBlair.status, (fromBlair.body.details as FixtureValue).reason], [403, 'Your administrator turned calls off.']);
  await call(admin, 'PUT', `/api/admin/groups/${groups.support}/policies`, { current_password: password, clear: ['chat.calls'] });

  // ── At start-up a call left ringing ends as failed, with no missed call ──
  const stale = (await start(alex, { conversation_id: chat })).call.id;
  await age(stale, 'created_at', 3600);
  assert.equal(await sweepCalls(true), 1);
  assert.deepEqual([(await lastEntry(blair, chat)).call.outcome, await missedTitles(stale)], ['failed', []]);

  // ── Deleting Casey empties the caller of the busy call; its entry stays ──
  await call(admin, 'DELETE', `/api/admin/users/${ids.stranger}`, { current_password: password });
  const kept = await lastEntry(blair, busy.conversation_id);
  assert.deepEqual([kept.kind, kept.sender_user_id, kept.call.caller_user_id, kept.call.outcome], ['call', null, null, 'busy']);

  // ── Retention removes call entries with their calls ──
  await call(admin, 'PUT', '/api/admin/policies', { current_password: password, values: { 'chat.retention_days': 30 } });
  await runChatRetention();
  await pool.execute('UPDATE chat_conversations SET retention_from = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = ?', [chat]);
  await pool.execute("UPDATE chat_messages SET created_at = UTC_TIMESTAMP() - INTERVAL 40 DAY WHERE conversation_id = ? AND kind = 'call'", [chat]);
  await runChatRetention();
  assert.deepEqual(await rows('SELECT id FROM chat_calls WHERE conversation_id = ?', [chat]), []);
  assert.deepEqual((await call(alex, 'GET', `/api/chat/conversations/${chat}/messages`)).messages.filter((item: FixtureValue) => item.kind === 'call'), []);
  void [a1, desk, lap, phoneChat, oldChat];
});

test('relay credentials: the standard answer for a fixed secret and time, none without the configuration', () => {
  const { iceServers, relayConfigured } = require('../dist/src/services/turn') as typeof import('../src/services/turn');
  const saved = { urls: process.env.TURN_URLS, secret: process.env.TURN_SECRET };
  try {
    delete process.env.TURN_URLS;
    process.env.TURN_SECRET = 'relay-secret';
    assert.deepEqual([iceServers('call-1'), relayConfigured()], [[], false]);
    process.env.TURN_URLS = 'turn:calls.example.test:3478, turn:calls.example.test:3478?transport=tcp';
    const now = Date.UTC(2026, 0, 1);
    const username = `${now / 1000 + 12 * 3600}:call-1`;
    assert.deepEqual(iceServers('call-1', now), [{ urls: ['turn:calls.example.test:3478?transport=udp', 'turn:calls.example.test:3478?transport=tcp'], username,
      credential: crypto.createHmac('sha1', 'relay-secret').update(username).digest('base64') }]);
    // The known answer of this secret and user name.
    assert.equal(iceServers('call-1', now)[0].credential, 'RaNcGrGnMXbOr+b/58j3PVQdcRI=');
    assert.equal(relayConfigured(), true);
    delete process.env.TURN_SECRET;
    assert.deepEqual(iceServers('call-1', now), []);
  } finally {
    for (const [name, value] of [['TURN_URLS', saved.urls], ['TURN_SECRET', saved.secret]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
