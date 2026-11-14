import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import type { SignupMode } from '@/lib/admin-api';
import type { InviteCheckRequest, InviteCheckResponse } from '../../api/src/contracts/organisation';

export type { InviteCheckResponse } from '../../api/src/contracts/organisation';

/**
 * Who may create an account, for the sign-in page; unknown counts as closed.
 * With it the rules that limit a new person on this server, in plain words
 * (the rules notice): a server before 0.28 sends none.
 */
/**
 * The sign-up mode with the data rules a new person is shown and the
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

/** Deletes one's own UniHub account with everything in it; asks for the password again. */
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

// ── Setup links (/invite#<token>, 0.30) ──────────────────────────
// The token travels in the fragment, so it never reaches server or proxy
// logs. Accepting signs in through AuthContext.acceptInvite.

/** The server answers one 404 INVITE_INVALID for a link that is unknown, used, expired or revoked. */
export const INVITE_INVALID = 'INVITE_INVALID';

const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

/** The token of a setup link's fragment (`#<token>` or `#token=<token>`), or null. */
export function inviteTokenFromHash(hash: string): string | null {
  const raw = hash.replace(/^#/, '');
  const token = raw.startsWith('token=') ? new URLSearchParams(raw).get('token') ?? '' : raw;
  return TOKEN.test(token) ? token : null;
}

/** Reads the token and removes it from the address bar and the history entry. */
export function takeInviteToken(): string | null {
  const token = inviteTokenFromHash(window.location.hash);
  if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  return token;
}

/** Who the link is for and the rules that will apply to them, before a password is chosen. */
export async function checkInvite(token: string): Promise<InviteCheckResponse> {
  const answer = unwrap(await api.post<InviteCheckResponse>('/auth/invite/check', { token } satisfies InviteCheckRequest));
  if (!answer?.email) throw new Error('The server did not answer with the setup link.');
  const revision = answer.rules_revision;
  return {
    ...answer,
    data_rules: Array.isArray(answer.data_rules) ? answer.data_rules.filter(rule => typeof rule === 'string') : [],
    rules_revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 0,
  };
}
