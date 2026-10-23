import type { RowDataPacket } from 'mysql2/promise';
import type { RouteRequest, ApiError } from '../types';
import crypto from 'crypto';
import fs from 'fs';
import { promisify } from 'util';
import { db } from '../state';
import {
  toBooleanFlag,
  ensureDefaultMailFoldersForUser,
  sendEmail,
  sendOnce,
  replyThreading,
  deleteStoredAttachmentFiles,
} from '../services/mail';
import { draftThreading } from '../services/mail-send';
import { adoptReplies, resolveThreadKey, storedReferences } from '../services/mail-threading';
import type { ReplyThreading } from '../services/mail-send';
import type { PoolConnection } from 'mysql2/promise';
import { saveDraftMutation } from '../services/mail-drafts';
import { normalizeRecipients, parseStoredRecipients } from '../services/mail-recipients';
import { extractMailRouteId, routeError, idempotencyKey } from './mail-route-helpers';

type Request = RouteRequest & { url: string; params: Record<string, string> };
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
interface Input {
  account_id?: string;
  isHtml?: boolean;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  body_html?: string;
  attachments?: unknown;
  existing_attachment_ids?: unknown[] | null;
  /** The UniHub id of the message a reply answers; on a draft, null or '' removes the reply link. */
  in_reply_to_email_id?: unknown;
}

const readFile = promisify(fs.readFile);
const MAIL_DRAFT_FOLDER = 'drafts';
const RECIPIENT_FIELDS = ['to', 'cc', 'bcc'] as const;
const MAX_RECIPIENT_FIELD_LENGTH = 10000;

