import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { RouteRequest, ApiError } from '../types';
import { FILING_ACCOUNT_SQL } from '../services/mail-folder-reconciliation';
import { folderMembershipSql, pendingMoveSql } from '../services/mail-folder-view';
import { presentMailFiling } from '../services/mail-filing';
import fs from 'fs';
import path from 'path';
import { db } from '../state';
import { toBooleanFlag } from '../services/mail';
import { pendingFlagSql, EFFECTIVE_READ_SQL, EFFECTIVE_STAR_SQL, extractMailRouteId } from './mail-route-helpers';

type Request = RouteRequest & { url: string; params: Record<string, string> };
type Input = unknown;

const MAIL_LIST_PREVIEW_LENGTH = 240;
const MAIL_ATTACHMENT_UPLOAD_ROOT = process.env.MAIL_ATTACHMENT_UPLOAD_ROOT || '/app/uploads/attachments';

export = {
  'GET /api/mail/emails': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    let query: string | undefined, params: (string | number | null)[] | undefined, folder: string | null | undefined, accountId: string | null | undefined;
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      folder = url.searchParams.get('folder');
      accountId = url.searchParams.get('account_id');
      const hasFolderFilter = !!folder && folder !== 'all';
      const hasAccountFilter = !!accountId && accountId !== 'all';
      const isReadParam = url.searchParams.get('is_read');
      const isStarredParam = url.searchParams.get('is_starred');
      const searchParam = (url.searchParams.get('search') || '').trim();
      const includeCount = url.searchParams.get('include_count') !== 'false';
      const where = ['user_id = ?'];
      params = [userId];

      if (folder === 'starred') {
        where.push(`${EFFECTIVE_STAR_SQL} = 1`);
      } else if (hasFolderFilter) {
        where.push(folderMembershipSql);
        params.push(folder, folder, folder);
      }

      if (hasAccountFilter) {
        where.push(accountId === 'legacy' ? 'is_legacy = TRUE' : `is_legacy = FALSE AND ${FILING_ACCOUNT_SQL} = ?`);
        if (accountId !== 'legacy') params.push(accountId);
      }

      if (isReadParam === 'true' || isReadParam === 'false') {
        where.push(`${EFFECTIVE_READ_SQL} = ?`);
        params.push(isReadParam === 'true' ? 1 : 0);
      }

      if (isStarredParam === 'true' || isStarredParam === 'false') {
        where.push(`${EFFECTIVE_STAR_SQL} = ?`);
        params.push(isStarredParam === 'true' ? 1 : 0);
      }

      if (searchParam) {
        const searchValue = `%${searchParam.toLowerCase()}%`;
        where.push(`(
          LOWER(COALESCE(subject, '')) LIKE ? OR
          LOWER(COALESCE(from_name, '')) LIKE ? OR
          LOWER(COALESCE(from_address, '')) LIKE ? OR
          LOWER(COALESCE(body_text, '')) LIKE ?
        )`);
        params.push(searchValue, searchValue, searchValue, searchValue);
      }

      // Pagination
      const requestedLimit = parseInt(url.searchParams.get('limit') || '50', 10);
      const requestedOffset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
      const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
      const page = Math.max(1, Math.floor(offset / limit) + 1);
      const whereSql = where.join(' AND ');

      // Use template literals for LIMIT/OFFSET since they're already sanitized integers
      // This avoids parameter binding issues with mysql2
      query = `
        SELECT
          id,
          user_id,
          mail_account_id, filing_account_id, is_legacy, remote_missing,
          message_id,
          subject,
          from_address,
          from_name,
          to_addresses,
          CASE
            WHEN body_text IS NULL THEN NULL
            WHEN CHAR_LENGTH(body_text) > ${MAIL_LIST_PREVIEW_LENGTH}
              THEN CONCAT(LEFT(body_text, ${MAIL_LIST_PREVIEW_LENGTH}), '...')
            ELSE body_text
          END AS body_text,
          NULL AS body_html,
          COALESCE(${pendingMoveSql}, folder) AS folder,
          source_folder,
          imap_uid,
          imap_uidvalidity,
          raw_storage_path,
          raw_sha256,
          ${EFFECTIVE_READ_SQL} AS is_read,
          ${EFFECTIVE_STAR_SQL} AS is_starred,
          ${pendingFlagSql('read')} AS read_sync_pending,
          ${pendingFlagSql('star')} AS star_sync_pending,
          is_draft,
          has_attachments,
          received_at,
          created_at
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

      // Parse JSON fields
      const parsedEmails = emails.map(email => ({
        ...presentMailFiling(email),
        ...(hasFolderFilter && folder !== 'starred' ? { folder } : {}),
        to_addresses: typeof email.to_addresses === 'string' ? JSON.parse(email.to_addresses || '[]') : email.to_addresses,
        is_read: toBooleanFlag(email.is_read),
        is_starred: toBooleanFlag(email.is_starred),
        read_sync_pending: !!email.read_sync_pending,
        star_sync_pending: !!email.star_sync_pending,
        is_draft: !!email.is_draft,
      }));
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
      return { error: 'Failed to get emails', status: 500 };
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
        to_addresses: typeof email.to_addresses === 'string' ? JSON.parse(email.to_addresses || '[]') : email.to_addresses,
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

      return { email: parsedEmail };
    } catch (error) {
      return { error: 'Failed to get email', status: 500 };
    }
  },

  'GET /api/mail/attachments/:id': async (req: Request, userId: string | null, body: Input, res: import('node:http').ServerResponse) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const parts = req.url.split('?')[0].split('/');
      const attachmentId = parts[parts.length - 1];

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
        const uploadsRoot = path.resolve(MAIL_ATTACHMENT_UPLOAD_ROOT);
        const resolvedPath = path.resolve(attachment.storage_path || '');
        if (!resolvedPath.startsWith(`${uploadsRoot}${path.sep}`) && resolvedPath !== uploadsRoot) {
          console.error('[ATTACH] Rejected attachment path outside uploads root:', resolvedPath);
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
        return { error: 'Failed to read attachment file', status: 500 };
      }
    } catch (error) {
      console.error('[ATTACH] Error:', error);
      return { error: 'Failed to fetch attachment', status: 500 };
    }
  },
};
