import { DEFAULT_USER_SETTINGS, defaultsResolved, type UserSettingValues } from '@/lib/settings-api';

/** The answer of GET /settings/values with these values chosen and the rest at their defaults. */
export function userSettingsAnswer(values: Partial<UserSettingValues> = {}) {
  const settings = defaultsResolved({ ...DEFAULT_USER_SETTINGS, ...values });
  for (const key of Object.keys(values) as (keyof UserSettingValues)[]) settings[key] = { ...settings[key], source: 'user' } as never;
  return { data: { settings } };
}

/** The answer of PUT /settings/values for its body, as if nothing else had been chosen. */
export function savedSettingsAnswer(body: unknown) {
  return userSettingsAnswer((body as { values: Partial<UserSettingValues> }).values);
}
