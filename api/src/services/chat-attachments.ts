import type { RowDataPacket } from 'mysql2/promise';
import type { RouteResponse, SqlExecutor } from '../types';
import type { UploadBody } from '../http/route';
import type { ChatAttachment, ChatFileTooLargeDetails } from '../contracts/chat';

import fs from 'node:fs';
import path from 'node:path';
import { db } from '../state';
import { ApiError, badRequest, conflict, notFound } from '../http/errors';
import { log } from '../log';
import { withTransaction } from './transactions';
import { assertCan, can } from './access';
import { resolvePolicy } from './settings';
import { utcIso } from './chat-devices';
import { fileRemovalGate } from './file-removal-gate';

// Chat files (contracts/chat.ts): ciphertext the device encrypted, one file
// per row under <CHAT_FILES_ROOT>/<conversation>/<id>. The file belongs to
// the chat, not to its uploader: deleting the person empties the uploader and
// keeps the file for the others. A file is tied to one message at its post,
// goes with that message, and an upload no message names goes after a day.
// Rows go first and files after, through the file removal gate.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Ten files, and for each picture among them its small preview, which is an upload of its own.
const MAX_PER_MESSAGE = 20;
const MB = 1024 * 1024;
// shortcut: one request per file up to this, no resumable upload; a session of chunks (as recordings have) if files must grow past it.
const UPLOAD_LIMIT = 101 * MB;
const SWEEP_BATCH = 500;

const chatFilesRoot = () => path.resolve(process.env.CHAT_FILES_ROOT || '/app/uploads/chat');
// Both ids are checked UUIDs, so the path stays inside the root.
const filePath = (conversationId: string, id: string) => path.join(chatFilesRoot(), conversationId.toLowerCase(), id.toLowerCase());
const attachmentNotFound = () => notFound('CHAT_ATTACHMENT_NOT_FOUND', 'File not found');
const toAttachment = (row: RowDataPacket): ChatAttachment => ({
  id: String(row.id), conversation_id: String(row.conversation_id), size_bytes: Number(row.size_bytes),
  message_id: row.message_id ? String(row.message_id) : null, created_at: utcIso(row.created_at),
});
const COLUMNS = 'id, conversation_id, message_id, uploader_user_id, size_bytes, created_at';

