import type { RowDataPacket } from 'mysql2/promise';
import type { RouteRequest, ApiError, MailAccountIdentity, StoredFlag } from '../types';
import * as mailWritebacks from '../services/mail-writebacks';
import * as mailAccountLifecycle from '../services/mail-account-lifecycle';
import { mailAccountModeChange, sameProviderMailbox, addressConfirmed } from '../services/mail-account-mode';
import { parseMailAccountInput } from '../services/mail-account-input';
import * as mailSyncPolicy from '../services/mail-sync-policy';
import { withMailAccountLock } from '../services/mail-account-lock';
import { accountUnreadQuery } from '../services/mail-folder-view';
import { keepsSnoozedInLists } from '../services/mail-snooze';
import crypto from 'crypto';
import { db } from '../state';
import { encrypt } from '../security/encryption';
import { inspectMailCertificate, normalizeFingerprint } from '../security/mail-certificates';
import {
  DEFAULT_MAIL_SYNC_FETCH_LIMIT,
  toBooleanFlag,
  ensureDefaultMailFoldersForUser,
  normalizeSyncFetchLimit,
  seedMailServerDeletionQueueForAccount,
  buildMailHostTrustResult,
  validateMailHostPolicy,
  testImapConnection,
  stopMailAccountWork,
  getRunningMailServerDeleteAccountIds,
} from '../services/mail';
import * as calendarAccounts from '../services/calendar-accounts';
import { EFFECTIVE_READ_SQL, extractMailRouteId, routeError } from './mail-route-helpers';
import { createMailAccount, updateMailAccount, confirmSyncPolicy, loadAccountJson, withPolicyFields, ACCOUNT_COLUMNS } from '../services/mail-account-changes';
import type { MailAccountInput, MailAccountRow } from '../services/mail-account-changes';

type Request = RouteRequest & { url: string; params: Record<string, string> };
type Input = MailAccountInput;
type AccountRow = MailAccountRow;

// /api/mail/accounts/:id/<action>: the id is not the last path segment.
const accountRouteId = (req: Request) => req.params?.id || extractMailRouteId(req, 2)!;

