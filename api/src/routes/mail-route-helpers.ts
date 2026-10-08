import type { IncomingMessage } from 'node:http';
import type { RowDataPacket } from 'mysql2/promise';
import type { StoredFlag } from '../types';
import { db } from '../state';
import { normalizeMailFolderSlug, ensureDefaultMailFoldersForUser, scheduleMailAccountSync } from '../services/mail';

// Keep stored flags as the last confirmed provider state. Show an accepted
// pending action immediately, including after a page reload or a long sync.
const effectiveFlagSql = (action: 'read' | 'star', column: 'is_read' | 'is_starred') => `COALESCE((SELECT CAST(w.target_value AS UNSIGNED)
  FROM mail_writebacks w WHERE w.email_id = emails.id AND w.user_id = emails.user_id
    AND w.action = '${action}' AND w.status = 'pending' AND w.is_current = TRUE
    ORDER BY w.intent_revision DESC, w.created_at DESC, w.id DESC LIMIT 1), emails.${column})`;
const pendingFlagSql = (action: 'read' | 'star') => `EXISTS(SELECT 1 FROM mail_writebacks w WHERE w.email_id = emails.id
  AND w.user_id = emails.user_id AND w.action = '${action}' AND w.status = 'pending' AND w.is_current = TRUE)`;
const EFFECTIVE_READ_SQL = effectiveFlagSql('read', 'is_read');
const EFFECTIVE_STAR_SQL = effectiveFlagSql('star', 'is_starred');

async function startMailSyncInBackground(accountId: string, label = accountId, options: Record<string, unknown> = {}) {
  const job = await scheduleMailAccountSync(accountId, options);
  if (job.skipped) return null;
  job.promise
    .then((result: { success?: boolean; error?: string } | null | undefined) => {
      if (result?.success === false) {
        console.error(`[SYNC] Background sync failed for ${label}:`, result.error || 'Unknown error');
      }
    })
    .catch((error: Error) => {
      console.error(`[SYNC] Background sync failed for ${label}:`, error.message);
    });
  return job.started;
}

async function validateUserMailFolder(userId: string, folderSlug: unknown) {
  const normalizedSlug = normalizeMailFolderSlug(folderSlug);
  if (!normalizedSlug) return { error: 'Valid folder is required', status: 400 };
  await ensureDefaultMailFoldersForUser(userId);
  const [rows] = await db.execute<(RowDataPacket & { mail_account_id: string | null; is_system: StoredFlag })[]>('SELECT mail_account_id, is_system FROM mail_folders WHERE user_id = ? AND slug = ? LIMIT 1', [userId, normalizedSlug]);
  if (!rows.length) return { error: 'Folder not found', status: 404 };
  return { folder: normalizedSlug, accountId: rows[0].mail_account_id || null, isSystem: !!rows[0].is_system };
}

function extractMailRouteId(req: Pick<IncomingMessage, 'url'>, offsetFromEnd = 1) {
  const parts = req.url!.split('?')[0].split('/').filter(Boolean);
  return parts[parts.length - offsetFromEnd] || null;
}

export {
  pendingFlagSql,
  EFFECTIVE_READ_SQL,
  EFFECTIVE_STAR_SQL,
  startMailSyncInBackground,
  validateUserMailFolder,
  extractMailRouteId,
};