/** POST /api/chat/conversations/:id/attachments: stores a member's upload, refused above their chat.attachment_max_mb. */
async function storeAttachment(userId: string, conversationId: string, rawId: string | null, body: UploadBody): Promise<ChatAttachment> {
  if (!rawId || !UUID.test(rawId)) throw badRequest('CHAT_ATTACHMENT_INVALID', 'Invalid file id');
  const id = rawId.toLowerCase();
  // The id names a folder: only the stored spelling, not one the database would also match.
  if (!UUID.test(conversationId)) throw notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
  await assertCan(userId, { kind: 'conversation', id: conversationId }, 'member');
  const limit = (await resolvePolicy(userId, 'chat.attachment_max_mb')).value;
  if (body.size > limit * MB) {
    const reason = `Files in a chat can be at most ${limit} MB.`;
    throw new ApiError(413, 'CHAT_FILE_TOO_LARGE', reason, { limit_mb: limit, reason } satisfies ChatFileTooLargeDetails);
  }
  const target = filePath(conversationId, id);
  const stored = async () => {
    const [[row]] = await db.execute<RowDataPacket[]>(`SELECT ${COLUMNS} FROM chat_attachments WHERE id = ?`, [id]);
    if (row && row.conversation_id === conversationId && row.uploader_user_id === userId) return toAttachment(row);
    throw conflict('CHAT_ATTACHMENT_EXISTS', 'This file id is taken');
  };
  try {
    // The row is held uncommitted while the file is placed: a retry waits for it, and a crash leaves at most a file without a row.
    await withTransaction(async cx => {
      await cx.execute('INSERT INTO chat_attachments (id, conversation_id, uploader_user_id, size_bytes, storage_path) VALUES (?, ?, ?, ?, ?)',
        [id, conversationId, userId, body.size, `chat/${conversationId}/${id}`]);
      await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      // A file there without a row is left from a crash; this row is ours, so it is replaced.
      await fs.promises.rm(target, { force: true });
      await fs.promises.link(body.path, target).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EXDEV') throw error;
        await fs.promises.copyFile(body.path, target, fs.constants.COPYFILE_EXCL);
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ER_DUP_ENTRY') return stored();
    throw error;
  }
  return stored();
}

/**
 * In the post's transaction: ties the sender's unsent uploads to this chat
 * to the message, at most ten; an edit names none.
 */
async function tieAttachments(cx: SqlExecutor, conversationId: string, userId: string, messageId: string, edit: boolean, value: unknown) {
  if (value === undefined || (Array.isArray(value) && !value.length)) return;
  const invalid = () => badRequest('CHAT_ATTACHMENT_INVALID', `A message carries up to ${MAX_PER_MESSAGE} of your files sent to this chat and not used yet; an edit carries none.`);
  if (edit || !Array.isArray(value) || value.length > MAX_PER_MESSAGE || value.some(item => typeof item !== 'string' || !UUID.test(item))) throw invalid();
  const ids = [...new Set((value as string[]).map(item => item.toLowerCase()))];
  const [result] = await cx.execute<import('mysql2/promise').ResultSetHeader>(`UPDATE chat_attachments SET message_id = ?
    WHERE id IN (${ids.map(() => '?').join(', ')}) AND conversation_id = ? AND uploader_user_id = ? AND message_id IS NULL`, [messageId, ...ids, conversationId, userId]);
  if (result.affectedRows !== ids.length) throw invalid();
}

/** GET /api/chat/attachments/:id: the ciphertext, to a member who reads its message, or to its uploader before it is sent. */
async function attachmentFile(userId: string, id: string): Promise<RouteResponse> {
  if (!UUID.test(id)) throw attachmentNotFound();
  const [[row]] = await db.execute<RowDataPacket[]>(`SELECT a.conversation_id, a.message_id, a.uploader_user_id, a.size_bytes, m.seq, m.ciphertext IS NULL AS gone,
      IF(me.user_id IS NULL AND c.kind = 'group', c.last_seq, COALESCE(me.joined_seq, 0)) AS joined_seq
    FROM chat_attachments a JOIN chat_conversations c ON c.id = a.conversation_id LEFT JOIN chat_messages m ON m.id = a.message_id
    LEFT JOIN chat_members me ON me.conversation_id = a.conversation_id AND me.user_id = ? WHERE a.id = ?`, [userId, id]);
  if (!row || !await can(userId, { kind: 'conversation', id: String(row.conversation_id) }, 'member')) throw attachmentNotFound();
  const readable = row.message_id ? !Number(row.gone) && Number(row.seq) > Number(row.joined_seq) : row.uploader_user_id === userId;
  if (!readable) throw attachmentNotFound();
  return { __streamPath: filePath(String(row.conversation_id), id), __contentType: 'application/octet-stream', __contentLength: Number(row.size_bytes),
    __filename: id, __headers: { 'Cache-Control': 'no-store' } };
}

/** In a transaction: deletes the rows `where` selects (FOR UPDATE) and answers their files, for removeFiles once it commits. */
async function dropAttachments(cx: SqlExecutor, where: string, params: string[]) {
  const [rows] = await cx.execute<RowDataPacket[]>(`SELECT id, conversation_id FROM chat_attachments WHERE ${where} FOR UPDATE`, params);
  if (rows.length) await cx.execute(`DELETE FROM chat_attachments WHERE id IN (${rows.map(() => '?').join(', ')})`, rows.map(row => row.id));
  return rows.map(row => ({ id: String(row.id), conversationId: String(row.conversation_id) }));
}

/** After the rows are gone: their files, through the gate; a file whose id has a row again (a new upload) stays. */
async function removeFiles(files: readonly { id: string; conversationId: string }[], directories: readonly string[] = []) {
  if (!files.length && !directories.length) return;
  await fileRemovalGate.run(async () => {
    const [present] = files.length ? await db.execute<RowDataPacket[]>(`SELECT id FROM chat_attachments WHERE id IN (${files.map(() => '?').join(', ')})`, files.map(file => file.id)) : [[]];
    const kept = new Set(present.map(row => String(row.id)));
    for (const file of files) {
      if (!kept.has(file.id)) await fs.promises.rm(filePath(file.conversationId, file.id), { force: true }).catch(error => log.error('CHAT', 'A chat file was not removed', error));
    }
    for (const id of directories) await fs.promises.rm(path.join(chatFilesRoot(), id), { recursive: true, force: true }).catch(error => log.error('CHAT', 'A chat folder was not removed', error));
  });
}

/** After a message was deleted for both sides: its files. */
async function deleteMessageFiles(messageId: string) {
  await removeFiles(await withTransaction(cx => dropAttachments(cx, 'message_id = ?', [messageId])));
}

/**
 * Uploads no message named within a day, and files of messages deleted
 * meanwhile; answers how many went. The second condition is read on the
 * locked rows, so an upload a post named in this moment stays.
 */
async function sweepChatFiles() {
  const files = await withTransaction(cx => dropAttachments(cx, `id IN (SELECT id FROM (SELECT a.id FROM chat_attachments a LEFT JOIN chat_messages m ON m.id = a.message_id
    WHERE (a.message_id IS NULL AND a.created_at < UTC_TIMESTAMP() - INTERVAL 1 DAY) OR (a.message_id IS NOT NULL AND m.ciphertext IS NULL) LIMIT ${SWEEP_BATCH}) due)
    AND (message_id IS NULL OR message_id IN (SELECT id FROM chat_messages WHERE ciphertext IS NULL))`, []));
  await removeFiles(files);
  return files.length;
}

export { UPLOAD_LIMIT, chatFilesRoot, storeAttachment, tieAttachments, attachmentFile, dropAttachments, removeFiles, deleteMessageFiles, sweepChatFiles };
