// Request and response shapes of the settings routes (F11). The frontend
// imports these as types only; the registry that checks the values lives in
// services/settings-registry.ts.

import type { BinRetention } from './bin';
import type { AppLockArea, RelockAfter } from './devices';

// `device` (0.29, F5): choices of one device of the person, kept with the
// device record on the server (the app lock), never in a backup.
export type SettingScope = 'user' | 'mail_account' | 'calendar' | 'device';

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
  /**
   * The list new tasks go to: one of the person's own UniHub lists with
   * ToDo on. '' means UniHub's choice (the oldest such list). A list that is
   * gone or no longer qualifies reads as UniHub's choice where it is used;
   * GET /api/calendar/calendars marks the list in effect (default_for_tasks).
   */
  default_task_list_id: string;
  /**
   * The calendar new events go to: any writable calendar of an active
   * account, server calendars included. '' means UniHub's choice; the one in
   * effect is marked default_for_events.
   */
  default_calendar_id: string;
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
  /** How long the bin keeps deleted items, in days or 'forever' (contracts/bin.ts). */
  bin_retention: BinRetention;
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

/**
 * The app lock of one device. The server keeps it so it can enforce the
 * administrator's requirement and hide notification content while the
 * device is locked; the PIN or fingerprint itself never leaves the device.
 */
export interface DeviceSettingValues {
  /** What locks: [] is off, ['app'] the whole app, otherwise these modules. Under a policy, at least what it requires. */
  app_lock_scope: AppLockArea[];
  /** Seconds in the background before it locks again; '0' asks every time UniHub opens. */
  app_lock_relock_after: RelockAfter;
  /** Also lock when the device's own screen locks, where the device can tell. */
  app_lock_on_device_lock: boolean;
}

export interface SettingValuesByScope {
  user: UserSettingValues;
  mail_account: MailAccountSettingValues;
  calendar: CalendarSettingValues;
  device: DeviceSettingValues;
}

export type ResolvedSettings<T> = { [K in keyof T]: ResolvedSetting<T[K]> };

/** GET /api/settings/values and the answer of PUT /api/settings/values. */
export interface UserSettingsResponse { settings: ResolvedSettings<UserSettingValues> }
/** GET /api/settings/values/mail-accounts: every mail account of the user, by id. */
export interface MailAccountSettingsResponse { accounts: Record<string, ResolvedSettings<MailAccountSettingValues>> }
/** GET /api/settings/values/calendars: every calendar of the user, by id. */
export interface CalendarSettingsResponse { calendars: Record<string, ResolvedSettings<CalendarSettingValues>> }
/** GET and PUT /api/settings/values/device: the settings of the device the request came from. */
export interface DeviceSettingsResponse { device_id: string; settings: ResolvedSettings<DeviceSettingValues> }
/** The answer of PUT .../mail-accounts/:id and .../calendars/:id. */
export interface ScopedSettingsResponse<T> { id: string; settings: ResolvedSettings<T> }

/** The body of every PUT: the changed values only; one invalid value saves nothing. */
export interface SettingsUpdateRequest<T> { values: Partial<T> }

/**
 * DELETE /api/settings/account: the person's own password again. 400
 * PASSWORD_REQUIRED without it, 403 PASSWORD_INCORRECT, 429 after too many
 * wrong ones; 403 POLICY_FORBIDS while account.delete is forbidden.
 */
export interface AccountDeleteRequest { current_password: string }

/**
 * POST /api/settings/clear-{contacts,calendar,mail-accounts,recordings}: the
 * module's items deleted for good. clear-mail-accounts answers 409
 * MAIL_OPERATIONS_UNRESOLVED, deleting nothing, while a provider change of
 * an account has an unresolved outcome (as purging one account does).
 */
export interface ClearDataResponse { message: string; deleted: number }