function recipientFieldError(body: Input | undefined) {
  for (const field of RECIPIENT_FIELDS) {
    const value = body?.[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `${field} must be a string`;
    if (value.length > MAX_RECIPIENT_FIELD_LENGTH) return `${field} is too long`;
    if (/[\r\n]/.test(value)) return `${field} must be on one line`;
  }
  return null;
}

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

const draftRecipients = (value: unknown) => {
  const recipients = normalizeRecipients(value);
  return recipients.length ? JSON.stringify(recipients) : null;
};

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

// A composer names each file it uploads (client_id); the answer pairs those
// names with the attachments they became, so the composer never guesses which
// stored attachment is which of its files.
const CLIENT_ID = /^[A-Za-z0-9-]{1,64}$/;
function uploadedAttachments(attachments: unknown, ids: string[]) {
  if (!Array.isArray(attachments)) return [];
  return ids.flatMap((id, index) => {
    const clientId = (attachments[index] as { client_id?: unknown } | null)?.client_id;
    return typeof clientId === 'string' && CLIENT_ID.test(clientId) ? [{ client_id: clientId, id }] : [];
  });
}

// A reply draft keeps the threading of the message it answers (0.24), so a
// reply finished later from Drafts still goes out with In-Reply-To and
// References. The draft's own conversation is the parent's.
async function draftThreadColumns(connection: PoolConnection, { userId, draftId, threading, subject, participants }:
  { userId: string; draftId: string; threading: ReplyThreading | null; subject: string | null; participants: string[] }) {
  const messageId = `<draft-${draftId}@unihub.local>`;
  const threadKey = threading?.threadKey ?? await resolveThreadKey(connection, { userId, emailId: draftId, messageId,
    inReplyTo: threading?.inReplyTo ?? null, references: threading?.references ?? [], subject, receivedAt: new Date(), participants });
  return { in_reply_to: threading?.inReplyTo ?? null, references_header: storedReferences(threading?.references ?? []), thread_key: threadKey,
    adopt: () => adoptReplies(connection, { userId, messageId, threadKey }) };
}
const replyLinkGiven = (value: unknown) => value !== undefined;
const replyLinkRemoved = (value: unknown) => value === null || value === '';

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

export = {
  'POST /api/mail/drafts': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const invalidRecipients = recipientFieldError(body);
      if (invalidRecipients) return { error: invalidRecipients, status: 400 };
      const account = await loadMailAccountForDraft(userId, body?.account_id);
      if (!account) return { error: 'Account not found', status: 404 };

      const draftId = crypto.randomUUID();
      const isHtml = body?.isHtml !== false;
      const draftBody = String(body?.body_html ?? body?.body ?? '');
      const bodyText = isHtml ? htmlToDraftText(draftBody) : draftBody;
      const bodyHtml = isHtml ? draftBody : null;
      const subject = String(body?.subject ?? '');
      const threading = replyLinkRemoved(body?.in_reply_to_email_id) ? null : await replyThreading(userId, body?.in_reply_to_email_id);
      const participants = [account.email_address, ...normalizeRecipients(body?.to), ...normalizeRecipients(body?.cc), ...normalizeRecipients(body?.bcc)];

      await ensureDefaultMailFoldersForUser(userId);
      const ids = await saveDraftMutation({ db, userId, emailId: draftId, isNew: true, body,
        deleteFiles: deleteStoredAttachmentFiles,
        mutate: async (connection) => {
        const thread = await draftThreadColumns(connection, { userId, draftId, threading, subject: subject || null, participants });
        await connection.execute(
        `INSERT INTO emails
          (id, user_id, mail_account_id, message_id, subject, from_address, from_name, to_addresses,
           cc_addresses, bcc_addresses, body_text, body_html, has_attachments, received_at, folder, is_read, is_draft,
           in_reply_to, references_header, thread_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, UTC_TIMESTAMP(), ?, TRUE, TRUE, ?, ?, ?)`,
        [
          draftId,
          userId,
          account.id,
          `<draft-${draftId}@unihub.local>`,
          subject || null,
          account.email_address,
          account.display_name || null,
          JSON.stringify(normalizeRecipients(body?.to)),
          draftRecipients(body?.cc),
          draftRecipients(body?.bcc),
          bodyText || null,
          bodyHtml,
          MAIL_DRAFT_FOLDER,
          thread.in_reply_to,
          thread.references_header,
          thread.thread_key,
        ]
        );
        await thread.adopt();
        },
      });

      return { draft: await loadDraftEmail(userId, draftId), uploaded: uploadedAttachments(body?.attachments, ids) };
    } catch (error) {
      console.error('Create draft error:', error);
      return routeError(error, 'Failed to save draft');
    }
  },

  'PUT /api/mail/drafts/:id': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const invalidRecipients = recipientFieldError(body);
      if (invalidRecipients) return { error: invalidRecipients, status: 400 };
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
        params.push(JSON.stringify(normalizeRecipients(body.to)));
      }
      if (body?.cc !== undefined) {
        updates.push('cc_addresses = ?');
        params.push(draftRecipients(body.cc));
      }
      if (body?.bcc !== undefined) {
        updates.push('bcc_addresses = ?');
        params.push(draftRecipients(body.bcc));
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

      const relink = replyLinkGiven(body?.in_reply_to_email_id);
      const threading = relink && !replyLinkRemoved(body?.in_reply_to_email_id) ? await replyThreading(userId, body?.in_reply_to_email_id) : null;

      const ids = await saveDraftMutation({ db, userId, emailId: draftId, body,
        deleteFiles: deleteStoredAttachmentFiles,
        mutate: async (connection) => {
          const thread = relink ? await draftThreadColumns(connection, { userId, draftId, threading,
            subject: body?.subject !== undefined ? String(body.subject || '') || null : current.subject,
            participants: [account?.email_address ?? current.from_address, ...normalizeRecipients(body?.to ?? current.to_addresses),
              ...normalizeRecipients(body?.cc ?? current.cc_addresses)] }) : null;
          const threadUpdates = thread ? ['in_reply_to = ?', 'references_header = ?', 'thread_key = ?'] : [];
          await connection.execute(
            `UPDATE emails SET ${[...updates, ...threadUpdates].join(', ')} WHERE id = ? AND user_id = ? AND is_draft = TRUE`,
            [...params, ...(thread ? [thread.in_reply_to, thread.references_header, thread.thread_key] : []), draftId, userId]
          );
          await thread?.adopt();
        },
      });

      return { draft: await loadDraftEmail(userId, draftId), uploaded: uploadedAttachments(body?.attachments, ids) };
    } catch (error) {
      console.error('Update draft error:', error);
      return routeError(error, 'Failed to update draft');
    }
  },

  'DELETE /api/mail/drafts/:id': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      return await deleteDraftWithFiles(userId, extractMailRouteId(req)!);
    } catch (error) {
      console.error('Delete draft error:', error);
      return routeError(error, 'Failed to delete draft');
    }
  },

  'POST /api/mail/drafts/:id/send': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const draftId = extractMailRouteId(req, 2)!;
      const replyTo = body?.in_reply_to_email_id;
      // A repeat after a lost response gets the first result, before the (deleted) draft is looked up.
      return await sendOnce({ userId, clientKey: idempotencyKey(req), request: { draftId, replyTo } }, async () => {
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
        console.error('Send draft cleanup error:', (error as Error)?.name || 'Error');
        return { deletedAttachmentFiles: 0, failedAttachmentFiles: 0 };
      });

      return {
        success: true,
        messageId: result.messageId,
        deletedAttachmentFiles: deleteResult.deletedAttachmentFiles || 0,
        failedAttachmentFiles: deleteResult.failedAttachmentFiles || 0,
      };
      });
    } catch (error) {
      console.error('Send draft error:', (error as NodeJS.ErrnoException)?.code || (error as Error)?.name || 'Error');
      return routeError(error, 'Failed to send draft');
    }
  },

  // Emails endpoints

  'POST /api/mail/send': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const { account_id, to, cc, bcc, subject, body: emailBody, isHtml, attachments, in_reply_to_email_id } = body;
      const invalidRecipients = recipientFieldError(body);
      if (invalidRecipients) return { error: invalidRecipients, status: 400 };
      if (!account_id || !(to?.trim() || cc?.trim() || bcc?.trim()) || !subject || !emailBody) {
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

      const message = { to: to || '', cc, bcc, subject, body: emailBody, isHtml, attachments: attachments || [] };
      return await sendOnce({ userId, clientKey: idempotencyKey(req), request: { account_id, ...message, in_reply_to_email_id } }, async () => {
        const result = await sendEmail({ userId, accountId: account_id }, { ...message, ...(await replyThreading(userId, in_reply_to_email_id) ?? {}) });
        return { ...result, success: true, messageId: result.messageId };
      });
    } catch (error) {
      // SMTP errors carry the rejected recipients in their message and fields; the log gets the kind only.
      console.error('Send email error:', (error as NodeJS.ErrnoException)?.code || (error as Error)?.name || 'Error');
      return routeError(error, 'Failed to send email');
    }
  },
};
