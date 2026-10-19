import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import type { SignupMode } from '@/lib/admin-api';

/** Who may create an account, for the sign-in page; unknown counts as closed. */
export async function fetchPublicSignupMode(): Promise<SignupMode> {
  const response = await api.get<{ signup_mode?: SignupMode }>('/auth/signup-mode');
  return response.data?.signup_mode || 'disabled';
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
