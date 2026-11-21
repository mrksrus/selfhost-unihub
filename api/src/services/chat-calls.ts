import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { ChatCall, ChatCallOutcome, ChatCallSignal } from '../contracts/chat';

import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { log } from '../log';
import { withTransaction } from './transactions';
import { can } from './access';
import { notEnrolled, object, ownChatDevice, utcIso } from './chat-devices';
import { otherOf, peerState, startConversation } from './chat';
import { policyForbids, resolvePolicy } from './settings';
import { publishChatChanged, realtime } from './realtime';
import { enqueueFromSource, processNotificationJobs } from './notifications';
import { iceServers } from './turn';

// Voice calls between the two people of a direct chat (contracts/chat.ts).
// The server rings, carries the signals between the two ends as rows the
// other end fetches after a hint, and writes the call's entry in the chat
// when it ends; the sound never passes through it. One call per person at a
// time: starting one locks both people's rows, so two starts never both see
// a person free. Nothing of a signal is logged, and signals go when the call ends.

const RING_SECONDS = 45;
const ALIVE_SECONDS = 90;
const MAX_SIGNAL = 16384;
const MAX_SIGNALS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A missed call for the callee: a notification, and an entry that counts as unread.
const MISSED: readonly ChatCallOutcome[] = ['missed', 'cancelled', 'busy'];

const COLUMNS = `k.id, k.conversation_id, k.caller_user_id, k.callee_user_id, k.caller_chat_device_id, k.answered_chat_device_id, k.state, k.outcome,
  k.created_at, k.answered_at, k.ended_at, COALESCE(NULLIF(cu.full_name, ''), cu.email) AS caller_name, COALESCE(NULLIF(ce.full_name, ''), ce.email) AS callee_name`;
const FROM = 'chat_calls k LEFT JOIN users cu ON cu.id = k.caller_user_id LEFT JOIN users ce ON ce.id = k.callee_user_id';
const iso = (value: unknown) => value === null ? null : utcIso(value);
const callNotFound = () => notFound('CHAT_CALL_NOT_FOUND', 'Call not found');
const notAnEnd = () => forbidden('CHAT_CALL_DEVICE', 'This device is not in this call.');
const ended = () => conflict('CHAT_CALL_ENDED', 'The call has ended.');
const isEnd = (row: RowDataPacket, device: string) => row.caller_chat_device_id === device || row.answered_chat_device_id === device;

function toCall(row: RowDataPacket, device: string | null): ChatCall {
  return {
    id: String(row.id), conversation_id: String(row.conversation_id),
    caller_user_id: row.caller_user_id ? String(row.caller_user_id) : null, callee_user_id: row.callee_user_id ? String(row.callee_user_id) : null,
    caller_name: row.caller_name ? String(row.caller_name) : 'Deleted person', callee_name: row.callee_name ? String(row.callee_name) : 'Deleted person',
    state: row.state, outcome: row.outcome ?? null, this_device: !!device && isEnd(row, device),
    created_at: utcIso(row.created_at), answered_at: iso(row.answered_at), ended_at: iso(row.ended_at),
  };
}

