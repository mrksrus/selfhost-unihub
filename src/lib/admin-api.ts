import { api } from '@/lib/api';
import { ApiError, unwrap } from '@/lib/api-error';

export interface AdminUser {
  id: string;
  email: string;
  full_name: string | null;
  role: 'user' | 'admin';
  is_active: boolean;
  two_factor_enabled?: boolean;
  created_at: string;
}

export const adminUsersQueryKey = ['admin', 'users'] as const;

export async function fetchAdminUsers(signal?: AbortSignal) {
  return unwrap(await api.get<{ users: AdminUser[] }>('/admin/users', { signal }))?.users ?? [];
}
// Deleting, deactivating, role, password and two-factor changes need the
// acting admin's own password.
export async function deleteAdminUser(userId: string, currentPassword: string) {
  unwrap(await api.delete(`/admin/users/${userId}`, { current_password: currentPassword }));
}
export async function setUserRole(userId: string, role: AdminUser['role'], currentPassword: string) {
  unwrap(await api.put(`/admin/users/${userId}/role`, { role, current_password: currentPassword }));
}
/** Activating needs no password; deactivating does. */
export async function setUserActive(userId: string, isActive: boolean, currentPassword?: string) {
  unwrap(await api.put(`/admin/users/${userId}/activate`, { is_active: isActive, ...(currentPassword ? { current_password: currentPassword } : {}) }));
}
export async function resetUserTwoFactor(userId: string, currentPassword: string) {
  unwrap(await api.post(`/admin/users/${userId}/2fa/reset`, { current_password: currentPassword }));
}
export async function setUserPassword(userId: string, newPassword: string, currentPassword: string) {
  unwrap(await api.put(`/admin/users/${userId}/password`, { new_password: newPassword, current_password: currentPassword }));
}

export type SignupMode = 'open' | 'approval' | 'disabled';
export const signupModeQueryKey = ['admin', 'signup-mode'] as const;

export async function fetchSignupMode(signal?: AbortSignal): Promise<SignupMode> {
  return unwrap(await api.get<{ signup_mode: SignupMode }>('/admin/settings/signup-mode', { signal }))?.signup_mode || 'disabled';
}
export async function saveSignupMode(mode: SignupMode) {
  unwrap(await api.put('/admin/settings/signup-mode', { signup_mode: mode }));
}

export type StorageSection = {
  key: string;
  label: string;
  bytes: number;
  files: number;
  tracked_bytes?: number;
  tracked_items?: number;
  ready_items?: number;
  path_exists: boolean;
  scan_error: string | null;
};

export type StorageUser = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  is_active: boolean;
  orphaned: boolean;
  bytes: number;
  files: number;
  sections: Record<string, { bytes: number; files: number }>;
};

export type StorageOverview = {
  generated_at: string;
  totals: {
    users: number;
    active_users: number;
    mail_accounts: number;
    emails: number;
    contacts: number;
    calendar_events: number;
    bytes: number;
    files: number;
  };
  sections: StorageSection[];
  users: StorageUser[];
};

export const storageQueryKey = ['admin', 'storage'] as const;

export async function fetchStorageOverview(signal?: AbortSignal) {
  return unwrap(await api.get<{ storage: StorageOverview }>('/admin/storage', { signal }))?.storage || null;
}

/** One entry of the server's audit trail (GET /api/admin/audit). */
export interface AuditEntry {
  id: string;
  createdAt: string;
  action: string;
  actor: { id: string; email: string | null } | null;
  target: { id: string; email: string | null } | null;
  ipAddress: string | null;
  requestId: string | null;
  details: Record<string, string | number | boolean | null> | null;
}

export interface AuditPage { entries: AuditEntry[]; cursor: string | null }

export const auditLogQueryKey = ['admin', 'audit'] as const;

export async function fetchAuditLog(before: string | null, signal?: AbortSignal): Promise<AuditPage> {
  const query = before ? `?before=${encodeURIComponent(before)}` : '';
  const page = unwrap(await api.get<AuditPage>(`/admin/audit${query}`, { signal }));
  return { entries: page?.entries ?? [], cursor: page?.cursor ?? null };
}

