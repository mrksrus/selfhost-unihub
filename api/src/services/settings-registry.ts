import type { SettingScope } from '../contracts/settings';
import type { PolicyKey, PolicyValues } from '../contracts/policies';

// The settings registry (F1): every option of every scope, with its type,
// default and, where an administrator may set a minimum, how strict each
// value is. Pure data, so the frontend's defaults can be checked against it;
// services/settings.ts stores, resolves and checks the values.

export type ReferenceTarget = 'mail_account' | 'calendar' | 'task_list';
export type Value = string | number | boolean | null | string[];
export type Kind =
  | { type: 'enum'; values: readonly string[] }
  | { type: 'boolean' }
  | { type: 'integer'; min: number; max: number; values?: readonly number[]; nullable?: boolean }
  // An id of one of the user's records ('' for none); checked when written
  // (settings.ts checkReference), remapped on restore by its target's id map.
  // A task_list is a calendar that can take tasks without a date.
  | { type: 'reference'; target: ReferenceTarget }
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
    // The event dialog's reminder choices (REMINDER_OPTIONS in src/lib/calendar-api.ts).
    default_event_reminder: { scope: 'user', kind: { type: 'integer', min: 0, max: 1440, values: [0, 5, 15, 30, 60, 120, 1440], nullable: true }, default: 0 },
    // Where new tasks and events go (0.27); '' is UniHub's choice
    // (services/calendar.ts resolveCalendarDefaults).
    default_task_list_id: { scope: 'user', kind: { type: 'reference', target: 'task_list' }, default: '' },
    default_calendar_id: { scope: 'user', kind: { type: 'reference', target: 'calendar' }, default: '' },
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
    // A view rule (mail-snooze.ts): which lists show a message while it is
    // snoozed. 'hide' is the behaviour before 0.25.
    snoozed_messages: { scope: 'user', kind: { type: 'enum', values: ['hide', 'keep'] }, default: 'hide' },
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

// Data-safety policies (F13): rules on actions, not settings of a person.
// Each key's default allows what UniHub does today, so nothing changes until
// an administrator sets a policy (stored in setting_policies as
// policy.<key>). services/settings.ts resolves them; the boundary and the
// services refuse a forbidden action with POLICY_FORBIDS and the key's reason.
export interface PolicyEntry<V extends Value = Value> {
  kind: Kind;
  default: V;
  // Values from the least to the most strict, where the key has an order.
  strictness?: readonly string[];
  // The values that refuse the action the key names.
  refuses: readonly V[];
  // A plain sentence for each value other than the default, shown beside a
  // greyed control and in the notice of the rules in force.
  reasons: Readonly<Record<string, string>>;
  // The key also refuses while this one does.
  impliedBy?: PolicyKey;
}

const ALLOWANCE: Kind = { type: 'enum', values: ['allowed', 'forbidden'] };
const allowance = (reason: string, impliedBy?: PolicyKey): PolicyEntry<'allowed' | 'forbidden'> => ({
  kind: ALLOWANCE, default: 'allowed', strictness: ['allowed', 'forbidden'], refuses: ['forbidden'], reasons: { forbidden: reason }, ...(impliedBy ? { impliedBy } : {}),
});

export const POLICIES: { readonly [K in PolicyKey]: PolicyEntry<PolicyValues[K]> } = {
  'mail.mode.download': allowance('Your administrator does not allow Download mode for mail accounts.'),
  'mail.mode.sync': allowance('Your administrator does not allow Sync mode for mail accounts.'),
  'mail.mode.new_accounts': {
    kind: { type: 'enum', values: ['user_choice', 'download', 'download_delete', 'sync'] }, default: 'user_choice', refuses: [],
    reasons: {
      download: 'New mail accounts use Download mode, as your administrator set.',
      download_delete: 'New mail accounts use Download mode and delete downloaded mail at the provider, as your administrator set.',
      sync: 'New mail accounts use Sync mode, as your administrator set.',
    },
  },
  'mail.provider_delete': {
    kind: { type: 'enum', values: ['user_choice', 'forbidden', 'required'] }, default: 'user_choice', refuses: ['forbidden'],
    reasons: {
      forbidden: 'Your administrator does not allow deleting mail at the provider.',
      required: 'New mail accounts delete downloaded mail at the provider, as your administrator requires.',
    },
  },
  'backup.download_mail': {
    kind: { type: 'enum', values: ['user_choice', 'always'] }, default: 'user_choice', strictness: ['user_choice', 'always'], refuses: [],
    reasons: { always: 'Your backups always include downloaded mail, as your administrator requires.' },
  },
  'backup.create': allowance('Your administrator does not allow creating backups.'),
  'backup.restore': allowance('Your administrator does not allow restoring backups.'),
  'backup.delete': allowance('Your administrator does not allow deleting backups.'),
  'backup.server_retention_days': {
    kind: { type: 'integer', min: 30, max: 365, values: [30, 90, 365], nullable: true }, default: null, refuses: [],
    reasons: Object.fromEntries([30, 90, 365].map(days => [String(days), `The server keeps each of your backups for ${days} days, then removes it.`])),
  },
  'accounts.add': allowance('Your administrator does not allow adding accounts.'),
  'accounts.remove': allowance('Your administrator does not allow removing accounts.'),
  'accounts.reset': allowance('Your administrator does not allow deleting UniHub\'s copy of an account\'s mail.'),
  // The administrator's path for a person (F13) is always there.
  'accounts.admin_manage': { kind: { type: 'enum', values: ['available'] }, default: 'available', refuses: [], reasons: {} },
  'account.delete': allowance('Your administrator does not allow deleting your UniHub account.'),
  'data.clear': allowance('Your administrator does not allow deleting data.', 'bin.delete'),
  'bin.delete': allowance('Your administrator does not allow deleting items from the bin for good.'),
};
