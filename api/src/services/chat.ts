import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type {
  ChatArchiveEntry, ChatConversation, ChatGroupStaleDetails, ChatMarksResponse, ChatMessage, ChatMessagesResponse, ChatPeer, ChatWelcome,
} from '../contracts/chat';

import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { log } from '../log';
import { withTransaction } from './transactions';
import { assertCan, can, conversationPeople, setGrant, visible } from './access';
import { bytes, notEnrolled, object, ownChatDevice, utcIso, validDevices } from './chat-devices';
import { isModuleEnabled } from './module-settings';
import { settingValues } from './settings';
import { publishChatChanged, publishChatPresence, realtime } from './realtime';
import { enqueueFromSource, processNotificationJobs } from './notifications';

// Conversations, groups, messages, marks, the personal archive and presence.
// The server stores and hands out opaque bytes; what it decides is
// who may read a conversation (access.ts, kind `conversation`), the order of
// its entries (seq) and whether a message goes to a group with exactly the
// valid devices of the people the conversation reaches. A group never
// changes: when the devices change, the next sender makes a new one.
// Hints on the live stream tell the pages to fetch; nothing travels in them.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CIPHERTEXT = 64 * 1024;
const MAX_ARCHIVE = 48 * 1024;
const MAX_WELCOME = 384 * 1024;
const MAX_PREVIEW = 2048;
const MAX_DEVICES = 1000;
const MAX_ARCHIVE_COPIES = 200;
const PRESENCE_MS = 10 * 1000;

const uuid = (value: unknown, code: string) => {
  if (typeof value !== 'string' || !UUID.test(value)) throw badRequest(code, 'Invalid chat data');
  return value.toLowerCase();
};
const count = (value: string | null, fallback: number, max: number) => {
  const number = value === null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw badRequest('CHAT_QUERY_INVALID', 'Invalid chat query');
  return Math.min(number, max);
};
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length;
const placeholders = (items: readonly unknown[]) => items.map(() => '?').join(', ');
const stale = (current: unknown) => conflict('CHAT_GROUP_STALE', 'The chat\'s devices changed. Read it again.',
  { current_group_id: current ? String(current) : null } satisfies ChatGroupStaleDetails);
const messageNotFound = () => notFound('CHAT_MESSAGE_NOT_FOUND', 'Message not found');
const conversationOf = (id: string) => ({ kind: 'conversation' as const, id });
const directKey = (a: string, b: string) => [a, b].sort().join(':');
const otherOf = (key: unknown, userId: string) => String(key ?? '').split(':').find(id => id && id !== userId) ?? null;
const chatSettings = (userId: string, executor: SqlExecutor) => settingValues('user', userId, userId, executor);

// --- The other person -------------------------------------------------------------------

interface PeerState { user_id: string | null; name: string; reason: string | null; ready: boolean }

/** Whether a person can be written to: active, Chat on, and (for a message) a chat device. ready leaves out the device. */
async function peerState(peerId: string | null, executor: SqlExecutor = db): Promise<PeerState> {
  const [[user]] = await executor.execute<RowDataPacket[]>("SELECT COALESCE(NULLIF(full_name, ''), email) AS name, is_active FROM users WHERE id = ?", [peerId]);
  if (!peerId || !user) return { user_id: null, name: 'Deleted person', reason: 'This person was deleted.', ready: false };
  const name = String(user.name);
  const off = !user.is_active ? `${name} is deactivated.` : !await isModuleEnabled(peerId!, 'chat', executor) ? `Chat is off for ${name}.` : null;
  const reason = off ?? ((await validDevices([peerId!], executor)).length ? null : `${name} has not opened UniHub since the update.`);
  return { user_id: peerId, name, reason, ready: !off };
}

// --- Conversations ----------------------------------------------------------------------