const ACTIONS: Record<string, string> = {
  'auth.signin': 'Signed in',
  'auth.signin_failed': 'Failed sign-in',
  'auth.password_changed': 'Changed their password',
  'auth.two_factor_enabled': 'Turned on two-factor authentication',
  'auth.two_factor_disabled': 'Turned off two-factor authentication',
  'auth.recovery_codes_replaced': 'Created new recovery codes',
  'auth.session_revoked': 'Signed out another device',
  'auth.account_deleted': 'Deleted their account',
  'admin.password_reset': 'Set a new password',
  'admin.role_changed': 'Changed the role',
  'admin.two_factor_reset': 'Reset two-factor authentication',
  'admin.user_activated': 'Activated the account',
  'admin.user_deactivated': 'Deactivated the account',
  'admin.user_deleted': 'Deleted the account',
  'admin.signup_mode_changed': 'Changed sign-up',
  'mail.account_disconnected': 'Disconnected a mail account',
  'mail.account_purged': 'Removed a mail account and its mail from UniHub',
  // 0.28: policies, the admin path for a person, the instance backup.
  'admin.policy_changed': 'Changed a policy',
  'admin.mail_account_added': 'Added a mail account',
  'admin.mail_account_changed': 'Changed a mail account',
  'admin.mail_account_removed': 'Removed a mail account',
  'admin.mail_account_reset': 'Deleted UniHub\'s copy of a mail account\'s mail',
  'admin.calendar_account_added': 'Added a calendar account',
  'admin.calendar_account_changed': 'Changed a calendar account',
  'admin.calendar_account_removed': 'Removed a calendar account',
  'admin.backup_deleted': 'Deleted a backup',
  'admin.bin_emptied': 'Emptied the bin',
  'admin.bin_item_deleted': 'Deleted an item from the bin for good',
  'admin.data_cleared': 'Deleted data',
  'admin.instance_backup_started': 'Started an instance backup',
};

/** What happened, in words; the person acting and the account it concerns are shown beside it. */
export function auditActionLabel(entry: Pick<AuditEntry, 'action' | 'details'>) {
  const label = ACTIONS[entry.action] ?? entry.action;
  if (entry.action === 'admin.role_changed' && entry.details?.role) return `${label} to ${entry.details.role === 'admin' ? 'admin' : 'standard user'}`;
  if (entry.action === 'admin.signup_mode_changed' && entry.details?.mode) return `${label} to ${entry.details.mode}`;
  if (entry.action === 'admin.policy_changed' && entry.details?.key) return `${label}: ${entry.details.key} to ${entry.details.to ?? '?'}`;
  if (entry.action === 'admin.data_cleared' && entry.details?.module) return `${label}: ${entry.details.module}`;
  return label;
}

// ── Policies (Server settings → Policies) ─────────────────────────
import type { AdminBinMinimumRetention, AdminPoliciesResponse, AdminPoliciesUpdateRequest, BinMinimumRetention, PolicyValues } from '../../api/src/contracts/policies';
export type { AdminPolicy, AdminPoliciesResponse } from '../../api/src/contracts/policies';

export const adminPoliciesQueryKey = ['admin', 'policies'] as const;

/**
 * The bin's minimum retention while bin.delete is forbidden: 30 or 90
 * days, or until restored (the default). The server resolves it as the floor
 * of each person's bin_retention setting; it is its own field of the
 * administrator's routes (bin_min_retention). A server without it leaves
 * the choice greyed out.
 */
export type BinMinimum = BinMinimumRetention;
export type AdminBinMinimum = AdminBinMinimumRetention;
export type AdminPoliciesAnswer = AdminPoliciesResponse;

