import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { chatPeople } = require('./helpers/chat.cts') as import('./helpers/chat.cts').ChatHelpers;

// Group chats through the real request handler with the shared people: who
// may start one and add whom (chat.reach), a chat that follows Support,
// joining and removal, the limit of 100, managers who are gone, and what a
// group message notifies. Random bytes stand in for MLS data.
test('group chats: reach, following a group, joining and removal, the limit, managers, mentions and notifications', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const webPush = require('web-push');
  const pushed: { endpoint: string; payload: FixtureValue }[] = [];
  t.mock.method(webPush, 'sendNotification', async (subscription: FixtureValue, body: string) => { pushed.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) }); return { statusCode: 201 }; });
  const { ids, groups, clients, password, call, refused, random, enrol, group, message, send, pushKeys } = await chatPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey, revoked: drew } = clients;
  const { processNotificationJobs } = require('../dist/src/services/notifications') as typeof import('../src/services/notifications');
  const rows = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0];
  const NEW = '/api/chat/conversations';
  const url = (id: string, path = '') => `${NEW}/${id}${path}`;
  const listed = async (client: typeof admin, id: string) => (await call(client, 'GET', NEW)).conversations.find((item: FixtureValue) => item.id === id);
  const people = async (client: typeof admin, id: string) => (await call(client, 'GET', url(id, '/members'))).members.map((item: FixtureValue) => item.user_id).sort();
  const policy = (values: Record<string, unknown>, group?: string) =>
    call(admin, 'PUT', group ? `/api/admin/groups/${group}/policies` : '/api/admin/policies', { current_password: password, values });
  const [a1, b1, c1, d1] = [await enrol(alex), await enrol(blair), await enrol(casey), await enrol(drew)];

  // ── Reach: Alex adds the people of his groups; anyone once chat.reach is 'organisation'; his group can set it back ──
  assert.deepEqual(await refused(alex, 'POST', NEW, { kind: 'group', name: 'Launch', user_ids: [ids.member, ids.stranger] }), [403, 'CHAT_OUT_OF_REACH']);
  assert.equal((await rows("SELECT COUNT(*) AS n FROM chat_conversations WHERE kind = 'group'"))[0].n, 0, 'nothing is made');
  assert.deepEqual(await refused(alex, 'POST', NEW, { kind: 'group', name: '', user_ids: [ids.member] }), [400, 'CHAT_NAME_INVALID']);
  await policy({ 'chat.reach': 'organisation' });
  const made = await call(alex, 'POST', NEW, { kind: 'group', name: 'Launch', user_ids: [ids.member, ids.stranger, ids.manager] });
  const launch = made.conversation.id as string;
  assert.deepEqual([made.created, made.conversation.kind, made.conversation.name, made.conversation.role, made.conversation.member_count, made.conversation.follows, made.conversation.added_by],
    [true, 'group', 'Launch', 'manager', 3, null, null]);
  assert.deepEqual([(await listed(blair, launch)).role, (await listed(blair, launch)).added_by], ['member', 'Alex Manager']);
  await policy({ 'chat.reach': 'own_groups' }, groups.finance);
  assert.deepEqual(await refused(alex, 'POST', NEW, { kind: 'group', name: 'Again', user_ids: [ids.stranger] }), [403, 'CHAT_OUT_OF_REACH'], "Finance's rule is stricter");
  const ops = (await call(admin, 'POST', NEW, { kind: 'group', name: 'Ops', user_ids: [ids.stranger] })).conversation.id;
  assert.ok(ops, 'an administrator adds anyone');
  await call(admin, 'PUT', `/api/admin/groups/${groups.finance}/policies`, { current_password: password, clear: ['chat.reach'] });

  // ── Managers rename; members may not ──
  assert.deepEqual(await refused(blair, 'PUT', url(launch), { name: 'Mine' }), [403, 'CHAT_FORBIDDEN']);
  assert.equal((await call(alex, 'PUT', url(launch), { name: 'Launch team' })).conversation.name, 'Launch team');

  // ── A chat that follows Support: made by its manager, not by a member; nobody adds or leaves by hand ──
  assert.deepEqual(await refused(blair, 'POST', NEW, { kind: 'group', name: 'Support', follow: { kind: 'group', id: groups.support } }), [403, 'CHAT_FORBIDDEN']);
  assert.deepEqual(await refused(alex, 'POST', NEW, { kind: 'group', name: 'All', follow: { kind: 'everyone' } }), [403, 'CHAT_FORBIDDEN'], 'only an administrator follows everyone');
  const followed = (await call(alex, 'POST', NEW, { kind: 'group', name: 'Support', follow: { kind: 'group', id: groups.support } })).conversation;
  const support = followed.id as string;
  assert.deepEqual([followed.follows, followed.member_count, (await listed(blair, support)).role], [{ kind: 'group', id: groups.support, name: 'Support' }, 2, 'member']);
  assert.deepEqual(await refused(alex, 'POST', url(support, '/members'), { user_ids: [ids.stranger] }), [409, 'CHAT_FOLLOWS_GROUP']);
  assert.deepEqual(await refused(blair, 'POST', url(support, '/leave')), [409, 'CHAT_FOLLOWS_GROUP']);

  // ── Casey is not in Support: every route of its chat answers 404 ──
  const s1 = await group(alex, support, null, [a1, b1]);
  for (const [method, path, body] of [['PUT', '', { name: 'x' }], ['GET', '/members', undefined], ['POST', '/members', { user_ids: [ids.stranger] }],
    ['DELETE', `/members/${ids.member}`, undefined], ['POST', '/leave', undefined], ['POST', '/unfollow', undefined], ['PUT', '/notify', { notify: 'none' }],
    ['GET', '/messages', undefined], ['POST', '/messages', message(s1)], ['PUT', '/marks', { read_seq: 1 }], ['GET', '/devices', undefined], ['POST', '/key-packages', undefined],
    ['POST', '/groups', { group_id: crypto.randomUUID(), previous_group_id: s1, welcome: random(900), chat_device_ids: [a1, b1, c1] }]] as const) {
    assert.deepEqual(await refused(casey, method, url(support, path), body), [404, 'CONVERSATION_NOT_FOUND'], `${method} ${path}`);
  }
  assert.equal(await listed(casey, support), undefined);

  // ── A person joining the followed group: the next post is refused until a group holds their devices ──
  await send(alex, support, message(s1));
  await call(alex, 'POST', `/api/groups/${groups.support}/members`, { user_ids: [ids.stranger] });
  assert.deepEqual(await refused(blair, 'POST', url(support, '/messages'), message(s1)), [409, 'CHAT_GROUP_STALE']);
  assert.equal((await call(casey, 'GET', url(support, '/messages'))).messages.length, 0, 'the newcomer reads nothing from before');
  const s2 = await group(blair, support, s1, [a1, b1, c1]);
  await send(blair, support, message(s2));
  assert.deepEqual((await call(casey, 'GET', `${url(support, '/messages')}?after=0`)).messages.map((item: FixtureValue) => item.seq), [2]);

  // ── Joining a chat of chosen people: Drew reads from the first group that holds his device ──
  const g1 = await group(alex, launch, null, [a1, b1, c1]);
  const m1 = await send(alex, launch, message(g1));
  await call(alex, 'POST', url(launch, '/members'), { user_ids: [ids.revoked] });
  assert.deepEqual(await refused(alex, 'POST', url(launch, '/messages'), message(g1)), [409, 'CHAT_GROUP_STALE'], 'added');
  assert.deepEqual([(await call(drew, 'GET', url(launch, '/messages'))).messages, (await listed(drew, launch)).unread], [[], 0]);
  assert.equal((await call(drew, 'POST', '/api/chat/archive', { copies: [{ message_id: m1.id, sealed: random(300) }] })).stored, 1, 'a copy he could store');
  assert.equal((await group(alex, launch, g1, [a1, b1, c1], 409)).code, 'CHAT_GROUP_STALE', "a group without Drew's device");
  const g2 = await group(alex, launch, g1, [a1, b1, c1, d1]);
  const m2 = await send(blair, launch, message(g2));
  const fetched = await call(drew, 'GET', `${url(launch, '/messages')}?after=0`);
  assert.deepEqual([fetched.messages.map((item: FixtureValue) => item.id), fetched.senders], [[m2.id], [{ user_id: ids.member, name: 'Blair Member', active: true }]]);
  assert.equal((await listed(drew, launch)).joined_seq, m1.seq);

  // ── Removing Drew: refused at once, his copies of the chat gone, the next post waits for a group without him ──
  assert.deepEqual(await refused(blair, 'DELETE', url(launch, `/members/${ids.revoked}`)), [403, 'CHAT_FORBIDDEN']);
  await call(alex, 'DELETE', url(launch, `/members/${ids.revoked}`));
  assert.deepEqual(await refused(drew, 'GET', url(launch, '/messages')), [404, 'CONVERSATION_NOT_FOUND']);
  assert.deepEqual(await refused(drew, 'POST', url(launch, '/messages'), message(g2)), [404, 'CONVERSATION_NOT_FOUND']);
  assert.deepEqual(await rows('SELECT user_id FROM chat_archive WHERE user_id = ?', [ids.revoked]), []);
  assert.deepEqual(await rows('SELECT user_id FROM chat_members WHERE user_id = ?', [ids.revoked]), []);
  assert.deepEqual(await refused(alex, 'POST', url(launch, '/messages'), message(g2)), [409, 'CHAT_GROUP_STALE'], 'removed');
  const g3 = await group(alex, launch, g2, [a1, b1, c1]);

  // ── Mentions name other people of a group chat only ──
  assert.deepEqual(await refused(alex, 'POST', url(launch, '/messages'), message(g3, { mentions: [ids.admin] })), [400, 'CHAT_MENTION_INVALID']);
  assert.deepEqual(await refused(alex, 'POST', url(launch, '/messages'), message(g3, { mentions: [ids.manager] })), [400, 'CHAT_MENTION_INVALID'], 'not oneself');
  const direct = (await call(alex, 'POST', NEW, { user_id: ids.member })).conversation.id;
  const dg = await group(alex, direct, null, [a1, b1]);
  assert.deepEqual(await refused(alex, 'POST', url(direct, '/messages'), message(dg, { mentions: [ids.member] })), [400, 'CHAT_MENTION_INVALID'], 'not in a direct chat');

  // ── Notifications: "<sender> in <chat>", a mention says so; the level and the person's choice for the chat apply ──
  const endpoint = 'https://fcm.googleapis.com/fcm/send/chat-groups-test-blair';
  await call(blair, 'POST', '/api/notifications/subscription', { subscription: { endpoint, keys: pushKeys().keys } });
  const lock = await pool.getConnection();
  t.after(() => lock.release());
  const NAME = "SHA2(CONCAT(DATABASE(), ':notification-jobs'), 256)";
  await lock.query(`SELECT GET_LOCK(${NAME}, 10)`);
  // A pass that meets another running is skipped; run until one really ran, then read what Blair's browser was sent.
  const shown = async (to = endpoint) => {
    await lock.query(`SELECT RELEASE_LOCK(${NAME})`);
    while ('skipped' in await processNotificationJobs()) await new Promise(resolve => setTimeout(resolve, 50));
    await lock.query(`SELECT GET_LOCK(${NAME}, 10)`);
    return pushed.splice(0).filter(push => push.endpoint === to).map(push => [push.payload.title, push.payload.body, push.payload.preview ?? null]);
  };
  const sealed = random(120);
  const post = (extra: Record<string, unknown> = {}) => send(alex, launch, message(g3, { previews: [{ chat_device_id: b1, sealed }], ...extra }));
  await post();
  assert.deepEqual(await shown(), [['Alex Manager in Launch team', 'New message', sealed]]);
  await post({ mentions: [ids.member] });
  assert.deepEqual(await shown(), [['Alex Manager mentioned you in Launch team', 'New message', sealed]]);
  for (const [level, expected] of [['sender', ['Alex Manager in Launch team', 'New message', null]], ['none', ['New message', '', null]]] as const) {
    await call(blair, 'PUT', '/api/settings/values', { values: { chat_notification_detail: level } });
    await post();
    assert.deepEqual(await shown(), [expected], level);
  }
  await call(blair, 'PUT', '/api/settings/values', { values: { chat_notification_detail: 'full' } });
  assert.deepEqual(await call(blair, 'PUT', url(launch, '/notify'), { notify: 'mentions' }), { notify: 'mentions' });
  await post();
  assert.deepEqual(await shown(), [], 'mentions only: an ordinary message is silent');
  await post({ mentions: [ids.member] });
  assert.deepEqual(await shown(), [['Alex Manager mentioned you in Launch team', 'New message', sealed]]);
  await call(blair, 'PUT', url(launch, '/notify'), { notify: 'none' });
  await post({ mentions: [ids.member] });
  assert.deepEqual([await shown(), (await listed(blair, launch)).notify, (await listed(blair, launch)).unread > 0], [[], 'none', true], 'nothing, while unread still counts');
  // Someone in the chat without a chat device is served no message, so none is announced to them.
  const waiting = 'https://fcm.googleapis.com/fcm/send/chat-groups-test-admin';
  await call(admin, 'POST', '/api/notifications/subscription', { subscription: { endpoint: waiting, keys: pushKeys().keys } });
  await call(alex, 'POST', url(launch, '/members'), { user_ids: [ids.admin] });
  await post();
  assert.deepEqual(await shown(waiting), []);
  await call(alex, 'DELETE', url(launch, `/members/${ids.admin}`));
  await lock.query(`SELECT RELEASE_LOCK(${NAME})`);

  // ── The limit: 100 people in one chat ──
  const extra = Array.from({ length: 98 }, () => crypto.randomUUID());
  await pool.query('INSERT INTO users (id, email, password_hash, full_name, role, email_verified) VALUES ?',
    [extra.map((id, index) => [id, `person${index}@example.test`, 'x', `Person ${index}`, 'user', true])]);
  const big = (await call(admin, 'POST', NEW, { kind: 'group', name: 'Everyone here', user_ids: extra })).conversation.id;
  assert.equal((await call(admin, 'POST', url(big, '/members'), { user_ids: [ids.member] })).members.length, 100);
  const full = await admin.request('POST', url(big, '/members'), { user_ids: [ids.stranger] });
  assert.deepEqual([full.status, full.body.code, (full.body.details as FixtureValue)?.limit], [400, 'CHAT_TOO_MANY_PEOPLE', 100]);

  // ── A chat whose manager was deleted is managed by its longest-standing active member ──
  const team = (await call(casey, 'POST', NEW, { kind: 'group', name: 'Casey and friends', user_ids: [ids.member] })).conversation.id;
  await call(casey, 'POST', url(team, '/members'), { user_ids: [ids.manager] });
  await pool.execute("UPDATE grants SET granted_at = granted_at - INTERVAL 1 HOUR WHERE resource_id = ? AND principal_id = ?", [team, ids.member]);
  assert.equal((await listed(blair, team)).role, 'member');
  await call(admin, 'DELETE', `/api/admin/users/${ids.stranger}`, { current_password: password });
  assert.deepEqual([(await listed(blair, team)).role, (await listed(alex, team)).role], ['manager', 'member']);
  assert.equal((await call(blair, 'PUT', url(team), { name: 'Blair and Alex' })).conversation.name, 'Blair and Alex');

  // ── Deleting Support: its chat stops following and keeps its people ──
  const before = await people(alex, support);
  await call(admin, 'DELETE', `/api/admin/groups/${groups.support}`, { current_password: password });
  assert.deepEqual([(await listed(alex, support)).follows, await people(blair, support)], [null, before]);
  await send(blair, support, message(s2));

  // ── Leaving: Blair is refused from then on ──
  const g4 = await group(alex, launch, g3, [a1, b1]);
  await send(alex, launch, message(g4));
  assert.deepEqual(await call(blair, 'POST', url(launch, '/leave')), { left: true });
  assert.deepEqual(await refused(blair, 'GET', url(launch, '/messages')), [404, 'CONVERSATION_NOT_FOUND']);
  assert.deepEqual(await people(alex, launch), [ids.manager]);

  // ── Added back before anyone wrote: the group still holds her device, yet a new one is asked for, and she reads from it ──
  await call(alex, 'POST', url(launch, '/members'), { user_ids: [ids.member] });
  assert.deepEqual(await refused(alex, 'POST', url(launch, '/messages'), message(g4)), [409, 'CHAT_GROUP_STALE']);
  const back = await send(alex, launch, message(await group(alex, launch, g4, [a1, b1])));
  assert.deepEqual((await call(blair, 'GET', `${url(launch, '/messages')}?after=0`)).messages.map((item: FixtureValue) => item.id), [back.id]);
});
