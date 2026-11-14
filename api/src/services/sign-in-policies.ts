import type { SqlExecutor } from '../types';
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

export { passwordMinimum };