export async function fetchAdminPolicies(signal?: AbortSignal): Promise<AdminPoliciesAnswer> {
  const answer = unwrap(await api.get<AdminPoliciesAnswer>('/admin/policies', { signal }));
  if (!answer?.policies) throw new Error('The server did not answer with its policies.');
  return answer;
}

/**
 * Saves the changed values only, with the administrator's password; the
 * answer is every policy as now set. `binMinimum` travels as its own field
 * (AdminPoliciesUpdateRequest.bin_min_retention) when it changed.
 */
export async function saveAdminPolicies(values: Partial<PolicyValues>, currentPassword: string, binMinimum?: BinMinimum): Promise<AdminPoliciesAnswer> {
  const body: AdminPoliciesUpdateRequest = { values, current_password: currentPassword, ...(binMinimum ? { bin_min_retention: binMinimum } : {}) };
  const answer = unwrap(await api.put<AdminPoliciesAnswer>('/admin/policies', body));
  if (!answer?.policies) throw new Error('The server did not answer with its policies.');
  return answer;
}

// ── A person's accounts, backups and bin (the admin path, F13) ───
// Every change carries the administrator's own password; the activity log
// records it. The routes call the same services as the person's own.
import type {
  AdminAccountResponse, AdminBinEmptyRequest, AdminCalendarAccount, AdminCalendarAccountCreateRequest, AdminCalendarAccountUpdateRequest,
  AdminClearModule, AdminDeleteResponse, AdminMailAccount, AdminMailAccountCreateRequest, AdminMailAccountUpdateRequest,
  AdminUserAccountsResponse, AdminUserBackupsResponse,
} from '../../api/src/contracts/admin-accounts';
import type { BinDeleteResponse, BinListResponse, BinModule } from '../../api/src/contracts/bin';
import type { MailHostTrustResult } from '@/components/mail/mail-page-model';
export type {
  AdminCalendarAccount, AdminCalendarAccountCreateRequest, AdminCalendarAccountUpdateRequest, AdminClearModule, AdminMailAccount,
  AdminMailAccountCreateRequest, AdminMailAccountUpdateRequest, AdminUserAccountsResponse,
} from '../../api/src/contracts/admin-accounts';

export const adminUserQueryKeys = {
  accounts: (userId: string) => ['admin', 'users', userId, 'accounts'] as const,
  backups: (userId: string) => ['admin', 'users', userId, 'backups'] as const,
  bin: (userId: string) => ['admin', 'users', userId, 'bin'] as const,
};

/**
 * The person's mail server could not be verified: the server answers 409
 * with the certificates to review (as for the person's own add), and the
 * administrator may trust them with accept_host_trust and the fingerprints.
 */
export class AdminHostTrustError extends ApiError {
  constructor(response: Parameters<typeof unwrap>[0], readonly trust: MailHostTrustResult) {
    super(response);
    this.name = 'AdminHostTrustError';
  }
}
const unwrapAccount = <T>(response: Parameters<typeof unwrap>[0] & { data?: T; requiresHostTrustConfirmation?: unknown; mailHostTrust?: unknown }) => {
  if (response.error && response.status === 409 && response.requiresHostTrustConfirmation && response.mailHostTrust) throw new AdminHostTrustError(response, response.mailHostTrust as MailHostTrustResult);
  return unwrap(response);
};

const userPath = (userId: string, rest: string) => `/admin/users/${encodeURIComponent(userId)}${rest}`;
const withPassword = <T extends object>(body: T, currentPassword: string) => ({ ...body, current_password: currentPassword });
const deleted = (answer: AdminDeleteResponse | undefined) => answer?.deleted ?? 0;

