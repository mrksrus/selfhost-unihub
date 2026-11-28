import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { ChatCall, ChatCallMember, ChatCallOutcome, ChatCallSignal } from '../contracts/chat';

import crypto from 'node:crypto';
import { db } from '../state';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../http/errors';
import { log } from '../log';
import { withTransaction } from './transactions';
import { can, conversationPeople } from './access';
import { notEnrolled, object, ownChatDevice, utcIso } from './chat-devices';
import { CALL_PEOPLE, otherOf, peerState, startConversation } from './chat';
import { policyForbids, resolvePolicy } from './settings';
import { publishChatChanged, realtime } from './realtime';
import { enqueueFromSource, processNotificationJobs } from './notifications';
import { iceServers } from './turn';
import { callMedia } from './call-media';

// Voice calls (contracts/chat.ts): between the two people of a direct chat,
// or the call of a group chat with its people in chat_call_members. The
// server rings, carries the signals between the ends as rows the others
// fetch after a hint, and writes the call's entry in the chat when it ends;
// the sound goes directly, or encrypted through the call's media sockets
// (call-media.ts), always so in a group. One call per person at a time:
// starting or joining one locks the people's rows, so two never both see a
// person free; a group call's row lock orders its joins and leaves. Nothing
// of a signal is logged, and signals go when the call ends.

const RING_SECONDS = 45;
const ALIVE_SECONDS = 90;
const MAX_SIGNAL = 16384;
const MAX_SIGNALS = 1000;
const MAX_DEVICE_SIGNALS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A missed call for the callee: a notification, and an entry that counts as unread.
const MISSED: readonly ChatCallOutcome[] = ['missed', 'cancelled', 'busy'];

const COLUMNS = `k.id, k.conversation_id, k.caller_user_id, k.callee_user_id, k.caller_chat_device_id, k.answered_chat_device_id, k.state, k.outcome,
  k.created_at, k.answered_at, k.ended_at, COALESCE(NULLIF(cu.full_name, ''), cu.email) AS caller_name, COALESCE(NULLIF(ce.full_name, ''), ce.email) AS callee_name,
  c.kind, c.name AS chat_name`;
const FROM = `chat_calls k JOIN chat_conversations c ON c.id = k.conversation_id
  LEFT JOIN users cu ON cu.id = k.caller_user_id LEFT JOIN users ce ON ce.id = k.callee_user_id`;
// The call's row locked, with its chat's kind (the chat's row stays unlocked).
const LOCKED = 'SELECT k.*, (SELECT kind FROM chat_conversations WHERE id = k.conversation_id) AS kind FROM chat_calls k';
// A member who is no longer in the call keeps no device or number.
const OUT = 'chat_device_id = NULL, sender = NULL, left_at = UTC_TIMESTAMP()';
const iso = (value: unknown) => value === null ? null : utcIso(value);
const callNotFound = () => notFound('CHAT_CALL_NOT_FOUND', 'Call not found');
const notAnEnd = () => forbidden('CHAT_CALL_DEVICE', 'This device is not in this call.');
const ended = () => conflict('CHAT_CALL_ENDED', 'The call has ended.');
const isEnd = (row: RowDataPacket, device: string) => row.caller_chat_device_id === device || row.answered_chat_device_id === device;
const chatOf = (row: RowDataPacket) => ({ kind: 'conversation' as const, id: String(row.conversation_id) });
const ownJoined = (member: RowDataPacket | undefined, device: string) => member?.state === 'joined' && member.chat_device_id === device;
const memberOf = async (cx: SqlExecutor, callId: string, userId: string) =>
  (await cx.execute<RowDataPacket[]>('SELECT * FROM chat_call_members WHERE call_id = ? AND user_id = ?', [callId, userId]))[0][0];

