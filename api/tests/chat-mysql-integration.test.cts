import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { chatPeople } = require('./helpers/chat.cts') as import('./helpers/chat.cts').ChatHelpers;

// Chat messaging through the real request handler with the shared people:
// Alex and Blair chat; Casey, Drew and the administrator are outside their
// conversation. Random bytes stand in for MLS ciphertext, Welcomes and
// sealed archive copies: the server never reads them.
test('chat: conversations, groups, messages in order, edits and deletes, marks and receipts, presence, and peers who leave', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, groups, clients, password, call, refused, random, enrol, signIn, group, message, send, stream, until, ANDROID_AGENT, pushKeys } = await chatPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey, revoked: drew } = clients;
  type Client = typeof admin;
  const rows = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0];

  // ── Alex starts a chat with Blair, who has not opened Chat since the update ──
  const a1 = await enrol(alex);
  const started = await call(alex, 'POST', '/api/chat/conversations', { user_id: ids.member });
  const conversation = started.conversation.id as string;
  assert.deepEqual([started.created, started.conversation.peer.name, started.conversation.peer.can_write], [true, 'Blair Member', false]);
  assert.match(started.conversation.peer.reason, /has not opened UniHub/);
  assert.deepEqual(await refused(alex, 'POST', '/api/chat/conversations', { user_id: ids.manager }), [400, 'CHAT_SELF']);
  assert.deepEqual(await refused(alex, 'POST', '/api/chat/conversations', { user_id: crypto.randomUUID() }), [404, 'USER_NOT_FOUND']);
  const again = await call(blair, 'POST', '/api/chat/conversations', { user_id: ids.manager });
  assert.deepEqual([again.created, again.conversation.id], [false, conversation], 'one conversation per pair, whoever starts it');
  const url = (path: string) => `/api/chat/conversations/${conversation}/${path}`;
  const lonely = await group(alex, conversation, null, [a1]);
  assert.deepEqual(await refused(alex, 'POST', url('messages'), message(lonely)), [403, 'CHAT_UNAVAILABLE'], 'nobody could read it');

  // ── Blair and Alex's laptop enrol: the group is out of date until one of the three devices is made ──
  const b1 = await enrol(blair);
  const alexLaptop = await signIn('manager');
  const a2 = await enrol(alexLaptop);
  const outdated = await alex.request('POST', url('messages'), message(lonely));
  assert.deepEqual([outdated.status, outdated.body.code, outdated.body.details], [409, 'CHAT_GROUP_STALE', { current_group_id: lonely }]);
  const g1 = await group(alex, conversation, lonely, [a1, a2, b1]);
  // Two devices making a group at once: the second reads again.
  const lost = await group(blair, conversation, lonely, [a1, a2, b1], 409);
  assert.deepEqual([lost.code, lost.details], ['CHAT_GROUP_STALE', { current_group_id: g1 }]);
  assert.equal((await group(alex, conversation, g1, [a1, b1], 409)).code, 'CHAT_GROUP_STALE', 'a group must hold every valid device');

  // ── Alex and Blair exchange opaque blobs, in order; a retried id is stored once ──
  const m1 = message(g1);
  const first = await send(alex, conversation, m1);
  assert.deepEqual(await send(alex, conversation, m1), first, 'a retry answers the stored message');
  assert.equal((await rows('SELECT COUNT(*) AS n FROM chat_messages WHERE id = ?', [m1.id]))[0].n, 1);
  assert.equal((await rows('SELECT COUNT(*) AS n FROM chat_archive WHERE message_id = ? AND user_id = ?', [m1.id, ids.manager]))[0].n, 1, "the sender's own archive copy");
  const m2 = message(g1);
  await send(blair, conversation, m2);
  const fetched = await call(blair, 'GET', `${url('messages')}?after=0`);
  assert.deepEqual(fetched.messages.map((item: FixtureValue) => [item.seq, item.id, item.ciphertext, item.sender_user_id]),
    [[1, m1.id, m1.ciphertext, ids.manager], [2, m2.id, m2.ciphertext, ids.member]]);
  assert.deepEqual([fetched.last_seq, fetched.more, fetched.welcomes.map((item: FixtureValue) => item.group_id)], [2, false, [g1]]);
  const page = await call(blair, 'GET', `${url('messages')}?after=0&limit=1`);
  assert.deepEqual([page.messages.map((item: FixtureValue) => item.id), page.more], [[m1.id], true]);
  // A device that joined is not handed the Welcome again; once every device has, it goes.
  await call(blair, 'POST', `/api/chat/groups/${g1}/joined`);
  assert.deepEqual((await call(blair, 'GET', url('messages'))).welcomes, []);
  assert.deepEqual((await call(alexLaptop, 'GET', url('messages'))).welcomes.map((item: FixtureValue) => item.group_id), [g1]);
  await call(alexLaptop, 'POST', `/api/chat/groups/${g1}/joined`);
  assert.equal((await rows('SELECT welcome FROM chat_groups WHERE id = ?', [g1]))[0].welcome, null);

  // ── Nobody outside the conversation reaches any route of it ──
  for (const client of [casey, drew, admin]) await enrol(client);
  for (const [name, client] of [['Casey', casey], ['Drew', drew], ['the administrator', admin]] as const) {
    assert.deepEqual(await refused(client, 'GET', url('messages')), [404, 'CONVERSATION_NOT_FOUND'], name);
    assert.deepEqual(await refused(client, 'POST', url('messages'), message(g1)), [404, 'CONVERSATION_NOT_FOUND'], name);
    assert.deepEqual(await refused(client, 'POST', url('groups'), { group_id: crypto.randomUUID(), previous_group_id: g1, welcome: random(900), chat_device_ids: [a1, b1] }),
      [404, 'CONVERSATION_NOT_FOUND'], name);
    assert.deepEqual(await refused(client, 'PUT', url('marks'), { read_seq: 1 }), [404, 'CONVERSATION_NOT_FOUND'], name);
    assert.deepEqual(await refused(client, 'POST', `/api/chat/groups/${g1}/joined`), [404, 'CHAT_GROUP_NOT_FOUND'], name);
    assert.deepEqual(await refused(client, 'DELETE', `/api/chat/messages/${m1.id}`), [404, 'CHAT_MESSAGE_NOT_FOUND'], name);
    assert.deepEqual(await call(client, 'POST', '/api/chat/archive', { copies: [{ message_id: m1.id, sealed: random(300) }] }), { stored: 0 }, name);
    assert.deepEqual(await call(client, 'GET', '/api/chat/conversations'), { conversations: [] }, name);
  }
  assert.deepEqual(await refused(alex, 'GET', `/api/chat/conversations/${crypto.randomUUID()}/messages`), [404, 'CONVERSATION_NOT_FOUND']);

  // ── A removed device in the group: every post is refused until a group without it is made ──
  await call(alex, 'DELETE', `/api/devices/${(await call(alexLaptop, 'GET', '/api/devices/current')).device.id}`);
  assert.deepEqual(await refused(alex, 'POST', url('messages'), message(g1)), [409, 'CHAT_GROUP_STALE']);
  const g2 = await group(alex, conversation, g1, [a1, b1]);
  assert.deepEqual(await refused(blair, 'POST', url('messages'), message(g1)), [409, 'CHAT_GROUP_STALE'], 'an old group');
  const m3 = await send(alex, conversation, message(g2));

  // ── Edits: only of one's own message ──
  const edit = await send(alex, conversation, message(g2, { replaces: m1.id }));
  assert.equal(edit.replaces, m1.id);
  assert.deepEqual(await refused(blair, 'POST', url('messages'), message(g2, { replaces: m1.id })), [404, 'CHAT_MESSAGE_NOT_FOUND'], "someone else's message");
  assert.deepEqual(await refused(alex, 'POST', url('messages'), message(g2, { replaces: edit.id })), [404, 'CHAT_MESSAGE_NOT_FOUND'], 'an edit names the original');

  // ── Deleting: refused while deleting for good is forbidden, then final for both sides with its edit and copies ──
  assert.deepEqual(await call(blair, 'POST', '/api/chat/archive', { copies: [m1.id, edit.id].map(id => ({ message_id: id, sealed: random(300) })) }), { stored: 2 });
  await call(admin, 'PUT', '/api/admin/policies', { current_password: password, values: { 'bin.delete': 'forbidden' } });
  assert.deepEqual(await refused(alex, 'DELETE', `/api/chat/messages/${m1.id}`), [403, 'POLICY_FORBIDS']);
  await call(admin, 'PUT', '/api/admin/policies', { current_password: password, values: { 'bin.delete': 'allowed' } });
  assert.deepEqual(await refused(blair, 'DELETE', `/api/chat/messages/${m1.id}`), [404, 'CHAT_MESSAGE_NOT_FOUND'], 'only the sender deletes');
  const deleted = await call(alex, 'DELETE', `/api/chat/messages/${m1.id}`);
  assert.deepEqual(await call(alex, 'DELETE', `/api/chat/messages/${m1.id}`), deleted, 'deleting again answers the same entry');
  assert.deepEqual((await rows('SELECT ciphertext FROM chat_messages WHERE id IN (?, ?)', [m1.id, edit.id])).map(row => row.ciphertext), [null, null]);
  assert.equal((await rows('SELECT COUNT(*) AS n FROM chat_archive WHERE message_id IN (?, ?)', [m1.id, edit.id]))[0].n, 0, 'every archive copy of it and its edit');
  const entry = (await call(blair, 'GET', `${url('messages')}?after=${m3.seq}`)).messages.find((item: FixtureValue) => item.kind === 'delete');
  assert.deepEqual([entry.seq, entry.replaces, entry.ciphertext, entry.sender_user_id], [deleted.seq, m1.id, null, ids.manager]);
  assert.deepEqual(await refused(alex, 'POST', url('messages'), message(g2, { replaces: m1.id })), [404, 'CHAT_MESSAGE_NOT_FOUND']);
  assert.deepEqual(await call(blair, 'POST', '/api/chat/archive', { copies: [{ message_id: m1.id, sealed: random(300) }] }), { stored: 0 });

  // ── Read and delivery marks both ways, under the receipts rule ──
  const listed = async (client: Client, id = conversation) => (await call(client, 'GET', '/api/chat/conversations')).conversations.find((item: FixtureValue) => item.id === id);
  const last = deleted.seq as number;
  assert.deepEqual(await call(blair, 'PUT', url('marks'), { read_seq: last + 50 }), { read_seq: last, delivered_seq: last }, 'never past the last entry; reading delivers');
  assert.deepEqual(await call(blair, 'PUT', url('marks'), { read_seq: 1 }), { read_seq: last, delivered_seq: last }, 'never back');
  await call(alex, 'PUT', url('marks'), { delivered_seq: 2 });
  assert.deepEqual([(await listed(alex)).peer_read_seq, (await listed(alex)).peer_delivered_seq, (await listed(blair)).peer_delivered_seq], [last, last, 2]);
  await call(blair, 'PUT', '/api/settings/values', { values: { chat_read_receipts: false } });
  assert.deepEqual([(await listed(alex)).peer_read_seq, (await listed(blair)).peer_read_seq], [null, null], 'off for either hides "read" from both');
  await call(admin, 'PUT', `/api/admin/groups/${groups.support}/policies`, { current_password: password, values: { 'chat.read_receipts': 'on' } });
  assert.equal((await listed(alex)).peer_read_seq, last, "the group's lock wins over Blair's switch");
  await call(admin, 'PUT', `/api/admin/groups/${groups.support}/policies`, { current_password: password, clear: ['chat.read_receipts'] });

  // ── Unread counts are the person's, on every device ──
  const alexTablet = await signIn('manager');
  await send(blair, conversation, message(g2));
  assert.deepEqual([(await listed(alex)).unread, (await listed(alexTablet)).unread], [2, 2], "Blair's two messages; deleted ones and Alex's own do not count");
  await call(alex, 'PUT', url('marks'), { read_seq: (await listed(alex)).last_seq });
  assert.equal((await listed(alexTablet)).unread, 0);

  // ── Presence: a page open, seen only by people who share a conversation, both with it on ──
  const online = async () => (await listed(alex)).peer.online;
  assert.equal(await online(), false);
  const alexPage = await stream(alex, '/api/events');
  const caseyPage = await stream(casey, '/api/events');
  const blairPage = await stream(blair, '/api/events');
  assert.equal(blairPage.status, 200);
  assert.equal(await online(), true);
  assert.deepEqual(await alexPage.next('chat.presence'), { user_id: ids.member, online: true });
  assert.equal(await caseyPage.next('chat.presence', 0), null, 'Casey shares no conversation with Blair');
  // A read with receipts off for either is not announced to the other person; a delivery is.
  const quiet = async () => { while (await alexPage.next('chat.changed', 1500)); };
  const unread = await send(alex, conversation, message(g2));
  await call(blair, 'PUT', '/api/settings/values', { values: { chat_read_receipts: false } });
  await call(blair, 'PUT', url('marks'), { delivered_seq: unread.seq });
  assert.ok(await alexPage.next('chat.changed'), 'a delivery is announced');
  await quiet();
  assert.deepEqual(await call(blair, 'PUT', `/api/chat/conversations/${conversation.toUpperCase()}/marks`, { read_seq: unread.seq }), { read_seq: unread.seq, delivered_seq: unread.seq });
  assert.equal(await alexPage.next('chat.changed', 1500), null, 'the moment of reading stays with Blair');
  await call(blair, 'PUT', '/api/settings/values', { values: { chat_read_receipts: true } });
  await call(blair, 'PUT', '/api/settings/values', { values: { chat_presence: false } });
  assert.deepEqual([await online(), (await listed(blair)).peer.online], [null, null], 'off for either hides it from both');
  await call(blair, 'PUT', '/api/settings/values', { values: { chat_presence: true } });
  await call(admin, 'PUT', `/api/admin/groups/${groups.support}/policies`, { current_password: password, values: { 'chat.presence': 'off' } });
  assert.equal(await online(), null, 'the lock wins');
  await call(admin, 'PUT', `/api/admin/groups/${groups.support}/policies`, { current_password: password, clear: ['chat.presence'] });
  blairPage.close();
  await until(online, value => value === false, 'Blair closed the page');
  // A phone's notification connection alone is not "online".
  const blairPhone = await signIn('member', ANDROID_AGENT);
  const registration = await call(blairPhone, 'POST', '/api/notifications/android/devices', { keys: pushKeys().keys });
  const phoneStream = await stream(blairPhone, `/api/notifications/android/stream?device=${registration.device}`, ANDROID_AGENT);
  assert.ok(await phoneStream.next('ready'));
  assert.equal(await online(), false);
  for (const open of [alexPage, caseyPage, phoneStream]) open.close();

  // ── Peers who cannot be written to: Chat off, deactivated, deleted; their conversations stay readable ──
  await call(blair, 'PUT', '/api/modules', { modules: { chat: { enabled: false } } });
  assert.deepEqual(await refused(alex, 'POST', url('messages'), message(g2)), [403, 'CHAT_UNAVAILABLE']);
  assert.match((await listed(alex)).peer.reason, /Chat is off for Blair/);
  await call(blair, 'PUT', '/api/modules', { modules: { chat: { enabled: true } } });
  const withCasey = (await call(alex, 'POST', '/api/chat/conversations', { user_id: ids.stranger })).conversation.id;
  const caseyDevice = (await call(alex, 'GET', `/api/chat/conversations/${withCasey}/devices`)).devices.find((item: FixtureValue) => item.user_id === ids.stranger).chat_device_id;
  const g3 = await group(alex, withCasey, null, [a1, caseyDevice]);
  await send(alex, withCasey, message(g3));
  await call(admin, 'PUT', `/api/admin/users/${ids.stranger}/activate`, { is_active: false, current_password: password });
  assert.deepEqual([(await listed(alex, withCasey)).peer.can_write, await refused(alex, 'POST', `/api/chat/conversations/${withCasey}/messages`, message(g3))], [false, [403, 'CHAT_UNAVAILABLE']]);
  assert.match((await listed(alex, withCasey)).peer.reason, /deactivated/);
  assert.equal((await call(alex, 'GET', `/api/chat/conversations/${withCasey}/messages`)).messages.length, 1);
  const withDrew = (await call(alex, 'POST', '/api/chat/conversations', { user_id: ids.revoked })).conversation.id;
  const drewDevice = (await call(drew, 'GET', '/api/chat/devices/current')).chat_device_id;
  const g4 = await group(drew, withDrew, null, [a1, drewDevice]);
  const fromDrew = await send(drew, withDrew, message(g4));
  await call(admin, 'DELETE', `/api/admin/users/${ids.revoked}`, { current_password: password });
  const kept = (await call(alex, 'GET', `/api/chat/conversations/${withDrew}/messages`)).messages;
  assert.deepEqual(kept.map((item: FixtureValue) => [item.id, item.ciphertext, item.sender_user_id, item.sender_chat_device_id]), [[fromDrew.id, fromDrew.ciphertext, null, null]],
    'the conversation stays for Alex, with the sender empty');
  assert.deepEqual((await listed(alex, withDrew)).peer, { user_id: null, name: 'Deleted person', can_write: false, reason: 'This person was deleted.', online: null });
  assert.deepEqual(await refused(alex, 'POST', `/api/chat/conversations/${withDrew}/messages`, message(g4)), [403, 'CHAT_UNAVAILABLE']);
  const reopened = await call(alex, 'POST', '/api/chat/conversations', { user_id: ids.revoked });
  assert.deepEqual([reopened.created, reopened.conversation.id], [false, withDrew], 'starting it again opens the same one');
});
