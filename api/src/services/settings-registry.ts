import type { SettingScope } from '../contracts/settings';
import type { BinMinimumRetention, PolicyKey, PolicyValues } from '../contracts/policies';
import type { AppLockArea } from '../contracts/devices';

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
  // A list whose strictness is containment: a value covering more is
  // stricter, and the stricter of two is their union (in the kind's allowed
  // order). `alone` covers every other item and stands alone (the app
  // lock's 'app'). Such a key can have a floor like one with an order.
  union?: Union;
}

export interface Union { alone: string }

const FOLDER_REF = /^(role:[a-z0-9_]{1,32}|folder:[0-9a-f-]{36})$/;
// The app lock (0.29): the whole app, or modules by the module catalog's ids
// (calendar is Calendar and ToDo, recordings is Recordings and Music).
const APP_LOCK_AREAS = ['app', 'mail', 'contacts', 'calendar', 'recordings'] as const satisfies readonly AppLockArea[];
const APP_LOCK_SCOPE = { type: 'list', item: /^[a-z]{1,16}$/, maxItems: APP_LOCK_AREAS.length, unique: true, allowed: APP_LOCK_AREAS } as const satisfies Kind;
const APP_LOCK_UNION: Union = { alone: 'app' };
// Seconds in the background before the lock asks again, from the longest
// (least strict) to every time UniHub opens.
const RELOCK_AFTER = ['900', '300', '60', '0'] as const;
// The longest session after its sign-in, in days, from no limit to a day.
const SESSION_MAX_DAYS = ['none', '30', '14', '7', '1'] as const;
const SNOOZE_CHOICES =['1h', '3h', 'tomorrow', '1d', '2d', 'next_week', '1w', '2w', '1mo'] as const;

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
    // How long the bin keeps deleted items (services/bin.ts, D13; bin_retention).
    // Keeping longer is stricter, so an administrator's policy is a minimum;
    // while bin.delete is forbidden, BIN_MIN_RETENTION is one.
    bin_retention: { scope: 'user', kind: { type: 'enum', values: ['7', '30', '90', 'forever'] }, default: '30', strictness: ['7', '30', '90', 'forever'] },
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
  // One device of the person (F5): the app lock, kept with the device record
  // (device_settings) so the server can enforce a requirement and hide
  // notification content while the device is locked. Never in a backup.
  device: {
    app_lock_scope: { scope: 'device', kind: APP_LOCK_SCOPE, default: [], union: APP_LOCK_UNION },
    app_lock_relock_after: { scope: 'device', kind: { type: 'enum', values: RELOCK_AFTER }, default: '60', strictness: RELOCK_AFTER },
    app_lock_on_device_lock: { scope: 'device', kind: { type: 'boolean' }, default: true },
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
  // A list key whose strictness is containment (Entry.union).
  union?: Union;
  // The values that refuse the action the key names.
  refuses: readonly V[];
  // A plain sentence for each value other than the default, shown beside a
  // greyed control and in the notice of the rules in force.
  reasons: Readonly<Record<string, string>>;
  // The sentence of a value `reasons` cannot list (a list key's); null for none.
  reasonOf?(value: V): string | null;
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
  // A minimum: the backup routes refuse deleting a younger backup
  // (services/backup-policy.ts); nothing is deleted automatically.
  'backup.server_retention_days': {
    kind: { type: 'integer', min: 30, max: 365, values: [30, 90, 365], nullable: true }, default: null, strictness: ['null', '30', '90', '365'], refuses: [],
    reasons: Object.fromEntries([30, 90, 365].map(days => [String(days), `Your backups are kept at least ${days} days: until then nobody can delete them.`])),
  },
  'accounts.add': allowance('Your administrator does not allow adding accounts.'),
  'accounts.remove': allowance('Your administrator does not allow removing accounts.'),
  'accounts.reset': allowance('Your administrator does not allow deleting UniHub\'s copy of an account\'s mail.'),
  // The administrator's path for a person (F13) is always there.
  'accounts.admin_manage': { kind: { type: 'enum', values: ['available'] }, default: 'available', refuses: [], reasons: {} },
  'account.delete': allowance('Your administrator does not allow deleting your UniHub account.'),
  'data.clear': allowance('Your administrator does not allow deleting data.', 'bin.delete'),
  'bin.delete': allowance('Your administrator does not allow deleting items from the bin for good.'),
  // The app lock (0.29). None refuses a route by name: the request boundary
  // refuses the locked parts to a device that does not report a lock
  // covering them (APP_LOCK_REQUIRED), and the first two become the floors
  // of each device's app_lock_scope and app_lock_relock_after
  // (services/settings.ts withAppLockFloor).
  'app_lock.required': { kind: APP_LOCK_SCOPE, default: [], union: APP_LOCK_UNION, refuses: [], reasons: {}, reasonOf: appLockRequiredReason },
  'app_lock.max_background': {
    kind: { type: 'enum', values: ['none', ...RELOCK_AFTER] }, default: 'none', strictness: ['none', ...RELOCK_AFTER], refuses: [],
    reasons: {
      900: 'Your administrator allows at most 15 minutes in the background before UniHub locks again.',
      300: 'Your administrator allows at most 5 minutes in the background before UniHub locks again.',
      60: 'Your administrator allows at most 1 minute in the background before UniHub locks again.',
      0: 'Your administrator requires UniHub to lock every time you leave it.',
    },
  },
  'app_lock.screenshots': { ...allowance('Your administrator does not allow screenshots in the UniHub app.'), refuses: [] },
  // Sign-in, modules, notifications, phone and offline (0.30). Registered
  // here with their values and reasons; the request boundary, the services
  // and the workers enforce them.
  'auth.two_factor': {
    kind: { type: 'enum', values: ['optional', 'required'] }, default: 'optional', strictness: ['optional', 'required'], refuses: ['required'],
    reasons: { required: 'Your administrator requires two-factor authentication.' },
  },
  'auth.password_min_length': {
    kind: { type: 'integer', min: 12, max: 20, values: [12, 14, 16, 20] }, default: 12, strictness: ['12', '14', '16', '20'], refuses: [],
    reasons: Object.fromEntries([14, 16, 20].map(length => [String(length), `Passwords need at least ${length} characters, as your administrator set.`])),
  },
  'auth.session_max_days': {
    kind: { type: 'enum', values: SESSION_MAX_DAYS }, default: 'none', strictness: SESSION_MAX_DAYS, refuses: [],
    reasons: {
      30: 'You sign in again at least every 30 days, as your administrator set.',
      14: 'You sign in again at least every 14 days, as your administrator set.',
      7: 'You sign in again at least every 7 days, as your administrator set.',
      1: 'You sign in again every day, as your administrator set.',
    },
  },
  'modules.mail': allowance('Your administrator turned Mail off.'),
  'modules.calendar': allowance('Your administrator turned Calendar and ToDo off.'),
  'modules.contacts': allowance('Your administrator turned Contacts off.'),
  'modules.recordings': allowance('Your administrator turned Recordings and Music off.'),
  'pages.music': allowance('Your administrator turned the Music page off.'),
  'notifications.detail': {
    kind: { type: 'enum', values: ['full', 'sender', 'none'] }, default: 'full', strictness: ['full', 'sender', 'none'], refuses: [],
    reasons: {
      sender: 'Notifications show at most who a message is from, as your administrator set.',
      none: 'Notifications show no content, as your administrator set.',
    },
  },
  'contacts.phone_sync': allowance('Your administrator does not allow UniHub contacts in the phone\'s contacts.'),
  'offline.copies': allowance('Your administrator does not allow offline copies.'),
};