async function membersOf(callId: string): Promise<ChatCallMember[]> {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT cm.user_id, cm.state, cm.chat_device_id, cm.sender, cm.joined_at, COALESCE(NULLIF(u.full_name, ''), u.email) AS name
    FROM chat_call_members cm JOIN users u ON u.id = cm.user_id WHERE cm.call_id = ? ORDER BY cm.joined_at IS NULL, cm.joined_at, cm.user_id`, [callId]);
  return rows.map(row => ({ user_id: String(row.user_id), name: String(row.name), state: row.state, chat_device_id: row.chat_device_id ? String(row.chat_device_id) : null,
    sender: row.sender === null ? null : Number(row.sender), joined_at: iso(row.joined_at) }));
}

async function toCall(row: RowDataPacket, device: string | null): Promise<ChatCall> {
  const group = row.kind === 'group';
  const members = group ? await membersOf(String(row.id)) : [];
  return {
    id: String(row.id), conversation_id: String(row.conversation_id), kind: group ? 'group' : 'direct', name: group ? String(row.chat_name) : null,
    caller_user_id: row.caller_user_id ? String(row.caller_user_id) : null, callee_user_id: row.callee_user_id ? String(row.callee_user_id) : null,
    caller_name: row.caller_name ? String(row.caller_name) : 'Deleted person', callee_name: row.callee_name ? String(row.callee_name) : 'Deleted person', members,
    state: row.state, outcome: row.outcome ?? null,
    this_device: !!device && (group ? members.some(member => member.state === 'joined' && member.chat_device_id === device) : isEnd(row, device)),
    created_at: utcIso(row.created_at), answered_at: iso(row.answered_at), ended_at: iso(row.ended_at),
  };
}

/**
 * A call of the person: either of a direct call's two people, or someone its
 * group chat reaches now. Locked, the call's row alone, without the names.
 * 404 for anyone else.
 */
async function loadCall(userId: string, callId: string, executor: SqlExecutor = db, lock = false) {
  if (!UUID.test(callId)) throw callNotFound();
  const [[row]] = await executor.execute<RowDataPacket[]>(lock ? `${LOCKED} WHERE k.id = ? FOR UPDATE` : `SELECT ${COLUMNS} FROM ${FROM} WHERE k.id = ?`, [callId]);
  if (!row || !(row.kind === 'group' ? await can(userId, chatOf(row), 'member', executor) : row.caller_user_id === userId || row.callee_user_id === userId)) throw callNotFound();
  return row;
}

/** The calls going on of these people (and of a chat), locked: a direct call's two people, a group call's people rung or in it. */
async function liveCalls(cx: SqlExecutor, people: readonly string[], conversationId: string | null = null) {
  const list = people.map(() => '?').join(', ');
  const [rows] = await cx.execute<RowDataPacket[]>(`SELECT k.id, k.state, k.conversation_id, k.caller_user_id, k.callee_user_id, cm.user_id AS member,
      (SELECT kind FROM chat_conversations WHERE id = k.conversation_id) AS kind
    FROM chat_calls k LEFT JOIN chat_call_members cm ON cm.call_id = k.id AND cm.state IN ('ringing', 'joined')
    WHERE k.state <> 'ended' AND (k.caller_user_id IN (${list}) OR k.callee_user_id IN (${list}) OR cm.user_id IN (${list}) OR k.conversation_id <=> ?) FOR UPDATE`,
  [...people, ...people, ...people, conversationId]);
  return rows;
}
const busy = (live: RowDataPacket[], person: string, exceptCall: string | null = null) => live.some(call => String(call.id) !== exceptCall
  && (call.kind === 'group' ? call.member === person : call.caller_user_id === person || call.callee_user_id === person));

async function deviceOf(userId: string, token: string | null) {
  const own = await ownChatDevice(userId, token);
  if (!own) throw notEnrolled();
  return own;
}

// The pass that sends notifications runs now, not in 30 seconds; one already
// running may have chosen its deliveries before this one was queued, so a
// skipped pass is tried again.
// shortcut: retries for ten seconds at most; a longer pass leaves the ring to the next one.
function deliverNow(tries = 40) {
  void processNotificationJobs().then(result => {
    if ('skipped' in result && tries > 1) setTimeout(() => deliverNow(tries - 1), 250).unref();
  }).catch(error => log.error('CALLS', 'Notification pass deferred', error));
}

/**
 * After a change: the people's pages refetch the call (a group call's: everyone
 * of the chat, whose chat shows the call), and their chat if it gained its entry.
 */
async function announce(row: RowDataPacket, entry = false) {
  const group = row.kind === 'group';
  const people = group ? await conversationPeople(String(row.conversation_id)) : [row.caller_user_id, row.callee_user_id].filter(Boolean);
  realtime.publishToUsers(people, 'chat.call', { call_id: String(row.id) }, { module: 'chat' });
  // Every caller announces an entry once the call ended.
  if (entry || group) publishChatChanged(people, String(row.conversation_id));
  if (entry) callMedia.closeCall(String(row.id));
  deliverNow();
}

/** Tells a rung person's ringing phones to stop, except the device that answered. */
async function stopRinging(cx: SqlExecutor, userId: string | null, callId: string, exceptChatDevice: string | null) {
  if (!userId) return;
  const [phones] = await cx.execute<RowDataPacket[]>(`SELECT p.endpoint_hash FROM push_subscriptions p WHERE p.user_id = ? AND p.transport = 'android'
    AND NOT (p.device_id <=> (SELECT device_id FROM chat_devices WHERE id = ?))`, [userId, exceptChatDevice]);
  for (const phone of phones) {
    await enqueueFromSource({ kind: 'call', userId: String(userId), sourceId: callId, dedupeKey: `call:${callId}:end:${phone.endpoint_hash}`,
      url: `/call?id=${callId}`, data: { call: { id: callId, event: 'end' } }, endpointHash: String(phone.endpoint_hash) }, cx);
  }
}

const missedNotice = (cx: SqlExecutor, row: RowDataPacket, userId: unknown) => enqueueFromSource({ kind: 'call_missed', userId: String(userId), sourceId: String(row.id),
  dedupeKey: `call_missed:${row.id}`, url: `/chat?c=${encodeURIComponent(String(row.conversation_id))}`, data: { conversationId: String(row.conversation_id) } }, cx);

/** A group call's people still rung stop ringing: they missed it (with its notification), or left it when it failed. */
async function missRinging(cx: SqlExecutor, row: RowDataPacket, missed: boolean) {
  const [rung] = await cx.execute<RowDataPacket[]>("SELECT user_id FROM chat_call_members WHERE call_id = ? AND state = 'ringing'", [row.id]);
  await cx.execute("UPDATE chat_call_members SET state = ?, left_at = UTC_TIMESTAMP() WHERE call_id = ? AND state = 'ringing'", [missed ? 'missed' : 'left', row.id]);
  for (const { user_id: userId } of rung) {
    await stopRinging(cx, userId, String(row.id), null);
    if (missed) await missedNotice(cx, row, userId);
  }
}

/** Ends a group call nobody is in, or one nobody joined that nobody is rung for any more; whether it ended. */
async function settle(cx: SqlExecutor, row: RowDataPacket, failed = false) {
  const [[count]] = await cx.execute<RowDataPacket[]>("SELECT COUNT(state = 'joined' OR NULL) AS joined, COUNT(state = 'ringing' OR NULL) AS ringing FROM chat_call_members WHERE call_id = ?", [row.id]);
  const outcome: ChatCallOutcome | null = !Number(count.joined) ? failed ? 'failed' : row.answered_at ? 'answered' : 'cancelled'
    : row.state === 'ringing' && !Number(count.ringing) ? 'declined' : null;
  if (outcome) await finish(cx, row, outcome);
  return !!outcome;
}

/**
 * Ends a call in its transaction: its outcome, its signals deleted, its
 * entry written after the chat's last one, a stop for phones still ringing
 * and, for a missed call, the callee's notification.
 */
async function finish(cx: SqlExecutor, row: RowDataPacket, outcome: ChatCallOutcome) {
  const [[conversation]] = await cx.execute<RowDataPacket[]>('SELECT last_seq FROM chat_conversations WHERE id = ? FOR UPDATE', [row.conversation_id]);
  const seq = Number(conversation.last_seq) + 1;
  const messageId = crypto.randomUUID();
  await cx.execute('UPDATE chat_conversations SET last_seq = ? WHERE id = ?', [seq, row.conversation_id]);
  await cx.execute(`INSERT INTO chat_messages (id, conversation_id, seq, group_id, sender_user_id, sender_chat_device_id, kind, replaces, ciphertext)
    VALUES (?, ?, ?, NULL, ?, ?, 'call', NULL, NULL)`, [messageId, row.conversation_id, seq, row.caller_user_id, row.caller_chat_device_id]);
  await cx.execute("UPDATE chat_calls SET state = 'ended', outcome = ?, ended_at = UTC_TIMESTAMP(), message_id = ? WHERE id = ?", [outcome, messageId, row.id]);
  await cx.execute('DELETE FROM chat_call_signals WHERE call_id = ?', [row.id]);
  if (row.kind === 'group') {
    await missRinging(cx, row, outcome !== 'failed');
    await cx.execute(`UPDATE chat_call_members SET state = 'left', ${OUT} WHERE call_id = ? AND state = 'joined'`, [row.id]);
    return;
  }
  // A busy call never rang anywhere.
  if (row.state === 'ringing' && outcome !== 'busy') await stopRinging(cx, row.callee_user_id, String(row.id), null);
  if (MISSED.includes(outcome) && row.callee_user_id) await missedNotice(cx, row, row.callee_user_id);
}

/** The person as a callee: refused without a joined device or Chat, and where either person's calls policy forbids it. */
async function callable(userId: string, peerId: string | null) {
  const peer = await peerState(peerId);
  if (peer.reason) throw forbidden('CHAT_UNAVAILABLE', peer.reason);
  const mine = await resolvePolicy(userId, 'chat.calls');
  if (!mine.allowed) throw policyForbids('chat.calls', mine.reason ?? 'Your administrator turned calls off.');
  if (!(await resolvePolicy(peer.user_id!, 'chat.calls')).allowed) throw policyForbids('chat.calls', `Calls are off for ${peer.name}.`);
  return peer;
}

// --- The routes ----------------------------------------------------------------------------

/** A group chat's call: started with the request's device in it, ringing by the chat's size; or the call already going on there. */
async function startGroupCall(userId: string, own: string, conversationId: string) {
  const mine = await resolvePolicy(userId, 'chat.calls');
  if (!mine.allowed) throw policyForbids('chat.calls', mine.reason ?? 'Your administrator turned calls off.');
  const people = await conversationPeople(conversationId);
  const others = people.filter(person => person !== userId);
  const callable: string[] = [];
  if (people.length <= CALL_PEOPLE) {
    for (const person of others) if (!(await peerState(person)).reason && (await resolvePolicy(person, 'chat.calls')).allowed) callable.push(person);
  }
  return withTransaction(async cx => {
    await cx.execute(`SELECT id FROM users WHERE id IN (${[userId, ...callable].map(() => '?').join(', ')}) ORDER BY id FOR UPDATE`, [userId, ...callable]);
    // Two starts in one chat: the second finds the first's call.
    await cx.execute('SELECT id FROM chat_conversations WHERE id = ? FOR UPDATE', [conversationId]);
    const live = await liveCalls(cx, [userId, ...callable], conversationId);
    const going = live.find(call => call.conversation_id === conversationId);
    if (going) return { id: String(going.id), started: false };
    if (busy(live, userId)) throw conflict('CHAT_CALL_IN_PROGRESS', 'You are on a call.');
    const rung = callable.filter(person => !busy(live, person));
    const callId = crypto.randomUUID();
    await cx.execute(`INSERT INTO chat_calls (id, conversation_id, caller_user_id, callee_user_id, caller_chat_device_id, state, created_at, alive_at)
      VALUES (?, ?, ?, NULL, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [callId, conversationId, userId, own, rung.length ? 'ringing' : 'active']);
    await cx.execute(`INSERT INTO chat_call_members (call_id, user_id, chat_device_id, state, sender, joined_at, alive_at)
      VALUES (?, ?, ?, 'joined', 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [callId, userId, own]);
    for (const person of others) {
      if (rung.includes(person)) {
        await cx.execute("INSERT INTO chat_call_members (call_id, user_id, state) VALUES (?, ?, 'ringing')", [callId, person]);
        await enqueueFromSource({ kind: 'call', userId: person, sourceId: callId, dedupeKey: `call:${callId}:ring`, url: `/call?id=${callId}`,
          data: { call: { id: callId, event: 'ring' } } }, cx);
      } else {
        await enqueueFromSource({ kind: 'call_started', userId: person, sourceId: callId, dedupeKey: `call_started:${callId}`,
          url: `/chat?c=${encodeURIComponent(conversationId)}`, data: { conversationId } }, cx);
      }
    }
    return { id: callId, started: true };
  });
}

/** POST /api/chat/calls: the request's device calls the other person of a direct chat, or starts or finds a group chat's call. */
async function startCall(userId: string, token: string | null, input: unknown) {
  const body = object(input);
  if ((body.user_id === undefined) === (body.conversation_id === undefined)) throw badRequest('CHAT_CALL_INVALID', 'Name the person or the chat to call.');
  const own = await deviceOf(userId, token);
  let conversationId: string;
  let peer: Awaited<ReturnType<typeof callable>> | null = null;
  if (body.user_id !== undefined) {
    // Before the chat is made: a refused call leaves no empty chat behind.
    if (typeof body.user_id === 'string' && UUID.test(body.user_id)) peer = await callable(userId, body.user_id.toLowerCase());
    conversationId = (await startConversation(userId, { user_id: body.user_id })).conversation.id;
  } else {
    conversationId = typeof body.conversation_id === 'string' && UUID.test(body.conversation_id) ? body.conversation_id.toLowerCase() : '';
    if (!conversationId || !await can(userId, { kind: 'conversation', id: conversationId }, 'member')) throw notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
  }
  const [[conversation]] = await db.execute<RowDataPacket[]>('SELECT kind, direct_key FROM chat_conversations WHERE id = ?', [conversationId]);
  const group = conversation.kind === 'group';
  if (!group) peer ??= await callable(userId, otherOf(conversation.direct_key, userId));
  const peerId = peer?.user_id ?? '';

  const { id, started } = group ? await startGroupCall(userId, own, conversationId) : await withTransaction(async cx => {
    await cx.execute('SELECT id FROM users WHERE id IN (?, ?) ORDER BY id FOR UPDATE', [userId, peerId]);
    const live = await liveCalls(cx, [userId, peerId]);
    // Both called each other at once: the second start answers with the first's call, to be answered.
    const incoming = live.find(call => call.kind === 'direct' && call.caller_user_id === peerId && call.callee_user_id === userId && call.state === 'ringing');
    if (incoming) return { id: String(incoming.id), started: false };
    if (busy(live, userId)) throw conflict('CHAT_CALL_IN_PROGRESS', 'You are on a call.');
    const callId = crypto.randomUUID();
    await cx.execute(`INSERT INTO chat_calls (id, conversation_id, caller_user_id, callee_user_id, caller_chat_device_id, state, created_at, alive_at)
      VALUES (?, ?, ?, ?, ?, 'ringing', UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [callId, conversationId, userId, peerId, own]);
    if (busy(live, peerId)) {
      await finish(cx, await loadCall(userId, callId, cx), 'busy');
      return { id: callId, started: false };
    }
    await enqueueFromSource({ kind: 'call', userId: peerId, sourceId: callId, dedupeKey: `call:${callId}:ring`, url: `/call?id=${callId}`,
      data: { call: { id: callId, event: 'ring' } } }, cx);
    return { id: callId, started: true };
  });
  const row = await loadCall(userId, id);
  await announce(row, row.state === 'ended');
  if (row.outcome === 'busy') throw conflict('CHAT_CALL_BUSY', `${peer?.name} is on another call.`);
  return { call: await toCall(row, own), started, ice_servers: iceServers(id) };
}

