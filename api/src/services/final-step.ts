import type { Pool, PoolConnection } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { EffectivePolicy, PolicyKey } from '../contracts/policies';
import type { PolicyActor } from './settings';
import { db } from '../state';
import { ApiError, conflict, forbidden } from '../http/errors';
import { lockedPolicies, policyForbids } from './settings';
import { lockedUserModules } from './module-settings';
import { lockedRestoreSections } from './restore-locks';
import { sectionOf } from './access-policy';
import { lockUnchanged } from './account-identity';
import type { AccountSnapshot } from './account-identity';

// The last check of every destructive step (F13): deleting for good,
// clearing, removing or resetting an account, deleting a backup, erasing at
// the provider. The request boundary and a service's early checks answer
// fast, but they can be older than what holds when the step acts: an
// administrator's save, a module switched off, a restore admitted while the
// step waited. So the step asks again inside its final transaction, after
// its own row locks, on that transaction's connection, with locking reads
// (current, whatever the transaction read before), and those locks are held
// until it commits:
//
//   0. before any of them, the person's lock (person-lock.ts) where the
//      step is a change of the person's accounts;
//   1. the step's own rows, in the step's own order (they come first;
//      accounts the step carries as `unchanged` are locked here, mail
//      accounts before calendar accounts, by id);
//   2. the rules revision row, shared, then the installation's policies;
//   3. the person's module switches row, shared;
//   4. the person's restore jobs (every row and the gap for a new one), shared.
//
// An administrator's save locks the revision row first, a module switch its
// settings row, and a restore's admission (create, start, retry, unlock;
// backup-restore-jobs.ts) its own job row and the person's others; each
// therefore commits before the step reads it or waits until the step ends.
// docs/AUTH_ADMIN_SETTINGS.md describes the order once.

interface FinalStep {
  userId: string;
  /** The route's policies of the action; an administrator's actor passes them (F13). */
  policies?: readonly PolicyKey[];
  actor?: PolicyActor;
  /** Every module the step writes: its switch, and the restore section it belongs to. */
  modules?: readonly string[];
  /** A worker's step: the module's background switch counts as well. */
  background?: boolean;
  /** Refused while any restore of the person runs (deleting the account). */
  anyRestore?: boolean;
  /** Accounts the step chose before it waited, still as it saw them (account-identity.ts): locked shared, first, by id. */
  unchanged?: readonly AccountSnapshot[];
}

interface FinalStepAnswer {
  /** Any other key as read under the same lock (the backup minimum). */
  policy: <K extends PolicyKey>(key: K) => EffectivePolicy<K>;
}

const moduleOff = (module: string) => forbidden('MODULE_DISABLED', 'This module is disabled. Enable it in Settings.', { module });
const restoring = (module: string) => conflict('RESTORE_IN_PROGRESS', `Restore in progress for ${module}. This section is temporarily read-only.`);

/** Throws POLICY_FORBIDS, MODULE_DISABLED or RESTORE_IN_PROGRESS when the step may not happen now. */
async function assertFinalStep(connection: SqlExecutor, { userId, policies = [], actor = {}, modules = [], background = false, anyRestore = false, unchanged = [] }: FinalStep): Promise<FinalStepAnswer> {
  // Mail accounts before calendar accounts, as everywhere else; then by id.
  const order = (snapshot: AccountSnapshot) => `${snapshot.kind === 'mail' ? 0 : 1}:${snapshot.id}`;
  for (const snapshot of [...unchanged].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0))) {
    await lockUnchanged(connection, userId, snapshot, { lock: 'share' });
  }
  const policy = await lockedPolicies(connection);
  if (!actor.adminId) {
    for (const key of policies) {
      const resolved = policy(key);
      if (!resolved.allowed) throw policyForbids(key, resolved.reason ?? 'Your administrator does not allow this.');
    }
  }
  if (modules.length) {
    const switches = await lockedUserModules(userId, connection);
    for (const id of modules) {
      const module = switches.find(entry => entry.id === id);
      if (!module?.enabled || (background && !module.background)) throw moduleOff(id);
    }
  }
  if (modules.length || anyRestore) {
    const sections = await lockedRestoreSections(userId, connection);
    if (anyRestore && sections.size) throw conflict('RESTORE_IN_PROGRESS', 'Restore in progress. Try again when it has finished.');
    for (const id of modules) if (sections.has(sectionOf(id))) throw restoring(id);
  }
  return { policy };
}

const REFUSALS = new Set(['POLICY_FORBIDS', 'MODULE_DISABLED', 'RESTORE_IN_PROGRESS', 'ACCOUNT_CHANGED']);
const isRefusal = (error: unknown) => error instanceof ApiError && REFUSALS.has(error.code);

/**
 * For a step that is a provider command, which never runs inside a
 * transaction that could be retried: the check on a connection of its own,
 * whose locks are held while `work` runs, so a save, a switch or a restore
 * admitted meanwhile waits until the provider answered and none starts the
 * step after them. `work` runs once and must not use the database. Throws
 * the refusal, or what `work` threw.
 */
async function underFinalStep<T>(step: FinalStep, work: () => Promise<T>, pool: Pick<Pool, 'getConnection'> = db): Promise<T> {
  const cx: PoolConnection = await pool.getConnection();
  try {
    await cx.beginTransaction();
    await assertFinalStep(cx, step);
    const result = await work();
    await cx.commit();
    return result;
  } catch (error) {
    await cx.rollback().catch(() => undefined);
    throw error;
  } finally { cx.release(); }
}

/** underFinalStep for a worker: whether it ran; a refusal is no error there. */
async function whileFinalStepAllows(step: FinalStep, work: () => Promise<unknown>): Promise<boolean> {
  try {
    await underFinalStep(step, work);
    return true;
  } catch (error) {
    if (isRefusal(error)) return false;
    throw error;
  }
}

export { assertFinalStep, underFinalStep, whileFinalStepAllows, isRefusal };
export type { FinalStep };