const APP_LOCK_AREA_NAMES: Readonly<Record<Exclude<AppLockArea, 'app'>, string>> = {
  mail: 'Mail', contacts: 'Contacts', calendar: 'Calendar and ToDo', recordings: 'Recordings and Music',
};
function appLockRequiredReason(value: readonly string[]): string | null {
  if (!value.length) return null;
  if (value.includes('app')) return 'Your administrator requires the app lock for the whole app.';
  const names = APP_LOCK_AREAS.filter(area => area !== 'app' && value.includes(area)).map(area => APP_LOCK_AREA_NAMES[area as Exclude<AppLockArea, 'app'>]);
  // "Mail and Contacts"; with more, commas and a last "and" keep "Calendar and ToDo" one name.
  const list = names.length > 2 ? `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}` : names.join(' and ');
  return `Your administrator requires the app lock for ${list}.`;
}

// The bin's minimum retention while bin.delete is forbidden, stored as
// policy.bin.min_retention. It only ever adds a floor to the person's
// bin_retention (services/settings.ts), so it refuses nothing itself.
export const BIN_MIN_RETENTION: PolicyEntry<BinMinimumRetention> = {
  kind: { type: 'enum', values: ['30', '90', 'forever'] }, default: 'forever', strictness: ['30', '90', 'forever'], refuses: [],
  reasons: {
    30: 'Deleted items stay in the bin for at least 30 days.',
    90: 'Deleted items stay in the bin for at least 90 days.',
    forever: 'Deleted items stay in the bin until they are restored.',
  },
};

