// Which person signed in with their password in this page, and the wipe of
// the lock's records at sign-out (contexts/AuthContext.tsx calls both).
//
// A sign-in is proof enough to open UniHub and to set up a new PIN: after
// "Forgot PIN? Sign out", or on a device whose lock is on but whose PIN is
// gone, the person signs in again and chooses a new one. Without a fresh
// sign-in, a lost PIN only allows signing out.
import { deleteLockRecords } from '@/lib/app-lock/db';

const SIGNED_IN_KEY = 'unihub:lock-signed-in';
// A reload shortly after signing in may still set up the PIN.
const SET_UP_WINDOW_MS = 10 * 60_000;

let signedInHere: string | null = null;

/** The person signed in with their password in this page. */
export function noteSignIn(userId: string) {
  signedInHere = userId;
  try { sessionStorage.setItem(SIGNED_IN_KEY, JSON.stringify({ userId, at: Date.now() })); } catch { /* Storage may be off; this page still knows. */ }
}

/** This page load began with this person's sign-in: open without asking. */
export function signedInInThisPage(userId: string) {
  return signedInHere === userId;
}

/** This person signed in with their password in this tab within the set-up window. */
export function recentSignIn(userId: string, now = Date.now()) {
  if (signedInHere === userId) return true;
  try {
    const value = JSON.parse(sessionStorage.getItem(SIGNED_IN_KEY) || 'null') as { userId?: unknown; at?: unknown } | null;
    return value?.userId === userId && typeof value.at === 'number' && now - value.at >= 0 && now - value.at < SET_UP_WINDOW_MS;
  } catch { return false; }
}

/**
 * Removes the lock's records in this browser: everyone's at a sign-out or an
 * ended session, everyone's but `keepUserId`'s when another person is signed
 * in now. Never rejects; a browser without storage has nothing to remove.
 */
export async function clearAppLockData(keepUserId?: string) {
  if (signedInHere !== keepUserId) signedInHere = null;
  try {
    const stored = JSON.parse(sessionStorage.getItem(SIGNED_IN_KEY) || 'null') as { userId?: unknown } | null;
    if (!keepUserId || stored?.userId !== keepUserId) sessionStorage.removeItem(SIGNED_IN_KEY);
  } catch { /* Nothing stored. */ }
  try { await deleteLockRecords(keepUserId); } catch { /* No storage, nothing kept. */ }
}
