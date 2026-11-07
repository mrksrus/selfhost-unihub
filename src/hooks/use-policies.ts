import { useQuery } from '@tanstack/react-query';
import { useContext } from 'react';
import { AuthContext } from '@/contexts/auth-context';
import { defaultPolicies, effectivePoliciesQueryOptions, policyLock, type EffectivePolicies, type EffectivePolicy, type PolicyKey } from '@/lib/policies-api';

const DEFAULTS = defaultPolicies();

/**
 * The data-safety rules as they apply to the signed-in person. Until they
 * load, every action reads as allowed: the server refuses a forbidden one
 * anyway, and the control greys out as soon as the answer is here.
 *
 * `rules`, `revision` and `acknowledgedRevision` feed the notice dialog and
 * "Rules on this server" (D38): `noticeDue` is true when an administrator
 * changed a user-facing rule since the person last confirmed them, or when
 * they never confirmed any.
 */
export function usePolicies() {
  // The session where one is mounted; a view rendered on its own (unit tests) has none.
  const auth = useContext(AuthContext);
  const query = useQuery({ ...effectivePoliciesQueryOptions, enabled: !!auth?.user && !auth.isOffline });
  const policies: EffectivePolicies = query.data?.policies ?? DEFAULTS;
  return {
    policies,
    loaded: query.isSuccess,
    rules: query.data?.rules ?? [],
    revision: query.data?.revision ?? 0,
    acknowledgedRevision: query.data?.acknowledged_revision ?? 0,
    noticeDue: !!query.data && query.data.acknowledged_revision < query.data.revision,
  };
}

/** One rule, with the reason for a greyed control (undefined while allowed). */
export function usePolicy<K extends PolicyKey>(key: K): EffectivePolicy<K> & { lock: string | undefined } {
  const { policies } = usePolicies();
  const policy = policies[key] as EffectivePolicy<K>;
  return { ...policy, lock: policyLock(policy) };
}