async function describeConversations(userId: string, ids: readonly string[], executor: SqlExecutor = db): Promise<ChatConversation[]> {
  if (!ids.length) return [];
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT c.id, c.direct_key, c.current_group_id, c.last_seq, c.created_at,
      (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.conversation_id = c.id) AS last_activity_at,
      COALESCE(me.read_seq, 0) AS read_seq, COALESCE(me.delivered_seq, 0) AS delivered_seq, COALESCE(me.joined_seq, 0) AS joined_seq,
      COALESCE(peer.read_seq, 0) AS peer_read_seq, COALESCE(peer.delivered_seq, 0) AS peer_delivered_seq,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.kind = 'message' AND m.replaces IS NULL AND m.ciphertext IS NOT NULL
        AND m.seq > GREATEST(COALESCE(me.read_seq, 0), COALESCE(me.joined_seq, 0)) AND NOT (m.sender_user_id <=> ?)) AS unread
    FROM chat_conversations c
    LEFT JOIN chat_members me ON me.conversation_id = c.id AND me.user_id = ?
    LEFT JOIN chat_members peer ON peer.conversation_id = c.id AND peer.user_id <> ?
    WHERE c.id IN (${placeholders(ids)})
    ORDER BY COALESCE(last_activity_at, c.created_at) DESC, c.id`, [userId, userId, userId, ...ids]);
  const mine = await chatSettings(userId, executor);
  const conversations: ChatConversation[] = [];
  for (const row of rows) {
    const peer = await peerState(otherOf(row.direct_key, userId), executor);
    const theirs = peer.user_id ? await chatSettings(peer.user_id, executor) : null;
    conversations.push({
      id: String(row.id), kind: 'direct',
      peer: { user_id: peer.user_id, name: peer.name, can_write: !peer.reason, reason: peer.reason,
        online: mine.chat_presence && theirs?.chat_presence ? realtime.isPresent(peer.user_id) : null } satisfies ChatPeer,
      current_group_id: row.current_group_id ? String(row.current_group_id) : null,
      last_seq: Number(row.last_seq),
      last_activity_at: row.last_activity_at ? utcIso(row.last_activity_at) : null,
      unread: Number(row.unread),
      read_seq: Number(row.read_seq), delivered_seq: Number(row.delivered_seq), joined_seq: Number(row.joined_seq),
      peer_read_seq: mine.chat_read_receipts && theirs?.chat_read_receipts ? Number(row.peer_read_seq) : null,
      peer_delivered_seq: Number(row.peer_delivered_seq),
    });
  }
  return conversations;
}

async function listConversations(userId: string): Promise<ChatConversation[]> {
  return describeConversations(userId, await visible(userId, 'conversation'));
}

/**
 * Finds or makes the one direct conversation of the caller and another
 * person. Starting it again opens the same one, whoever the other person is
 * now; a new one needs them active with Chat on.
 */
async function startConversation(userId: string, input: unknown): Promise<{ conversation: ChatConversation; created: boolean }> {
  const peerId = uuid(object(input).user_id, 'CHAT_INVALID');
  if (peerId === userId) throw badRequest('CHAT_SELF', 'You cannot start a chat with yourself');
  const key = directKey(userId, peerId);
  const [[existing]] = await db.execute<RowDataPacket[]>('SELECT id FROM chat_conversations WHERE direct_key = ?', [key]);
  let created = false;
  let id = existing ? String(existing.id) : null;
  if (!id || !await can(userId, conversationOf(id), 'member')) {
    const peer = await peerState(peerId);
    if (!peer.user_id) throw notFound('USER_NOT_FOUND', 'User not found');
    if (!peer.ready) throw forbidden('CHAT_UNAVAILABLE', peer.reason!);
    id = await withTransaction(async cx => {
      const [insert] = await cx.execute<ResultSetHeader>("INSERT IGNORE INTO chat_conversations (id, kind, direct_key, created_by) VALUES (?, 'direct', ?, ?)",
        [crypto.randomUUID(), key, userId]);
      created = insert.affectedRows > 0;
      const [[row]] = await cx.execute<RowDataPacket[]>('SELECT id FROM chat_conversations WHERE direct_key = ? FOR UPDATE', [key]);
      for (const person of [userId, peerId]) await setGrant(cx, conversationOf(String(row.id)), { kind: 'user', id: person }, 'member', userId);
      return String(row.id);
    });
    publishChatChanged([userId, peerId], id);
  }
  return { conversation: (await describeConversations(userId, [id]))[0], created };
}

// --- Groups -----------------------------------------------------------------------------

async function lockConversation(cx: SqlExecutor, conversationId: string) {
  const [[row]] = await cx.execute<RowDataPacket[]>('SELECT current_group_id, last_seq, direct_key FROM chat_conversations WHERE id = ? FOR UPDATE', [conversationId]);
  if (!row) throw notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
  return row;
}
const validDeviceIds = async (conversationId: string, cx: SqlExecutor) =>
  (await validDevices(await conversationPeople(conversationId, cx), cx)).map(device => device.chat_device_id);

/**
 * A new group made by the caller's device, made current only while
 * previous_group_id still is and its devices are exactly the valid devices
 * of the conversation's people; else 409 CHAT_GROUP_STALE and the device
 * reads again.
 */
async function createGroup(userId: string, token: string | null, conversationId: string, input: unknown) {
  const body = object(input);
  const groupId = uuid(body.group_id, 'CHAT_GROUP_INVALID');
  const previous = body.previous_group_id === null ? null : uuid(body.previous_group_id, 'CHAT_GROUP_INVALID');
  const welcome = bytes(body.welcome, 16, MAX_WELCOME, 'CHAT_GROUP_INVALID');
  if (!Array.isArray(body.chat_device_ids) || !body.chat_device_ids.length || body.chat_device_ids.length > MAX_DEVICES) throw badRequest('CHAT_GROUP_INVALID', 'Invalid chat data');
  const deviceIds = [...new Set(body.chat_device_ids.map(item => uuid(item, 'CHAT_GROUP_INVALID')))];
  await assertCan(userId, conversationOf(conversationId), 'member');
  const own = await ownChatDevice(userId, token);
  if (!own) throw notEnrolled();
  await withTransaction(async cx => {
    const { current_group_id: current } = await lockConversation(cx, conversationId);
    if (current === groupId) return;
    if ((current ?? null) !== previous || !sameSet(deviceIds, await validDeviceIds(conversationId, cx))) throw stale(current);
    try {
      await cx.execute('INSERT INTO chat_groups (id, conversation_id, welcome) VALUES (?, ?, ?)', [groupId, conversationId, welcome]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ER_DUP_ENTRY') throw badRequest('CHAT_GROUP_INVALID', 'This group id is taken');
      throw error;
    }
    // The device that made the group is in it already.
    await cx.execute(`INSERT INTO chat_group_devices (group_id, chat_device_id, joined_at) VALUES ${deviceIds.map(() => '(?, ?, IF(?, UTC_TIMESTAMP(), NULL))').join(', ')}`,
      deviceIds.flatMap(id => [groupId, id, id === own]));
    await cx.execute('UPDATE chat_conversations SET current_group_id = ? WHERE id = ?', [groupId, conversationId]);
  });
  publishChatChanged(await conversationPeople(conversationId), conversationId);
  return { group_id: groupId, current: true as const };
}

/** The device of the request joined the group from its Welcome; once every device has, the Welcome goes. */
async function confirmJoined(userId: string, token: string | null, groupId: string) {
  const own = await ownChatDevice(userId, token);
  if (!own) throw notEnrolled();
  const [[group]] = await db.execute<RowDataPacket[]>(`SELECT g.conversation_id FROM chat_groups g JOIN chat_group_devices gd ON gd.group_id = g.id
    WHERE g.id = ? AND gd.chat_device_id = ?`, [groupId, own]);
  if (!group || !await can(userId, conversationOf(String(group.conversation_id)), 'member')) throw notFound('CHAT_GROUP_NOT_FOUND', 'Group not found');
  await db.execute('UPDATE chat_group_devices SET joined_at = COALESCE(joined_at, UTC_TIMESTAMP()) WHERE group_id = ? AND chat_device_id = ?', [groupId, own]);
  await db.execute('UPDATE chat_groups SET welcome = NULL WHERE id = ? AND NOT EXISTS (SELECT 1 FROM chat_group_devices WHERE group_id = ? AND joined_at IS NULL)', [groupId, groupId]);
  return { joined: true as const };
}

// --- Messages ---------------------------------------------------------------------------

const MESSAGE_COLUMNS = 'id, seq, group_id, sender_user_id, sender_chat_device_id, kind, replaces, format, ciphertext, created_at';
const toMessage = (row: RowDataPacket): ChatMessage => ({
  id: String(row.id), seq: Number(row.seq), group_id: String(row.group_id),
  sender_user_id: row.sender_user_id ? String(row.sender_user_id) : null,
  sender_chat_device_id: row.sender_chat_device_id ? String(row.sender_chat_device_id) : null,
  kind: row.kind === 'delete' ? 'delete' : 'message', replaces: row.replaces ? String(row.replaces) : null,
  format: Number(row.format), ciphertext: row.ciphertext === null ? null : String(row.ciphertext), created_at: utcIso(row.created_at),
});

function parseMessage(input: unknown) {
  const body = object(input);
  if (!Number.isSafeInteger(body.format) || Number(body.format) < 1 || Number(body.format) > 65535) throw badRequest('CHAT_MESSAGE_INVALID', 'Invalid chat data');
  if (!Array.isArray(body.previews) || body.previews.length > MAX_DEVICES) throw badRequest('CHAT_MESSAGE_INVALID', 'Invalid chat data');
  return {
    id: uuid(body.id, 'CHAT_MESSAGE_INVALID'), groupId: uuid(body.group_id, 'CHAT_MESSAGE_INVALID'),
    replaces: body.replaces === null ? null : uuid(body.replaces, 'CHAT_MESSAGE_INVALID'), format: Number(body.format),
    ciphertext: bytes(body.ciphertext, 1, MAX_CIPHERTEXT, 'CHAT_MESSAGE_INVALID'), archive: bytes(body.archive, 1, MAX_ARCHIVE, 'CHAT_MESSAGE_INVALID'),
    previews: new Map(body.previews.map(item => [uuid(object(item).chat_device_id, 'CHAT_MESSAGE_INVALID'), bytes(object(item).sealed, 1, MAX_PREVIEW, 'CHAT_MESSAGE_INVALID')])),
  };
}

/**
 * Posts a message to the conversation's current group. The id makes a retry
 * harmless; an edit names the sender's own earlier message. The sender's
 * archive copy is stored with it, and each recipient is notified with the
 * previews sealed to their own devices.
 */
async function postMessage(userId: string, token: string | null, conversationId: string, input: unknown): Promise<ChatMessage> {
  const message = parseMessage(input);
  await assertCan(userId, conversationOf(conversationId), 'member');
  const own = await ownChatDevice(userId, token);
  if (!own) throw notEnrolled();
  const { row, created } = await withTransaction(async cx => {
    const conversation = await lockConversation(cx, conversationId);
    const [[existing]] = await cx.execute<RowDataPacket[]>(`SELECT conversation_id, ${MESSAGE_COLUMNS} FROM chat_messages WHERE id = ?`, [message.id]);
    if (existing) {
      if (existing.conversation_id !== conversationId || existing.sender_user_id !== userId) throw conflict('CHAT_MESSAGE_EXISTS', 'This message id is taken');
      return { row: existing, created: false };
    }
    if (conversation.current_group_id !== message.groupId) throw stale(conversation.current_group_id);
    const peerId = otherOf(conversation.direct_key, userId);
    const peer = await peerState(peerId, cx);
    if (peer.reason) throw forbidden('CHAT_UNAVAILABLE', peer.reason);
    const [members] = await cx.execute<RowDataPacket[]>('SELECT chat_device_id FROM chat_group_devices WHERE group_id = ?', [message.groupId]);
    if (!sameSet(members.map(item => String(item.chat_device_id)), await validDeviceIds(conversationId, cx))) throw stale(conversation.current_group_id);
    if (message.replaces) {
      const [[original]] = await cx.execute<RowDataPacket[]>(`SELECT 1 FROM chat_messages WHERE id = ? AND conversation_id = ? AND sender_user_id = ?
        AND kind = 'message' AND replaces IS NULL AND ciphertext IS NOT NULL`, [message.replaces, conversationId, userId]);
      if (!original) throw messageNotFound();
    }
    const seq = Number(conversation.last_seq) + 1;
    await cx.execute('UPDATE chat_conversations SET last_seq = ? WHERE id = ?', [seq, conversationId]);
    await cx.execute(`INSERT INTO chat_messages (id, conversation_id, seq, group_id, sender_user_id, sender_chat_device_id, kind, replaces, format, ciphertext)
      VALUES (?, ?, ?, ?, ?, ?, 'message', ?, ?, ?)`, [message.id, conversationId, seq, message.groupId, userId, own, message.replaces, message.format, message.ciphertext]);
    await cx.execute('INSERT INTO chat_archive (user_id, message_id, sealed) VALUES (?, ?, ?)', [userId, message.id, message.archive]);
    // An edit is not news.
    if (!message.replaces && peerId) {
      const previews = Object.fromEntries((await validDevices([peerId], cx)).filter(device => message.previews.has(device.chat_device_id))
        .map(device => [device.chat_device_id, message.previews.get(device.chat_device_id)]));
      await enqueueFromSource({ kind: 'chat', userId: peerId, sourceId: message.id, dedupeKey: `chat:${message.id}`,
        url: `/chat?conversation=${encodeURIComponent(conversationId)}`, data: { conversationId, messageId: message.id, tag: `chat:${conversationId}`, previews } }, cx);
    }
    const [[row]] = await cx.execute<RowDataPacket[]>(`SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE id = ?`, [message.id]);
    return { row, created: true };
  });
  if (created) {
    publishChatChanged(await conversationPeople(conversationId), conversationId);
    // The recipient's phone hears of it now, not at the next pass.
    if (!message.replaces) void processNotificationJobs().catch(error => log.error('CHAT', 'Notification pass deferred', error));
  }
  return toMessage(row);
}

/** Entries after a seq (never before the caller's joined_seq), with the Welcomes of groups the request's device has not joined. */
async function fetchMessages(userId: string, token: string | null, conversationId: string, query: URLSearchParams): Promise<ChatMessagesResponse> {
  const after = count(query.get('after'), 0, Number.MAX_SAFE_INTEGER);
  const limit = Math.max(1, count(query.get('limit'), 100, 200));
  await assertCan(userId, conversationOf(conversationId), 'member');
  const [[conversation]] = await db.execute<RowDataPacket[]>(`SELECT c.last_seq, COALESCE(me.joined_seq, 0) AS joined_seq FROM chat_conversations c
    LEFT JOIN chat_members me ON me.conversation_id = c.id AND me.user_id = ? WHERE c.id = ?`, [userId, conversationId]);
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ${limit + 1}`,
    [conversationId, Math.max(after, Number(conversation.joined_seq))]);
  const own = await ownChatDevice(userId, token);
  const [welcomes] = own ? await db.execute<RowDataPacket[]>(`SELECT g.id, g.welcome, g.created_at FROM chat_groups g
    JOIN chat_group_devices gd ON gd.group_id = g.id AND gd.chat_device_id = ?
    WHERE g.conversation_id = ? AND gd.joined_at IS NULL AND g.welcome IS NOT NULL ORDER BY g.created_at, g.id`, [own, conversationId]) : [[]];
  return {
    messages: rows.slice(0, limit).map(toMessage),
    welcomes: welcomes.map((row): ChatWelcome => ({ group_id: String(row.id), welcome: String(row.welcome), created_at: utcIso(row.created_at) })),
    last_seq: Number(conversation.last_seq), more: rows.length > limit,
  };
}

