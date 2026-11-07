import type { ServerResponse } from 'node:http';
import type { RowDataPacket } from 'mysql2/promise';
import { db } from '../state';
import { verifyPassword } from '../auth';
import { refundReauth, reserveReauth } from './login-limits';

// The signed-in person's own password, asked again before an action a stolen
// or unattended session must not take: an administrator acting on another
// person (their password, role, 2FA, accounts, backups, bin, data or the
// installation's policies), and deleting one's own UniHub account. Wrong
// guesses share the re-authentication budget (login-limits.ts). Not 401: the
// client treats a 401 outside /api/auth/ as an expired session and signs out.

interface ReauthCodes { required: string; incorrect: string }
const ADMIN_CODES: ReauthCodes = { required: 'ADMIN_PASSWORD_REQUIRED', incorrect: 'ADMIN_PASSWORD_INCORRECT' };
const OWN_CODES: ReauthCodes = { required: 'PASSWORD_REQUIRED', incorrect: 'PASSWORD_INCORRECT' };

type Refusal = { error: string; code?: string; status: number };

/** null when `currentPassword` is the person's password; otherwise the answer to send. */
async function confirmPassword(userId: string, currentPassword: unknown, res?: ServerResponse | null, codes: ReauthCodes = ADMIN_CODES): Promise<Refusal | null> {
  if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 1024) {
    return { error: 'Your current password is required', code: codes.required, status: 400 };
  }
  const retryAfter = reserveReauth(userId);
  if (retryAfter) {
    res?.setHeader('Retry-After', String(retryAfter));
    return { error: `Too many attempts. Try again in ${retryAfter} seconds.`, status: 429 };
  }
  let wrong: boolean | null = null;
  try {
    const [rows] = await db.execute<RowDataPacket[]>('SELECT password_hash FROM users WHERE id = ?', [userId]);
    wrong = !rows.length || !(await verifyPassword(currentPassword, rows[0].password_hash));
  } finally {
    // A right password, or a check that failed for another reason, is not a guess.
    if (wrong !== true) refundReauth(userId);
  }
  if (wrong) return { error: 'Current password is incorrect', code: codes.incorrect, status: 403 };
  return null;
}

export { confirmPassword, ADMIN_CODES, OWN_CODES };
export type { ReauthCodes };
