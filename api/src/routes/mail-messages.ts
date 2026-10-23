import type { RowDataPacket } from 'mysql2/promise';
import type { RouteRequest, ApiError } from '../types';
import { presentMailFiling } from '../services/mail-filing';
import { mailListColumns, mailListView, presentMailListRow } from '../services/mail-list';
import { parseStoredRecipients } from '../services/mail-recipients';
import fs from 'fs';
import { db } from '../state';
import { mailPathUnderRoot } from '../services/mail-storage';
import { tasksForEmail } from '../services/email-tasks';
import { isModuleEnabled } from '../services/module-settings';
import { toBooleanFlag } from '../services/mail';
import { pendingFlagSql, EFFECTIVE_READ_SQL, EFFECTIVE_STAR_SQL, extractMailRouteId, routeError } from './mail-route-helpers';

type Request = RouteRequest & { url: string; params: Record<string, string> };
type Input = unknown;

export = {
  'GET /api/mail/emails': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    let query: string | undefined, params: (string | number | Date | null)[] | undefined, folder: string | null | undefined, accountId: string | null | undefined;
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      // The view and row shape are shared with the conversation list (services/mail-list.ts).
      const view = mailListView(url.searchParams, userId);
      ({ folder, accountId, params } = view);
      const { hasFolderFilter, hasAccountFilter, includeCount, limit, offset, page, whereSql } = view;

      // Use template literals for LIMIT/OFFSET since they're already sanitized integers
      // This avoids parameter binding issues with mysql2
      query = `
        SELECT ${await mailListColumns(userId)}
        FROM emails
        WHERE ${whereSql}
        ORDER BY received_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}`;

      // Get total count for pagination
      let total = null;
      if (includeCount) {
        const countQuery = `SELECT COUNT(*) as total FROM emails WHERE ${whereSql}`;
        const [countResult] = await db.execute<RowDataPacket[]>(countQuery, params);
        total = countResult[0]?.total || 0;
      }

      const [emails] = await db.execute<RowDataPacket[]>(query, params);
      console.log(`[API] GET /api/mail/emails: Found ${emails.length} emails for user ${userId}, folder ${hasFolderFilter ? folder : 'all'}, account ${hasAccountFilter ? accountId : 'all'}, total ${includeCount ? total : 'not requested'}`);

      const parsedEmails = emails.map(email => presentMailListRow(email, view));
      return {
        emails: parsedEmails,
        pagination: {
          total,
          limit,
          offset,
          page,
          totalPages: includeCount ? Math.ceil(total / limit) : null,
          hasMore: emails.length === limit,
        }
      };
    } catch (error) {
      console.error(`[API] GET /api/mail/emails ERROR:`, (error as ApiError).message);
      console.error(`[API] Query:`, query || 'N/A');
      console.error(`[API] Params:`, params || 'N/A');
      console.error(`[API] Folder:`, folder || 'N/A', `AccountId:`, accountId || 'N/A');
      console.error(`[API] Error stack:`, (error as ApiError).stack);
      return routeError(error, 'Failed to get emails');
    }
  },

  'GET /api/mail/emails/:id': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const id = extractMailRouteId(req)!;
      const [emails] = await db.execute<RowDataPacket[]>(
        `SELECT emails.*, ${EFFECTIVE_READ_SQL} AS effective_is_read,
          ${EFFECTIVE_STAR_SQL} AS effective_is_starred,
          ${pendingFlagSql('read')} AS read_sync_pending,
          ${pendingFlagSql('star')} AS star_sync_pending FROM emails WHERE id = ? AND user_id = ?`,
        [id, userId]
      );

      if (emails.length === 0) {
        return { error: 'Email not found', status: 404 };
      }

      const email = emails[0];
      const { effective_is_read, effective_is_starred, ...storedEmail } = email;
      // Parse JSON fields
      const parsedEmail: Record<string, unknown> = {
        ...presentMailFiling(storedEmail),
        to_addresses: parseStoredRecipients(email.to_addresses),
        cc_addresses: parseStoredRecipients(email.cc_addresses),
        bcc_addresses: parseStoredRecipients(email.bcc_addresses),
        is_read: toBooleanFlag(effective_is_read),
        is_starred: toBooleanFlag(effective_is_starred),
        read_sync_pending: !!email.read_sync_pending,
        star_sync_pending: !!email.star_sync_pending,
        is_draft: !!email.is_draft,
      };

      // Fetch attachments (exclude inline attachments from list - they're embedded in HTML)
      const [attachments] = await db.execute<RowDataPacket[]>(
        'SELECT id, filename, content_type, size_bytes, content_id FROM email_attachments WHERE email_id = ? AND user_id = ? ORDER BY filename',
        [id, userId]
      );

      // Separate inline and regular attachments
      const inlineAttachments = attachments.filter(att => att.content_id);
      const regularAttachments = attachments.filter(att => !att.content_id);

      parsedEmail.attachments = regularAttachments.map(att => ({
        id: att.id,
        filename: att.filename,
        content_type: att.content_type,
        size_bytes: att.size_bytes,
      }));

      // Note: Inline attachments are already embedded in body_html via URL replacement
      // The tasks made from this email are Calendar data: none while that module is off.
      parsedEmail.tasks = await isModuleEnabled(userId, 'calendar') ? await tasksForEmail(userId, id) : [];

      return { email: parsedEmail };
    } catch (error) {
      return routeError(error, 'Failed to get email');
    }
  },

  'GET /api/mail/attachments/:id': async (req: Request, userId: string | null, body: Input, res: import('node:http').ServerResponse) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const attachmentId = extractMailRouteId(req)!;

      // Get attachment info and verify it belongs to user's email
      const [attachments] = await db.execute<RowDataPacket[]>(
        `SELECT a.id, a.filename, a.content_type, a.storage_path, a.user_id
         FROM email_attachments a
         WHERE a.id = ? AND a.user_id = ?`,
        [attachmentId, userId]
      );

      if (attachments.length === 0) {
        return { error: 'Attachment not found', status: 404 };
      }

      const attachment = attachments[0];

      // Read file from storage (must stay under attachments root)
      try {
        const resolvedPath = mailPathUnderRoot('attachment', attachment.storage_path);
        if (!resolvedPath) {
          console.error('[ATTACH] Rejected attachment path outside uploads root:', attachment.storage_path);
          return { error: 'Invalid attachment path', status: 400 };
        }

        const fileStat = await fs.promises.stat(resolvedPath);
        if (!fileStat.isFile()) return { error: 'Attachment not found', status: 404 };

        // Reuse the bounded-memory download response used by recordings/backups.
        // Ensure proper content type for PDFs and other common types
        let contentType = attachment.content_type || 'application/octet-stream';
        const filename = attachment.filename || 'download';

        // Fix common content type issues
        if (filename.toLowerCase().endsWith('.pdf') && !contentType.includes('pdf')) {
          contentType = 'application/pdf';
        } else if (filename.toLowerCase().endsWith('.jpg') || filename.toLowerCase().endsWith('.jpeg')) {
          contentType = 'image/jpeg';
        } else if (filename.toLowerCase().endsWith('.png')) {
          contentType = 'image/png';
        } else if (filename.toLowerCase().endsWith('.txt')) {
          contentType = 'text/plain';
        }

        return {
          __streamPath: resolvedPath,
          __contentLength: fileStat.size,
          __contentType: contentType,
          __filename: filename,
        };
      } catch (fileError) {
        console.error(`[ATTACH] Failed to read attachment file:`, (fileError as Error).message);
        return routeError(fileError, 'Failed to read attachment file');
      }
    } catch (error) {
      console.error('[ATTACH] Error:', error);
      return routeError(error, 'Failed to fetch attachment');
    }
  },
};