/**
 * The sender deletes a message for both sides (the route is refused while
 * bin.delete forbids it): its text and its edits' are emptied, their archive
 * copies and queued notifications go, and a 'delete' entry tells every device.
 */
async function deleteMessage(userId: string, token: string | null, messageId: string) {
  const [[message]] = await db.execute<RowDataPacket[]>("SELECT conversation_id, group_id FROM chat_messages WHERE id = ? AND sender_user_id = ? AND kind = 'message' AND replaces IS NULL",
    [messageId, userId]);
  if (!message || !await can(userId, conversationOf(String(message.conversation_id)), 'member')) throw messageNotFound();
  const conversationId = String(message.conversation_id);
  const own = await ownChatDevice(userId, token);
  const seq = await withTransaction(async cx => {
    const conversation = await lockConversation(cx, conversationId);
    const [[done]] = await cx.execute<RowDataPacket[]>("SELECT seq FROM chat_messages WHERE replaces = ? AND kind = 'delete'", [messageId]);
    if (done) return Number(done.seq);
    const [edits] = await cx.execute<RowDataPacket[]>("SELECT id FROM chat_messages WHERE replaces = ? AND kind = 'message'", [messageId]);
    const ids = [messageId, ...edits.map(row => String(row.id))];
    await cx.execute(`UPDATE chat_messages SET ciphertext = NULL WHERE id IN (${placeholders(ids)})`, ids);
    await cx.execute(`DELETE FROM chat_archive WHERE message_id IN (${placeholders(ids)})`, ids);
    await cx.execute(`DELETE FROM notification_events WHERE kind = 'chat' AND source_id IN (${placeholders(ids)})`, ids);
    const next = Number(conversation.last_seq) + 1;
    await cx.execute('UPDATE chat_conversations SET last_seq = ? WHERE id = ?', [next, conversationId]);
    await cx.execute(`INSERT INTO chat_messages (id, conversation_id, seq, group_id, sender_user_id, sender_chat_device_id, kind, replaces, ciphertext)
      VALUES (?, ?, ?, ?, ?, ?, 'delete', ?, NULL)`, [crypto.randomUUID(), conversationId, next, conversation.current_group_id ?? message.group_id, userId, own, messageId]);
    return next;
  });
  publishChatChanged(await conversationPeople(conversationId), conversationId);
  return { deleted: true as const, seq };
}

