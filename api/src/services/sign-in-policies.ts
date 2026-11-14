import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { PolicyPreviewResponse, TwoFactorRequiredDetails, TwoFactorRequirement } from '../contracts/policies';
import { db } from '../state';
import { resolvePolicy } from './settings';

// The sign-in policies (0.30): the shortest password, the longest session and
// two-factor authentication, as they apply to one person. The registry holds
// their values and reasons (settings-registry.ts); this file enforces them.

/**
 * The shortest password the person may set (auth.password_min_length).
 * Without a person yet (sign-up), the installation's (Everyone's) rule.
 */
async function passwordMinimum(userId: string | null, executor: SqlExecutor = db): Promise<number> {
  // No account id is empty, so '' resolves the installation's level alone.
  return Number((await resolvePolicy(userId ?? '', 'auth.password_min_length', executor)).value);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a session signed in at `createdAt` is older than the person's auth.session_max_days. */
async function sessionOutlived(userId: string, createdAt: Date | string, now = new Date(), executor: SqlExecutor = db): Promise<boolean> {
  const { value } = await resolvePolicy(userId, 'auth.session_max_days', executor);
  return value !== 'none' && now.getTime() - new Date(createdAt).getTime() >= Number(value) * DAY_MS;
}

// --- Two-factor authentication required (auth.two_factor, D51) -----------------

const GRACE_MS = 7 * DAY_MS;

interface TwoFactorState { enabled: boolean; requiredSince: Date | null }

async function readTwoFactorState(userId: string, executor: SqlExecutor): Promise<TwoFactorState | null> {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT two_factor_enabled, two_factor_required_since FROM users WHERE id = ?', [userId]);
  if (!rows.length) return null;
  return { enabled: !!Number(rows[0].two_factor_enabled), requiredSince: rows[0].two_factor_required_since ? new Date(rows[0].two_factor_required_since) : null };
}

/**
 * auth.two_factor for the person, keeping their grace in step with it:
 * users.two_factor_required_since is set the first time the rule is found
 * to apply to them without 2FA (only while empty, so it counts from the
 * first time) and cleared once it no longer applies or they have 2FA. A
 * later application starts a new grace. `state` is the person's 2FA state
 * when the caller already read it (the session lookup); without it the
 * person is read only when the rule applies.
 */
async function twoFactorRequirement(userId: string, state?: TwoFactorState | null, now = new Date(), executor: SqlExecutor = db):
  Promise<TwoFactorRequirement & { refused: TwoFactorRequiredDetails | null }> {
  const policy = await resolvePolicy(userId, 'auth.two_factor', executor);
  const rule = policy.value === 'required';
  if (!state && rule) state = await readTwoFactorState(userId, executor);
  if (!state || !rule || state.enabled) {
    if (state?.requiredSince) await executor.execute('UPDATE users SET two_factor_required_since = NULL WHERE id = ?', [userId]);
    return { required: false, grace_ends_at: null, refused: null };
  }
  let since = state.requiredSince;
  if (!since) {
    const start = new Date(Math.floor(now.getTime() / 1000) * 1000);
    const [result] = await executor.execute<ResultSetHeader>('UPDATE users SET two_factor_required_since = ? WHERE id = ? AND two_factor_required_since IS NULL', [start, userId]);
    since = result.affectedRows ? start : (await readTwoFactorState(userId, executor))?.requiredSince ?? start;
  }
  const ends = new Date(since.getTime() + GRACE_MS);
  const reason = policy.reason ?? 'Your administrator requires two-factor authentication.';
  return { required: true, grace_ends_at: ends.toISOString(), refused: now >= ends ? { grace_ended_at: ends.toISOString(), reason } : null };
}

/**
 * After a change of the rule or of who it covers: starts or ends the grace
 * of each person (all active people by default), so it counts from the save
 * and not from their next request.
 */
async function syncTwoFactorGrace(userIds?: readonly string[], executor: SqlExecutor = db) {
  if (userIds && !userIds.length) return;
  const [rows] = await executor.query<RowDataPacket[]>(`SELECT id, two_factor_enabled, two_factor_required_since FROM users
    WHERE is_active = TRUE${userIds ? ' AND id IN (?)' : ''}`, userIds ? [userIds] : []);
  for (const row of rows) {
    await twoFactorRequirement(String(row.id), { enabled: !!Number(row.two_factor_enabled),
      requiredSince: row.two_factor_required_since ? new Date(row.two_factor_required_since) : null }, new Date(), executor);
  }
}

/**
 * The policies page's save preview: of the active people a rule for
 * Everyone (no group) or the group covers, how many have no 2FA, and who of
 * them is already in a grace, with its end.
 */
async function previewTwoFactor(memberIds: readonly string[] | null, executor: SqlExecutor = db): Promise<PolicyPreviewResponse> {
  if (memberIds && !memberIds.length) return { two_factor: { without: 0, in_grace: [] } };
  const [rows] = await executor.query<RowDataPacket[]>(`SELECT id, email, full_name, two_factor_required_since FROM users
    WHERE is_active = TRUE AND two_factor_enabled = FALSE${memberIds ? ' AND id IN (?)' : ''} ORDER BY full_name, email`, memberIds ? [memberIds] : []);
  return { two_factor: {
    without: rows.length,
    in_grace: rows.filter(row => row.two_factor_required_since).map(row => ({ id: String(row.id), email: String(row.email), full_name: row.full_name ?? null,
      grace_ends_at: new Date(new Date(row.two_factor_required_since).getTime() + GRACE_MS).toISOString() })),
  } };
}

export { passwordMinimum, sessionOutlived, twoFactorRequirement, syncTwoFactorGrace, previewTwoFactor };
export type { TwoFactorState };