/** A call of the person (either of its two people); locked, the call's row alone, without the names. 404 for anyone else. */
async function loadCall(userId: string, callId: string, executor: SqlExecutor = db, lock = false) {
  if (!UUID.test(callId)) throw callNotFound();
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT ${lock ? 'k.*' : COLUMNS} FROM ${lock ? 'chat_calls k' : FROM}
    WHERE k.id = ? AND (k.caller_user_id = ? OR k.callee_user_id = ?)${lock ? ' FOR UPDATE' : ''}`, [callId, userId, userId]);
  if (!row) throw callNotFound();
  return row;
}

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

/** After a change: both people's pages refetch the call, and their chat if it gained its entry. */
function announce(row: RowDataPacket, entry = false) {
  const people = [row.caller_user_id, row.callee_user_id].filter(Boolean);
  realtime.publishToUsers(people, 'chat.call', { call_id: String(row.id) }, { module: 'chat' });
  if (entry) publishChatChanged(people, String(row.conversation_id));
  deliverNow();
}

/** Tells the callee's ringing phones to stop, except the device that answered. */
async function stopRinging(cx: SqlExecutor, row: RowDataPacket, exceptChatDevice: string | null) {
  if (!row.callee_user_id) return;
  const [phones] = await cx.execute<RowDataPacket[]>(`SELECT p.endpoint_hash FROM push_subscriptions p WHERE p.user_id = ? AND p.transport = 'android'
    AND NOT (p.device_id <=> (SELECT device_id FROM chat_devices WHERE id = ?))`, [row.callee_user_id, exceptChatDevice]);
  for (const phone of phones) {
    await enqueueFromSource({ kind: 'call', userId: String(row.callee_user_id), sourceId: String(row.id), dedupeKey: `call:${row.id}:end:${phone.endpoint_hash}`,
      url: `/call?id=${row.id}`, data: { call: { id: String(row.id), event: 'end' } }, endpointHash: String(phone.endpoint_hash) }, cx);
  }
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
  if (row.state === 'ringing') await stopRinging(cx, row, null);
  if (MISSED.includes(outcome) && row.callee_user_id) {
    await enqueueFromSource({ kind: 'call_missed', userId: String(row.callee_user_id), sourceId: String(row.id), dedupeKey: `call_missed:${row.id}`,
      url: `/chat?c=${encodeURIComponent(String(row.conversation_id))}`, data: { conversationId: String(row.conversation_id) } }, cx);
  }
}

// --- The routes ----------------------------------------------------------------------------

/** POST /api/chat/calls: the request's device calls the other person of a direct chat. */
async function startCall(userId: string, token: string | null, input: unknown) {
  const body = object(input);
  if ((body.user_id === undefined) === (body.conversation_id === undefined)) throw badRequest('CHAT_CALL_INVALID', 'Name the person or the chat to call.');
  const own = await deviceOf(userId, token);
  let conversationId: string;
  if (body.user_id !== undefined) conversationId = (await startConversation(userId, { user_id: body.user_id })).conversation.id;
  else {
    conversationId = typeof body.conversation_id === 'string' && UUID.test(body.conversation_id) ? body.conversation_id.toLowerCase() : '';
    if (!conversationId || !await can(userId, { kind: 'conversation', id: conversationId }, 'member')) throw notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
  }
  const [[conversation]] = await db.execute<RowDataPacket[]>('SELECT kind, direct_key FROM chat_conversations WHERE id = ?', [conversationId]);
  if (conversation.kind !== 'direct') throw badRequest('CHAT_NOT_DIRECT', 'Calls are between two people.');
  const peer = await peerState(otherOf(conversation.direct_key, userId));
  if (peer.reason) throw forbidden('CHAT_UNAVAILABLE', peer.reason);
  const peerId = peer.user_id!;
  const mine = await resolvePolicy(userId, 'chat.calls');
  if (!mine.allowed) throw policyForbids('chat.calls', mine.reason ?? 'Your administrator turned calls off.');
  if (!(await resolvePolicy(peerId, 'chat.calls')).allowed) throw policyForbids('chat.calls', `Calls are off for ${peer.name}.`);

  const { id, started } = await withTransaction(async cx => {
    await cx.execute('SELECT id FROM users WHERE id IN (?, ?) ORDER BY id FOR UPDATE', [userId, peerId]);
    const [live] = await cx.execute<RowDataPacket[]>(`SELECT id, caller_user_id, callee_user_id, state FROM chat_calls
      WHERE state <> 'ended' AND (caller_user_id IN (?, ?) OR callee_user_id IN (?, ?)) FOR UPDATE`, [userId, peerId, userId, peerId]);
    // Both called each other at once: the second start answers with the first's call, to be answered.
    const incoming = live.find(call => call.caller_user_id === peerId && call.callee_user_id === userId && call.state === 'ringing');
    if (incoming) return { id: String(incoming.id), started: false };
    if (live.some(call => call.caller_user_id === userId || call.callee_user_id === userId)) throw conflict('CHAT_CALL_IN_PROGRESS', 'You are on a call.');
    const callId = crypto.randomUUID();
    await cx.execute(`INSERT INTO chat_calls (id, conversation_id, caller_user_id, callee_user_id, caller_chat_device_id, state, created_at, alive_at)
      VALUES (?, ?, ?, ?, ?, 'ringing', UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [callId, conversationId, userId, peerId, own]);
    if (live.length) {
      await finish(cx, await loadCall(userId, callId, cx), 'busy');
      return { id: callId, started: false };
    }
    await enqueueFromSource({ kind: 'call', userId: peerId, sourceId: callId, dedupeKey: `call:${callId}:ring`, url: `/call?id=${callId}`,
      data: { call: { id: callId, event: 'ring' } } }, cx);
    return { id: callId, started: true };
  });
  const row = await loadCall(userId, id);
  announce(row, row.state === 'ended');
  if (row.outcome === 'busy') throw conflict('CHAT_CALL_BUSY', `${peer.name} is on another call.`);
  return { call: toCall(row, own), started, ice_servers: iceServers(id) };
}

