import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { RouteRequest, ApiError } from '../types';
import crypto from 'crypto';
import fs from 'fs';
import { promisify } from 'util';
import { db } from '../state';
import { debugLog } from '../logger';
import {
  toBooleanFlag,
  ensureDefaultMailFoldersForUser,
  sendEmail,
  deleteStoredAttachmentFiles,
} from '../services/mail';
import { saveDraftMutation } from '../services/mail-drafts';
import { extractMailRouteId } from './mail-route-helpers';

type Request = RouteRequest & { url: string; params: Record<string, string> };
interface DraftRow extends RowDataPacket {
  mail_account_id: string;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
}
interface Input {
  account_id?: string;
  isHtml?: boolean;
  to?: string;
  subject?: string;
  body?: string;
  body_html?: string;
  attachments?: unknown;
  existing_attachment_ids?: unknown[] | null;
}

const readFile = promisify(fs.readFile);
const MAIL_DRAFT_FOLDER = 'drafts';

function htmlToDraftText(value: unknown) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeDraftRecipients(value: unknown) {
  return String(value || '')
    .split(',')
    .map(part => {
      const trimmed = part.trim();
      const match = trimmed.match(/^(.+?)\s*<(.+?)>$/);
      return (match ? match[2] : trimmed).trim();
    })
    .filter(Boolean);
}

function formatDraftRecipients(value: unknown) {
  const recipients = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? JSON.parse(value || '[]')
      : [];
  return recipients.filter(Boolean).join(', ');
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
    to_addresses: typeof draft.to_addresses === 'string' ? JSON.parse(draft.to_addresses || '[]') : draft.to_addresses,
    is_read: toBooleanFlag(draft.is_read),
    is_starred: toBooleanFlag(draft.is_starred),
    is_draft: !!draft.is_draft,
    has_attachments: !!draft.has_attachments,
    attachments: attachments || [],
  };
}

async function deleteDraftWithFiles(userId: string, draftId: string) {
  const draft = await loadDraftEmail(userId, draftId);
  if (!draft) return { error: 'Draft not found', status: 404 };
  const [attachments] = await db.execute<RowDataPacket[]>(
    'SELECT storage_path FROM email_attachments WHERE email_id = ? AND user_id = ?',
    [draftId, userId]
  );
  await db.execute<RowDataPacket[]>('DELETE FROM emails WHERE id = ? AND user_id = ? AND is_draft = TRUE', [draftId, userId]);
  const fileResult = await deleteStoredAttachmentFiles((attachments || []).map(row => row.storage_path));
  return {
    deleted: true,
    deletedAttachmentFiles: fileResult.deletedFiles,
    failedAttachmentFiles: fileResult.failedFiles,
  };
}

