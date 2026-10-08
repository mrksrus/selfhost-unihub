import type { RowDataPacket } from 'mysql2/promise';
import type { RouteRequest, ApiError } from '../types';
import * as mailWritebacks from '../services/mail-writebacks';
import * as mailRepository from '../services/mail-engine/repository';
import { folderConnections } from '../services/mail-folder-reconciliation';
import { filingAccountId, folderAcceptsAccount } from '../services/mail-filing';
import crypto from 'crypto';
import { db } from '../state';
import { validateUserMailFolder } from './mail-route-helpers';

type Request = RouteRequest & { url: string; params: Record<string, string> };
interface Input {
  is_read?: unknown;
  is_starred?: unknown;
  email_ids?: string[];
  folder?: unknown;
  account_id?: unknown;
}

function operationOptions(req: Request) {
  const key = req.headers?.['idempotency-key'];
  if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))) {
    throw Object.assign(new Error('Invalid Idempotency-Key'), { status: 400 });
  }
  return { idempotencyKey: key };
}

export = {
  'GET /api/mail/writebacks': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const result = await mailWritebacks.listWritebacks(userId, { accountId: query.get('account_id'), includeHistory: query.get('history') === 'true' });
      return Array.isArray(result) ? { operations: result } : result;
    } catch (error) { return { error: (error as ApiError).status ? (error as ApiError).message : 'Could not load provider changes', status: (error as ApiError).status || 500 }; }
  },

  'GET /api/mail/operations': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const key = new URL(req.url, 'http://localhost').searchParams.get('key');
      if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) return { error: 'Valid operation key required', status: 400 };
      return await mailWritebacks.getOperationReceipt(userId, key);
    } catch (error) { return { error: (error as ApiError).status ? (error as ApiError).message : 'Could not look up accepted change', status: (error as ApiError).status || 500 }; }
  },

  'POST /api/mail/writebacks/:id/cancel': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try { return await mailWritebacks.cancelWriteback(userId, req.params.id); }
    catch (error) { return { error: (error as ApiError).status ? (error as ApiError).message : 'Could not cancel provider change', status: (error as ApiError).status || 500 }; }
  },

  'POST /api/mail/writebacks/:id/retry': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try { return await mailWritebacks.retryWriteback(userId, req.params.id); }
    catch (error) { return { error: (error as ApiError).status ? (error as ApiError).message : 'Could not retry provider update', status: (error as ApiError).status || 500 }; }
  },

  'POST /api/mail/writebacks/:id/accept-server-state': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try { return await mailWritebacks.acceptServerState(userId, req.params.id); }
    catch (error) { return { error: (error as ApiError).status ? (error as ApiError).message : 'Could not accept the server state', status: (error as ApiError).status || 500 }; }
  },

  'PUT /api/mail/emails/:id/read': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const parts = req.url.split('?')[0].split('/');
      const id = parts[parts.length - 2];
      if (typeof body.is_read !== 'boolean') return { error: 'Read state must be boolean', status: 400 };
      return await mailWritebacks.mutateMessages(userId, [id], { read: Number(body.is_read) }, undefined, operationOptions(req));
    } catch (error) {
      return { error: (error as ApiError).status ? (error as ApiError).message : 'Failed to update email', status: (error as ApiError).status || 500 };
    }
  },

  'PUT /api/mail/emails/:id/star': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const parts = req.url.split('?')[0].split('/');
      const id = parts[parts.length - 2];
      if (typeof body.is_starred !== 'boolean') return { error: 'Star state must be boolean', status: 400 };
      return await mailWritebacks.mutateMessages(userId, [id], { star: Number(body.is_starred) }, undefined, operationOptions(req));
    } catch (error) {
      return { error: (error as ApiError).status ? (error as ApiError).message : 'Failed to update email', status: (error as ApiError).status || 500 };
    }
  },

  'POST /api/mail/emails/bulk-delete': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const { email_ids } = body;
      if (!Array.isArray(email_ids) || email_ids.length === 0) {
        return { error: 'Email IDs array required', status: 400 };
      }

      return await mailWritebacks.mutateMessages(userId, email_ids, { move: 'trash' }, undefined, operationOptions(req));
    } catch (error) {
      console.error('[BULK] Delete error:', error);
      return { error: (error as ApiError).status ? (error as ApiError).message : 'Failed to delete emails', status: (error as ApiError).status || 500 };
    }
  },

  'POST /api/mail/emails/bulk-move': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const { folder } = body;
      const options = operationOptions(req);
      if (!Array.isArray(body.email_ids) || !body.email_ids.length || body.email_ids.length > 500 || body.email_ids.some(id => typeof id !== 'string' || !id)) {
        return { error: 'Select between 1 and 500 messages.', status: 400 };
      }
      const email_ids = [...new Set(body.email_ids)].sort();
      const folderValidation = await validateUserMailFolder(userId, folder);
      if (folderValidation.error) return folderValidation;

      const requestedAccount = String(body.account_id || '').trim() || null;
      const links = await folderConnections(userId);
      if (requestedAccount) {
        const [owned] = await db.execute<RowDataPacket[]>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?', [requestedAccount, userId]);
        if (!owned.length) return { error: 'Receiving account not found', status: 400 };
      }
      if (!requestedAccount) {
        return await mailWritebacks.mutateMessages(userId, email_ids, { move: folderValidation.folder! }, async (_connection, selected) => {
          for (const email of selected) {
            if (email.is_legacy || !folderAcceptsAccount({ slug: folderValidation.folder!, mail_account_id: folderValidation.accountId, is_system: folderValidation.isSystem }, filingAccountId(email), links)) {
              throw Object.assign(new Error('Choose a folder connected to the message account; Legacy mail needs a receiving account.'), { status: 400 });
            }
          }
        }, options);
      }
      const localHash = crypto.createHash('sha256').update(JSON.stringify({ kind: 'legacy-recovery',
        ids: email_ids, folder: folderValidation.folder!, account_id: requestedAccount })).digest('hex');
      const replay = (saved: Record<string, unknown>) => saved.recovery_required
        ? { ...saved, sync_pending: false, message: 'Recovered command requires review; no operation was replayed' } : saved;
      const response = { message: `Filed ${email_ids.length} email(s) locally in ${folderValidation.folder!}. Provider mail was not changed.`,
        sync_pending: false, operation_ids: [], accepted_revision: null, local_only: true };
      const refuse = (message: string, status: number) => Object.assign(new Error(message), { status, refusal: true });
      const placeholders = email_ids.map(() => '?').join(',');
      try {
        return await mailRepository.withTransaction(async connection => {
          if (options.idempotencyKey) {
            let receipt;
            try {
              receipt = await mailRepository.recordReceipt({ userId, clientKey: options.idempotencyKey, requestHash: localHash, response }, connection);
            } catch (error) {
              if ((error as ApiError).code === 'IDEMPOTENCY_KEY_REUSED') throw refuse('Idempotency-Key already used for a different request', 409);
              throw error;
            }
            if (receipt.replayed) return replay(receipt.response as Record<string, unknown>);
          }
          const [selected] = await connection.execute<RowDataPacket[]>(
            `SELECT id, mail_account_id, filing_account_id, folder, is_legacy FROM emails
             WHERE id IN (${placeholders}) AND user_id = ? FOR UPDATE`, [...email_ids, userId]);
          if (selected.length !== new Set(email_ids).size) throw refuse('Some selected emails are unavailable', 404);
          for (const email of selected) {
            const targetAccount = requestedAccount || filingAccountId(email);
            if ((requestedAccount && !email.is_legacy) || (!requestedAccount && email.is_legacy)
              || !folderAcceptsAccount({ slug: folderValidation.folder!, mail_account_id: folderValidation.accountId, is_system: folderValidation.isSystem }, targetAccount, links)) {
              throw refuse('Move cancelled. Choose a receiving account for Legacy mail and a folder connected to that account.', 400);
            }
          }
          if (requestedAccount) {
            for (const email of selected) {
              await connection.execute(`INSERT INTO mail_folder_recovery_items
                (email_id, user_id, source_account_id, original_folder, original_filing_account_id, target_folder, target_account_id, action)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'manual') ON DUPLICATE KEY UPDATE
                target_folder = VALUES(target_folder), target_account_id = VALUES(target_account_id), action = 'manual'`,
              [email.id, userId, email.mail_account_id, email.folder, email.filing_account_id, folderValidation.folder!, requestedAccount]);
            }
            await connection.execute(`UPDATE emails SET folder = ?, filing_account_id = ?, is_legacy = FALSE
              WHERE id IN (${placeholders}) AND user_id = ?`, [folderValidation.folder!, requestedAccount, ...email_ids, userId]);
          } else {
            await connection.execute(`UPDATE emails SET folder = ? WHERE id IN (${placeholders}) AND user_id = ?`,
              [folderValidation.folder!, ...email_ids, userId]);
          }
          return response;
        }, db);
      } catch (error) {
        if ((error as ApiError & { refusal?: boolean }).refusal) return { error: (error as ApiError).message, status: (error as ApiError).status };
        throw error;
      }
    } catch (error) {
      console.error('[BULK] Move error:', error);
      return { error: (error as ApiError).status ? (error as ApiError).message : 'Failed to move emails', status: (error as ApiError).status || 500 };
    }
  },

  'POST /api/mail/emails/bulk-update': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const { email_ids, is_read, is_starred } = body;
      if (!Array.isArray(email_ids) || email_ids.length === 0) {
        return { error: 'Email IDs array required', status: 400 };
      }

      const updates = [];
      const values = [];

      if (typeof is_read === 'boolean') {
        updates.push('is_read = ?');
        values.push(is_read ? 1 : 0);
      }
      if (typeof is_starred === 'boolean') {
        updates.push('is_starred = ?');
        values.push(is_starred ? 1 : 0);
      }

      if (updates.length === 0) {
        return { error: 'At least one field (is_read or is_starred) required', status: 400 };
      }

      const changes: Record<string, number> = {};
      if (typeof is_read === 'boolean') changes.read = Number(is_read);
      if (typeof is_starred === 'boolean') changes.star = Number(is_starred);
      return await mailWritebacks.mutateMessages(userId, email_ids, changes, undefined, operationOptions(req));
    } catch (error) {
      console.error('[BULK] Update error:', error);
      return { error: (error as ApiError).status ? (error as ApiError).message : 'Failed to update emails', status: (error as ApiError).status || 500 };
    }
  },
};
