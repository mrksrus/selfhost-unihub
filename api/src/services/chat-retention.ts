import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AuthRequest } from '../types';
import type { ChatRetentionDays, ChatRetentionPreviewResponse } from '../contracts/chat';

import { db } from '../state';
import { badRequest, forbidden, notFound } from '../http/errors';
import { withTransaction } from './transactions';
import { conversationFollows, conversationPeople, removeGrantsOn } from './access';
import { groupExists, groupMemberIds } from './groups';
import { policyForEveryone } from './settings';
import { recordAudit } from './audit';
import { dropAttachments, removeFiles, sweepChatFiles } from './chat-attachments';
import { utcIso } from './chat-devices';

// Chat retention (chat.retention_days). A message is one row for all its
// readers, so a chat follows the shortest value among its active people. Each
// chat stores the value in force and the moment deleting under it starts: a
// shorter value starts 24 hours after it is first seen (at a save of the
// rules, a change of a group's people or the hourly pass), whatever
// made it shorter (a policy, someone joining a group or the chat); a longer
// one, or none, holds at once without ending a wait. Only the owner starts
// the waiting chats at once. Retention deletes even while bin.delete forbids
// deleting for good: it is the administrator's way to delete chat messages.

type Days = ChatRetentionDays | null;
const DAYS: readonly number[] = [30, 90, 180, 365];
const BATCH = 500;
const shorter = (a: Days, b: Days) => a !== null && (b === null || a < b);
const list = (items: readonly unknown[]) => items.map(() => '?').join(', ');

/** The shortest value among the chat's active people; undefined while none is active (the stored value then stays). */
function chatValue(people: readonly string[], active: ReadonlySet<string>, valueOf: (userId: string) => Days): Days | undefined {
  const values = people.filter(id => active.has(id)).map(valueOf);
  return values.length ? values.reduce((a, b) => (shorter(b, a) ? b : a)) : undefined;
}

// shortcut: a few queries per chat each hour, fine for one organisation; one query over the grants when chats number in the tens of thousands.
async function chats(valueOf?: (userId: string) => Days) {
  const policy = await policyForEveryone('chat.retention_days');
  const [users] = await db.execute<RowDataPacket[]>('SELECT id FROM users WHERE is_active = TRUE');
  const active = new Set(users.map(row => String(row.id)));
  const [rows] = await db.execute<RowDataPacket[]>('SELECT id, retention_days FROM chat_conversations ORDER BY id');
  const result = [];
  for (const row of rows) {
    const people = await conversationPeople(String(row.id));
    result.push({ id: String(row.id), people, stored: (row.retention_days === null ? null : Number(row.retention_days)) as Days,
      value: chatValue(people, active, valueOf ?? (id => policy.of(id).value)) });
  }
  return result;
}

/** Stores each chat's value; a shorter one waits 24 hours. Answers the chats with their people. */
async function refreshRetention() {
  const result = await chats();
  for (const chat of result) {
    if (chat.value === undefined || chat.value === chat.stored) continue;
    if (chat.value === null) await db.execute('UPDATE chat_conversations SET retention_days = NULL, retention_from = NULL WHERE id = ?', [chat.id]);
    else if (shorter(chat.value, chat.stored)) await db.execute('UPDATE chat_conversations SET retention_days = ?, retention_from = UTC_TIMESTAMP() + INTERVAL 24 HOUR WHERE id = ?', [chat.value, chat.id]);
    else await db.execute('UPDATE chat_conversations SET retention_days = ? WHERE id = ?', [chat.value, chat.id]);
  }
  return result;
}

const OLDER = "conversation_id = ? AND replaces IS NULL AND created_at < UTC_TIMESTAMP() - INTERVAL ? DAY";
const SHOWN = "kind = 'message' AND ciphertext IS NOT NULL";

/** A chat's messages older than its days, with their edits, deletion entries, archive copies, files and queued notifications, in batches. */
async function deleteOlder(conversationId: string, days: number) {
  let messages = 0, files = 0;
  for (;;) {
    const batch = await withTransaction(async cx => {
      await cx.execute('SELECT id FROM chat_conversations WHERE id = ? FOR UPDATE', [conversationId]);
      const [originals] = await cx.execute<RowDataPacket[]>(`SELECT id, ${SHOWN} AS shown FROM chat_messages WHERE ${OLDER} ORDER BY seq LIMIT ${BATCH}`, [conversationId, days]);
      if (!originals.length) return null;
      const ids = originals.map(row => String(row.id));
      const [later] = await cx.execute<RowDataPacket[]>(`SELECT id FROM chat_messages WHERE replaces IN (${list(ids)})`, ids);
      const all = [...ids, ...later.map(row => String(row.id))];
      const dropped = await dropAttachments(cx, `message_id IN (${list(ids)})`, ids);
      await cx.execute(`DELETE FROM notification_events WHERE kind = 'chat' AND source_id IN (${list(all)})`, all);
      await cx.execute(`DELETE FROM chat_messages WHERE id IN (${list(all)})`, all);
      return { shown: originals.filter(row => Number(row.shown)).length, dropped };
    });
    if (!batch) return { messages, files };
    messages += batch.shown;
    files += batch.dropped.length;
    await removeFiles(batch.dropped);
  }
}

/** A chat nobody is in any more (not one that follows a group), with everything it holds. */
async function deleteChat(conversationId: string) {
  const files = await withTransaction(async cx => {
    await cx.execute('SELECT id FROM chat_conversations WHERE id = ? FOR UPDATE', [conversationId]);
    if ((await conversationPeople(conversationId, cx)).length) return null;
    const dropped = await dropAttachments(cx, 'conversation_id = ?', [conversationId]);
    // Messages before their groups: a message names its group without a delete rule.
    await cx.execute('DELETE FROM chat_messages WHERE conversation_id = ?', [conversationId]);
    await cx.execute('DELETE FROM chat_groups WHERE conversation_id = ?', [conversationId]);
    await removeGrantsOn(cx, { kind: 'conversation', id: conversationId });
    await cx.execute('DELETE FROM chat_conversations WHERE id = ?', [conversationId]);
    return dropped;
  });
  if (files) await removeFiles(files, [conversationId]);
  return !!files;
}

