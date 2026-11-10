import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import { describeUserAgent } from '@/lib/platform';

/** A signed-in device of this account (GET /api/auth/sessions). */
export interface AccountSession {
  id: string;
  current: boolean;
  createdAt: string | null;
  /** When the session was last used, to the day (it renews at most daily). */
  lastActiveAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export const accountSessionsQueryKey = ['account', 'sessions'] as const;

export async function fetchAccountSessions(signal?: AbortSignal): Promise<AccountSession[]> {
  return unwrap(await api.get<{ sessions: AccountSession[] }>('/auth/sessions', { signal }))?.sessions ?? [];
}

export async function signOutSession(id: string) {
  unwrap(await api.delete(`/auth/sessions/${encodeURIComponent(id)}`));
}

/** "Firefox on Linux" from a browser's user agent (lib/platform.ts reads user agents). */
export const describeDevice = describeUserAgent;

/** "today", "yesterday", "3 days ago" or a date, for when a device was last used. */
export function lastActiveLabel(iso: string, now = new Date()) {
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((day(now) - day(new Date(iso))) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return `on ${new Date(iso).toLocaleDateString()}`;
}
