// Request and response shapes of the settings routes (F11). The frontend
// imports these as types only; the registry that checks the values lives in
// services/settings-registry.ts.

export type SettingScope = 'user' | 'mail_account' | 'calendar';

/**
 * Where a value comes from: the person's own choice, an administrator's
 * policy (a lock, or a floor the choice may not go below), or the default.
 */
export type SettingSource = 'user' | 'policy' | 'default';

export interface ResolvedSetting<T> {
  value: T;
  source: SettingSource;
  /** An administrator fixed the value; the control is shown greyed out. */
  locked: boolean;
  /** The least strict value a policy still allows, when a floor applies. */
  floor?: T;
}

export type ReadingFormat = 'theme' | 'simplified' | 'original' | 'auto';
export type SnoozeChoice = '1h' | '3h' | 'tomorrow' | '1d' | '2d' | 'next_week' | '1w' | '2w' | '1mo';
/** Where a snoozed message is until it comes back: out of its folder (hidden) or still listed there, marked. */
export type SnoozedMessages = 'hide' | 'keep';
export type StartPage = 'mail' | 'calendar' | 'todo' | 'contacts' | 'recordings' | 'music' | 'dashboard';

export interface UserSettingValues {
  email_link_behavior: 'mailto' | 'internal';
  default_start_page: StartPage;
  /** The account new messages are sent from; '' means the first connected account. */
  default_mail_account_id: string;
  /** The accent colour; the choices live in the frontend (src/lib/accent.ts). */
  accent_color: 'blue' | 'indigo' | 'violet' | 'pink' | 'teal' | 'green';
  week_start: 'monday' | 'sunday' | 'saturday';
  /** Minutes before a new event starts; null is no reminder. */
  default_event_reminder: number | null;
  /** How much a calendar reminder shows: the title and time, or only "Event reminder". */
  reminder_notification_detail: 'full' | 'none';
  compose_format: 'rich' | 'plain';
  /** Optional compose buttons (P-26): off until switched on. */
  compose_format_switch: boolean;
  compose_templates: boolean;
  compose_scheduled_send: boolean;
  reading_format: ReadingFormat;
  mail_threaded_view: boolean;
  mail_preview_lines: number;
  snooze_choices: SnoozeChoice[];
  snoozed_messages: SnoozedMessages;
}

/** A folder by its role (inbox, sent, drafts, archive, trash, junk, ...) or by id. */
export type NotificationFolderRef = `role:${string}` | `folder:${string}`;

export interface MailAccountSettingValues {
  notify_enabled: boolean;
  notify_folder_mode: 'except' | 'only';
  notify_folders: NotificationFolderRef[];
  /** How much a new-mail notification shows. */
  notify_detail: 'full' | 'sender' | 'none';
}

export interface CalendarSettingValues {
  notify_enabled: boolean;
}

export interface SettingValuesByScope {
  user: UserSettingValues;
  mail_account: MailAccountSettingValues;
  calendar: CalendarSettingValues;
}

export type ResolvedSettings<T> = { [K in keyof T]: ResolvedSetting<T[K]> };

/** GET /api/settings/values and the answer of PUT /api/settings/values. */
export interface UserSettingsResponse { settings: ResolvedSettings<UserSettingValues> }
/** GET /api/settings/values/mail-accounts: every mail account of the user, by id. */
export interface MailAccountSettingsResponse { accounts: Record<string, ResolvedSettings<MailAccountSettingValues>> }
/** GET /api/settings/values/calendars: every calendar of the user, by id. */
export interface CalendarSettingsResponse { calendars: Record<string, ResolvedSettings<CalendarSettingValues>> }
/** The answer of PUT .../mail-accounts/:id and .../calendars/:id. */
export interface ScopedSettingsResponse<T> { id: string; settings: ResolvedSettings<T> }

/** The body of every PUT: the changed values only; one invalid value saves nothing. */
export interface SettingsUpdateRequest<T> { values: Partial<T> }