export = {
  'POST /api/mail/drafts': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const account = await loadMailAccountForDraft(userId, body?.account_id);
      if (!account) return { error: 'Account not found', status: 404 };

      const draftId = crypto.randomUUID();
      const isHtml = body?.isHtml !== false;
      const draftBody = String(body?.body_html ?? body?.body ?? '');
      const bodyText = isHtml ? htmlToDraftText(draftBody) : draftBody;
      const bodyHtml = isHtml ? draftBody : null;
      const toAddresses = normalizeDraftRecipients(body?.to);
      const subject = String(body?.subject ?? '');

      await ensureDefaultMailFoldersForUser(userId);
      await saveDraftMutation({ db, userId, emailId: draftId, isNew: true, body,
        deleteFiles: deleteStoredAttachmentFiles,
        mutate: (connection) => connection.execute(
        `INSERT INTO emails
          (id, user_id, mail_account_id, message_id, subject, from_address, from_name, to_addresses,
           body_text, body_html, has_attachments, received_at, folder, is_read, is_draft)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, UTC_TIMESTAMP(), ?, TRUE, TRUE)`,
        [
          draftId,
          userId,
          account.id,
          `<draft-${draftId}@unihub.local>`,
          subject || null,
          account.email_address,
          account.display_name || null,
          JSON.stringify(toAddresses),
          bodyText || null,
          bodyHtml,
          MAIL_DRAFT_FOLDER,
        ]
        ),
      });

      return { draft: await loadDraftEmail(userId, draftId) };
    } catch (error) {
      console.error('Create draft error:', error);
      return { error: (error as ApiError).message || 'Failed to save draft', status: (error as ApiError).status || 500 };
    }
  },

  'PUT /api/mail/drafts/:id': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const draftId = extractMailRouteId(req)!;
      const current = await loadDraftEmail(userId, draftId);
      if (!current) return { error: 'Draft not found', status: 404 };

      let account = null;
      if (body?.account_id !== undefined && body.account_id !== current.mail_account_id) {
        account = await loadMailAccountForDraft(userId, body.account_id);
        if (!account) return { error: 'Account not found', status: 404 };
      }

      const updates = ['received_at = UTC_TIMESTAMP()', 'folder = ?', 'is_draft = TRUE', 'is_read = TRUE'];
      const params: (string | null)[] = [MAIL_DRAFT_FOLDER];

      if (account) {
        updates.push('mail_account_id = ?', 'from_address = ?', 'from_name = ?');
        params.push(account.id, account.email_address, account.display_name || null);
      }
      if (body?.to !== undefined) {
        updates.push('to_addresses = ?');
        params.push(JSON.stringify(normalizeDraftRecipients(body.to)));
      }
      if (body?.subject !== undefined) {
        updates.push('subject = ?');
        params.push(String(body.subject || '') || null);
      }
      if (body?.body !== undefined || body?.body_html !== undefined) {
        const isHtml = body?.isHtml !== false;
        const draftBody = String(body.body_html ?? body.body ?? '');
        updates.push('body_text = ?', 'body_html = ?');
        params.push(isHtml ? htmlToDraftText(draftBody) || null : draftBody || null, isHtml ? draftBody : null);
      }

      params.push(draftId, userId);
      await saveDraftMutation({ db, userId, emailId: draftId, body,
        deleteFiles: deleteStoredAttachmentFiles,
        mutate: (connection) => connection.execute(
          `UPDATE emails SET ${updates.join(', ')} WHERE id = ? AND user_id = ? AND is_draft = TRUE`, params
        ),
      });

      return { draft: await loadDraftEmail(userId, draftId) };
    } catch (error) {
      console.error('Update draft error:', error);
      return { error: (error as ApiError).message || 'Failed to update draft', status: (error as ApiError).status || 500 };
    }
  },

  'DELETE /api/mail/drafts/:id': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      return await deleteDraftWithFiles(userId, extractMailRouteId(req)!);
    } catch (error) {
      console.error('Delete draft error:', error);
      return { error: (error as ApiError).message || 'Failed to delete draft', status: 500 };
    }
  },

  'POST /api/mail/drafts/:id/send': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const draftId = extractMailRouteId(req, 2)!;
      const draft = await loadDraftEmail(userId, draftId);
      if (!draft) return { error: 'Draft not found', status: 404 };

      const account = await loadMailAccountForDraft(userId, draft.mail_account_id);
      if (!account) return { error: 'Account not found', status: 404 };

      const to = formatDraftRecipients(draft.to_addresses);
      if (!to) return { error: 'Draft needs at least one recipient before sending', status: 400 };

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

      const result = await sendEmail(draft.mail_account_id, {
        to,
        subject: draft.subject || '(No subject)',
        body: bodyContent,
        isHtml: !!draft.body_html || attachments.length > 0,
        attachments,
      });
      const deleteResult = await deleteDraftWithFiles(userId, draftId);

      return {
        success: true,
        messageId: result.messageId,
        deletedAttachmentFiles: deleteResult.deletedAttachmentFiles || 0,
        failedAttachmentFiles: deleteResult.failedAttachmentFiles || 0,
      };
    } catch (error) {
      console.error('Send draft error:', error);
      return { error: (error as ApiError).message || 'Failed to send draft', status: (error as ApiError).status || 500 };
    }
  },

  // Emails endpoints

  'POST /api/mail/send': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const { account_id, to, subject, body: emailBody, isHtml, attachments } = body;
      if (!account_id || !to || !subject || !emailBody) {
        return { error: 'Missing required fields', status: 400 };
      }
      if (attachments !== undefined && !Array.isArray(attachments)) {
        return { error: 'attachments must be an array', status: 400 };
      }

      // Verify account belongs to user
      const [accounts] = await db.execute<RowDataPacket[]>(
        'SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?',
        [account_id, userId]
      );
      if (accounts.length === 0) return { error: 'Account not found', status: 404 };

      // #region agent log
      debugLog('server.js:1440', 'POST /mail/send START', { account_id, to, subject, userId }, 'H5');
      // #endregion
      const result = await sendEmail(account_id, { to, subject, body: emailBody, isHtml, attachments: attachments || [] });
      // #region agent log
      debugLog('server.js:1441', 'POST /mail/send SUCCESS', { messageId: result.messageId }, 'H5');
      // #endregion
      return { ...result, success: true, messageId: result.messageId };
    } catch (error) {
      // #region agent log
      debugLog('server.js:1442', 'POST /mail/send ERROR', { errorMessage: (error as ApiError).message, errorStack: (error as ApiError).stack?.substring(0, 200) }, 'H5');
      // #endregion
      console.error('Send email error:', error);
      return { error: (error as ApiError).message || 'Failed to send email', status: (error as ApiError).status || 500 };
    }
  },
};
