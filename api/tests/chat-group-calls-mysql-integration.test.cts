import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { chatPeople } = require('./helpers/chat.cts') as import('./helpers/chat.cts').ChatHelpers;

// Group calls through the real request handler: a chat that follows Support
// (Alex, Blair and six more people), first with 8 people and later with 9.
// The ring time and the signs of life are driven by ageing the rows and
// running the sweep, never by waiting.
test('chat group calls: ringing by size, joining, the limit, signals, leaving, removal, busy, endings, entries and notices', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, clients, groups, password, api, call, refused, enrol, signIn } = await chatPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey } = clients;
  type Client = typeof alex;
  const { sweepCalls, callNotice } = require('../dist/src/services/chat-calls') as typeof import('../src/services/chat-calls');
  const { runChatRetention } = require('../dist/src/services/chat-retention') as typeof import('../src/services/chat-retention');
  const rows = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0];
  const route = (id: string, action: string) => `/api/chat/calls/${id}/${action}`;
  const inSupport = (user: string) => pool.execute("INSERT INTO org_group_members (group_id, user_id, role, added_by) VALUES (?, ?, 'member', ?)", [groups.support, user, ids.admin]);

  // Six more people in Support, each with a joined chat device.
  const hash = await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4);
  const extra: { id: string; client: Client }[] = [];
  for (let index = 1; index <= 6; index++) {
    const id = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name, role, email_verified) VALUES (?, ?, ?, ?, \'user\', TRUE)',
      [id, `person${index}@example.test`, hash, `Person ${index}`]);
    await inSupport(id);
    const client = api.client();
    assert.equal((await client.request('POST', '/api/auth/signin', { email: `person${index}@example.test`, password, device: { key: crypto.randomBytes(32).toString('base64url'), kind: 'web' } })).status, 200);
    await enrol(client);
    extra.push({ id, client });
  }
  const [p1, p2, p3, p4, p5, p6] = extra;
  const devices = { alex: await enrol(alex), blair: await enrol(blair) };
  await enrol(casey);
  const laptop = await signIn('member');
  await enrol(laptop);
  const waiting = await signIn('member');
  await enrol(waiting, undefined, { waiting: true });
  // Every joined device holds a browser's push subscription, so its notifications are recorded.
  await pool.execute(`INSERT INTO push_subscriptions (id, user_id, session_id, device_id, endpoint, endpoint_hash, p256dh, auth)
    SELECT UUID(), cd.user_id, s.id, cd.device_id, CONCAT('https://push.example.test/', cd.id), SHA2(cd.id, 256), 'synthetic', 'synthetic'
    FROM chat_devices cd JOIN sessions s ON s.device_id = cd.device_id AND s.user_id = cd.user_id WHERE cd.approved_at IS NOT NULL`);

  const team = (await call(alex, 'POST', '/api/chat/conversations', { kind: 'group', name: 'Team', follow: { kind: 'group', id: groups.support } })).conversation.id as string;
  const conversationOf = async (client: Client) => (await call(client, 'GET', '/api/chat/conversations')).conversations.find((item: FixtureValue) => item.id === team);
  // Everyone reads the chat once, so its later entries count for them.
  for (const client of [alex, blair, ...extra.map(person => person.client)]) await call(client, 'PUT', `/api/chat/conversations/${team}/marks`, { read_seq: 0 });
  const members = async (id: string) => Object.fromEntries((await rows('SELECT user_id, state FROM chat_call_members WHERE call_id = ?', [id])).map(row => [row.user_id, row.state]));
  const noticed = async (kind: string, id: string) => (await rows('SELECT user_id FROM notification_events WHERE kind = ? AND source_id = ? ORDER BY user_id', [kind, id])).map(row => row.user_id);
  const notice = (user: string, id: string, kind: 'call' | 'call_missed' | 'call_started') => callNotice(user, id, pool, { call: { event: 'ring' } }, kind);
  const lastEntry = async (client: Client) => (await call(client, 'GET', `/api/chat/conversations/${team}/messages`)).messages.at(-1);
  const sorted = (...people: string[]) => [...people].sort();

  // P4's calls are forbidden by a group of their own; P5 calls P6, so both are busy.
  const night = crypto.randomUUID();
  await pool.execute("INSERT INTO org_groups (id, name, created_by) VALUES (?, 'Night', ?)", [night, ids.admin]);
  await pool.execute("INSERT INTO org_group_members (group_id, user_id, role, added_by) VALUES (?, ?, 'member', ?)", [night, p4.id, ids.admin]);
  await call(admin, 'PUT', `/api/admin/groups/${night}/policies`, { current_password: password, values: { 'chat.calls': 'forbidden' } });
  const side = (await call(p5.client, 'POST', '/api/chat/calls', { user_id: p6.id })).call.id as string;

  // ── A chat of 8: the callable who are not busy ring, the others are told it started ──
  assert.deepEqual(await refused(waiting, 'POST', '/api/chat/calls', { conversation_id: team }), [403, 'CHAT_DEVICE_WAITING']);
  const started = await call(alex, 'POST', '/api/chat/calls', { conversation_id: team });
  const first = started.call.id as string;
  assert.deepEqual([started.started, started.call.kind, started.call.name, started.call.state, started.call.this_device, started.call.callee_user_id],
    [true, 'group', 'Team', 'ringing', true, null]);
  assert.deepEqual(started.call.members[0], { user_id: ids.manager, name: 'Alex Manager', state: 'joined', chat_device_id: devices.alex, sender: 0, joined_at: started.call.members[0].joined_at });
  assert.deepEqual(await members(first), { [ids.manager]: 'joined', [ids.member]: 'ringing', [p1.id]: 'ringing', [p2.id]: 'ringing', [p3.id]: 'ringing' });
  // The ring is current for each rung person (only Android apps that can ring are sent it).
  for (const person of [ids.member, p1.id, p2.id, p3.id, p4.id, p5.id]) assert.equal((await notice(person, first, 'call'))?.chat ?? null, [p4.id, p5.id].includes(person) ? null : 'Team', person);
  // P5 and P6 are busy; P4, whose calls are off, is told nothing.
  assert.deepEqual(await noticed('call_started', first), sorted(p5.id, p6.id));
  assert.equal(await notice(p4.id, first, 'call_started'), null);
  const told = await notice(p5.id, first, 'call_started');
  assert.deepEqual([told?.caller, told?.chat], ['Alex Manager', 'Team']);
  assert.deepEqual((await conversationOf(blair)).call, { id: first, started_at: started.call.created_at, people: 1, full: false });
  assert.deepEqual((await call(blair, 'GET', '/api/chat/calls/current')).call.this_device, false);
  // A second start in the chat answers with its call.
  assert.deepEqual([(await call(blair, 'POST', '/api/chat/calls', { conversation_id: team })).started, (await call(p1.client, 'POST', '/api/chat/calls', { conversation_id: team })).call.id], [false, first]);

  // ── Casey, whom the chat does not reach, gets 404 everywhere ──
  for (const [method, path, body] of [['POST', route(first, 'answer')], ['POST', route(first, 'end'), {}], ['POST', route(first, 'signals'), { payload: 'x' }],
    ['GET', route(first, 'signals')], ['POST', route(first, 'alive')], ['GET', route(first, 'media')]] as [string, string, unknown?][]) {
    assert.deepEqual(await refused(casey, method, path, body), [404, 'CHAT_CALL_NOT_FOUND'], `${method} ${path}`);
  }
  assert.equal((await call(casey, 'GET', '/api/chat/calls/current')).call, null);

  // ── Joining: Blair's desk takes it, the laptop is refused, P4's policy refuses, P5 is on another call ──
  const joined = await call(blair, 'POST', route(first, 'answer'));
  assert.deepEqual([joined.call.state, joined.call.this_device, joined.call.members.find((member: FixtureValue) => member.user_id === ids.member).sender], ['active', true, 1]);
  assert.deepEqual(await refused(laptop, 'POST', route(first, 'answer')), [409, 'CHAT_CALL_ANSWERED']);
  assert.equal((await call(blair, 'POST', route(first, 'answer'))).call.this_device, true, 'the same device joining again');
  assert.deepEqual(await refused(p4.client, 'POST', route(first, 'answer')), [403, 'POLICY_FORBIDS']);
  assert.deepEqual(await refused(p5.client, 'POST', route(first, 'answer')), [409, 'CHAT_CALL_IN_PROGRESS']);
  await call(p6.client, 'POST', route(side, 'end'), {});

  // ── Signals reach every device in the call, named by their device; only joined devices post or read ──
  await call(alex, 'POST', route(first, 'signals'), { payload: 'hello alex' });
  await call(blair, 'POST', route(first, 'signals'), { payload: 'hello blair' });
  assert.deepEqual(await refused(p1.client, 'POST', route(first, 'signals'), { payload: 'early' }), [403, 'CHAT_CALL_DEVICE']);
  assert.deepEqual(await refused(laptop, 'GET', route(first, 'signals')), [403, 'CHAT_CALL_DEVICE']);
  const p1Device = (await call(p1.client, 'POST', route(first, 'answer'))).call.members.find((member: FixtureValue) => member.user_id === p1.id).chat_device_id;
  const read = await call(p1.client, 'GET', `${route(first, 'signals')}?after=0`);
  assert.deepEqual(read.signals.map((item: FixtureValue) => [item.from, item.payload]), [[devices.alex, 'hello alex'], [devices.blair, 'hello blair']], 'a late joiner reads every hello');
  assert.deepEqual((await call(alex, 'GET', `${route(first, 'signals')}?after=0`)).signals.map((item: FixtureValue) => item.from), [devices.blair]);
  // 299 signals of P1's device already: one more is allowed, then none.
  await pool.query(`INSERT INTO chat_call_signals (call_id, from_chat_device_id, payload, created_at) VALUES ${Array(299).fill("(?, ?, 'x', UTC_TIMESTAMP())").join(', ')}`,
    Array(299).fill([first, p1Device]).flat());
  await call(p1.client, 'POST', route(first, 'signals'), { payload: 'keys' });
  assert.deepEqual(await refused(p1.client, 'POST', route(first, 'signals'), { payload: 'one more' }), [409, 'CHAT_CALL_SIGNALS_LIMIT']);
  await call(alex, 'POST', route(first, 'signals'), { payload: 'still fine' });

  // ── One decline ends nothing; a rung device that cannot take it changes nothing ──
  assert.equal((await call(p2.client, 'POST', route(first, 'end'), {})).call.state, 'active');
  assert.equal((await call(p3.client, 'POST', route(first, 'end'), { failed: true })).call.state, 'active');
  assert.deepEqual([(await members(first))[p2.id], (await members(first))[p3.id]], ['declined', 'ringing']);

  // ── The ring time passes while others talk: P3 missed it, the call goes on ──
  await pool.execute('UPDATE chat_calls SET created_at = UTC_TIMESTAMP() - INTERVAL 50 SECOND WHERE id = ?', [first]);
  assert.equal(await sweepCalls(), 1);
  assert.deepEqual([(await members(first))[p3.id], (await call(alex, 'GET', '/api/chat/calls/current')).call.state], ['missed', 'active']);
  assert.deepEqual([await noticed('call_missed', first), (await notice(p3.id, first, 'call_missed'))?.chat], [[p3.id], 'Team']);

  // ── Busy across both kinds: Alex cannot call anyone else, and Casey calling Alex gets busy ──
  assert.deepEqual(await refused(alex, 'POST', '/api/chat/calls', { user_id: ids.stranger }), [409, 'CHAT_CALL_IN_PROGRESS']);
  assert.deepEqual(await refused(casey, 'POST', '/api/chat/calls', { user_id: ids.manager }), [409, 'CHAT_CALL_BUSY']);

  // ── P1, removed from the chat, is taken out at their next sign of life; Blair, silent, by the sweep ──
  await pool.execute('DELETE FROM org_group_members WHERE group_id = ? AND user_id = ?', [groups.support, p1.id]);
  assert.deepEqual(await refused(p1.client, 'POST', route(first, 'alive')), [404, 'CHAT_CALL_NOT_FOUND']);
  assert.deepEqual(await refused(p1.client, 'POST', route(first, 'answer')), [404, 'CHAT_CALL_NOT_FOUND'], 'nor let in again');
  await call(alex, 'POST', route(first, 'alive'));
  await pool.execute('UPDATE chat_call_members SET alive_at = UTC_TIMESTAMP() - INTERVAL 100 SECOND WHERE call_id = ? AND user_id = ?', [first, ids.member]);
  assert.equal(await sweepCalls(), 1);
  assert.deepEqual([(await members(first))[p1.id], (await members(first))[ids.member], (await members(first))[ids.manager]], ['left', 'left', 'joined']);
  assert.equal((await conversationOf(alex)).call.people, 1);

  // ── The last leave ends it: answered, its entry with the people who were in it, unread only for whoever missed it ──
  const left = await call(alex, 'POST', route(first, 'end'), {});
  assert.deepEqual([left.call.state, left.call.outcome], ['ended', 'answered']);
  assert.deepEqual(await rows('SELECT id FROM chat_call_signals WHERE call_id = ?', [first]), []);
  const entry = await lastEntry(blair);
  assert.deepEqual([entry.kind, entry.sender_user_id, entry.call.call_id, entry.call.outcome, entry.call.callee_user_id, entry.call.people], ['call', ids.manager, first, 'answered', null, 3]);
  assert.deepEqual([(await conversationOf(p3.client)).unread, (await conversationOf(p2.client)).unread, (await conversationOf(blair)).unread, (await conversationOf(alex)).call], [1, 0, 0, null]);
  await call(p3.client, 'PUT', `/api/chat/conversations/${team}/marks`, { read_seq: entry.seq });
  assert.equal(await notice(p3.id, first, 'call_missed'), null, 'read in the chat');

  // ── Nobody answers: missed for everyone rung; a cancelled ring is missed too ──
  await inSupport(p1.id);
  const unanswered = (await call(alex, 'POST', '/api/chat/calls', { conversation_id: team })).call.id as string;
  await pool.execute('UPDATE chat_calls SET created_at = UTC_TIMESTAMP() - INTERVAL 50 SECOND WHERE id = ?', [unanswered]);
  assert.equal(await sweepCalls(), 1);
  assert.equal((await lastEntry(alex)).call.outcome, 'missed');
  assert.deepEqual(await noticed('call_missed', unanswered), sorted(ids.member, p1.id, p2.id, p3.id, p5.id, p6.id));
  assert.equal((await conversationOf(p2.client)).unread, 1);
  const cancelled = (await call(alex, 'POST', '/api/chat/calls', { conversation_id: team })).call.id as string;
  assert.equal((await call(alex, 'POST', route(cancelled, 'end'), {})).call.outcome, 'cancelled');
  assert.equal((await members(cancelled))[ids.member], 'missed');
  // Everyone rung declines: it ends as declined.
  const refusedByAll = (await call(alex, 'POST', '/api/chat/calls', { conversation_id: team })).call.id as string;
  for (const client of [blair, p1.client, p2.client, p3.client, p5.client]) assert.equal((await call(client, 'POST', route(refusedByAll, 'end'), {})).call.state, 'ringing');
  assert.equal((await call(p6.client, 'POST', route(refusedByAll, 'end'), {})).call.outcome, 'declined');

  // ── A chat of 9 rings nobody: everyone else is told, but not through a chat that notifies of nothing ──
  await inSupport(ids.stranger);
  await call(admin, 'PUT', `/api/admin/groups/${night}/policies`, { current_password: password, clear: ['chat.calls'] });
  await call(p2.client, 'PUT', `/api/chat/conversations/${team}/notify`, { notify: 'none' });
  const big = await call(alex, 'POST', '/api/chat/calls', { conversation_id: team });
  const second = big.call.id as string;
  assert.deepEqual([big.call.state, big.call.members.length], ['active', 1]);
  assert.equal(await notice(ids.member, second, 'call'), null, 'nobody rings');
  assert.deepEqual(await noticed('call_started', second), sorted(ids.member, ids.stranger, p1.id, p3.id, p4.id, p5.id, p6.id));
  assert.equal(await notice(p2.id, second, 'call_started'), null, 'a chat that notifies of nothing');
  assert.ok(await notice(p3.id, second, 'call_started'));

  // ── 8 in the call: the ninth is refused until someone leaves, and takes the freed number ──
  for (const client of [blair, casey, p1.client, p2.client, p3.client, p4.client, p5.client]) await call(client, 'POST', route(second, 'answer'));
  const full = (await call(alex, 'GET', '/api/chat/calls/current')).call;
  assert.deepEqual(full.members.filter((member: FixtureValue) => member.state === 'joined').map((member: FixtureValue) => member.sender).sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(await notice(p3.id, second, 'call_started'), null, 'not for someone in the call');
  assert.deepEqual([(await conversationOf(p6.client)).call.people, (await conversationOf(p6.client)).call.full], [8, true]);
  assert.deepEqual(await refused(p6.client, 'POST', route(second, 'answer')), [409, 'CHAT_CALL_FULL']);
  const freed = full.members.find((member: FixtureValue) => member.user_id === p5.id).sender;
  await call(p5.client, 'POST', route(second, 'end'), {});
  const sixth = await call(p6.client, 'POST', route(second, 'answer'));
  assert.equal(sixth.call.members.find((member: FixtureValue) => member.user_id === p6.id).sender, freed);

  // ── Everyone goes silent: taken out by the sweep, and the emptied call failed ──
  await pool.execute('UPDATE chat_call_members SET alive_at = UTC_TIMESTAMP() - INTERVAL 100 SECOND WHERE call_id = ?', [second]);
  assert.equal(await sweepCalls(), 1);
  assert.equal((await lastEntry(alex)).call.outcome, 'failed');
  assert.equal((await lastEntry(alex)).call.people, 9, 'everyone who was ever in it');

  // ── At start-up a group call left ringing ends as failed, with no missed call ──
  await pool.execute('DELETE FROM org_group_members WHERE group_id = ? AND user_id = ?', [groups.support, ids.stranger]);
  const stale = (await call(alex, 'POST', '/api/chat/calls', { conversation_id: team })).call.id as string;
  await pool.execute('UPDATE chat_calls SET created_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = ?', [stale]);
  assert.equal(await sweepCalls(true), 1);
  assert.deepEqual([(await lastEntry(alex)).call.outcome, await noticed('call_missed', stale)], ['failed', []]);

  // ── Retention takes the calls with their entries, and their people with them ──
  await call(admin, 'PUT', '/api/admin/policies', { current_password: password, values: { 'chat.retention_days': 30 } });
  await runChatRetention();
  await pool.execute('UPDATE chat_conversations SET retention_from = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = ?', [team]);
  await pool.execute("UPDATE chat_messages SET created_at = UTC_TIMESTAMP() - INTERVAL 40 DAY WHERE conversation_id = ? AND kind = 'call'", [team]);
  await runChatRetention();
  assert.deepEqual([await rows('SELECT id FROM chat_calls WHERE conversation_id = ?', [team]), await rows('SELECT call_id FROM chat_call_members')], [[], []]);
});