/** Moves the caller's marks forward, never back and never past the last entry; reading delivers. */
async function moveMarks(userId: string, conversationId: string, input: unknown): Promise<ChatMarksResponse> {
  const body = object(input);
  const mark = (value: unknown) => {
    if (value === undefined) return 0;
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw badRequest('CHAT_MARKS_INVALID', 'Invalid chat data');
    return Number(value);
  };
  const read = mark(body.read_seq);
  const delivered = Math.max(read, mark(body.delivered_seq));
  await assertCan(userId, conversationOf(conversationId), 'member');
  const [[conversation]] = await db.execute<RowDataPacket[]>('SELECT last_seq FROM chat_conversations WHERE id = ?', [conversationId]);
  const last = Number(conversation.last_seq);
  await db.execute(`INSERT INTO chat_members (conversation_id, user_id, read_seq, delivered_seq) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE read_seq = GREATEST(read_seq, VALUES(read_seq)), delivered_seq = GREATEST(delivered_seq, VALUES(delivered_seq))`,
  [conversationId, userId, Math.min(read, last), Math.min(delivered, last)]);
  const [[marks]] = await db.execute<RowDataPacket[]>('SELECT read_seq, delivered_seq FROM chat_members WHERE conversation_id = ? AND user_id = ?', [conversationId, userId]);
  publishChatChanged(await conversationPeople(conversationId), conversationId);
  return { read_seq: Number(marks.read_seq), delivered_seq: Number(marks.delivered_seq) };
}

