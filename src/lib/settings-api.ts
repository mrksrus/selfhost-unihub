import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type StartPage = 'mail' | 'calendar' | 'todo' | 'contacts' | 'recordings' | 'music' | 'dashboard';

export interface UserPreferences {
  email_link_behavior: 'mailto' | 'internal';
  default_start_page: StartPage;
}

export const DEFAULT_PREFERENCES: UserPreferences = { email_link_behavior: 'mailto', default_start_page: 'mail' };

export const preferencesQueryKey = ['settings', 'preferences'] as const;

export async function fetchPreferences(signal?: AbortSignal): Promise<UserPreferences> {
  const response = await api.get<{ preferences: UserPreferences }>('/settings/preferences', { signal });
  if (response.error) throw new Error(response.error);
  return { ...DEFAULT_PREFERENCES, ...response.data?.preferences };
}

export async function savePreferences(preferences: UserPreferences): Promise<UserPreferences> {
  const response = await api.put<{ preferences: UserPreferences }>('/settings/preferences', preferences);
  if (response.error) throw new Error(response.error);
  return { ...DEFAULT_PREFERENCES, ...(response.data?.preferences ?? preferences) };
}

export const preferencesQueryOptions = queryOptions({
  queryKey: preferencesQueryKey,
  queryFn: ({ signal }) => fetchPreferences(signal),
  staleTime: 5 * 60 * 1000,
});
