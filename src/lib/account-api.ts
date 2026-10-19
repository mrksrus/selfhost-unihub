import { api } from '@/lib/api';

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
  const response = await api.get<{ sessions: AccountSession[] }>('/auth/sessions', { signal });
  if (response.error) throw new Error(response.error);
  return response.data?.sessions ?? [];
}

export async function signOutSession(id: string) {
  const response = await api.delete(`/auth/sessions/${encodeURIComponent(id)}`);
  if (response.error) throw new Error(response.error);
}

const BROWSERS: [RegExp, string][] = [
  [/UniHubAndroid\//, 'UniHub app'], [/Edg\//, 'Edge'], [/OPR\//, 'Opera'], [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'], [/Safari\//, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [
  [/UniHubAndroid\/|Android/, 'Android'], [/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Windows/, 'Windows'], [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'], [/Linux/, 'Linux'],
];

/** "Firefox on Linux" from a browser's user agent, enough to recognize a device. */
export function describeDevice(userAgent: string | null | undefined) {
  if (!userAgent) return 'Unknown device';
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser || system || 'Unknown device';
}

/** "today", "yesterday", "3 days ago" or a date, for when a device was last used. */
export function lastActiveLabel(iso: string, now = new Date()) {
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((day(now) - day(new Date(iso))) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return `on ${new Date(iso).toLocaleDateString()}`;
}