/** GET /api/chat/calls/current: the person's ringing or active call. */
async function currentCall(userId: string, token: string | null) {
  const own = await deviceOf(userId, token);
  const [[row]] = await db.execute<RowDataPacket[]>(`SELECT ${COLUMNS} FROM ${FROM} WHERE k.state <> 'ended' AND ((c.kind = 'direct' AND (k.caller_user_id = ? OR k.callee_user_id = ?))
      OR EXISTS (SELECT 1 FROM chat_call_members cm WHERE cm.call_id = k.id AND cm.user_id = ? AND cm.state IN ('ringing', 'joined')))
    ORDER BY k.created_at DESC, k.id LIMIT 1`, [userId, userId, userId]);
  const reached = row && (row.kind !== 'group' || await can(userId, chatOf(row), 'member'));
  return { call: reached ? await toCall(row, own) : null };
}

/** A group call's join: a rung person answering, or anyone the chat reaches joining while it lasts; null when this device is in it already. */
async function joinCall(cx: SqlExecutor, userId: string, own: string, call: RowDataPacket) {
  if (call.state === 'ended') throw ended();
  const mine = await memberOf(cx, call.id, userId);
  if (mine?.state === 'joined') {
    if (mine.chat_device_id === own) return null;
    throw conflict('CHAT_CALL_ANSWERED', 'You are in this call on another device.');
  }
  const policy = await resolvePolicy(userId, 'chat.calls', cx);
  if (!policy.allowed) throw policyForbids('chat.calls', policy.reason ?? 'Your administrator turned calls off.');
  await cx.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (busy(await liveCalls(cx, [userId]), userId, String(call.id))) throw conflict('CHAT_CALL_IN_PROGRESS', 'You are on a call.');
  const [inCall] = await cx.execute<RowDataPacket[]>("SELECT sender FROM chat_call_members WHERE call_id = ? AND state = 'joined'", [call.id]);
  if (inCall.length >= CALL_PEOPLE) throw conflict('CHAT_CALL_FULL', 'The call is full.');
  const taken = new Set(inCall.map(member => Number(member.sender)));
  const sender = [...Array(CALL_PEOPLE).keys()].find(number => !taken.has(number));
  await cx.execute(`INSERT INTO chat_call_members (call_id, user_id, chat_device_id, state, sender, joined_at, alive_at) VALUES (?, ?, ?, 'joined', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE chat_device_id = VALUES(chat_device_id), state = 'joined', sender = VALUES(sender), joined_at = VALUES(joined_at), left_at = NULL, alive_at = VALUES(alive_at)`,
  [call.id, userId, own, sender]);
  if (mine?.state === 'ringing') await stopRinging(cx, userId, String(call.id), own);
  // Only a second person ever joins: the starter is in it from the start, and the call ends when its last person leaves.
  await cx.execute("UPDATE chat_calls SET state = 'active', answered_at = COALESCE(answered_at, UTC_TIMESTAMP()) WHERE id = ?", [call.id]);
  return call;
}

