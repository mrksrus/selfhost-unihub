import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import { deleteOwnOfflineCopy } from '@/lib/offline';
import type { ModuleId, PageId } from '@/lib/modules';
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

/**
 * auth.two_factor as it applies to the person (D51): while `required` and
 * not set up, the grace end; after it the server refuses with
 * TWO_FACTOR_REQUIRED. null from a server before 0.30.
 */
// shortcut: typed here until contracts/policies.ts carries `two_factor` (stream B); then import it.
export interface TwoFactorRequirement { required: boolean; grace_ends_at: string | null }
export type EffectivePoliciesAnswer = EffectivePoliciesResponse & { two_factor: TwoFactorRequirement | null };

function twoFactorOf(value: unknown): TwoFactorRequirement | null {
  if (!value || typeof value !== 'object') return null;
  const { required, grace_ends_at: ends } = value as Record<string, unknown>;
  return { required: required === true, grace_ends_at: typeof ends === 'string' && !Number.isNaN(Date.parse(ends)) ? ends : null };
}

export async function fetchEffectivePolicies(signal?: AbortSignal): Promise<EffectivePoliciesAnswer> {
  const answer = unwrap(await api.get<EffectivePoliciesResponse & { two_factor?: unknown }>('/policies/effective', { signal }));
  if (!answer?.policies) throw new Error('The server did not answer with its rules.');
  // A key the server does not know yet (an older server) keeps its default.
  const policies = { ...defaultPolicies(), ...answer.policies };
  // The server refuses new offline copies; the one this browser holds goes now.
  if (policies['offline.copies'].allowed === false) await deleteOwnOfflineCopy().catch(() => false);
  return { ...answer, policies, two_factor: twoFactorOf(answer.two_factor) };
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

const MODULE_POLICIES: Record<ModuleId, PolicyKey> = {
  mail: 'modules.mail', calendar: 'modules.calendar', contacts: 'modules.contacts', recordings: 'modules.recordings',
};

/** Why a module is off and locked for the person (modules.*), or undefined while allowed. */
export function moduleLock(policies: EffectivePolicies, id: ModuleId) {
  return policyLock(policies[MODULE_POLICIES[id]]);
}

/** Why a page is unavailable: its module's policy, or for Music also pages.music. */
export function pageLock(policies: EffectivePolicies, id: PageId, module: ModuleId | null) {
  return (module ? moduleLock(policies, module) : undefined) ?? (id === 'music' ? policyLock(policies['pages.music']) : undefined);
}