export async function fetchAdminUserAccounts(userId: string, signal?: AbortSignal): Promise<AdminUserAccountsResponse> {
  const answer = unwrap(await api.get<AdminUserAccountsResponse>(userPath(userId, '/accounts'), { signal }));
  return { user_id: userId, mail_accounts: answer?.mail_accounts ?? [], calendar_accounts: answer?.calendar_accounts ?? [] };
}
export async function fetchAdminUserBackups(userId: string, signal?: AbortSignal) {
  return unwrap(await api.get<AdminUserBackupsResponse>(userPath(userId, '/backups'), { signal }))?.jobs ?? [];
}
export async function addAdminMailAccount(userId: string, account: Omit<AdminMailAccountCreateRequest, 'current_password'>, currentPassword: string) {
  return unwrapAccount(await api.post<AdminAccountResponse<AdminMailAccount>>(userPath(userId, '/mail-accounts'), withPassword(account, currentPassword)))?.account;
}
export async function updateAdminMailAccount(userId: string, accountId: string, change: Omit<AdminMailAccountUpdateRequest, 'current_password'>, currentPassword: string) {
  return unwrapAccount(await api.put<AdminAccountResponse<AdminMailAccount>>(userPath(userId, `/mail-accounts/${encodeURIComponent(accountId)}`), withPassword(change, currentPassword)))?.account;
}
/** Disconnects the account; `purge` also deletes UniHub's copy of its mail (the provider keeps it). */
export async function removeAdminMailAccount(userId: string, accountId: string, currentPassword: string, purge = false) {
  return deleted(unwrap(await api.delete<AdminDeleteResponse>(userPath(userId, `/mail-accounts/${encodeURIComponent(accountId)}${purge ? '?purge=true' : ''}`), { current_password: currentPassword })));
}
export async function addAdminCalendarAccount(userId: string, account: Omit<AdminCalendarAccountCreateRequest, 'current_password'>, currentPassword: string) {
  return unwrap(await api.post<AdminAccountResponse<AdminCalendarAccount>>(userPath(userId, '/calendar-accounts'), withPassword(account, currentPassword)))?.account;
}
export async function updateAdminCalendarAccount(userId: string, accountId: string, change: Omit<AdminCalendarAccountUpdateRequest, 'current_password'>, currentPassword: string) {
  return unwrap(await api.put<AdminAccountResponse<AdminCalendarAccount>>(userPath(userId, `/calendar-accounts/${encodeURIComponent(accountId)}`), withPassword(change, currentPassword)))?.account;
}
export async function removeAdminCalendarAccount(userId: string, accountId: string, currentPassword: string) {
  return deleted(unwrap(await api.delete<AdminDeleteResponse>(userPath(userId, `/calendar-accounts/${encodeURIComponent(accountId)}`), { current_password: currentPassword })));
}
export async function deleteAdminUserBackup(userId: string, jobId: string, currentPassword: string) {
  return deleted(unwrap(await api.delete<AdminDeleteResponse>(userPath(userId, `/backups/${encodeURIComponent(jobId)}`), { current_password: currentPassword })));
}
/** The person's bin as they see it (GET /api/admin/users/:id/bin). */
export async function fetchAdminUserBin(userId: string, signal?: AbortSignal): Promise<BinListResponse> {
  const answer = unwrap(await api.get<BinListResponse>(userPath(userId, '/bin'), { signal }));
  return { items: answer?.items ?? [], retention: answer?.retention ?? '30' };
}
/** Deletes one item of the person's bin for good. */
export async function deleteAdminUserBinItem(userId: string, itemId: string, currentPassword: string) {
  return unwrap(await api.delete<BinDeleteResponse>(userPath(userId, `/bin/${encodeURIComponent(itemId)}`), { current_password: currentPassword }))?.deleted ?? 0;
}
export async function emptyAdminUserBin(userId: string, currentPassword: string, module?: BinModule) {
  return deleted(unwrap(await api.post<AdminDeleteResponse>(userPath(userId, '/bin/empty'), withPassword(module ? { module } : {}, currentPassword) satisfies AdminBinEmptyRequest)));
}
/** Settings → Delete data for that person: every item of one module. */
export async function clearAdminUserModule(userId: string, module: AdminClearModule, currentPassword: string) {
  return deleted(unwrap(await api.post<AdminDeleteResponse>(userPath(userId, `/clear/${module}`), { current_password: currentPassword })));
}