/** GET /api/chat/calls/current: the person's ringing or active call. */
async function currentCall(userId: string, token: string | null) {
  const own = await deviceOf(userId, token);
  const [[row]] = await db.execute<RowDataPacket[]>(`SELECT ${COLUMNS} FROM ${FROM} WHERE k.state <> 'ended' AND (k.caller_user_id = ? OR k.callee_user_id = ?)
    ORDER BY k.created_at DESC, k.id LIMIT 1`, [userId, userId]);
  return { call: row ? toCall(row, own) : null };
}

/** POST /api/chat/calls/:id/answer: the first of the callee's devices to answer takes the call. */
async function answerCall(userId: string, token: string | null, callId: string) {
  const own = await deviceOf(userId, token);
  const row = await withTransaction(async cx => {
    const call = await loadCall(userId, callId, cx, true);
    if (call.caller_user_id === userId) throw notAnEnd();
    if (call.answered_chat_device_id === own) return null;
    if (call.state === 'ended') throw ended();
    if (call.state === 'active') throw conflict('CHAT_CALL_ANSWERED', 'The call was answered on another device.');
    await cx.execute("UPDATE chat_calls SET state = 'active', answered_chat_device_id = ?, answered_at = UTC_TIMESTAMP(), alive_at = UTC_TIMESTAMP() WHERE id = ?", [own, callId]);
    await stopRinging(cx, call, own);
    return call;
  });
  if (row) announce(row);
  return { call: toCall(await loadCall(userId, callId), own), ice_servers: iceServers(callId) };
}

/** POST /api/chat/calls/:id/end: declined, cancelled, hung up or failed. */
async function endCall(userId: string, token: string | null, callId: string, input: unknown) {
  const failed = object(input).failed === true;
  const own = await deviceOf(userId, token);
  const row = await withTransaction(async cx => {
    const call = await loadCall(userId, callId, cx, true);
    if (call.state === 'ended') return null;
    const caller = call.caller_user_id === userId;
    // While it rings any of the callee's devices declines; otherwise only an end of the call.
    if (!(call.state === 'ringing' && !caller) && !isEnd(call, own)) throw notAnEnd();
    await finish(cx, call, failed ? 'failed' : call.state === 'active' ? 'answered' : caller ? 'cancelled' : 'declined');
    return call;
  });
  if (row) announce(row, true);
  return { call: toCall(await loadCall(userId, callId), own) };
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
    if (!isEnd(call, own)) throw notAnEnd();
    const [[sent]] = await cx.execute<RowDataPacket[]>('SELECT COUNT(*) AS n FROM chat_call_signals WHERE call_id = ?', [callId]);
    if (Number(sent.n) >= MAX_SIGNALS) throw conflict('CHAT_CALL_SIGNALS_LIMIT', 'This call has sent too many signals. Call again.');
    const [insert] = await cx.execute<ResultSetHeader>(`INSERT INTO chat_call_signals (call_id, from_chat_device_id, payload, created_at)
      VALUES (?, ?, ?, UTC_TIMESTAMP())`, [callId, own, payload]);
    return { id: insert.insertId, row: call };
  });
  const other = row.caller_user_id === userId ? row.callee_user_id : row.caller_user_id;
  if (other) realtime.publishToUser(other, 'chat.call', { call_id: callId }, { module: 'chat' });
  return { id: Number(id) };
}

