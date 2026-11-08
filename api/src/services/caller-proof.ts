import { AsyncLocalStorage } from 'node:async_hooks';
import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import { forbidden, unauthorized } from '../http/errors';
import { lockLiveSession } from './sessions';

// Who asked for a change, as the request boundary and the route proved it:
// the signed-in person, their session, their role where the route needs an
// administrator, and the password they entered again (its stored hash) where
// the route asks for it. A change can wait (the person's lock, an account's,
// rows) after that proof; the final check (final-step.ts) and the
// installation saves that run under it (policies, the instance backup's
// schedule) ask again under their locks, so a request whose session was
// signed out, whose person was deactivated or lost the administrator role,
// or whose password was changed while it waited changes nothing.
//
// Held for the request's own work only: background work it starts runs
// without it (outsideCaller, also through person-lock.ts outsidePersonLock),
// and once the request has answered the proof counts no more.

interface CallerProof {
  userId: string;
  token: string | null;
  /** The route needs an administrator. */
  admin?: boolean;
  /** The stored hash of the password the person entered again; null when the route asks for none. */
  passwordHash?: string | null;
}
interface Held { proof: CallerProof; active: boolean }

const callers = new AsyncLocalStorage<Held>();

async function asCaller<T>(proof: CallerProof, work: () => T | PromiseLike<T>): Promise<T> {
  const held: Held = { proof, active: true };
  try {
    return await callers.run(held, work);
  } finally { held.active = false; }
}

function currentCaller(): CallerProof | null {
  const held = callers.getStore();
  return held?.active ? held.proof : null;
}

/** Starts background work without the request's caller. */
function outsideCaller<T>(work: () => T): T {
  return callers.exit(work);
}

/**
 * Inside a transaction, before the step's provider command or last write:
 * the caller's row and session are read with shared locks, held until the
 * step commits, so a deactivation, password change or sign-out waits for it
 * or is seen by it. Without a caller (a worker, a test) nothing is checked.
 */
async function assertCaller(connection: SqlExecutor, proof: CallerProof | null = currentCaller()) {
  if (!proof) return;
  const [[user]] = await connection.execute<RowDataPacket[]>('SELECT role, is_active, password_hash FROM users WHERE id = ? LOCK IN SHARE MODE', [proof.userId]);
  if (!user || !Number(user.is_active) || !await lockLiveSession(proof.userId, proof.token, connection)) {
    throw unauthorized('SESSION_ENDED', 'Your session has ended. Sign in again; nothing was changed.');
  }
  if (proof.passwordHash != null && user.password_hash !== proof.passwordHash) {
    throw forbidden('PASSWORD_CHANGED', 'Your password was changed meanwhile, so nothing was changed. Enter your current password again.');
  }
  if (proof.admin && user.role !== 'admin') throw forbidden('ADMIN_REQUIRED', 'Only an administrator can do this; nothing was changed.');
}

export { asCaller, assertCaller, currentCaller, outsideCaller };
export type { CallerProof };
