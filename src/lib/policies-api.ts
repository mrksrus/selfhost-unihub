import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import type { AcknowledgePoliciesRequest, AcknowledgePoliciesResponse, EffectivePoliciesResponse, EffectivePolicy, PolicyKey, PolicyValues } from '../../api/src/contracts/policies';

export type { Allowance, EffectivePoliciesResponse, EffectivePolicy, PolicyKey, PolicyValues, PolicySource } from '../../api/src/contracts/policies';

// The data-safety policies as they apply to the signed-in person (F13). The
// server refuses a forbidden action with 403 POLICY_FORBIDS; the page only
// greys the control out with the server's reason, never hides it.

export const POLICY_KEYS = [
  'mail.mode.download', 'mail.mode.sync', 'mail.mode.new_accounts', 'mail.provider_delete',
  'backup.download_mail', 'backup.create', 'backup.restore', 'backup.delete', 'backup.server_retention_days',
  'accounts.add', 'accounts.remove', 'accounts.reset', 'accounts.admin_manage',
  'account.delete', 'data.clear', 'bin.delete',
  'app_lock.required', 'app_lock.max_background', 'app_lock.screenshots',
  'auth.two_factor', 'auth.password_min_length', 'auth.session_max_days',
  'modules.mail', 'modules.calendar', 'modules.contacts', 'modules.recordings', 'pages.music',
  'notifications.detail', 'contacts.phone_sync', 'offline.copies',
] as const satisfies readonly PolicyKey[];

/** Every key's default: allowed, from the default, no reason. Shown until the server's answer arrives. */
export const DEFAULT_POLICY_VALUES: PolicyValues = {
  'mail.mode.download': 'allowed',
  'mail.mode.sync': 'allowed',
  'mail.mode.new_accounts': 'user_choice',
  'mail.provider_delete': 'user_choice',
  'backup.download_mail': 'user_choice',
  'backup.create': 'allowed',
  'backup.restore': 'allowed',
  'backup.delete': 'allowed',
  'backup.server_retention_days': null,
  'accounts.add': 'allowed',
  'accounts.remove': 'allowed',
  'accounts.reset': 'allowed',
  'accounts.admin_manage': 'available',
  'account.delete': 'allowed',
  'data.clear': 'allowed',
  'bin.delete': 'allowed',
  'app_lock.required': [],
  'app_lock.max_background': 'none',
  'app_lock.screenshots': 'allowed',
  'auth.two_factor': 'optional',
  'auth.password_min_length': 12,
  'auth.session_max_days': 'none',
  'modules.mail': 'allowed',
  'modules.calendar': 'allowed',
  'modules.contacts': 'allowed',
  'modules.recordings': 'allowed',
  'pages.music': 'allowed',
  'notifications.detail': 'full',
  'contacts.phone_sync': 'allowed',
  'offline.copies': 'allowed',
};

export type EffectivePolicies = EffectivePoliciesResponse['policies'];

export function defaultPolicies(): EffectivePolicies {
  return Object.fromEntries(POLICY_KEYS.map(key => [key, { value: DEFAULT_POLICY_VALUES[key], source: 'default', allowed: true, reason: null }])) as EffectivePolicies;
}

export const policiesQueryKey = ['policies', 'effective'] as const;

export async function fetchEffectivePolicies(signal?: AbortSignal): Promise<EffectivePoliciesResponse> {
  const answer = unwrap(await api.get<EffectivePoliciesResponse>('/policies/effective', { signal }));
  if (!answer?.policies) throw new Error('The server did not answer with its rules.');
  // A key the server does not know yet (an older server) keeps its default.
  return { ...answer, policies: { ...defaultPolicies(), ...answer.policies } };
}

export const effectivePoliciesQueryOptions = queryOptions({
  queryKey: policiesQueryKey,
  queryFn: ({ signal }) => fetchEffectivePolicies(signal),
  staleTime: 5 * 60 * 1000,
});

/** Records that the person saw the rules of `revision` (the notice dialog). */
export async function acknowledgePolicies(revision: number) {
  return unwrap(await api.post<AcknowledgePoliciesResponse>('/policies/acknowledge', { revision } satisfies AcknowledgePoliciesRequest));
}

/** The reason to show beside a greyed control, or undefined while the action is allowed. */
export function policyLock<K extends PolicyKey>(policy: EffectivePolicy<K> | undefined): string | undefined {
  if (!policy || policy.allowed) return undefined;
  return policy.reason ?? 'Your administrator does not allow this.';
}