export = {
  'GET /api/mail/accounts': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const [accounts] = await db.execute<(RowDataPacket & AccountRow)[]>(`SELECT ${ACCOUNT_COLUMNS} FROM mail_accounts WHERE user_id = ?`, [userId]);
      await ensureDefaultMailFoldersForUser(userId);

      // The badge is the sum of the account's folder counts, so mail that sits
      // in no folder (gone from the server, awaiting cleanup) is not counted.
      const [unreadRows] = await db.execute<(RowDataPacket & AccountRow)[]>(accountUnreadQuery(EFFECTIVE_READ_SQL, await keepsSnoozedInLists(userId)), [userId]);

      const unreadByAccount: Record<string, number> = {};
      for (const row of unreadRows) {
        unreadByAccount[row.mail_account_id] = Number(row.unread_count) || 0;
      }

      const [deleteRows] = await db.execute<(RowDataPacket & AccountRow)[]>(
        `SELECT mail_account_id,
                SUM(CASE WHEN delete_status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
                SUM(CASE WHEN delete_status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
                SUM(CASE WHEN delete_status = 'deleted' THEN 1 ELSE 0 END) AS deleted_count,
                SUM(CASE WHEN delete_status = 'missing' THEN 1 ELSE 0 END) AS missing_count,
                SUM(CASE WHEN delete_status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count
         FROM mail_server_messages
         WHERE user_id = ?
         GROUP BY mail_account_id`,
        [userId]
      );
      const deleteCountsByAccount: Record<string, { pending: number; failed: number; deleted: number; missing: number; skipped: number }> = {};
      for (const row of deleteRows || []) {
        deleteCountsByAccount[row.mail_account_id] = {
          pending: Number(row.pending_count) || 0,
          failed: Number(row.failed_count) || 0,
          deleted: Number(row.deleted_count) || 0,
          missing: Number(row.missing_count) || 0,
          skipped: Number(row.skipped_count) || 0,
        };
      }
      const runningDeleteAccountIds = new Set(getRunningMailServerDeleteAccountIds());

      const accountsWithUnread = (await Promise.all(accounts.map(withPolicyFields))).map((account) => ({
        ...account,
        sync_fetch_limit: normalizeSyncFetchLimit(account.sync_fetch_limit, DEFAULT_MAIL_SYNC_FETCH_LIMIT) || DEFAULT_MAIL_SYNC_FETCH_LIMIT,
        unread_count: unreadByAccount[account.id] || 0,
        server_delete_counts: deleteCountsByAccount[account.id] || { pending: 0, failed: 0, deleted: 0, missing: 0, skipped: 0 },
        server_delete_running: runningDeleteAccountIds.has(account.id),
      }));

      return { accounts: accountsWithUnread };
    } catch (error) {
      return routeError(error, 'Failed to get mail accounts');
    }
  },

  'GET /api/mail/accounts/:id': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const account = await loadAccountJson(userId, extractMailRouteId(req)!);
      return account ? { account } : { error: 'Account not found', status: 404 };
    } catch (error) {
      return routeError(error, 'Failed to get mail account');
    }
  },

  // The same steps as the administrator's path (routes/mail-account-changes.ts).
  'POST /api/mail/accounts': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return await createMailAccount(userId, body);
    } catch (error) {
      if (!(error as ApiError).status) console.error('[ACCOUNT] Create mail account error:', error);
      return routeError(error, 'Failed to create mail account');
    }
  },

  'PUT /api/mail/accounts/:id': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return await updateMailAccount(userId, extractMailRouteId(req)!, body);
    } catch (error) {
      if (!(error as ApiError).status) console.error('[ACCOUNT] Update error:', error);
      return routeError(error, 'Failed to update mail account');
    }
  },

  'GET /api/mail/accounts/:id/mode-impact': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const query = new URL(req.url, 'http://localhost').searchParams;
      // The browser sends "all mail" as an empty value; an absent parameter keeps the stored window.
      const window = (name: string) => query.has(name) ? mailSyncPolicy.parseWindowDays(query.get(name), name) : undefined;
      const [[account]] = await db.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?', [accountRouteId(req), userId]);
      if (!account) return { error: 'Account not found', status: 404 };
      return await mailSyncPolicy.computeModeImpact(account, { mode: query.get('mode'),
        syncWindowDays: window('sync_window_days'), trashWindowDays: window('trash_window_days') });
    } catch (error) {
      if (!(error as ApiError).status) console.error('[ACCOUNT] Mode impact error:', error);
      return routeError(error, 'Could not estimate the mode change');
    }
  },

  'POST /api/mail/accounts/:id/confirm-sync-policy': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return await confirmSyncPolicy(userId, accountRouteId(req)!, body?.confirm_address);
    } catch (error) {
      if (!(error as ApiError).status) console.error('[ACCOUNT] Confirm Sync policy error:', error);
      return routeError(error, 'Could not confirm the Sync policy');
    }
  },

  'POST /api/mail/accounts/:id/backup-export': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const id = accountRouteId(req);
      const [[account]] = await db.execute<(RowDataPacket & AccountRow)[]>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?', [id, userId]);
      if (!account) return { error: 'Account not found', status: 404 };
      const { startDataExportJob } = require('../services/export-jobs') as typeof import('../services/export-jobs');
      // Always encrypted (0.28); an older client's encrypt: false is ignored.
      const job = await startDataExportJob(userId, { sections: ['mail'], mailAccountId: id });
      return { job, status: 202 };
    } catch (error) {
      if (!(error as ApiError).status) console.error('[ACCOUNT] Account backup export error:', error);
      return routeError(error, 'Could not start the account backup');
    }
  },

  'GET /api/mail/accounts/:id/purge-preview': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const disconnecting = new URL(req.url, 'http://localhost').searchParams.get('disconnect') === 'true';
    try { return await mailAccountLifecycle.purgePreview(userId, req.params.id, undefined, { disconnecting }); }
    catch (error) { return routeError(error, 'Could not preview account purge'); }
  },

  'DELETE /api/mail/accounts/:id': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const id = extractMailRouteId(req)!;
      const query = new URL(req.url, 'http://localhost').searchParams;
      if (query.get('purge') === 'true') {
        return query.get('disconnect') === 'true'
          ? await mailAccountLifecycle.disconnectAndPurgeAccount(userId, id, query.get('confirm_purge'), { req })
          : await mailAccountLifecycle.purgeAccount(userId, id, query.get('confirm_purge'), { req });
      }
      return await mailAccountLifecycle.disconnectAccount(userId, id, { req });
    } catch (error) {
      return routeError(error, 'Could not change mail account connection');
    }
  },

  // Calendar of a mail account: on/off, status and server address.
  'GET /api/mail/accounts/:id/calendar': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return { calendar: await calendarAccounts.getMailCalendarLink(userId, accountRouteId(req)) };
    } catch (error) {
      if (!(error as ApiError).status) console.error('[CALENDAR] Mail calendar status error:', error);
      return routeError(error, 'Could not load the calendar settings');
    }
  },

  'PUT /api/mail/accounts/:id/calendar': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const calendar = await calendarAccounts.setMailCalendar(userId, accountRouteId(req), body || {});
      return { calendar };
    } catch (error) {
      if (!(error as ApiError).status) console.error('[CALENDAR] Mail calendar update error:', error);
      return routeError(error, 'Could not change the calendar settings');
    }
  },
};