/** A group call's member declines its ring or leaves it; false when nothing changed (a rung device that could not take it). */
async function leaveCall(cx: SqlExecutor, userId: string, own: string, call: RowDataPacket, failed: boolean) {
  const mine = await memberOf(cx, call.id, userId);
  if (mine?.state === 'ringing') {
    if (failed) return false;
    await cx.execute("UPDATE chat_call_members SET state = 'declined' WHERE call_id = ? AND user_id = ?", [call.id, userId]);
    await stopRinging(cx, userId, String(call.id), null);
  } else if (ownJoined(mine, own)) {
    await cx.execute(`UPDATE chat_call_members SET state = 'left', ${OUT} WHERE call_id = ? AND user_id = ?`, [call.id, userId]);
  } else throw notAnEnd();
  await settle(cx, call, failed);
  return true;
}

/** Someone a group chat no longer reaches is taken out of its call before they are refused as a stranger. */
async function orTakeOut<T>(userId: string, callId: string, read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'CHAT_CALL_NOT_FOUND' && UUID.test(callId)) await takeOut(userId, callId);
    throw error;
  }
}

async function takeOut(userId: string, callId: string) {
  const row = await withTransaction(async cx => {
    const [[call]] = await cx.execute<RowDataPacket[]>(`${LOCKED} WHERE k.id = ? AND k.state <> 'ended' FOR UPDATE`, [callId]);
    const mine = call?.kind === 'group' ? await memberOf(cx, callId, userId) : undefined;
    if (!mine || !['ringing', 'joined'].includes(mine.state) || await can(userId, chatOf(call), 'member', cx)) return null;
    await cx.execute(`UPDATE chat_call_members SET state = 'left', ${OUT} WHERE call_id = ? AND user_id = ?`, [callId, userId]);
    if (mine.state === 'ringing') await stopRinging(cx, userId, callId, null);
    return { call, ended: await settle(cx, call) };
  });
  if (row) await announce(row.call, row.ended);
}

