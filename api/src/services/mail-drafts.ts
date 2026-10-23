import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';

import fs from 'fs';
import { db } from '../state';
import { log } from '../log';
// Through the facade, as the draft routes did, so their tests can stub sending.
import { toBooleanFlag, deleteStoredAttachmentFiles, replyThreading, sendEmail } from './mail';
import { draftThreading } from './mail-send';
import { withTransaction } from './transactions';
import { parseStoredRecipients } from './mail-recipients';

import {
  normalizeComposerAttachments,
  validateAttachmentTotals,
  stageAttachments,
  discardStagedAttachments,
  insertStagedAttachments,
} from './mail-attachments';

interface DraftRow extends RowDataPacket {
  mail_account_id: string;
  from_address: string;
  subject: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  thread_key: string | null;
  body_html: string | null;
  body_text: string | null;
}
const readFile = fs.promises.readFile;

const sendInProgress = () => Object.assign(new Error('This message is being sent now.'), { status: 409, code: 'SCHEDULED_SEND_IN_PROGRESS' });

interface ExistingAttachment extends RowDataPacket {
  id: string;
  storage_path: string;
  filename: string;
  size_bytes: number;
}
interface DraftMutation {
  db: Pick<Pool, 'getConnection'>;
  userId: string;
  emailId: string;
  isNew?: boolean;
  body: { attachments?: unknown; existing_attachment_ids?: unknown[] | null };
  mutate: (connection: PoolConnection) => Promise<unknown>;
  deleteFiles: (paths: string[]) => Promise<unknown>;
}

async function saveDraftMutation({ db, userId, emailId, isNew = false, body, mutate, deleteFiles }: DraftMutation) {
  const changesAttachments = Array.isArray(body?.existing_attachment_ids) || body?.attachments !== undefined;
  const normalized = normalizeComposerAttachments(body?.attachments === undefined ? [] : body.attachments);
  const staged = await stageAttachments({ userId, emailId, attachments: normalized });
  let connection: PoolConnection | undefined;
  let committed = false;
  let commitAttempted = false;
  let removable: ExistingAttachment[] = [];
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    if (!isNew) {
      const locked = await lockDraftForSend(connection, userId, emailId);
      if (!locked) throw Object.assign(new Error('Draft not found'), { status: 404 });
      // A send claims the draft's send row before it reads the draft: holding
      // the row here, an edit lands either before the send starts or is refused.
      if (locked.send?.status === 'sending') throw sendInProgress();
    }
    let kept: ExistingAttachment[] = [];
    if (changesAttachments && !isNew) {
      const [existing] = await connection.execute<ExistingAttachment[]>('SELECT id, storage_path, filename, size_bytes FROM email_attachments WHERE email_id = ? AND user_id = ?', [emailId, userId]);
      const keepIds = new Set((body.existing_attachment_ids || []).map(String));
      kept = existing.filter(row => keepIds.has(String(row.id)));
      removable = existing.filter(row => !keepIds.has(String(row.id)));
    }
    if (changesAttachments) validateAttachmentTotals([...kept, ...staged]);
    await mutate(connection);
    if (changesAttachments) {
      if (removable.length) {
        await connection.execute(`DELETE FROM email_attachments WHERE id IN (${removable.map(() => '?').join(',')}) AND email_id = ? AND user_id = ?`,
          [...removable.map(row => row.id), emailId, userId]);
      }
      await insertStagedAttachments(connection, staged);
      await connection.execute('UPDATE emails SET has_attachments = ? WHERE id = ? AND user_id = ?', [kept.length + staged.length > 0 ? 1 : 0, emailId, userId]);
    }
    commitAttempted = true;
    await connection.commit();
    committed = true;
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection?.release();
    // Keep both old and staged files if COMMIT may have reached the server.
    if (!committed && !commitAttempted) await discardStagedAttachments(staged);
  }
  await deleteFiles(removable.map(row => row.storage_path));
  // The new attachments' ids, in the order of body.attachments.
  return staged.map(row => row.id);
}

