import type { SettingScope } from '../contracts/settings';

// The settings registry (F1): every option of every scope, with its type,
// default and, where an administrator may set a minimum, how strict each
// value is. Pure data, so the frontend's defaults can be checked against it;
// services/settings.ts stores, resolves and checks the values.

export type Value = string | number | boolean | null | string[];
export type Kind =
  | { type: 'enum'; values: readonly string[] }
  | { type: 'boolean' }
  | { type: 'integer'; min: number; max: number; values?: readonly number[]; nullable?: boolean }
  // An id of one of the user's records ('' for none); checked when written,
  // remapped on restore.
  | { type: 'reference'; target: 'mail_account' }
  | { type: 'list'; item: RegExp; maxItems: number; unique: true; allowed?: readonly string[] };

export interface Entry {
  scope: SettingScope;
  kind: Kind;
  default: Value;
  // Values from the most to the least detail (least to most strict). A key
  // with an order can have a floor: an unlocked policy then lets the person
  // choose only as strict or stricter. Without one, an unlocked policy is the
  // installation's default.
  strictness?: readonly string[];
}

const FOLDER_REF = /^(role:[a-z0-9_]{1,32}|folder:[0-9a-f-]{36})$/;
const SNOOZE_CHOICES = ['1h', '3h', 'tomorrow', '1d', '2d', 'next_week', '1w', '2w', '1mo'] as const;

export const SETTINGS = {
  user: {
    email_link_behavior: { scope: 'user', kind: { type: 'enum', values: ['mailto', 'internal'] }, default: 'mailto' },
    default_start_page: { scope: 'user', kind: { type: 'enum', values: ['mail', 'calendar', 'todo', 'contacts', 'recordings', 'music', 'dashboard'] }, default: 'mail' },
    default_mail_account_id: { scope: 'user', kind: { type: 'reference', target: 'mail_account' }, default: '' },
    accent_color: { scope: 'user', kind: { type: 'enum', values: ['blue', 'indigo', 'violet', 'pink', 'teal', 'green'] }, default: 'blue' },
    week_start: { scope: 'user', kind: { type: 'enum', values: ['monday', 'sunday', 'saturday'] }, default: 'monday' },
    default_event_reminder: { scope: 'user', kind: { type: 'integer', min: 0, max: 10080, values: [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080], nullable: true }, default: 0 },
    reminder_notification_detail: { scope: 'user', kind: { type: 'enum', values: ['full', 'none'] }, default: 'full', strictness: ['full', 'none'] },
    compose_format: { scope: 'user', kind: { type: 'enum', values: ['rich', 'plain'] }, default: 'rich' },
    compose_format_switch: { scope: 'user', kind: { type: 'boolean' }, default: false },
    compose_templates: { scope: 'user', kind: { type: 'boolean' }, default: false },
    compose_scheduled_send: { scope: 'user', kind: { type: 'boolean' }, default: false },
    // 'theme' is the behaviour before 0.24: the reading view in the dark
    // theme, the original appearance in the light one (P-14).
    reading_format: { scope: 'user', kind: { type: 'enum', values: ['theme', 'simplified', 'original', 'auto'] }, default: 'theme' },
    mail_threaded_view: { scope: 'user', kind: { type: 'boolean' }, default: false },
    mail_preview_lines: { scope: 'user', kind: { type: 'integer', min: 0, max: 5 }, default: 1 },
    snooze_choices: { scope: 'user', kind: { type: 'list', item: /^[a-z0-9_]{1,16}$/, maxItems: SNOOZE_CHOICES.length, unique: true, allowed: SNOOZE_CHOICES }, default: ['1h', '1d', '1w'] },
  },
  mail_account: {
    notify_enabled: { scope: 'mail_account', kind: { type: 'boolean' }, default: true },
    notify_folder_mode: { scope: 'mail_account', kind: { type: 'enum', values: ['except', 'only'] }, default: 'except' },
    // By role, so the default covers each account's own Junk folder too.
    notify_folders: { scope: 'mail_account', kind: { type: 'list', item: FOLDER_REF, maxItems: 100, unique: true }, default: ['role:junk', 'role:sent', 'role:drafts', 'role:trash', 'role:archive'] },
    notify_detail: { scope: 'mail_account', kind: { type: 'enum', values: ['full', 'sender', 'none'] }, default: 'full', strictness: ['full', 'sender', 'none'] },
  },
  calendar: {
    notify_enabled: { scope: 'calendar', kind: { type: 'boolean' }, default: true },
  },
} as const satisfies Record<SettingScope, Record<string, Entry>>;