// --- The personal archive ---------------------------------------------------------------

/** The caller's own copies of messages of their conversations; a copy already stored stays, a deleted message takes none. */
async function storeArchive(userId: string, input: unknown) {
  const copies = object(input).copies;
  if (!Array.isArray(copies) || !copies.length || copies.length > MAX_ARCHIVE_COPIES) throw badRequest('CHAT_ARCHIVE_INVALID', `Send 1 to ${MAX_ARCHIVE_COPIES} copies`);
  const parsed = copies.map(item => [uuid(object(item).message_id, 'CHAT_ARCHIVE_INVALID'), bytes(object(item).sealed, 1, MAX_ARCHIVE, 'CHAT_ARCHIVE_INVALID')]);
  const reached = await visible(userId, 'conversation');
  if (!reached.length) return { stored: 0 };
  let stored = 0;
  for (const [messageId, sealed] of parsed) {
    // A locking read: a deletion that ran first leaves no ciphertext to copy.
    const [insert] = await db.execute<ResultSetHeader>(`INSERT IGNORE INTO chat_archive (user_id, message_id, sealed)
      SELECT ?, id, ? FROM chat_messages WHERE id = ? AND kind = 'message' AND ciphertext IS NOT NULL AND conversation_id IN (${placeholders(reached)})`,
    [userId, sealed, messageId, ...reached]);
    stored += insert.affectedRows;
  }
  return { stored };
}