/**
 * The hourly job: each chat's value, then what is past it in chats whose
 * moment has come; Welcomes of groups replaced 30 days ago; uploads never
 * sent; chats nobody is in (kept while bin.delete is forbidden for everyone,
 * until retention has emptied them).
 */
async function runChatRetention() {
  const known = await refreshRetention();
  let messages = 0, files = 0, chatsDeleted = 0;
  const [due] = await db.execute<RowDataPacket[]>('SELECT id, retention_days FROM chat_conversations WHERE retention_days IS NOT NULL AND retention_from <= UTC_TIMESTAMP()');
  for (const row of due) {
    const deleted = await deleteOlder(String(row.id), Number(row.retention_days));
    messages += deleted.messages;
    files += deleted.files;
  }
  const [replaced] = await db.execute<RowDataPacket[]>(`SELECT g.id FROM chat_groups g JOIN chat_conversations c ON c.id = g.conversation_id
    WHERE g.welcome IS NOT NULL AND NOT (c.current_group_id <=> g.id) AND EXISTS (SELECT 1 FROM chat_groups n WHERE n.conversation_id = g.conversation_id
      AND n.id <> g.id AND n.created_at >= g.created_at AND n.created_at < UTC_TIMESTAMP() - INTERVAL 30 DAY)`);
  if (replaced.length) await db.execute(`UPDATE chat_groups SET welcome = NULL WHERE id IN (${list(replaced)})`, replaced.map(row => row.id));
  const unsent = await sweepChatFiles();
  const mayDelete = (await policyForEveryone('bin.delete')).everyone.allowed;
  for (const chat of known.filter(item => !item.people.length)) {
    if (await conversationFollows(chat.id)) continue;
    if (!mayDelete) {
      const [[left]] = await db.execute<RowDataPacket[]>('SELECT 1 FROM chat_messages WHERE conversation_id = ? LIMIT 1', [chat.id]);
      if (left) continue;
    }
    if (await deleteChat(chat.id)) chatsDeleted++;
  }
  return { messages, files, welcomes: replaced.length, unsent, chats: chatsDeleted };
}

/**
 * GET /api/admin/chat/retention-preview: what `days` for Everyone (or a
 * group's people) would delete once its wait is over, in the chats it would
 * shorten: their shown messages older than the new value and those messages' files.
 */
async function previewRetention(daysParam: string | null, groupId: string | null): Promise<ChatRetentionPreviewResponse> {
  const [[waits]] = await db.execute<RowDataPacket[]>('SELECT COUNT(*) AS waiting, MIN(retention_from) AS first FROM chat_conversations WHERE retention_from > UTC_TIMESTAMP()');
  const preview = { messages: 0, files: 0, conversations: 0, waiting: Number(waits.waiting), waiting_from: waits.first ? utcIso(waits.first) : null };
  if (daysParam === null) return preview;
  const days = Number(daysParam) as ChatRetentionDays;
  if (!DAYS.includes(days)) throw badRequest('CHAT_RETENTION_INVALID', 'Choose 30, 90, 180 or 365 days');
  if (groupId !== null && !await groupExists(groupId)) throw notFound('GROUP_NOT_FOUND', 'Group not found');
  const reached = groupId === null ? null : new Set(await groupMemberIds(groupId));
  const policy = await policyForEveryone('chat.retention_days');
  const result = await chats(id => {
    const now = policy.of(id).value;
    return (!reached || reached.has(id)) && shorter(days, now) ? days : now;
  });
  for (const chat of result) {
    if (chat.value === undefined || !shorter(chat.value, chat.stored)) continue;
    const [[counted]] = await db.execute<RowDataPacket[]>(`SELECT (SELECT COUNT(*) FROM chat_messages WHERE ${OLDER} AND ${SHOWN}) AS messages,
      (SELECT COUNT(*) FROM chat_attachments a JOIN chat_messages m ON m.id = a.message_id
        WHERE m.conversation_id = ? AND m.replaces IS NULL AND m.created_at < UTC_TIMESTAMP() - INTERVAL ? DAY) AS files`,
    [chat.id, chat.value, chat.id, chat.value]);
    if (!Number(counted.messages) && !Number(counted.files)) continue;
    preview.messages += Number(counted.messages);
    preview.files += Number(counted.files);
    preview.conversations++;
  }
  return preview;
}

/** POST /api/admin/chat/retention/apply-now, after the route checked the password: the owner starts every waiting chat now. */
async function applyRetentionNow(userId: string, req: AuthRequest | null) {
  const [[caller]] = await db.execute<RowDataPacket[]>('SELECT role FROM users WHERE id = ?', [userId]);
  if (caller?.role !== 'owner') throw forbidden('OWNER_REQUIRED', 'Only the owner can start deleting before the 24 hours are over.');
  await refreshRetention();
  return withTransaction(async cx => {
    const [result] = await cx.execute<ResultSetHeader>('UPDATE chat_conversations SET retention_from = UTC_TIMESTAMP() WHERE retention_from > UTC_TIMESTAMP()');
    await recordAudit({ action: 'admin.chat_retention_applied', actorId: userId, req, details: { conversations: result.affectedRows } }, cx);
    return { conversations: result.affectedRows };
  });
}

export { runChatRetention, refreshRetention, previewRetention, applyRetentionNow };
