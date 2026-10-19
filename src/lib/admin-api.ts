import { api } from '@/lib/api';

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
  const response = await api.get<AuditPage>(`/admin/audit${query}`, { signal });
  if (response.error) throw new Error(response.error);
  return { entries: response.data?.entries ?? [], cursor: response.data?.cursor ?? null };
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