// What a key's restrictive value means for data that already exists, for the
// administrator's page. Changing a policy deletes nothing (F13).
export const POLICY_EFFECTS: Readonly<Partial<Record<PolicyKey | 'bin.min_retention', string>>> = {
  'mail.mode.download': 'Existing Download accounts keep working; adding one or switching to Download is refused.',
  'mail.mode.sync': 'Existing Sync accounts keep working; adding one or switching to Sync is refused.',
  'mail.mode.new_accounts': 'Existing accounts keep their mode.',
  'mail.provider_delete': 'Not allowed: accounts that delete at the provider stop deleting there. Required: applies to new Download accounts only.',
  'backup.download_mail': 'Applies to backups made from now on.',
  'backup.delete': 'Existing backups stay until an administrator deletes them.',
  'backup.server_retention_days': 'A backup younger than this cannot be deleted by its owner; nothing is deleted automatically.',
  'accounts.remove': 'Existing accounts keep working.',
  'account.delete': 'Administrators can still delete accounts.',
  'bin.delete': 'The automatic purge then keeps items for the minimum below.',
  'bin.min_retention': 'Applies while deleting from the bin for good is not allowed; people may keep items longer.',
  'app_lock.required': 'People are asked to turn the app lock on at their next start; until then their devices cannot open the locked parts.',
  'app_lock.max_background': 'Devices set to lock later are asked to shorten the time.',
  'app_lock.screenshots': 'Applies in the Android app; browsers cannot block screenshots.',
  'auth.two_factor': 'People without two-factor authentication have 7 days to set it up; then they can use nothing else until they do.',
  'auth.password_min_length': 'Applies to passwords set from now on; existing passwords keep working.',
  'auth.session_max_days': 'Applies to existing sessions too: an older one signs out at its next use. Nothing is deleted.',
  'modules.mail': 'Mail is off for these people; their mail and accounts stay and come back when it is allowed again.',
  'modules.calendar': 'Calendar and ToDo are off for these people; their data stays.',
  'modules.contacts': 'Contacts are off for these people; their contacts stay. Phones remove UniHub contacts at their next sync.',
  'modules.recordings': 'Recordings and Music are off for these people; their recordings stay.',
  'pages.music': 'Only the Music page goes; recordings keep working.',
  'notifications.detail': 'Applies to notifications sent from now on.',
  'contacts.phone_sync': 'Phones remove UniHub contacts at their next sync; they stay in UniHub. Changes made on a phone since its last sync are lost.',
  'offline.copies': 'New offline copies are refused; each browser and app deletes its own copy the next time it is online.',
};

export { APP_LOCK_AREAS };