/** The caller's copies for a restore, in conversation and seq order. */
async function listArchive(userId: string, query: URLSearchParams) {
  const limit = Math.max(1, count(query.get('limit'), 200, 500));
  const cursor = query.get('cursor');
  const [after, seq] = cursor ? cursor.split(':') : ['', '0'];
  if (cursor && (!UUID.test(after) || !/^\d{1,15}$/.test(seq ?? ''))) throw badRequest('CHAT_QUERY_INVALID', 'Invalid chat query');
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT a.message_id, a.sealed, m.conversation_id, m.seq FROM chat_archive a JOIN chat_messages m ON m.id = a.message_id
    WHERE a.user_id = ? AND (m.conversation_id > ? OR (m.conversation_id = ? AND m.seq > ?)) ORDER BY m.conversation_id, m.seq LIMIT ${limit + 1}`,
  [userId, after, after, Number(seq)]);
  const copies = rows.slice(0, limit).map((row): ChatArchiveEntry => ({ message_id: String(row.message_id), sealed: String(row.sealed),
    conversation_id: String(row.conversation_id), seq: Number(row.seq) }));
  const last = copies.at(-1);
  return { copies, cursor: rows.length > limit && last ? `${last.conversation_id}:${last.seq}` : null };
}

// --- Notifications ----------------------------------------------------------------------

interface ChatNotificationSource { sender: string }

/** A message as its notification sees it: still there, not an edit, not the person's own, not read yet. */
async function notificationSource(userId: string, messageId: string, executor: SqlExecutor): Promise<ChatNotificationSource | null> {
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT m.conversation_id, COALESCE(NULLIF(u.full_name, ''), u.email) AS sender
    FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_user_id
    LEFT JOIN chat_members me ON me.conversation_id = m.conversation_id AND me.user_id = ?
    WHERE m.id = ? AND m.kind = 'message' AND m.replaces IS NULL AND m.ciphertext IS NOT NULL AND NOT (m.sender_user_id <=> ?)
      AND m.seq > COALESCE(me.read_seq, 0)`, [userId, messageId, userId]);
  if (!row || !await can(userId, conversationOf(String(row.conversation_id)), 'member', executor)) return null;
  return { sender: row.sender ? String(row.sender) : 'Deleted person' };
}