async function loadMailAccountForDraft(userId: string, accountId: unknown) {
  const normalizedAccountId = String(accountId || '').trim();
  if (!normalizedAccountId) return null;
  const [accounts] = await db.execute<RowDataPacket[]>(
    'SELECT id, user_id, email_address, display_name FROM mail_accounts WHERE id = ? AND user_id = ? LIMIT 1',
    [normalizedAccountId, userId]
  );
  return accounts[0] || null;
}

async function loadDraftEmail(userId: string, draftId: string) {
  const [rows] = await db.execute<DraftRow[]>(
    'SELECT * FROM emails WHERE id = ? AND user_id = ? AND is_draft = TRUE LIMIT 1',
    [draftId, userId]
  );
  if (!rows.length) return null;
  const draft = rows[0];
  const [attachments] = await db.execute<RowDataPacket[]>(
    'SELECT id, filename, content_type, size_bytes FROM email_attachments WHERE email_id = ? AND user_id = ? ORDER BY filename',
    [draftId, userId]
  );
  return {
    ...draft,
    to_addresses: parseStoredRecipients(draft.to_addresses),
    cc_addresses: parseStoredRecipients(draft.cc_addresses),
    bcc_addresses: parseStoredRecipients(draft.bcc_addresses),
    is_read: toBooleanFlag(draft.is_read),
    is_starred: toBooleanFlag(draft.is_starred),
    is_draft: !!draft.is_draft,
    has_attachments: !!draft.has_attachments,
    attachments: attachments || [],
  };
}


interface ScheduleLockRow extends RowDataPacket { id: string; status: string; origin: string; client_key: string }
/**
 * Locks one of the user's drafts and then its send row (mail_scheduled_sends:
 * a schedule, or a send by hand in progress), in the order every writer of a
 * draft uses. Null when there is no such draft.
 */
async function lockDraftForSend(connection: SqlExecutor, userId: string, draftId: string) {
  const [drafts] = await connection.execute<RowDataPacket[]>('SELECT id FROM emails WHERE id = ? AND user_id = ? AND is_draft = TRUE FOR UPDATE', [draftId, userId]);
  if (!drafts.length) return null;
  const [rows] = await connection.execute<ScheduleLockRow[]>('SELECT id, status, origin, client_key FROM mail_scheduled_sends WHERE email_id = ? AND user_id = ? FOR UPDATE', [draftId, userId]);
  return { send: rows[0] ?? null };
}

// Draft sends running in this process (by hand or scheduled). A mail restore
// waits until none runs; a send registers before it checks for a restore, so
// one of the two always sees the other.
let draftSendsRunning = 0;
async function trackDraftSend<T>(work: () => Promise<T>): Promise<T> {
  draftSendsRunning += 1;
  try { return await work(); } finally { draftSendsRunning -= 1; }
}
const isAnyDraftSendRunning = () => draftSendsRunning > 0;

/** Deletes one of the user's drafts by request: refused while it is being sent, in the same lock order as the sends. */
async function deleteDraftUnlessSending(userId: string, draftId: string) {
  const paths = await withTransaction(async connection => {
    const locked = await lockDraftForSend(connection, userId, draftId);
    if (!locked) return null;
    if (locked.send?.status === 'sending') throw sendInProgress();
    const [attachments] = await connection.execute<RowDataPacket[]>('SELECT storage_path FROM email_attachments WHERE email_id = ? AND user_id = ?', [draftId, userId]);
    await connection.execute('DELETE FROM emails WHERE id = ? AND user_id = ? AND is_draft = TRUE', [draftId, userId]);
    return attachments.map(row => row.storage_path as string);
  });
  if (!paths) return { error: 'Draft not found', status: 404 };
  const fileResult = await deleteStoredAttachmentFiles(paths);
  return { deleted: true, deletedAttachmentFiles: fileResult.deletedFiles, failedAttachmentFiles: fileResult.failedFiles };
}

