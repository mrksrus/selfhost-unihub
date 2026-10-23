import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { DEFAULT_USER_SETTINGS, defaultsResolved } from '@/lib/settings-defaults';
import type {
  CalendarSettingsResponse,
  CalendarSettingValues,
  MailAccountSettingsResponse,
  MailAccountSettingValues,
  ResolvedSettings,
  ScopedSettingsResponse,
  UserSettingsResponse,
  UserSettingValues,
} from '../../api/src/contracts/settings';

export type { ReadingFormat, ResolvedSetting, ResolvedSettings, SnoozeChoice, StartPage, UserSettingValues, MailAccountSettingValues, CalendarSettingValues, NotificationFolderRef } from '../../api/src/contracts/settings';
export { DEFAULT_USER_SETTINGS, DEFAULT_MAIL_ACCOUNT_SETTINGS, DEFAULT_CALENDAR_SETTINGS, defaultsResolved, settingValues } from '@/lib/settings-defaults';
export type UserSettings = ResolvedSettings<UserSettingValues>;
export type MailAccountSettings = ResolvedSettings<MailAccountSettingValues>;
export type CalendarSettings = ResolvedSettings<CalendarSettingValues>;

export const userSettingsQueryKey = ['settings', 'values'] as const;
export const mailAccountSettingsQueryKey = ['settings', 'values', 'mail-accounts'] as const;
export const calendarSettingsQueryKey = ['settings', 'values', 'calendars'] as const;

export async function fetchUserSettings(signal?: AbortSignal): Promise<UserSettings> {
  const response = await api.get<UserSettingsResponse>('/settings/values', { signal });
  if (response.error) throw new Error(response.error);
  return { ...defaultsResolved(DEFAULT_USER_SETTINGS), ...response.data?.settings };
}

/** Saves the changed values only; the answer is every setting as now resolved. */
export async function saveUserSettings(values: Partial<UserSettingValues>): Promise<UserSettings> {
  const response = await api.put<UserSettingsResponse>('/settings/values', { values });
  if (response.error) throw new Error(response.error);
  return { ...defaultsResolved(DEFAULT_USER_SETTINGS), ...response.data!.settings };
}

export async function fetchMailAccountSettings(signal?: AbortSignal): Promise<Record<string, MailAccountSettings>> {
  const response = await api.get<MailAccountSettingsResponse>('/settings/values/mail-accounts', { signal });
  if (response.error) throw new Error(response.error);
  return response.data?.accounts ?? {};
}

export async function saveMailAccountSettings(accountId: string, values: Partial<MailAccountSettingValues>): Promise<MailAccountSettings> {
  const response = await api.put<ScopedSettingsResponse<MailAccountSettingValues>>(`/settings/values/mail-accounts/${encodeURIComponent(accountId)}`, { values });
  if (response.error) throw new Error(response.error);
  return response.data!.settings;
}

export async function fetchCalendarSettings(signal?: AbortSignal): Promise<Record<string, CalendarSettings>> {
  const response = await api.get<CalendarSettingsResponse>('/settings/values/calendars', { signal });
  if (response.error) throw new Error(response.error);
  return response.data?.calendars ?? {};
}

export async function saveCalendarSettings(calendarId: string, values: Partial<CalendarSettingValues>): Promise<CalendarSettings> {
  const response = await api.put<ScopedSettingsResponse<CalendarSettingValues>>(`/settings/values/calendars/${encodeURIComponent(calendarId)}`, { values });
  if (response.error) throw new Error(response.error);
  return response.data!.settings;
}

export const userSettingsQueryOptions = queryOptions({
  queryKey: userSettingsQueryKey,
  queryFn: ({ signal }) => fetchUserSettings(signal),
  staleTime: 5 * 60 * 1000,
});

export const mailAccountSettingsQueryOptions = queryOptions({
  queryKey: mailAccountSettingsQueryKey,
  queryFn: ({ signal }) => fetchMailAccountSettings(signal),
  staleTime: 5 * 60 * 1000,
});

export const calendarSettingsQueryOptions = queryOptions({
  queryKey: calendarSettingsQueryKey,
  queryFn: ({ signal }) => fetchCalendarSettings(signal),
  staleTime: 5 * 60 * 1000,
});

/** One user setting's value, the default until loaded. */
export const selectUserSetting = <K extends keyof UserSettingValues>(key: K) => (settings: UserSettings) => settings[key].value;
