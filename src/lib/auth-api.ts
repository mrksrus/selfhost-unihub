import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import type { SignupMode } from '@/lib/admin-api';

/**
 * Who may create an account, for the sign-in page; unknown counts as closed.
 * With it the rules that limit a new person on this server, in plain words
 * (D38): a server before 0.28 sends none.
 */
/**
 * The sign-up mode with the data rules a new person is shown (D38) and the
 * revision of those rules: sign-up sends it back, so the account confirms
 * only the rules it was shown. A newer revision opens the notice afterwards.
 */
export async function fetchPublicSignupMode(): Promise<{ mode: SignupMode; dataRules: string[]; rulesRevision: number | null }> {
  const response = await api.get<{ signup_mode?: SignupMode; data_rules?: string[]; rules_revision?: number }>('/auth/signup-mode');
  const revision = response.data?.rules_revision;
  return {
    mode: response.data?.signup_mode || 'disabled',
    dataRules: Array.isArray(response.data?.data_rules) ? response.data.data_rules.filter(rule => typeof rule === 'string') : [],
    rulesRevision: Number.isSafeInteger(revision) && (revision as number) > 0 ? (revision as number) : null,
  };
}

/** Deletes one's own UniHub account with everything in it; asks for the password again (D41). */
export async function deleteOwnAccount(currentPassword: string) {
  unwrap(await api.delete('/settings/account', { current_password: currentPassword }));
}

/** Changes the password; the server then signs out every device, this one too. */
export async function changePassword(currentPassword: string, newPassword: string) {
  unwrap(await api.put('/auth/password', { current_password: currentPassword, new_password: newPassword }));
}

export type TwoFactorStatus = { enabled: boolean; recoveryCodesRemaining: number; secretReadable?: boolean };
export type TwoFactorSetup = { secret: string; otpauth_uri: string };

export const twoFactorStatusQueryKey = ['auth', '2fa-status'] as const;

export async function fetchTwoFactorStatus(signal?: AbortSignal): Promise<TwoFactorStatus> {
  return unwrap(await api.get<TwoFactorStatus>('/auth/2fa/status', { signal })) || { enabled: false, recoveryCodesRemaining: 0 };
}
export async function startTwoFactorSetup() {
  return unwrap(await api.post<TwoFactorSetup>('/auth/2fa/setup/start')) || null;
}
export async function confirmTwoFactorSetup(input: { secret: string; code: string; current_password: string }) {
  return unwrap(await api.post<{ recoveryCodes: string[] }>('/auth/2fa/setup/confirm', input))?.recoveryCodes || [];
}
export async function disableTwoFactor(input: { current_password: string; code: string }) {
  unwrap(await api.post('/auth/2fa/disable', input));
}
export async function regenerateRecoveryCodes(code: string) {
  return unwrap(await api.post<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes/regenerate', { code }))?.recoveryCodes || [];
}
