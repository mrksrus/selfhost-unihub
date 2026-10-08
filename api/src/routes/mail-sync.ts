import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { RouteRequest, ApiError } from '../types';
type Request = RouteRequest & { url: string; params: Record<string, string> };
interface Input { account_id?: string; min_age_ms?: unknown }
import imported1 = require('../state');
const { db } = imported1;
import imported2 = require('../services/mail');
const {
  scheduleMailAccountSync,
  getMailSyncState,
  cancelMailAccountSync,
} = imported2;
import imported3 = require('./mail-route-helpers');
const { startMailSyncInBackground } = imported3;

const BACKGROUND_MAIL_SYNC_MIN_AGE_MS = 10 * 60 * 1000;

function isMailSyncFresh(lastSyncedAt: string | number | Date | null | undefined, minAgeMs = BACKGROUND_MAIL_SYNC_MIN_AGE_MS) {
  if (!lastSyncedAt) return false;
  const lastSyncedAtMs = new Date(lastSyncedAt).getTime();
  if (!Number.isFinite(lastSyncedAtMs)) return false;
  return Date.now() - lastSyncedAtMs < minAgeMs;
}

export = {
  'POST /api/mail/sync/background': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const accountId = String(body?.account_id || '').trim();
      const requestedMinAgeMs = Number(body?.min_age_ms);
      const minAgeMs = Number.isFinite(requestedMinAgeMs)
        ? Math.max(BACKGROUND_MAIL_SYNC_MIN_AGE_MS, requestedMinAgeMs)
        : BACKGROUND_MAIL_SYNC_MIN_AGE_MS;

      const params = [userId];
      let query = `
        SELECT id, email_address, last_synced_at
        FROM mail_accounts
        WHERE user_id = ? AND is_active = TRUE`;

      if (accountId) {
        query += ' AND id = ?';
        params.push(accountId);
      }

      const [accounts] = await db.execute<RowDataPacket[]>(query, params);
      if (accountId && accounts.length === 0) {
        return { error: 'Account not found', status: 404 };
      }

      const started = [];
      const skipped = [];
      const alreadyRunning = [];

      for (const account of accounts) {
        if (isMailSyncFresh(account.last_synced_at, minAgeMs)) {
          skipped.push(account.id);
          continue;
        }

        const didStart = await startMailSyncInBackground(account.id, account.id, { background: true });
        if (didStart === null) {
          skipped.push(account.id);
        } else if (didStart) {
          started.push(account.id);
        } else {
          alreadyRunning.push(account.id);
        }
      }

      return { started, skipped, alreadyRunning: Array.from(new Set(alreadyRunning)) };
    } catch (error) {
      console.error('[SYNC] Background sync trigger error:', error);
      return { error: (error as ApiError).message || 'Failed to start background mail sync', status: 500 };
    }
  },

  'GET /api/mail/sync/status': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const accountId = new URL(req.url, 'http://localhost').searchParams.get('account_id');
    const [accounts] = await db.execute<RowDataPacket[]>(`SELECT id, sync_status FROM mail_accounts WHERE user_id = ?
      ${accountId ? 'AND id = ?' : ''} ORDER BY created_at`, accountId ? [userId, accountId] : [userId]);
    if (accountId && !accounts.length) return { error: 'Account not found', status: 404 };
    return { accounts: await Promise.all(accounts.map(async account => await getMailSyncState(account.id) || {
      account_id: account.id,
      state: account.sync_status === 'error' ? 'error' : account.sync_status === 'cancelled' ? 'cancelled' : 'idle',
      phase: null, processed: 0, total: null, started_at: null, updated_at: null,
      error: account.sync_status === 'error' ? 'The last sync failed; retry to see a detailed error.' : null,
    })) };
  },

  'POST /api/mail/sync': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const { account_id } = body;
      if (!account_id) return { error: 'Account ID required', status: 400 };

      // Verify account belongs to user before scheduling any provider work.
      const [accounts] = await db.execute<RowDataPacket[]>(
        'SELECT id, is_active FROM mail_accounts WHERE id = ? AND user_id = ?',
        [account_id, userId]
      );
      if (accounts.length === 0) return { error: 'Account not found', status: 404 };
      if (!accounts[0].is_active) return { error: 'Mail account is inactive', status: 409 };

      const job = await scheduleMailAccountSync(account_id);
      job.promise.then(result => {
        if (result?.success === false && 'error' in result) console.error(`[SYNC] Account ${account_id} failed:`, result.error);
      });
      return { success: true, started: job.started, alreadyRunning: job.alreadyRunning,
        account_id, message: job.started ? 'Sync queued; check status for progress.' : 'This account is already queued or syncing.',
        status: job.started ? 202 : 200 };
    } catch (error) {
      console.error('[SYNC] Sync error:', error);
      return { error: (error as ApiError).message || 'Failed to sync mail', status: 500 };
    }
  },

  'POST /api/mail/sync/cancel': async (_req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const accountId = body?.account_id;
    if (typeof accountId !== 'string' || !accountId.trim()) return { error: 'Account ID required', status: 400 };
    try {
      const [accounts] = await db.execute<RowDataPacket[]>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
      if (!accounts.length) return { error: 'Account not found', status: 404 };
      const requested = await cancelMailAccountSync(accountId);
      // A running IMAP command stops cooperatively. The status endpoint, not
      // this acknowledgement, establishes when its cleanup has completed.
      return { success: true, account_id: accountId, cancellationRequested: requested,
        message: requested ? 'Cancellation requested; check sync status.' : 'No active sync for this account.',
        status: requested ? 202 : 200 };
    } catch (error) {
      console.error('[SYNC] Cancellation request failed:', (error as ApiError).message);
      return { error: 'Could not request mail sync cancellation', status: 500 };
    }
  },
};
