import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';

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
export async function deleteAdminUser(userId: string) {
  unwrap(await api.delete(`/admin/users/${userId}`));
}
// Role, password and two-factor changes need the acting admin's own password.
export async function setUserRole(userId: string, role: AdminUser['role'], currentPassword: string) {
  unwrap(await api.put(`/admin/users/${userId}/role`, { role, current_password: currentPassword }));
}
export async function setUserActive(userId: string, isActive: boolean) {
  unwrap(await api.put(`/admin/users/${userId}/activate`, { is_active: isActive }));
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
};

/** What happened, in words; the person acting and the account it concerns are shown beside it. */
export function auditActionLabel(entry: Pick<AuditEntry, 'action' | 'details'>) {
  const label = ACTIONS[entry.action] ?? entry.action;
  if (entry.action === 'admin.role_changed' && entry.details?.role) return `${label} to ${entry.details.role === 'admin' ? 'admin' : 'standard user'}`;
  if (entry.action === 'admin.signup_mode_changed' && entry.details?.mode) return `${label} to ${entry.details.mode}`;
  return label;
}
