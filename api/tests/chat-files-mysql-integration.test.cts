import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');

// Chat files are read from their roots when used: point them at a scratch tree.
const scratch = path.join(os.tmpdir(), `unihub-chat-files-${crypto.randomUUID()}`);
Object.assign(process.env, { CHAT_FILES_ROOT: path.join(scratch, 'chat'), UPLOAD_SPOOL_ROOT: path.join(scratch, 'spool') });
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { chatPeople } = require('./helpers/chat.cts') as import('./helpers/chat.cts').ChatHelpers;

// Chat files through the real request handler with the shared people: the
// uploader's limit (a group's stricter one wins), who may fetch a file, tying
// it to one message of its uploader, deletion with the message, the sweep of
// uploads never sent, and a deleted uploader whose files and messages stay.
// Random bytes stand in for the ciphertext.
test('chat files: limits, who fetches, one message each, deletion, the sweep and a deleted uploader', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  fs.mkdirSync(scratch, { recursive: true });
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const pool = await withTestDatabase(t);
  const { ids, groups, clients, password, call, refused, enrol, group, message, send } = await chatPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey } = clients;
  const { runChatRetention } = require('../dist/src/services/chat-retention') as typeof import('../src/services/chat-retention');
  const rows = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0];
  const policy = (values: Record<string, unknown>, target?: string) =>
    call(admin, 'PUT', target ? `/api/admin/groups/${target}/policies` : '/api/admin/policies', { current_password: password, values });
  const upload = (client: typeof alex, chat: string, bytes: Buffer, id: string = crypto.randomUUID()) =>
    client.request('POST', `/api/chat/conversations/${chat}/attachments?id=${id}`, bytes, { 'content-type': 'application/octet-stream' });
  const uploaded = async (client: typeof alex, chat: string, bytes: Buffer) => {
    const reply = await upload(client, chat, bytes);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return (reply.body.attachment as FixtureValue).id as string;
  };
  const fetched = (client: typeof alex, id: string) => client.request('GET', `/api/chat/attachments/${id}`);
  const onDisk = (chat: string, id: string) => fs.existsSync(path.join(scratch, 'chat', chat, id));
  const [a1, b1, c1] = [await enrol(alex), await enrol(blair), await enrol(casey)];
  const chat = (await call(alex, 'POST', '/api/chat/conversations', { kind: 'group', name: 'Files', user_ids: [ids.member] })).conversation.id as string;
  const g1 = await group(alex, chat, null, [a1, b1]);

  // ── The uploader's limit: 25 MB for everyone, Finance (Alex's group) 10 MB ──
  await policy({ 'chat.attachment_max_mb': 25 });
  await policy({ 'chat.attachment_max_mb': 10 }, groups.finance);
  const eleven = crypto.randomBytes(11 * 1024 * 1024);
  const big = await upload(alex, chat, eleven);
  assert.deepEqual([big.status, big.body.code, (big.body.details as FixtureValue).limit_mb], [413, 'CHAT_FILE_TOO_LARGE', 10]);
  assert.match(String(big.body.error), /10 MB/);
  const blairs = await uploaded(blair, chat, eleven);
  assert.equal(onDisk(chat, blairs), true, "Blair's 25 MB holds for her");

  // ── Before it is sent only its uploader fetches it; Casey never reaches the chat ──
  const bytes = crypto.randomBytes(200_000);
  const file = await uploaded(alex, chat, bytes);
  const again = await upload(alex, chat, bytes, file);
  assert.deepEqual([again.status, (again.body.attachment as FixtureValue).id], [200, file], 'a retry answers the stored one');
  assert.deepEqual([(await upload(blair, chat, bytes, file)).status], [409], 'another person cannot take its id');
  assert.deepEqual(await refused(blair, 'GET', `/api/chat/attachments/${file}`), [404, 'CHAT_ATTACHMENT_NOT_FOUND']);
  assert.deepEqual((await fetched(alex, file)).bytes, bytes);
  assert.deepEqual([(await upload(casey, chat, bytes)).status], [404]);
  assert.deepEqual([(await upload(alex, `${chat}%20`, bytes)).status], [404], 'only the stored spelling of a chat id names a folder');

  // ── Tied to one message of its uploader in this chat, at most ten, never by an edit ──
  assert.deepEqual(await refused(blair, 'POST', `/api/chat/conversations/${chat}/messages`, message(g1, { attachments: [file] })), [400, 'CHAT_ATTACHMENT_INVALID'], 'not hers');
  assert.deepEqual(await refused(alex, 'POST', `/api/chat/conversations/${chat}/messages`, message(g1, { attachments: Array.from({ length: 21 }, () => file) })),
    [400, 'CHAT_ATTACHMENT_INVALID'], 'more than twenty');
  const sent = await send(alex, chat, message(g1, { attachments: [file] }));
  const second = message(g1, { attachments: [file] });
  assert.deepEqual(await refused(alex, 'POST', `/api/chat/conversations/${chat}/messages`, second), [400, 'CHAT_ATTACHMENT_INVALID'], 'used already');
  assert.deepEqual(await rows('SELECT id FROM chat_messages WHERE id = ?', [second.id]), [], 'the refused post stored nothing');
  const other = await uploaded(alex, chat, bytes);
  assert.deepEqual(await refused(alex, 'POST', `/api/chat/conversations/${chat}/messages`, message(g1, { replaces: sent.id, attachments: [other] })), [400, 'CHAT_ATTACHMENT_INVALID'], 'an edit');
  const download = await fetched(blair, file);
  assert.deepEqual([download.status, download.headers['cache-control'], download.bytes.equals(bytes)], [200, 'no-store', true]);
  assert.deepEqual(await refused(casey, 'GET', `/api/chat/attachments/${file}`), [404, 'CHAT_ATTACHMENT_NOT_FOUND']);

  // ── Someone added later reads nothing from before: not its message, not its file ──
  await policy({ 'chat.reach': 'organisation' });
  await call(alex, 'POST', `/api/chat/conversations/${chat}/members`, { user_ids: [ids.stranger] });
  assert.deepEqual(await refused(casey, 'GET', `/api/chat/attachments/${file}`), [404, 'CHAT_ATTACHMENT_NOT_FOUND']);

  // ── Deleting the message removes its file ──
  await call(alex, 'DELETE', `/api/chat/messages/${sent.id}`);
  assert.deepEqual([onDisk(chat, file), (await rows('SELECT id FROM chat_attachments WHERE id = ?', [file])).length], [false, 0]);
  assert.deepEqual(await refused(blair, 'GET', `/api/chat/attachments/${file}`), [404, 'CHAT_ATTACHMENT_NOT_FOUND']);

  // ── An upload no message named is gone after a day, not before ──
  await runChatRetention();
  assert.equal(onDisk(chat, other), true, 'younger than a day');
  await pool.query('UPDATE chat_attachments SET created_at = created_at - INTERVAL 25 HOUR WHERE id = ?', [other]);
  await runChatRetention();
  assert.deepEqual([onDisk(chat, other), (await rows('SELECT id FROM chat_attachments WHERE id = ?', [other])).length], [false, 0]);

  // ── Blair deactivated, then deleted: her message and file stay for Alex, and the answers say she is gone ──
  const direct = (await call(alex, 'POST', '/api/chat/conversations', { user_id: ids.member })).conversation.id as string;
  const g2 = await group(alex, chat, g1, [a1, b1, c1]);
  const kept = await send(blair, chat, message(g2, { attachments: [blairs] }));
  const peer = async () => (await call(alex, 'GET', '/api/chat/conversations')).conversations.find((item: FixtureValue) => item.id === direct).peer;
  assert.equal((await peer()).active, true);
  await pool.query('UPDATE users SET is_active = FALSE WHERE id = ?', [ids.member]);
  assert.deepEqual([(await peer()).active, (await peer()).can_write], [false, false]);
  assert.equal((await call(admin, 'GET', '/api/admin/storage')).storage.users.find((item: FixtureValue) => item.user_id === ids.member).sections.chat_files.bytes, eleven.length);
  await call(admin, 'DELETE', `/api/admin/users/${ids.member}`, { current_password: password });
  assert.deepEqual([(await peer()).user_id, (await peer()).active], [null, false]);
  const left = (await call(alex, 'GET', `/api/chat/conversations/${chat}/messages?after=0`)).messages.find((item: FixtureValue) => item.id === kept.id);
  assert.deepEqual([left.sender_user_id, !!left.ciphertext], [null, true]);
  const theirs = await fetched(alex, blairs);
  assert.deepEqual([theirs.status, theirs.bytes.equals(eleven), onDisk(chat, blairs)], [200, true, true]);
  assert.deepEqual(await rows('SELECT uploader_user_id FROM chat_attachments WHERE id = ?', [blairs]), [{ uploader_user_id: null }]);
  const storage = (await call(admin, 'GET', '/api/admin/storage')).storage;
  const section = storage.sections.find((item: FixtureValue) => item.key === 'chat_files');
  assert.deepEqual([section.former_colleagues, section.tracked_items], [{ bytes: eleven.length, files: 1 }, 1]);
});
