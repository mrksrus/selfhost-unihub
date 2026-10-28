import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor, ComposerAttachment, StagedAttachment } from '../types';
import crypto from 'crypto';
import { promises as fs } from 'node:fs';
import path from 'path';
import { db } from '../state';
import { badRequest } from '../http/errors';
import { attachmentsRoot, mailPathUnderRoot } from './mail-storage';

function attachmentError(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

function validateAttachmentTotals(attachments: readonly { filename?: string; size_bytes?: number; content?: Buffer }[]) {
  if (attachments.length > 20) throw attachmentError('Too many attachments (max 20)');
  let total = 0;
  for (const attachment of attachments) {
    const size = Number(attachment.size_bytes ?? attachment.content?.length) || 0;
    if (size > 15 * 1024 * 1024) throw attachmentError(`Attachment "${attachment.filename}" exceeds 15MB limit`);
    total += size;
  }
  if (total > 25 * 1024 * 1024) throw attachmentError('Total attachment size exceeds 25MB limit');
}

function normalizeComposerAttachments(attachments: unknown = []) {
  if (!Array.isArray(attachments)) throw attachmentError('attachments must be an array');
  if (attachments.length > 20) throw attachmentError('Too many attachments (max 20)');
  const normalized = attachments.map((attachment, index) => {
    if (!attachment || typeof attachment !== 'object') throw attachmentError(`Invalid attachment at index ${index}`);
    const filename = String(attachment.filename || `attachment-${index + 1}`);
    const encoded = String(attachment.dataBase64 || '');
    const content = Buffer.from(encoded, 'base64');
    if (!encoded || !content.length) throw attachmentError(`Attachment "${filename}" is empty`);
    return { filename, contentType: String(attachment.contentType || attachment.content_type || 'application/octet-stream'), content };
  });
  validateAttachmentTotals(normalized);
  return normalized;
}

// Files use their final unique names, but are invisible to readers until their
// metadata transaction commits. Call discardStagedAttachments on any failure.
async function stageAttachments({ userId, emailId, attachments, root = attachmentsRoot() }: { userId: string; emailId: string; attachments: readonly ComposerAttachment[]; root?: string }): Promise<StagedAttachment[]> {
  const staged: StagedAttachment[] = [];
  if (!attachments.length) return staged;
  const directory = path.join(root, userId);
  await fs.mkdir(directory, { recursive: true });
  try {
    for (const attachment of attachments) {
      const id = crypto.randomUUID();
      const filename = String(attachment.filename || attachment.cid || `attachment-${id}`);
      const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180) || id;
      const storagePath = path.join(directory, `${emailId}-${id}-${safeFilename}`);
      const row = { id, email_id: emailId, user_id: userId, filename,
        content_type: attachment.contentType || 'application/octet-stream',
        size_bytes: attachment.content.length, storage_path: storagePath,
        content_id: attachment.contentId || attachment.cid || null };
      staged.push(row);
      await fs.writeFile(storagePath, attachment.content, { flag: 'wx', mode: 0o600 });
    }
    return staged;
  } catch (error) {
    await discardStagedAttachments(staged);
    throw error;
  }
}

async function discardStagedAttachments(staged: readonly Pick<StagedAttachment, 'storage_path'>[]) {
  await Promise.all(staged.map(row => fs.rm(row.storage_path, { force: true }).catch(() => {})));
}

async function insertStagedAttachments(connection: SqlExecutor, staged: readonly StagedAttachment[]) {
  for (const row of staged) {
    await connection.execute(
      'INSERT INTO email_attachments (id, email_id, user_id, filename, content_type, size_bytes, storage_path, content_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [row.id, row.email_id, row.user_id, row.filename, row.content_type, row.size_bytes, row.storage_path, row.content_id]
    );
  }
}

function rewriteInlineAttachments(html: string | false | null | undefined, staged: readonly Pick<StagedAttachment, 'id' | 'content_id'>[]) {
  let result = html || null;
  for (const attachment of staged) {
    if (!result || !attachment.content_id) continue;
    const cid = String(attachment.content_id).replace(/^<|>$/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`cid:${cid}`, 'gi'), `/api/mail/attachments/${attachment.id}`);
  }
  return result;
}

interface AttachmentFile { path: string; size: number; filename: string; contentType: string }

/**
 * The stored file of one of the user's attachments, as GET
 * /api/mail/attachments/:id and a download ticket (services/file-tickets.ts)
 * stream it; null when the user has no such attachment or its file is gone.
 * The row proves ownership; the path must stay inside the attachments root.
 */
async function attachmentFileForUser(userId: string, attachmentId: string, executor: SqlExecutor = db): Promise<AttachmentFile | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    'SELECT filename, content_type, storage_path FROM email_attachments WHERE id = ? AND user_id = ?', [attachmentId, userId]);
  if (!rows.length) return null;
  const resolved = mailPathUnderRoot('attachment', rows[0].storage_path);
  if (!resolved) throw badRequest('ATTACHMENT_PATH_INVALID', 'Invalid attachment path');
  const stat = await fs.stat(resolved).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat?.isFile()) return null;
  const filename = rows[0].filename || 'download';
  return { path: resolved, size: stat.size, filename, contentType: attachmentContentType(rows[0].content_type, filename) };
}

// Senders often label common files generically; the extension decides then.
function attachmentContentType(declared: string | null, filename: string) {
  const type = declared || 'application/octet-stream';
  const name = filename.toLowerCase();
  if (name.endsWith('.pdf') && !type.includes('pdf')) return 'application/pdf';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.txt')) return 'text/plain';
  return type;
}

export {
  attachmentFileForUser,
  normalizeComposerAttachments,
  validateAttachmentTotals,
  stageAttachments,
  discardStagedAttachments,
  insertStagedAttachments,
  rewriteInlineAttachments,
};