/** POST /api/chat/calls/:id/answer: the first of the callee's devices to answer takes the call. */
async function answerCall(userId: string, token: string | null, callId: string) {
  const own = await deviceOf(userId, token);
  const row = await withTransaction(async cx => {
    const call = await loadCall(userId, callId, cx, true);
    if (call.kind === 'group') return joinCall(cx, userId, own, call);
    if (call.caller_user_id === userId) throw notAnEnd();
    if (call.answered_chat_device_id === own) return null;
    if (call.state === 'ended') throw ended();
    if (call.state === 'active') throw conflict('CHAT_CALL_ANSWERED', 'The call was answered on another device.');
    await cx.execute("UPDATE chat_calls SET state = 'active', answered_chat_device_id = ?, answered_at = UTC_TIMESTAMP(), alive_at = UTC_TIMESTAMP() WHERE id = ?", [own, callId]);
    await stopRinging(cx, call.callee_user_id, callId, own);
    return call;
  });
  if (row) await announce(row);
  return { call: await toCall(await loadCall(userId, callId), own), ice_servers: iceServers(callId) };
}

/** POST /api/chat/calls/:id/end: declined, cancelled, hung up or failed. */
async function endCall(userId: string, token: string | null, callId: string, input: unknown) {
  const failed = object(input).failed === true;
  const own = await deviceOf(userId, token);
  const row = await orTakeOut(userId, callId, () => withTransaction(async cx => {
    const call = await loadCall(userId, callId, cx, true);
    if (call.state === 'ended') return null;
    if (call.kind === 'group') return await leaveCall(cx, userId, own, call, failed) ? call : null;
    const caller = call.caller_user_id === userId;
    // While it rings any of the callee's devices declines; otherwise only an end of the call.
    if (!(call.state === 'ringing' && !caller) && !isEnd(call, own)) throw notAnEnd();
    await finish(cx, call, failed ? 'failed' : call.state === 'active' ? 'answered' : caller ? 'cancelled' : 'declined');
    return call;
  }));
  const now = await loadCall(userId, callId);
  if (row) {
    await announce(now, now.state === 'ended');
    // A member who left: their socket closes now, not at its next check.
    if (row.kind === 'group') callMedia.closeEnd(callId, own);
  }
  return { call: await toCall(now, own) };
}