async function deleteDraftWithFiles(userId: string, draftId: string) {
  const draft = await loadDraftEmail(userId, draftId);
  if (!draft) return { error: 'Draft not found', status: 404 };
  const [attachments] = await db.execute<RowDataPacket[]>(
    'SELECT storage_path FROM email_attachments WHERE email_id = ? AND user_id = ?',
    [draftId, userId]
  );
  await db.execute('DELETE FROM emails WHERE id = ? AND user_id = ? AND is_draft = TRUE', [draftId, userId]);
  const fileResult = await deleteStoredAttachmentFiles((attachments || []).map(row => row.storage_path));
  return {
    deleted: true,
    deletedAttachmentFiles: fileResult.deletedFiles,
    failedAttachmentFiles: fileResult.failedFiles,
  };
}

/**
 * Sends one of the user's stored drafts and removes it once the message is
 * out. The caller wraps it in sendOnce with the send's key; a refusal before
 * the message was handed over returns `error` (the key is released).
 */
async function sendStoredDraft(userId: string, draftId: string, replyTo?: unknown): Promise<Record<string, unknown>> {
  const draft = await loadDraftEmail(userId, draftId);
  if (!draft) return { error: 'Draft not found', status: 404 };

  const account = await loadMailAccountForDraft(userId, draft.mail_account_id);
  if (!account) return { error: 'Account not found', status: 404 };

  const to = parseStoredRecipients(draft.to_addresses);
  const cc = parseStoredRecipients(draft.cc_addresses);
  const bcc = parseStoredRecipients(draft.bcc_addresses);
  if (!to.length && !cc.length && !bcc.length) return { error: 'Draft needs at least one recipient before sending', status: 400 };

  const [attachmentRows] = await db.execute<RowDataPacket[]>(
    'SELECT filename, content_type, storage_path FROM email_attachments WHERE email_id = ? AND user_id = ? ORDER BY filename',
    [draftId, userId]
  );
  const attachments = [];
  for (const attachment of attachmentRows || []) {
    if (!attachment.storage_path) continue;
    const content = await readFile(attachment.storage_path);
    attachments.push({
      filename: attachment.filename,
      contentType: attachment.content_type || 'application/octet-stream',
      dataBase64: content.toString('base64'),
    });
  }

  const bodyContent = draft.body_html || draft.body_text || (attachments.length > 0 ? '<p></p>' : '');
  if (!bodyContent && attachments.length === 0) {
    return { error: 'Draft needs a message or attachment before sending', status: 400 };
  }

  const result = await sendEmail({ userId, accountId: draft.mail_account_id }, {
    to,
    cc,
    bcc,
    subject: draft.subject || '(No subject)',
    body: bodyContent,
    isHtml: !!draft.body_html || (!draft.body_text && attachments.length > 0),
    attachments,
    // The reply link the request names, else the one the draft kept.
    ...((await replyThreading(userId, replyTo)) ?? draftThreading(draft) ?? {}),
  });
  // The message is out: a draft that cannot be removed now stays, and the send still succeeded.
  const deleteResult = await deleteDraftWithFiles(userId, draftId).catch((error: unknown) => {
    log.warn('mail', 'a sent draft could not be removed', { userId, code: (error as Error)?.name || 'Error' });
    return { deletedAttachmentFiles: 0, failedAttachmentFiles: 0 };
  });

  return {
    success: true,
    messageId: result.messageId,
    deletedAttachmentFiles: deleteResult.deletedAttachmentFiles || 0,
    failedAttachmentFiles: deleteResult.failedAttachmentFiles || 0,
  };
}

export { saveDraftMutation, loadMailAccountForDraft, loadDraftEmail, deleteDraftWithFiles, deleteDraftUnlessSending, lockDraftForSend, sendStoredDraft, trackDraftSend, isAnyDraftSendRunning };
export type { DraftRow };