/** GET /api/chat/calls/:id/signals?after=<id>: the other end's signals after a cursor. */
async function fetchSignals(userId: string, token: string | null, callId: string, after: string | null) {
  const cursor = after === null || after === '' ? 0 : Number(after);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw badRequest('CHAT_QUERY_INVALID', 'Invalid chat query');
  const own = await deviceOf(userId, token);
  if (!isEnd(await loadCall(userId, callId), own)) throw notAnEnd();
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT id, payload, created_at FROM chat_call_signals WHERE call_id = ? AND id > ? AND NOT (from_chat_device_id <=> ?)
    ORDER BY id LIMIT 100`, [callId, cursor, own]);
  const signals = rows.map((item): ChatCallSignal => ({ id: Number(item.id), payload: String(item.payload), created_at: utcIso(item.created_at) }));
  return { signals, after: signals.at(-1)?.id ?? cursor };
}

/** POST /api/chat/calls/:id/alive: an end's sign of life. */
async function callAlive(userId: string, token: string | null, callId: string) {
  const own = await deviceOf(userId, token);
  if (!isEnd(await loadCall(userId, callId), own)) throw notAnEnd();
  await db.execute("UPDATE chat_calls SET alive_at = UTC_TIMESTAMP() WHERE id = ? AND state <> 'ended'", [callId]);
  return { call: toCall(await loadCall(userId, callId), own) };
}

/** GET /api/chat/calls/:id/ice: fresh connection servers for an end of a call going on. */
async function callIceServers(userId: string, token: string | null, callId: string) {
  const own = await deviceOf(userId, token);
  const row = await loadCall(userId, callId);
  if (row.state === 'ended') throw ended();
  if (!isEnd(row, own)) throw notAnEnd();
  return { ice_servers: iceServers(callId) };
}

// --- Sweeps, entries and notifications -------------------------------------------------------

/**
 * Ends what nobody ends: a call ringing past the ring time is missed, an
 * active call without a sign of life for 90 seconds failed. At start-up
 * (after a restart or an instance restore) both end as failed, with no
 * missed-call notification for a call of the past.
 */
async function sweepCalls(startup = false) {
  const [due] = await db.execute<RowDataPacket[]>(`SELECT id FROM chat_calls
    WHERE (state = 'ringing' AND created_at < UTC_TIMESTAMP() - INTERVAL ${RING_SECONDS} SECOND)
      OR (state = 'active' AND alive_at < UTC_TIMESTAMP() - INTERVAL ${ALIVE_SECONDS} SECOND)`);
  let swept = 0;
  for (const { id } of due) {
    const row = await withTransaction(async cx => {
      const [[call]] = await cx.execute<RowDataPacket[]>("SELECT * FROM chat_calls WHERE id = ? AND state <> 'ended' FOR UPDATE", [id]);
      if (!call) return null;
      await finish(cx, call, startup || call.state === 'active' ? 'failed' : 'missed');
      return call;
    });
    if (row) { announce(row, true); swept++; }
  }
  return swept;
}

interface CallNotice { caller: string; ringsUntil: number }

/**
 * A call as its notification sees it: for 'ring' still ringing, for 'end'
 * no longer ringing, for a missed call its entry not read yet; the callee's
 * only. The caller's name as the directory has it now.
 */
async function callNotice(userId: string, callId: string, executor: SqlExecutor, payload: Record<string, unknown>, missed = false): Promise<CallNotice | null> {
  const event = object(payload.call).event;
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT k.state, k.outcome, k.created_at, COALESCE(NULLIF(u.full_name, ''), u.email) AS caller,
      m.seq, COALESCE(me.read_seq, 0) AS read_seq
    FROM chat_calls k LEFT JOIN users u ON u.id = k.caller_user_id LEFT JOIN chat_messages m ON m.id = k.message_id
    LEFT JOIN chat_members me ON me.conversation_id = k.conversation_id AND me.user_id = k.callee_user_id
    WHERE k.id = ? AND k.callee_user_id = ?`, [callId, userId]);
  if (!row) return null;
  const current = missed ? MISSED.includes(row.outcome) && Number(row.seq) > Number(row.read_seq) : (event === 'ring') === (row.state === 'ringing');
  return current ? { caller: row.caller ? String(row.caller) : 'Deleted person', ringsUntil: new Date(utcIso(row.created_at)).getTime() + RING_SECONDS * 1000 } : null;
}

export type { CallNotice };
export { startCall, currentCall, answerCall, endCall, postSignal, fetchSignals, callAlive, callIceServers, sweepCalls, callNotice };