/** The preview the sender sealed to this device's chat keys, when there is one. */
async function previewFor(payload: Record<string, unknown>, deviceId: string, executor: SqlExecutor): Promise<Record<string, unknown>> {
  const previews = object(payload.previews) as Record<string, unknown>;
  const [[device]] = await executor.execute<RowDataPacket[]>('SELECT id FROM chat_devices WHERE device_id = ?', [deviceId]);
  const preview = device ? previews[String(device.id)] : undefined;
  return typeof preview === 'string' ? { preview } : {};
}

// --- Presence ---------------------------------------------------------------------------

// The state last sent per person; while it is held, later changes wait for its timer.
const presenceSent = new Map<string, boolean>();

/** Tells the people who share a conversation with the person, both with presence on, at most once in ten seconds. */
function presenceChanged(userId: string) {
  if (presenceSent.has(userId)) return;
  const online = realtime.isPresent(userId);
  presenceSent.set(userId, online);
  void sendPresence(userId, online).catch(error => log.error('CHAT', 'Presence not sent', error));
  setTimeout(() => {
    presenceSent.delete(userId);
    if (realtime.isPresent(userId) !== online) presenceChanged(userId);
  }, PRESENCE_MS).unref();
}

async function sendPresence(userId: string, online: boolean) {
  if (!(await chatSettings(userId, db)).chat_presence) return;
  const partners = new Set<string>();
  for (const id of await visible(userId, 'conversation')) for (const person of await conversationPeople(id)) if (person !== userId) partners.add(person);
  for (const partner of partners) {
    if (realtime.isPresent(partner) && (await chatSettings(partner, db)).chat_presence) publishChatPresence(partner, userId, online);
  }
}

realtime.onPresence(presenceChanged);

export type { ChatNotificationSource };
export {
  listConversations, startConversation, createGroup, confirmJoined, postMessage, fetchMessages, deleteMessage, moveMarks,
  storeArchive, listArchive, notificationSource, previewFor,
};
