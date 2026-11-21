import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type {
  ChatArchiveEntry, ChatConversation, ChatGroupStaleDetails, ChatMarksResponse, ChatMember, ChatMessage, ChatMessagesResponse, ChatNotify, ChatPeer,
  ChatRetentionDays, ChatSender, ChatTooManyPeopleDetails, ChatWelcome, ChatCandidatesResponse,
} from '../contracts/chat';
import type { Principal } from '../contracts/organisation';

import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { log } from '../log';
import { withTransaction } from './transactions';
import { accessLevel, assertCan, can, conversationFollows, conversationManagers, conversationPeople, grantedBy, grantedTo, setGrant, visible } from './access';
import { groupExists, groupNames, groupsOf, listGroups, membershipOf, peopleMatching, shareAGroup } from './groups';
import { can as roleCan } from '../security/permissions';
import { bytes, notEnrolled, object, ownChatDevice, utcIso, validDevices } from './chat-devices';
import { isModuleEnabled } from './module-settings';
import { resolvePolicy, settingValues } from './settings';
import { publishChatChanged, publishChatPresence, realtime } from './realtime';
import { enqueueFromSource, processNotificationJobs } from './notifications';
import { deleteMessageFiles, tieAttachments } from './chat-attachments';

// Conversations, groups, messages, marks, the personal archive and presence.
// The server stores and hands out opaque bytes; what it decides is
// who may read a conversation (access.ts, kind `conversation`), the order of
// its entries (seq) and whether a message goes to a group with exactly the
// valid devices of the people the conversation reaches. A group never
// changes: when the devices or the people change, the next sender makes a
// new one, and a group chat's people read from the first group that holds
// their devices (joined_seq; without a row, nothing yet).
// A direct chat is two people; a group chat has a name and at most 100
// people, chosen by its managers or those of the organisation group it
// follows (access.ts says who manages).
// Hints on the live stream tell the pages to fetch; nothing travels in them.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CIPHERTEXT = 64 * 1024;
const MAX_ARCHIVE = 48 * 1024;
const MAX_WELCOME = 384 * 1024;
const MAX_PREVIEW = 2048;
const MAX_DEVICES = 1000;
const MAX_ARCHIVE_COPIES = 200;
const MAX_PEOPLE = 100;
const MAX_MENTIONS = 20;
const MAX_NAME = 80;
const NOTIFY: readonly ChatNotify[] = ['all', 'mentions', 'none'];
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
const notGroup = () => badRequest('CHAT_NOT_GROUP', 'Only a group chat has people to add, remove or leave.');
const followsGroup = () => conflict('CHAT_FOLLOWS_GROUP', 'This chat follows a group: its people change with the group.');
const tooMany = () => badRequest('CHAT_TOO_MANY_PEOPLE', `A chat can have at most ${MAX_PEOPLE} people.`,
  { limit: MAX_PEOPLE, reason: `A chat can have at most ${MAX_PEOPLE} people.` } satisfies ChatTooManyPeopleDetails);
const chatName = (value: unknown) => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > MAX_NAME) throw badRequest('CHAT_NAME_INVALID', `A chat's name has 1 to ${MAX_NAME} characters.`);
  return name;
};
const userIds = (value: unknown) => {
  if (!Array.isArray(value) || value.length > MAX_PEOPLE) throw badRequest('CHAT_INVALID', 'Invalid chat data');
  return [...new Set(value.map(item => uuid(item, 'CHAT_INVALID')))];
};
const nameOf = async (userId: string, executor: SqlExecutor) => {
  const [[row]] = await executor.execute<RowDataPacket[]>("SELECT COALESCE(NULLIF(full_name, ''), email) AS name FROM users WHERE id = ?", [userId]);
  return row ? String(row.name) : null;
};
const chatAdmin = async (userId: string, executor: SqlExecutor) => {
  const [[row]] = await executor.execute<RowDataPacket[]>('SELECT role FROM users WHERE id = ?', [userId]);
  return roleCan(row?.role, 'chat.manage');
};
// A person in a group chat without a marks row has not joined yet: their messages start at the conversation's end.
const JOINED = "IF(me.user_id IS NULL AND c.kind = 'group', c.last_seq, COALESCE(me.joined_seq, 0))";

// --- The other person -------------------------------------------------------------------

