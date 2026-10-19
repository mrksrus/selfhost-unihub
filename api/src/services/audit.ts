import type { RowDataPacket } from 'mysql2/promise';
import type { AuthRequest, SqlExecutor } from '../types';

import { db } from '../state';
import { getClientIP } from '../auth';
import { currentRequestId, log } from '../log';

// Who did what to which account: administration and account security. An
// entry is written in the same transaction as the change where there is one,
// so a change and its record commit together. Entries carry ids, the client
// address and a few allowlisted values, never passwords, codes or content,
// and are kept for a year (pruneAuditLog, from background work).
const AUDIT_ACTIONS = [
  'auth.signin', 'auth.signin_failed', 'auth.password_changed', 'auth.two_factor_enabled', 'auth.two_factor_disabled',
  'auth.recovery_codes_replaced', 'auth.session_revoked', 'auth.account_deleted',
  'admin.password_reset', 'admin.role_changed', 'admin.two_factor_reset', 'admin.user_activated', 'admin.user_deactivated',
  'admin.user_deleted', 'admin.signup_mode_changed',
] as const;
type AuditAction = typeof AUDIT_ACTIONS[number];
type AuditDetails = Record<string, string | number | boolean | null>;

interface AuditEntry {
  action: AuditAction;
  actorId: string | null;
  targetUserId?: string | null;
  req?: AuthRequest | null;
  details?: AuditDetails | null;
}

const RETENTION_DAYS = 365;

function clientAddress(req: AuthRequest | null | undefined) {
  if (!req) return null;
  try { return getClientIP(req as Parameters<typeof getClientIP>[0])?.slice(0, 45) || null; } catch { return null; }
}

/** Writes an entry on `executor` (pass the transaction's connection). Throws on failure. */
async function recordAudit({ action, actorId, targetUserId = null, req = null, details = null }: AuditEntry, executor: SqlExecutor = db) {
  await executor.execute(`INSERT INTO audit_log (actor_id, action, target_user_id, ip_address, request_id, details)
    VALUES (?, ?, ?, ?, ?, ?)`, [actorId, action, targetUserId, clientAddress(req), currentRequestId(), details ? JSON.stringify(details) : null]);
}

/** For a change that already committed: a lost entry is logged, never a failed request. */
async function recordAuditAfter(entry: AuditEntry) {
  await recordAudit(entry).catch(error => log.error('AUDIT', 'Could not record an audit entry', error, { action: entry.action }));
}

interface AuditRow extends RowDataPacket {
  id: string; created_at: Date | string; action: string; actor_id: string | null; actor_email: string | null;
  target_user_id: string | null; target_email: string | null; ip_address: string | null; request_id: string | null; details: unknown;
}

/** Newest first; `before` is the created_at/id of the last entry of the previous page. */
async function listAuditLog({ limit = 50, before = null }: { limit?: number; before?: { createdAt: string; id: string } | null } = {}) {
  const size = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  const page = before ? 'WHERE (a.created_at, a.id) < (?, ?)' : '';
  const [rows] = await db.query<AuditRow[]>(`SELECT a.id, a.created_at, a.action, a.actor_id, actor.email AS actor_email,
      a.target_user_id, target.email AS target_email, a.ip_address, a.request_id, a.details
    FROM audit_log a LEFT JOIN users actor ON actor.id = a.actor_id LEFT JOIN users target ON target.id = a.target_user_id
    ${page} ORDER BY a.created_at DESC, a.id DESC LIMIT ${size + 1}`, before ? [new Date(before.createdAt), before.id] : []);
  const entries = rows.slice(0, size).map(row => ({
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    action: row.action,
    actor: row.actor_id ? { id: row.actor_id, email: row.actor_email } : null,
    target: row.target_user_id ? { id: row.target_user_id, email: row.target_email } : null,
    ipAddress: row.ip_address,
    requestId: row.request_id,
    details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details ?? null,
  }));
  return { entries, more: rows.length > size };
}

async function pruneAuditLog(executor: SqlExecutor = db) {
  const [result] = await executor.execute<import('mysql2/promise').ResultSetHeader>(
    `DELETE FROM audit_log WHERE created_at < UTC_TIMESTAMP() - INTERVAL ${RETENTION_DAYS} DAY LIMIT 10000`);
  return result.affectedRows;
}

export { AUDIT_ACTIONS, RETENTION_DAYS, recordAudit, recordAuditAfter, listAuditLog, pruneAuditLog };
export type { AuditAction, AuditDetails };
