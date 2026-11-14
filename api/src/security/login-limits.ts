import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import crypto from 'crypto';
import { db } from '../state';
import { JWT_SECRET } from '../config';

type AuthAttemptScope = 'ip' | 'signup' | 'password' | 'secondFactor';

// Separate short network budgets from account budgets. Successful logins do
// not reset either: authenticating one account must not erase another's limits.
// The budgets live in login_attempts (0.30), so a restart does not reset them.
// Identities (addresses, account ids) are stored keyed-hashed: personal data,
// and an unkeyed hash of an IPv4 address is reversed by trying them all. A
// database that cannot answer fails the request, as the sign-in would anyway.
function createLoginLimiter({ now = () => new Date(), executor = db as SqlExecutor } = {}) {
  const identityHash = (identity: string) => crypto.createHmac('sha256', JWT_SECRET || '').update(identity).digest('hex');
  async function consume(scope: string, identity: string, limit: number, windowMs: number): Promise<number | null> {
    const time = now();
    const key = [scope, identityHash(identity)];
    // Opens a new window when there is none or it ended; the conditional
    // update then takes a place atomically, so parallel requests never get
    // more than the budget.
    await executor.execute(`INSERT INTO login_attempts (scope, identity_hash, attempts, window_ends_at) VALUES (?, ?, 0, ?)
      ON DUPLICATE KEY UPDATE attempts = IF(window_ends_at <= ?, 0, attempts), window_ends_at = IF(window_ends_at <= ?, VALUES(window_ends_at), window_ends_at)`,
    [...key, new Date(time.getTime() + windowMs), time, time]);
    const [taken] = await executor.execute<ResultSetHeader>('UPDATE login_attempts SET attempts = attempts + 1 WHERE scope = ? AND identity_hash = ? AND attempts < ?', [...key, limit]);
    if (taken.affectedRows > 0) return null;
    const [rows] = await executor.execute<RowDataPacket[]>('SELECT window_ends_at FROM login_attempts WHERE scope = ? AND identity_hash = ?', key);
    return Math.max(1, Math.ceil(((rows.length ? new Date(rows[0].window_ends_at).getTime() : 0) - time.getTime()) / 1000));
  }
  // Gives back an attempt that consume() spent, for a check that turned out
  // not to be a guess (a right password).
  async function refund(scope: string, identity: string) {
    await executor.execute('UPDATE login_attempts SET attempts = attempts - 1 WHERE scope = ? AND identity_hash = ? AND attempts > 0 AND window_ends_at > ?',
      [scope, identityHash(identity), now()]);
  }
  return { consume, refund };
}

const limiter = createLoginLimiter();
function consumeAuthAttempt(scope: AuthAttemptScope, identity: unknown) {
  const budgets: Record<AuthAttemptScope, [number, number]> = {
    ip: [60, 60000],
    signup: [10, 3600000],
    password: [10, 600000],
    secondFactor: [10, 600000],
  };
  const budget = budgets[scope];
  if (!budget) throw new Error('Unknown authentication rate limit');
  return limiter.consume(scope, String(identity), ...budget);
}

// An admin confirming an action with their password has a budget of its own,
// so failed sign-ins cannot lock them out of admin actions or the other way
// round. Each confirmation reserves an attempt before the password is
// checked, so a burst of parallel requests gets no more than the budget; a
// right password gives its attempt back, so only wrong passwords use it up.
const REAUTH_BUDGET: [number, number] = [10, 600000];
function reserveReauth(userId: string) {
  return limiter.consume('reauth', userId, ...REAUTH_BUDGET);
}
function refundReauth(userId: string) {
  return limiter.refund('reauth', userId);
}

/** Deletes budgets whose window has ended (the hourly clean-up); answers how many. */
async function pruneLoginAttempts(executor: SqlExecutor = db) {
  const [result] = await executor.execute<ResultSetHeader>('DELETE FROM login_attempts WHERE window_ends_at <= UTC_TIMESTAMP(3)');
  return result.affectedRows;
}

export { createLoginLimiter, consumeAuthAttempt, reserveReauth, refundReauth, pruneLoginAttempts };