interface PeerState { user_id: string | null; name: string; reason: string | null; ready: boolean; active: boolean }

/** Whether a person can be written to: active, Chat on, and (for a message) a chat device. ready leaves out the device. */
async function peerState(peerId: string | null, executor: SqlExecutor = db): Promise<PeerState> {
  const [[user]] = await executor.execute<RowDataPacket[]>("SELECT COALESCE(NULLIF(full_name, ''), email) AS name, is_active FROM users WHERE id = ?", [peerId]);
  if (!peerId || !user) return { user_id: null, name: 'Deleted person', reason: 'This person was deleted.', ready: false, active: false };
  const name = String(user.name);
  const off = !user.is_active ? `${name} is deactivated.` : !await isModuleEnabled(peerId!, 'chat', executor) ? `Chat is off for ${name}.` : null;
  const reason = off ?? ((await validDevices([peerId!], executor)).length ? null : `${name} has not opened UniHub since the update.`);
  return { user_id: peerId, name, reason, ready: !off, active: !!user.is_active };
}

// --- Conversations ----------------------------------------------------------------------

// shortcut: a few queries per conversation (the peer, or a group chat's people and managers); one query for the list when lists grow long.
async function describeConversations(userId: string, ids: readonly string[], executor: SqlExecutor = db): Promise<ChatConversation[]> {
  if (!ids.length) return [];
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT c.id, c.kind, c.name, c.direct_key, c.current_group_id, c.last_seq, c.created_at, c.retention_days, c.retention_from,
      (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.conversation_id = c.id) AS last_activity_at,
      COALESCE(me.read_seq, 0) AS read_seq, COALESCE(me.delivered_seq, 0) AS delivered_seq, ${JOINED} AS joined_seq, COALESCE(me.notify, 'all') AS notify,
      COALESCE(peer.read_seq, 0) AS peer_read_seq, COALESCE(peer.delivered_seq, 0) AS peer_delivered_seq,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.kind = 'message' AND m.replaces IS NULL AND m.ciphertext IS NOT NULL
        AND m.seq > GREATEST(COALESCE(me.read_seq, 0), ${JOINED}) AND NOT (m.sender_user_id <=> ?)) AS unread
    FROM chat_conversations c
    LEFT JOIN chat_members me ON me.conversation_id = c.id AND me.user_id = ?
    LEFT JOIN chat_members peer ON peer.conversation_id = c.id AND peer.user_id <> ? AND c.kind = 'direct'
    WHERE c.id IN (${placeholders(ids)})
    ORDER BY COALESCE(last_activity_at, c.created_at) DESC, c.id`, [userId, userId, userId, ...ids]);
  const mine = await chatSettings(userId, executor);
  const conversations: ChatConversation[] = [];
  for (const row of rows) {
    const id = String(row.id);
    const base = {
      id, current_group_id: row.current_group_id ? String(row.current_group_id) : null,
      last_seq: Number(row.last_seq),
      last_activity_at: row.last_activity_at ? utcIso(row.last_activity_at) : null,
      unread: Number(row.unread),
      read_seq: Number(row.read_seq), delivered_seq: Number(row.delivered_seq), joined_seq: Number(row.joined_seq),
      notify: String(row.notify) as ChatNotify,
      retention_days: row.retention_days === null ? null : Number(row.retention_days) as ChatRetentionDays,
      retention_from: row.retention_from ? utcIso(row.retention_from) : null,
    };
    if (row.kind === 'group') {
      const follows = await conversationFollows(id, executor);
      const by = await grantedBy(conversationOf(id), userId, executor);
      conversations.push({
        ...base, kind: 'group', name: String(row.name),
        follows: !follows ? null : follows.kind === 'group' ? { kind: 'group', id: follows.id, name: (await groupNames([follows.id], executor)).get(follows.id) ?? '' } : { kind: 'everyone' },
        role: await accessLevel(userId, conversationOf(id), executor) === 'manage' ? 'manager' : 'member',
        member_count: (await conversationPeople(id, executor)).length,
        added_by: by && by !== userId ? await nameOf(by, executor) : null,
      });
      continue;
    }
    const peer = await peerState(otherOf(row.direct_key, userId), executor);
    const theirs = peer.user_id ? await chatSettings(peer.user_id, executor) : null;
    conversations.push({
      ...base, kind: 'direct',
      peer: { user_id: peer.user_id, name: peer.name, active: peer.active, can_write: !peer.reason, reason: peer.reason,
        online: mine.chat_presence && theirs?.chat_presence ? realtime.isPresent(peer.user_id) : null } satisfies ChatPeer,
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
  if (object(input).kind === 'group') return startGroupChat(userId, object(input));
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

// --- Group chats ------------------------------------------------------------------------

/**
 * Whether the caller may add the person to a group chat: an active person
 * with Chat on, within reach (sharing an organisation group, anyone under
 * chat.reach 'organisation', anyone for an administrator).
 */
async function assertAddable(cx: SqlExecutor, userId: string, wide: boolean, personId: string) {
  const person = await peerState(personId, cx);
  if (!person.user_id) throw notFound('USER_NOT_FOUND', 'User not found');
  if (!person.ready) throw forbidden('CHAT_UNAVAILABLE', person.reason!);
  if (!wide && !await shareAGroup(userId, personId, cx)) throw forbidden('CHAT_OUT_OF_REACH', 'You can add only people who share a group with you.');
}
const reachesAnyone = async (userId: string, executor: SqlExecutor) =>
  await chatAdmin(userId, executor) || (await resolvePolicy(userId, 'chat.reach', executor)).value === 'organisation';

/** A new group chat of chosen people (the caller manages it) or following one organisation group or everyone. */
async function startGroupChat(userId: string, body: Record<string, unknown>) {
  const name = chatName(body.name);
  const id = crypto.randomUUID();
  const conversation = conversationOf(id);
  const people = await withTransaction(async cx => {
    const admin = await chatAdmin(userId, cx);
    const create = () => cx.execute("INSERT INTO chat_conversations (id, kind, name, created_by) VALUES (?, 'group', ?, ?)", [id, name, userId]);
    if (body.follow !== undefined) {
      const follow = object(body.follow);
      const principal: Principal = follow.kind === 'everyone' ? { kind: 'everyone' } : { kind: 'group', id: uuid(follow.id, 'CHAT_INVALID') };
      if (principal.kind === 'group' && !await groupExists(principal.id, cx)) throw notFound('GROUP_NOT_FOUND', 'Group not found');
      if (!admin && (principal.kind === 'everyone' || await membershipOf(principal.id, userId, cx) !== 'manager')) {
        throw forbidden('CHAT_FORBIDDEN', 'Only the group\'s managers and administrators can make a chat that follows it.');
      }
      await create();
      await setGrant(cx, conversation, principal, 'member', userId);
      const reached = await conversationPeople(id, cx);
      if (reached.length > MAX_PEOPLE) throw tooMany();
      return reached;
    }
    const others = userIds(body.user_ids).filter(person => person !== userId);
    if (others.length + 1 > MAX_PEOPLE) throw tooMany();
    const wide = await reachesAnyone(userId, cx);
    for (const person of others) await assertAddable(cx, userId, wide, person);
    await create();
    await setGrant(cx, conversation, { kind: 'user', id: userId }, 'manage', userId);
    for (const person of others) await setGrant(cx, conversation, { kind: 'user', id: person }, 'member', userId);
    return [userId, ...others];
  });
  publishChatChanged(people, id);
  return { conversation: (await describeConversations(userId, [id]))[0], created: true };
}

/** A group chat's lock for a change of its people or name, refused for a direct one and, unless asked, for one that follows a group. */
async function lockGroupChat(cx: SqlExecutor, userId: string, conversationId: string, permission: 'member' | 'manage', { followed = false } = {}) {
  const conversation = await lockConversation(cx, conversationId);
  await assertCan(userId, conversationOf(conversationId), permission, cx);
  if (conversation.kind !== 'group') throw notGroup();
  const follows = await conversationFollows(conversationId, cx);
  if (!followed && follows) throw followsGroup();
  return follows;
}

/** Someone no longer in a chat: their marks and their archive copies of it go. */
async function dropMember(cx: SqlExecutor, conversationId: string, userId: string) {
  await cx.execute('DELETE FROM chat_members WHERE conversation_id = ? AND user_id = ?', [conversationId, userId]);
  await cx.execute(`DELETE a FROM chat_archive a JOIN chat_messages m ON m.id = a.message_id WHERE a.user_id = ? AND m.conversation_id = ?`, [userId, conversationId]);
}

/** A manager renames a group chat. */
async function renameChat(userId: string, conversationId: string, input: unknown) {
  const name = chatName(object(input).name);
  await assertCan(userId, conversationOf(conversationId), 'manage');
  await withTransaction(async cx => {
    await lockGroupChat(cx, userId, conversationId, 'manage', { followed: true });
    await cx.execute('UPDATE chat_conversations SET name = ? WHERE id = ?', [name, conversationId]);
  });
  publishChatChanged(await conversationPeople(conversationId), conversationId);
  return { conversation: (await describeConversations(userId, [conversationId]))[0] };
}

/** A manager adds people to a group chat of chosen people; those already in it stay as they are. */
async function addChatMembers(userId: string, conversationId: string, input: unknown) {
  const ids = userIds(object(input).user_ids);
  await assertCan(userId, conversationOf(conversationId), 'manage');
  const people = await withTransaction(async cx => {
    await lockGroupChat(cx, userId, conversationId, 'manage');
    const present = await conversationPeople(conversationId, cx);
    const added = ids.filter(id => !present.includes(id));
    if (present.length + added.length > MAX_PEOPLE) throw tooMany();
    const wide = await reachesAnyone(userId, cx);
    for (const person of added) await assertAddable(cx, userId, wide, person);
    for (const person of added) await setGrant(cx, conversationOf(conversationId), { kind: 'user', id: person }, 'member', userId);
    return [...present, ...added];
  });
  publishChatChanged(people, conversationId);
  return { members: await chatMembers(userId, conversationId) };
}

/** A manager removes someone else from a group chat of chosen people; they are refused from now on. */
async function removeChatMember(userId: string, conversationId: string, personId: string) {
  if (personId === userId) throw badRequest('CHAT_SELF', 'Leave the chat instead.');
  await assertCan(userId, conversationOf(conversationId), 'manage');
  const people = await withTransaction(async cx => {
    await lockGroupChat(cx, userId, conversationId, 'manage');
    const present = await conversationPeople(conversationId, cx);
    if (!present.includes(personId)) throw notFound('USER_NOT_FOUND', 'This person is not in the chat.');
    await setGrant(cx, conversationOf(conversationId), { kind: 'user', id: personId }, null, null);
    await dropMember(cx, conversationId, personId);
    return present;
  });
  publishChatChanged(people, conversationId);
  return { members: await chatMembers(userId, conversationId) };
}

/** The caller leaves a group chat of chosen people. */
async function leaveChat(userId: string, conversationId: string) {
  await assertCan(userId, conversationOf(conversationId), 'member');
  const people = await withTransaction(async cx => {
    await lockGroupChat(cx, userId, conversationId, 'member');
    const present = await conversationPeople(conversationId, cx);
    await setGrant(cx, conversationOf(conversationId), { kind: 'user', id: userId }, null, null);
    await dropMember(cx, conversationId, userId);
    return present;
  });
  publishChatChanged(people, conversationId);
  return { left: true as const };
}

/** A followed chat becomes one of the people it reaches now; the manager who asked (if any) manages it. */
async function convertFollowed(cx: SqlExecutor, conversationId: string, follows: Exclude<Principal, { kind: 'user' }>, managerId: string | null) {
  for (const person of await conversationPeople(conversationId, cx)) {
    await setGrant(cx, conversationOf(conversationId), { kind: 'user', id: person }, person === managerId ? 'manage' : 'member', null);
  }
  await setGrant(cx, conversationOf(conversationId), follows, null, null);
}

/** A manager of a followed chat stops following: it keeps the people it has. */
async function unfollowChat(userId: string, conversationId: string) {
  await assertCan(userId, conversationOf(conversationId), 'manage');
  await withTransaction(async cx => {
    const follows = await lockGroupChat(cx, userId, conversationId, 'manage', { followed: true });
    if (!follows) throw conflict('CHAT_NOT_FOLLOWING', 'This chat follows no group.');
    await convertFollowed(cx, conversationId, follows, userId);
  });
  publishChatChanged(await conversationPeople(conversationId), conversationId);
  return { conversation: (await describeConversations(userId, [conversationId]))[0] };
}

/** In the transaction that deletes an organisation group: each chat that follows it keeps the people it has. */
async function unfollowDeletedGroup(cx: SqlExecutor, groupId: string) {
  for (const id of await grantedTo('conversation', { kind: 'group', id: groupId }, cx)) {
    await lockConversation(cx, id);
    await convertFollowed(cx, id, { kind: 'group', id: groupId }, null);
  }
}

/** An organisation group gained or lost people: the chats that follow it tell their people, and those who came or went. */
async function followedGroupChanged(groupId: string, reached: string[]) {
  for (const id of await grantedTo('conversation', { kind: 'group', id: groupId })) publishChatChanged([...await conversationPeople(id), ...reached], id);
}

/** The people a conversation reaches, managers first, with their reasons, marks and presence as the caller may see them. */
async function chatMembers(userId: string, conversationId: string): Promise<ChatMember[]> {
  await assertCan(userId, conversationOf(conversationId), 'member');
  const people = await conversationPeople(conversationId);
  const [[conversation]] = await db.execute<RowDataPacket[]>('SELECT kind, last_seq FROM chat_conversations WHERE id = ?', [conversationId]);
  const managers = conversation.kind === 'group' ? await conversationManagers(conversationId) : new Set<string>();
  const [users] = await db.execute<RowDataPacket[]>(`SELECT id, email, COALESCE(NULLIF(full_name, ''), email) AS name, is_active FROM users WHERE id IN (${placeholders(people)})`, people);
  const [marks] = await db.execute<RowDataPacket[]>('SELECT user_id, read_seq, delivered_seq, joined_seq FROM chat_members WHERE conversation_id = ?', [conversationId]);
  const marksOf = new Map(marks.map(row => [String(row.user_id), row]));
  const mine = await chatSettings(userId, db);
  const members: ChatMember[] = [];
  for (const user of users) {
    const id = String(user.id);
    const state = await peerState(id);
    const theirs = await chatSettings(id, db);
    const row = marksOf.get(id);
    members.push({
      user_id: id, name: String(user.name), email: String(user.email), role: managers.has(id) ? 'manager' : 'member', active: !!user.is_active, reason: state.reason,
      online: mine.chat_presence && theirs.chat_presence ? realtime.isPresent(id) : null,
      read_seq: mine.chat_read_receipts && theirs.chat_read_receipts ? Number(row?.read_seq ?? 0) : null,
      delivered_seq: Number(row?.delivered_seq ?? 0),
      joined_seq: row ? Number(row.joined_seq) : conversation.kind === 'group' ? Number(conversation.last_seq) : 0,
    });
  }
  return members.sort((a, b) => Number(b.role === 'manager') - Number(a.role === 'manager') || a.name.localeCompare(b.name) || a.user_id.localeCompare(b.user_id));
}

/** What a chat notifies the caller of. */
async function setNotify(userId: string, conversationId: string, input: unknown) {
  const notify = object(input).notify as ChatNotify;
  if (!NOTIFY.includes(notify)) throw badRequest('CHAT_INVALID', 'Invalid chat data');
  await assertCan(userId, conversationOf(conversationId), 'member');
  await ensureMemberRow(db, conversationId, userId);
  await db.execute('UPDATE chat_members SET notify = ? WHERE conversation_id = ? AND user_id = ?', [notify, conversationId, userId]);
  return { notify };
}

/** The person's marks row; one first made in a group chat starts at its end. */
const ensureMemberRow = (executor: SqlExecutor, conversationId: string, userId: string) => executor.execute(`INSERT IGNORE INTO chat_members (conversation_id, user_id, joined_seq)
  SELECT id, ?, IF(kind = 'group', last_seq, 0) FROM chat_conversations WHERE id = ?`, [userId, conversationId]);

/** For a new group chat or adding to one: people within reach with Chat on, the groups the caller may follow, and whether everyone. */
async function chatCandidates(userId: string, query: string): Promise<ChatCandidatesResponse> {
  const admin = await chatAdmin(userId, db);
  const wide = admin || (await resolvePolicy(userId, 'chat.reach')).value === 'organisation';
  const people = [];
  for (const person of await peopleMatching(query, wide ? {} : { sharingGroupsWith: userId })) {
    if (person.id !== userId && await isModuleEnabled(person.id, 'chat')) people.push(person);
  }
  const needle = query.trim().toLowerCase();
  const groups = (admin ? await listGroups() : (await groupsOf(userId)).filter(group => group.role === 'manager'))
    .filter(group => group.name.toLowerCase().includes(needle)).slice(0, 20).map(({ id, name }) => ({ id, name }));
  return { people, groups, everyone: admin };
}

// --- Groups -----------------------------------------------------------------------------

async function lockConversation(cx: SqlExecutor, conversationId: string) {
  const [[row]] = await cx.execute<RowDataPacket[]>('SELECT kind, current_group_id, last_seq, direct_key FROM chat_conversations WHERE id = ? FOR UPDATE', [conversationId]);
  if (!row) throw notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
  return row;
}

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
    const { current_group_id: current, kind, last_seq: last } = await lockConversation(cx, conversationId);
    if (current === groupId) return;
    const people = await conversationPeople(conversationId, cx);
    const devices = await validDevices(people, cx);
    if ((current ?? null) !== previous || !sameSet(deviceIds, devices.map(device => device.chat_device_id))) throw stale(current);
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
    if (kind !== 'group') return;
    // Who is in, and since when: whoever has a device in this group reads from here on; someone no longer reached loses their place.
    const joined = [...new Set(devices.map(device => device.user_id))];
    if (joined.length) {
      await cx.execute(`INSERT IGNORE INTO chat_members (conversation_id, user_id, joined_seq) VALUES ${joined.map(() => '(?, ?, ?)').join(', ')}`,
        joined.flatMap(id => [conversationId, id, last]));
    }
    const [rows] = await cx.execute<RowDataPacket[]>('SELECT user_id FROM chat_members WHERE conversation_id = ?', [conversationId]);
    for (const row of rows) if (!people.includes(String(row.user_id))) await dropMember(cx, conversationId, String(row.user_id));
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
  const mentions = body.mentions ?? [];
  if (!Array.isArray(mentions) || mentions.length > MAX_MENTIONS) throw badRequest('CHAT_MENTION_INVALID', `Mention at most ${MAX_MENTIONS} people of the chat.`);
  return {
    mentions: [...new Set(mentions.map(item => uuid(item, 'CHAT_MENTION_INVALID')))],
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
    const direct = conversation.kind !== 'group';
    if (direct) {
      const peer = await peerState(otherOf(conversation.direct_key, userId), cx);
      if (peer.reason) throw forbidden('CHAT_UNAVAILABLE', peer.reason);
    }
    const people = await conversationPeople(conversationId, cx);
    const devices = await validDevices(people, cx);
    const [members] = await cx.execute<RowDataPacket[]>('SELECT chat_device_id FROM chat_group_devices WHERE group_id = ?', [message.groupId]);
    if (!sameSet(members.map(item => String(item.chat_device_id)), devices.map(device => device.chat_device_id))) throw stale(conversation.current_group_id);
    if (!direct) {
      // Someone added back since this group was made has no place in the chat yet and would be served nothing: a new group gives them one.
      const [placed] = await cx.execute<RowDataPacket[]>('SELECT user_id FROM chat_members WHERE conversation_id = ?', [conversationId]);
      if (devices.some(device => !placed.some(row => String(row.user_id) === device.user_id))) throw stale(conversation.current_group_id);
    }
    if (message.mentions.length && (direct || message.mentions.some(id => id === userId || !people.includes(id)))) {
      throw badRequest('CHAT_MENTION_INVALID', 'Mention only other people of this group chat.');
    }
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
    await tieAttachments(cx, conversationId, userId, message.id, !!message.replaces, object(input).attachments);
    // An edit is not news. Each person's choice for the chat is applied when it is sent (notificationSource).
    for (const person of message.replaces ? [] : people.filter(id => id !== userId)) {
      const previews = Object.fromEntries(devices.filter(device => device.user_id === person && message.previews.has(device.chat_device_id))
        .map(device => [device.chat_device_id, message.previews.get(device.chat_device_id)]));
      await enqueueFromSource({ kind: 'chat', userId: person, sourceId: message.id, dedupeKey: `chat:${message.id}`,
        url: `/chat?c=${encodeURIComponent(conversationId)}`,
        data: { conversationId, messageId: message.id, tag: `chat:${conversationId}`, previews, mentioned: message.mentions.includes(person) } }, cx);
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
  const [[conversation]] = await db.execute<RowDataPacket[]>(`SELECT c.last_seq, ${JOINED} AS joined_seq FROM chat_conversations c
    LEFT JOIN chat_members me ON me.conversation_id = c.id AND me.user_id = ? WHERE c.id = ?`, [userId, conversationId]);
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ${limit + 1}`,
    [conversationId, Math.max(after, Number(conversation.joined_seq))]);
  const own = await ownChatDevice(userId, token);
  const [welcomes] = own ? await db.execute<RowDataPacket[]>(`SELECT g.id, g.welcome, g.created_at FROM chat_groups g
    JOIN chat_group_devices gd ON gd.group_id = g.id AND gd.chat_device_id = ?
    WHERE g.conversation_id = ? AND gd.joined_at IS NULL AND g.welcome IS NOT NULL ORDER BY g.created_at, g.id`, [own, conversationId]) : [[]];
  const messages = rows.slice(0, limit).map(toMessage);
  const senderIds = [...new Set(messages.flatMap(item => item.sender_user_id ? [item.sender_user_id] : []))];
  const [senders] = senderIds.length ? await db.execute<RowDataPacket[]>(`SELECT id, COALESCE(NULLIF(full_name, ''), email) AS name, is_active FROM users
    WHERE id IN (${placeholders(senderIds)}) ORDER BY id`, senderIds) : [[]];
  return {
    messages,
    welcomes: welcomes.map((row): ChatWelcome => ({ group_id: String(row.id), welcome: String(row.welcome), created_at: utcIso(row.created_at) })),
    senders: senders.map((row): ChatSender => ({ user_id: String(row.id), name: String(row.name), active: !!row.is_active })),
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
  await deleteMessageFiles(messageId);
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
  const own = 'SELECT read_seq, delivered_seq FROM chat_members WHERE conversation_id = ? AND user_id = ?';
  const [[before]] = await db.execute<RowDataPacket[]>(own, [conversationId, userId]);
  await ensureMemberRow(db, conversationId, userId);
  await db.execute('UPDATE chat_members SET read_seq = GREATEST(read_seq, ?), delivered_seq = GREATEST(delivered_seq, ?) WHERE conversation_id = ? AND user_id = ?',
    [Math.min(read, last), Math.min(delivered, last), conversationId, userId]);
  const [[marks]] = await db.execute<RowDataPacket[]>(own, [conversationId, userId]);
  const people = await conversationPeople(conversationId);
  // A delivery is everyone's news; the moment of reading only between people who both have read receipts on.
  const moved = Number(marks.delivered_seq) > Number(before?.delivered_seq ?? 0);
  const receipts = new Map(await Promise.all(people.map(async id => [id, (await chatSettings(id, db)).chat_read_receipts] as const)));
  publishChatChanged(moved ? people : receipts.get(userId) ? people.filter(id => id === userId || receipts.get(id)) : [userId], conversationId);
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

interface ChatNotificationSource { sender: string; chat: string | null; mentioned: boolean }

/**
 * A message as its notification sees it: still there, not an edit, not the
 * person's own, not read yet, one they are served, and wanted by the person's choice for the chat
 * (everything, mentions only, or nothing).
 */
async function notificationSource(userId: string, messageId: string, executor: SqlExecutor, payload: Record<string, unknown> = {}): Promise<ChatNotificationSource | null> {
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT m.conversation_id, COALESCE(NULLIF(u.full_name, ''), u.email) AS sender, c.name, COALESCE(me.notify, 'all') AS notify
    FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id LEFT JOIN users u ON u.id = m.sender_user_id
    LEFT JOIN chat_members me ON me.conversation_id = m.conversation_id AND me.user_id = ?
    WHERE m.id = ? AND m.kind = 'message' AND m.replaces IS NULL AND m.ciphertext IS NOT NULL AND NOT (m.sender_user_id <=> ?)
      AND m.seq > GREATEST(COALESCE(me.read_seq, 0), ${JOINED})`, [userId, messageId, userId]);
  const mentioned = payload.mentioned === true;
  if (!row || row.notify === 'none' || (row.notify === 'mentions' && !mentioned)) return null;
  if (!await can(userId, conversationOf(String(row.conversation_id)), 'member', executor)) return null;
  return { sender: row.sender ? String(row.sender) : 'Deleted person', chat: row.name === null ? null : String(row.name), mentioned };
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
  renameChat, addChatMembers, removeChatMember, leaveChat, unfollowChat, unfollowDeletedGroup, followedGroupChanged, chatMembers, setNotify, chatCandidates,
};