/** POST /api/chat/calls/:id/signals: one end's signal to the other. */
async function postSignal(userId: string, token: string | null, callId: string, input: unknown) {
  const payload = object(input).payload;
  if (typeof payload !== 'string' || !payload.length || payload.length > MAX_SIGNAL) throw badRequest('CHAT_CALL_SIGNAL_INVALID', 'Invalid call signal');
  const own = await deviceOf(userId, token);
  const { id, row } = await withTransaction(async cx => {
    // The call's lock: a signal never lands after the end deleted the others.
    const call = await loadCall(userId, callId, cx, true);
    if (call.state === 'ended') throw ended();
    const group = call.kind === 'group';
    if (group ? !ownJoined(await memberOf(cx, callId, userId), own) : !isEnd(call, own)) throw notAnEnd();
    const [[sent]] = await cx.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM chat_call_signals WHERE call_id = ?${group ? ' AND from_chat_device_id = ?' : ''}`,
      group ? [callId, own] : [callId]);
    if (Number(sent.n) >= (group ? MAX_DEVICE_SIGNALS : MAX_SIGNALS)) throw conflict('CHAT_CALL_SIGNALS_LIMIT', 'This call has sent too many signals. Call again.');
    const [insert] = await cx.execute<ResultSetHeader>(`INSERT INTO chat_call_signals (call_id, from_chat_device_id, payload, created_at)
      VALUES (?, ?, ?, UTC_TIMESTAMP())`, [callId, own, payload]);
    return { id: insert.insertId, row: call };
  });
  if (row.kind === 'group') {
    const [inCall] = await db.execute<RowDataPacket[]>("SELECT user_id FROM chat_call_members WHERE call_id = ? AND state = 'joined' AND user_id <> ?", [callId, userId]);
    realtime.publishToUsers(inCall.map(member => member.user_id), 'chat.call', { call_id: callId }, { module: 'chat' });
    return { id: Number(id) };
  }
  const other = row.caller_user_id === userId ? row.callee_user_id : row.caller_user_id;
  if (other) realtime.publishToUser(other, 'chat.call', { call_id: callId }, { module: 'chat' });
  return { id: Number(id) };
}

/** GET /api/chat/calls/:id/signals?after=<id>: the other end's signals after a cursor. */
async function fetchSignals(userId: string, token: string | null, callId: string, after: string | null) {
  const cursor = after === null || after === '' ? 0 : Number(after);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw badRequest('CHAT_QUERY_INVALID', 'Invalid chat query');
  const own = await deviceOf(userId, token);
  const row = await loadCall(userId, callId);
  if (row.kind === 'group' ? !ownJoined(await memberOf(db, callId, userId), own) : !isEnd(row, own)) throw notAnEnd();
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT id, from_chat_device_id, payload, created_at FROM chat_call_signals WHERE call_id = ? AND id > ? AND NOT (from_chat_device_id <=> ?)
    ORDER BY id LIMIT 100`, [callId, cursor, own]);
  const signals = rows.map((item): ChatCallSignal => ({ id: Number(item.id), from: item.from_chat_device_id ? String(item.from_chat_device_id) : null,
    payload: String(item.payload), created_at: utcIso(item.created_at) }));
  return { signals, after: signals.at(-1)?.id ?? cursor };
}

/** POST /api/chat/calls/:id/alive: an end's sign of life. */
async function callAlive(userId: string, token: string | null, callId: string) {
  const own = await deviceOf(userId, token);
  const row = await orTakeOut(userId, callId, () => loadCall(userId, callId));
  if (row.kind !== 'group') {
    if (!isEnd(row, own)) throw notAnEnd();
    await db.execute("UPDATE chat_calls SET alive_at = UTC_TIMESTAMP() WHERE id = ? AND state <> 'ended'", [callId]);
  } else if (row.state !== 'ended') {
    if (!ownJoined(await memberOf(db, callId, userId), own)) throw notAnEnd();
    await db.execute("UPDATE chat_call_members SET alive_at = UTC_TIMESTAMP() WHERE call_id = ? AND user_id = ? AND state = 'joined'", [callId, userId]);
  }
  return { call: await toCall(await loadCall(userId, callId), own) };
}

/** GET /api/chat/calls/:id/ice: fresh connection servers for an end of a call going on. */
async function callIceServers(userId: string, token: string | null, callId: string) {
  const own = await deviceOf(userId, token);
  const row = await loadCall(userId, callId);
  if (row.state === 'ended') throw ended();
  if (!isEnd(row, own)) throw notAnEnd();
  return { ice_servers: iceServers(callId) };
}

/**
 * GET /api/chat/calls/:id/media: the request's chat device when it is an end
 * of the active call, or a joined member's device of a group call with the
 * sender number its frames must carry (null in a direct call); refused otherwise.
 */
async function mediaEnd(userId: string, token: string | null, callId: string) {
  const own = await deviceOf(userId, token);
  const row = await orTakeOut(userId, callId, () => loadCall(userId, callId));
  if (row.state === 'ended') throw ended();
  if (row.kind === 'group') {
    const mine = await memberOf(db, callId, userId);
    if (!ownJoined(mine, own)) throw notAnEnd();
    return { device: own, sender: Number(mine.sender) };
  }
  if (!isEnd(row, own)) throw notAnEnd();
  if (row.state !== 'active') throw conflict('CHAT_CALL_NOT_ACTIVE', 'The call has not been answered.');
  return { device: own, sender: null };
}

// --- Sweeps, entries and notifications -------------------------------------------------------

/** A group call the sweep found: silent members leave, people rung past the ring time missed it, and a call nobody answered in time ends. */
async function sweepGroup(cx: SqlExecutor, call: RowDataPacket, startup: boolean) {
  await cx.execute(`UPDATE chat_call_members SET state = 'left', ${OUT} WHERE call_id = ? AND state = 'joined'
    AND alive_at < UTC_TIMESTAMP() - INTERVAL ${ALIVE_SECONDS} SECOND`, [call.id]);
  if (call.ring_over && call.state === 'ringing') {
    await finish(cx, call, startup ? 'failed' : 'missed');
    return true;
  }
  if (call.ring_over) await missRinging(cx, call, !startup);
  return settle(cx, call, true);
}

/**
 * Ends what nobody ends: a call ringing past the ring time is missed, an
 * active call without a sign of life for 90 seconds failed; in a group call
 * per person. At start-up (after a restart or an instance restore) both end
 * as failed, with no missed-call notification for a call of the past.
 */
async function sweepCalls(startup = false) {
  const ring = `k.created_at < UTC_TIMESTAMP() - INTERVAL ${RING_SECONDS} SECOND`;
  const silent = `UTC_TIMESTAMP() - INTERVAL ${ALIVE_SECONDS} SECOND`;
  const overdue = `k.state <> 'ended' AND IF((SELECT kind FROM chat_conversations WHERE id = k.conversation_id) = 'group',
      (k.state = 'ringing' AND ${ring}) OR EXISTS (SELECT 1 FROM chat_call_members cm WHERE cm.call_id = k.id
        AND ((cm.state = 'ringing' AND ${ring}) OR (cm.state = 'joined' AND cm.alive_at < ${silent}))),
      (k.state = 'ringing' AND ${ring}) OR (k.state = 'active' AND k.alive_at < ${silent}))`;
  const [due] = await db.execute<RowDataPacket[]>(`SELECT k.id FROM chat_calls k WHERE ${overdue}`);
  let swept = 0;
  for (const { id } of due) {
    const row = await withTransaction(async cx => {
      // Still overdue under the lock: an answer or a sign of life may have arrived since the list was read.
      const [[call]] = await cx.execute<RowDataPacket[]>(`SELECT k.*, (SELECT kind FROM chat_conversations WHERE id = k.conversation_id) AS kind, ${ring} AS ring_over
        FROM chat_calls k WHERE k.id = ? AND ${overdue} FOR UPDATE`, [id]);
      if (!call) return null;
      if (call.kind === 'group') return { call, ended: await sweepGroup(cx, call, startup) };
      await finish(cx, call, startup || call.state === 'active' ? 'failed' : 'missed');
      return { call, ended: true };
    });
    if (row) { await announce(row.call, row.ended); swept++; }
  }
  return swept;
}

/** The caller (a group call's starter), the group chat's name (null for a direct call) and when the ring ends. */
interface CallNotice { caller: string; chat: string | null; ringsUntil: number }

/**
 * A call as its notification sees it: for 'ring' still ringing, for 'end'
 * no longer ringing, for a missed call its entry not read yet (a group
 * call's missed while it goes on has none yet); the callee's or a group
 * call's rung person's only. call_started: the group call goes on, the person
 * is not in it, the chat reaches them, notifies them and calls are allowed
 * for them. The caller's name as the directory has it now.
 */
async function callNotice(userId: string, callId: string, executor: SqlExecutor, payload: Record<string, unknown>, kind: 'call' | 'call_missed' | 'call_started' = 'call'): Promise<CallNotice | null> {
  const event = object(payload.call).event;
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT k.state, k.outcome, k.created_at, k.conversation_id, COALESCE(NULLIF(u.full_name, ''), u.email) AS caller,
      c.kind, c.name, cm.state AS member, m.seq, COALESCE(me.read_seq, 0) AS read_seq, COALESCE(me.notify, 'all') AS notify
    FROM chat_calls k JOIN chat_conversations c ON c.id = k.conversation_id LEFT JOIN users u ON u.id = k.caller_user_id LEFT JOIN chat_messages m ON m.id = k.message_id
    LEFT JOIN chat_call_members cm ON cm.call_id = k.id AND cm.user_id = ?
    LEFT JOIN chat_members me ON me.conversation_id = k.conversation_id AND me.user_id = ?
    WHERE k.id = ? AND (k.callee_user_id = ? OR c.kind = 'group')`, [userId, userId, callId, userId]);
  if (!row) return null;
  const group = row.kind === 'group';
  const unread = row.seq === null ? group : Number(row.seq) > Number(row.read_seq);
  const current = kind === 'call_started'
    ? group && row.state !== 'ended' && row.member !== 'joined' && row.notify !== 'none' && await can(userId, chatOf(row), 'member', executor)
      && (await resolvePolicy(userId, 'chat.calls', executor)).allowed
    : kind === 'call_missed' ? (group ? row.member === 'missed' : MISSED.includes(row.outcome)) && unread
      : (!group || row.member !== null) && (event === 'ring') === (group ? row.member === 'ringing' : row.state === 'ringing');
  return current ? { caller: row.caller ? String(row.caller) : 'Deleted person', chat: group ? String(row.name) : null,
    ringsUntil: new Date(utcIso(row.created_at)).getTime() + RING_SECONDS * 1000 } : null;
}

export type { CallNotice };
export { startCall, currentCall, answerCall, endCall, postSignal, fetchSignals, callAlive, callIceServers, mediaEnd, sweepCalls, callNotice };
