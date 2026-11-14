// For unit tests whose fake databases model something other than policies
// (mail work, uploads): the policy and organisation reads of
// services/settings.ts answer as an installation with no policy and no
// group, so those fakes need no line of their own for them. Policies and
// groups are tested on the real database (*policy*-mysql-integration).
//
// Require it before taking setDb from ../dist/src/state: from then on every
// executor a test sets, and each connection it hands out, answers those reads.
const state = require('../../dist/src/state') as typeof import('../../src/state');

const POLICY_READS = /\b(FROM|JOIN) (setting_policies|org_groups|org_group_members)\b|^SELECT id FROM users ORDER BY id$/;
type Executor = { execute: (...args: unknown[]) => unknown; getConnection?: (...args: unknown[]) => Promise<unknown>; __noPolicies?: true };

function withoutPolicies<T>(target: T): T {
  const executor = target as unknown as Executor;
  if (!executor || typeof executor.execute !== 'function' || executor.__noPolicies) return target;
  const execute = executor.execute;
  executor.execute = function (this: unknown, sql: unknown, ...rest: unknown[]) {
    const text = String((sql as { sql?: string })?.sql ?? sql).trim();
    return POLICY_READS.test(text) ? Promise.resolve([[]]) : execute.call(this, sql, ...rest);
  };
  const getConnection = executor.getConnection;
  if (typeof getConnection === 'function') executor.getConnection = async function (this: unknown, ...args: unknown[]) { return withoutPolicies(await getConnection.apply(this, args)); };
  executor.__noPolicies = true;
  return target;
}

const setDb = state.setDb;
state.setDb = (next => setDb(next && withoutPolicies(next))) as typeof state.setDb;

module.exports = { withoutPolicies };
export type NoPoliciesHelpers = { withoutPolicies: typeof withoutPolicies };
