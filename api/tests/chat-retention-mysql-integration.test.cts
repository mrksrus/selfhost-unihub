import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');

const scratch = path.join(os.tmpdir(), `unihub-chat-retention-${crypto.randomUUID()}`);
Object.assign(process.env, { CHAT_FILES_ROOT: path.join(scratch, 'chat'), UPLOAD_SPOOL_ROOT: path.join(scratch, 'spool') });
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { chatPeople } = require('./helpers/chat.cts') as import('./helpers/chat.cts').ChatHelpers;

// Chat retention through the real request handler and the hourly job, with
// the shared people: a chat follows the shortest value among its active
// people; a shorter value waits 24 hours, whether a policy or a newcomer made
// it shorter; then rows, copies and files older than it go and nothing
// younger; "Undo" within the wait deletes nothing; only the owner skips the
// wait; the preview counts what the job then deletes; all of it while
// deleting for good is forbidden. The clock is moved by moving rows back.
test('chat retention: the shortest value, the 24-hour wait, undo, the owner skipping it, the preview and chats nobody is in', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  fs.mkdirSync(scratch, { recursive: true });
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const pool = await withTestDatabase(t);
  const { ids, groups, clients, password, api, call, refused, enrol, group, message, send } = await chatPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey } = clients;
  const { runChatRetention } = require('../dist/src/services/chat-retention') as typeof import('../src/services/chat-retention');
  const rows = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0];
  const policy = (values: Record<string, unknown>, target?: string, body: Record<string, unknown> = { current_password: password }) =>
    admin.request('PUT', target ? `/api/admin/groups/${target}/policies` : '/api/admin/policies', { ...body, values });
  const saved = async (values: Record<string, unknown>, target?: string) => assert.equal((await policy(values, target)).status, 200);
  const preview = async (days: number, target?: string) => {
    const { messages, files, conversations } = await call(admin, 'GET', `/api/admin/chat/retention-preview?days=${days}${target ? `&group_id=${target}` : ''}`);
    return { messages, files, conversations };
  };
  const listed = async (client: typeof alex, id: string) => (await call(client, 'GET', '/api/chat/conversations')).conversations.find((item: FixtureValue) => item.id === id);
  const present = async (...messageIds: string[]) => (await rows(`SELECT id FROM chat_messages WHERE id IN (${messageIds.map(() => '?').join(', ')})`, messageIds)).length;
  // The clock moves: a message sent `days` ago; a chat's wait `hours` further on.
  const age = (id: string, days: number) => pool.query('UPDATE chat_messages SET created_at = UTC_TIMESTAMP() - INTERVAL ? DAY WHERE id = ?', [days, id]);
  const later = (id: string, hours: number) => pool.query('UPDATE chat_conversations SET retention_from = retention_from - INTERVAL ? HOUR WHERE id = ?', [hours, id]);
  // Deleting for good is forbidden for everyone throughout: retention deletes anyway.
  await pool.query("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', 'policy.bin.delete', 'forbidden', 0)");
  const [a1, b1, c1, d1] = [await enrol(alex), await enrol(blair), await enrol(casey), await enrol(admin)];

  // Support: Alex and Blair. Ops: the administrator and Casey, in no group.
  const support = (await call(alex, 'POST', '/api/chat/conversations', { kind: 'group', name: 'Support', user_ids: [ids.member] })).conversation.id as string;
  const ops = (await call(admin, 'POST', '/api/chat/conversations', { kind: 'group', name: 'Ops', user_ids: [ids.stranger] })).conversation.id as string;
  const s1 = await group(alex, support, null, [a1, b1]);
  const o1 = await group(admin, ops, null, [c1, d1]);
  const file = crypto.randomUUID();
  assert.equal((await alex.request('POST', `/api/chat/conversations/${support}/attachments?id=${file}`, crypto.randomBytes(5000), { 'content-type': 'application/octet-stream' })).status, 200);
  const old = await send(alex, support, message(s1, { attachments: [file] }));
  const edit = await send(alex, support, message(s1, { replaces: old.id }));
  await call(blair, 'POST', '/api/chat/archive', { copies: [{ message_id: old.id, sealed: crypto.randomBytes(300).toString('base64url') }] });
  const middle = await send(blair, support, message(s1));
  const young = await send(blair, support, message(s1));
  const opsOld = await send(admin, ops, message(o1));
  await age(old.id, 100);
  await age(middle.id, 40);
  await age(opsOld.id, 100);

  // ── A shorter save needs the password and is written to the activity log ──
  assert.deepEqual([(await policy({ 'chat.retention_days': 90 }, groups.support, {})).status], [400]);
  assert.deepEqual(await preview(90, groups.support), { messages: 1, files: 1, conversations: 1 }, 'only the old message of Support, with its file');
  await saved({ 'chat.retention_days': 90 }, groups.support);
  assert.equal((await call(admin, 'GET', '/api/chat/candidates?q=')).people.find((person: FixtureValue) => person.id === ids.member).retention_days, 90, 'whoever adds Blair to a chat is told her rule');
  assert.equal((await rows("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.policy_changed' AND details LIKE '%chat.retention_days%'"))[0].n, 1);

  // ── Nothing goes in the 24 hours after it got shorter; then the old rows, copies and file go, nothing younger ──
  await runChatRetention();
  const waiting = await listed(alex, support);
  assert.equal(waiting.retention_days, 90);
  assert.ok(Date.parse(waiting.retention_from) > Date.now() + 23 * 3600 * 1000, 'deleting starts in 24 hours');
  assert.deepEqual(await call(admin, 'GET', '/api/admin/chat/retention-preview'), { messages: 0, files: 0, conversations: 0, waiting: 1, waiting_from: waiting.retention_from }, 'the Policies page sees the wait');
  assert.deepEqual([(await listed(admin, ops)).retention_days, (await listed(admin, ops)).retention_from], [null, null], 'Ops keeps its messages');
  await later(support, 23);
  await runChatRetention();
  assert.equal(await present(old.id, edit.id), 2, 'an hour before the end of the wait');
  await later(support, 1);
  const done = await runChatRetention();
  assert.deepEqual([done.messages, done.files], [1, 1], 'what the preview counted');
  assert.deepEqual([await present(old.id, edit.id), await present(middle.id, young.id)], [0, 2]);
  assert.deepEqual(await rows('SELECT user_id FROM chat_archive WHERE message_id = ?', [old.id]), []);
  assert.deepEqual([(await rows('SELECT id FROM chat_attachments WHERE id = ?', [file])).length, fs.existsSync(path.join(scratch, 'chat', support, file))], [0, false]);
  assert.equal(await present(opsOld.id), 1);

  // ── Alex's Finance sets 30: the chat follows its shortest member; "Undo" within the wait deletes nothing ──
  assert.deepEqual(await preview(30, groups.finance), { messages: 1, files: 0, conversations: 1 });
  await saved({ 'chat.retention_days': 30 }, groups.finance);
  await runChatRetention();
  assert.equal((await listed(blair, support)).retention_days, 30, "Alex's 30 days, not Blair's 90");
  await call(admin, 'PUT', `/api/admin/groups/${groups.finance}/policies`, { current_password: password, clear: ['chat.retention_days'] });
  await runChatRetention();
  assert.equal((await listed(blair, support)).retention_days, 90);
  await later(support, 25);
  await runChatRetention();
  assert.equal(await present(middle.id), 1, 'undone in time: the 40-day-old message stays');

  // ── Someone under a shorter rule joins Ops: the same wait; the owner alone skips it, with the password ──
  await call(admin, 'POST', `/api/chat/conversations/${ops}/members`, { user_ids: [ids.member] });
  await runChatRetention();
  assert.equal((await listed(admin, ops)).retention_days, 90);
  assert.equal(await present(opsOld.id), 1, 'waiting');
  const deputy = api.client();
  assert.equal((await deputy.request('POST', '/api/auth/signin', { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD })).status, 200);
  assert.deepEqual(await refused(deputy, 'POST', '/api/admin/chat/retention/apply-now', { current_password: process.env.BOOTSTRAP_ADMIN_PASSWORD }), [403, 'OWNER_REQUIRED']);
  assert.deepEqual(await refused(admin, 'POST', '/api/admin/chat/retention/apply-now', {}), [400, 'ADMIN_PASSWORD_REQUIRED']);
  assert.deepEqual(await call(admin, 'POST', '/api/admin/chat/retention/apply-now', { current_password: password }), { conversations: 1 });
  assert.equal((await rows("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.chat_retention_applied' AND actor_id = ?", [ids.admin]))[0].n, 1);
  await runChatRetention();
  assert.equal(await present(opsOld.id), 0);

  // ── Welcomes of groups replaced 30 days ago go ──
  const s2 = await group(blair, support, s1, [a1, b1]);
  await pool.query('UPDATE chat_groups SET created_at = UTC_TIMESTAMP() - INTERVAL 31 DAY WHERE id IN (?, ?)', [s1, s2]);
  await runChatRetention();
  assert.deepEqual((await rows('SELECT id FROM chat_groups WHERE id IN (?, ?) AND welcome IS NOT NULL', [s1, s2])).map(row => row.id), [s2], 'the current one keeps its Welcome');

  // ── A chat nobody is in stays while deleting for good is forbidden and it holds messages; then it goes ──
  const left = (await call(casey, 'POST', '/api/chat/conversations', { kind: 'group', name: 'Alone', user_ids: [] })).conversation.id as string;
  const l1 = await group(casey, left, null, [c1]);
  await send(casey, left, message(l1));
  await call(casey, 'POST', `/api/chat/conversations/${left}/leave`);
  await runChatRetention();
  assert.equal((await rows('SELECT id FROM chat_conversations WHERE id = ?', [left])).length, 1);
  await pool.query("DELETE FROM setting_policies WHERE setting_key = 'policy.bin.delete'");
  await runChatRetention();
  assert.deepEqual(await rows('SELECT id FROM chat_conversations WHERE id = ?', [left]), []);
  assert.deepEqual(await rows('SELECT id FROM chat_messages WHERE conversation_id = ?', [left]), []);
});
