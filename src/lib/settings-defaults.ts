import type { CalendarSettingValues, MailAccountSettingValues, ResolvedSettings, UserSettingValues } from '../../api/src/contracts/settings';

// The registry's defaults (api/src/services/settings-registry.ts, kept equal
// by settings-registry-parity.test.ts), shown until the account's settings load.
export const DEFAULT_USER_SETTINGS: UserSettingValues = {
  email_link_behavior: 'mailto',
  default_start_page: 'mail',
  default_mail_account_id: '',
  accent_color: 'blue',
  week_start: 'monday',
  default_event_reminder: 0,
  reminder_notification_detail: 'full',
  compose_format: 'rich',
  compose_format_switch: false,
  compose_templates: false,
  compose_scheduled_send: false,
  reading_format: 'theme',
  mail_threaded_view: false,
  mail_preview_lines: 1,
  snooze_choices: ['1h', '1d', '1w'],
  snoozed_messages: 'hide',
};
export const DEFAULT_MAIL_ACCOUNT_SETTINGS: MailAccountSettingValues = {
  notify_enabled: true,
  notify_folder_mode: 'except',
  notify_folders: ['role:junk', 'role:sent', 'role:drafts', 'role:trash', 'role:archive'],
  notify_detail: 'full',
};
export const DEFAULT_CALENDAR_SETTINGS: CalendarSettingValues = { notify_enabled: true };

/** Resolved settings for values only known by default (before loading, or offline). */
export function defaultsResolved<T extends object>(values: T): ResolvedSettings<T> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, source: 'default', locked: false }])) as ResolvedSettings<T>;
}

/** The plain values of resolved settings. */
export function settingValues<T extends object>(settings: ResolvedSettings<T>): T {
  return Object.fromEntries(Object.entries(settings).map(([key, setting]) => [key, (setting as { value: unknown }).value])) as T;
}
