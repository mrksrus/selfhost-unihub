import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type {
  ResolvedSetting,
  ResolvedSettings,
  SettingScope,
  SettingValuesByScope,
  UserSettingValues,
} from '../contracts/settings';

import { db } from '../state';
import { ApiError, badRequest, forbidden, notFound } from '../http/errors';
import { SETTINGS } from './settings-registry';
import type { Entry, Kind, Value } from './settings-registry';

// The one owner of settings and policies (F1). Every option is one entry of
// the registry (settings-registry.ts). Values are stored per scope:
// - user: user_settings (Settings backup section; module and page choices in
//   the same table belong to module-settings.ts)
// - mail_account: mail_account_settings (Mail section, follows its account)
// - calendar: calendar_settings (Calendar section, follows its calendar)
// Policies live in setting_policies as (target_kind, target_id, key, value,
// locked). Only the installation target exists until groups arrive (0.30);
// resolution is user -> group policies (strictest wins) -> installation ->
// default. Server settings (sign-up mode) live in system_settings, outside
// user recovery. Identity-bound values such as signatures are columns of
// their record, not settings.

type Values<S extends SettingScope> = SettingValuesByScope[S];

const STORAGE: Record<SettingScope, { table: string; idColumn: string; parent?: { table: string; label: string } }> = {
  user: { table: 'user_settings', idColumn: 'user_id' },
  mail_account: { table: 'mail_account_settings', idColumn: 'mail_account_id', parent: { table: 'mail_accounts', label: 'Mail account' } },
  calendar: { table: 'calendar_settings', idColumn: 'calendar_id', parent: { table: 'calendar_calendars', label: 'Calendar' } },
};

const entriesOf = (scope: SettingScope) => SETTINGS[scope] as Readonly<Record<string, Entry>>;
const entryOf = (scope: SettingScope, key: string): Entry | undefined => Object.prototype.hasOwnProperty.call(SETTINGS[scope], key) ? entriesOf(scope)[key] : undefined;
// Policies name a key with its scope: mail_account.notify_detail.
const policyKey = (scope: SettingScope, key: string) => `${scope}.${key}`;

function encode(kind: Kind, value: Value): string {
  if (kind.type === 'boolean') return value ? 'true' : 'false';
  if (kind.type === 'integer') return value === null ? '' : String(value);
  if (kind.type === 'list') return JSON.stringify(value);
  return String(value);
}

// A stored or policy value that is no longer valid reads as absent.
function decode(kind: Kind, text: string): Value | undefined {
  if (kind.type === 'boolean') return text === 'true' ? true : text === 'false' ? false : undefined;
  if (kind.type === 'integer') {
    if (text === '') return kind.nullable ? null : undefined;
    return /^\d+$/.test(text) ? accept(kind, Number(text)) : undefined;
  }
  if (kind.type === 'list') {
    try { return accept(kind, JSON.parse(text)); } catch { return undefined; }
  }
  return accept(kind, text);
}

// The value when it is valid for the kind, else undefined.
function accept(kind: Kind, value: unknown): Value | undefined {
  switch (kind.type) {
    case 'enum': return typeof value === 'string' && kind.values.includes(value) ? value : undefined;
    case 'boolean': return typeof value === 'boolean' ? value : undefined;
    case 'integer':
      if (value === null) return kind.nullable ? null : undefined;
      return Number.isSafeInteger(value) && (value as number) >= kind.min && (value as number) <= kind.max
        && (!kind.values || kind.values.includes(value as number)) ? value as number : undefined;
    case 'reference': return typeof value === 'string' && (value === '' || /^[0-9a-f-]{36}$/.test(value)) ? value : undefined;
    case 'list':
      if (!Array.isArray(value) || value.length > kind.maxItems || new Set(value).size !== value.length) return undefined;
      return value.every(item => typeof item === 'string' && kind.item.test(item) && (!kind.allowed || kind.allowed.includes(item))) ? [...value] as string[] : undefined;
  }
}

const stricter = (entry: Entry, a: Value, b: Value) => entry.strictness!.indexOf(String(a)) >= entry.strictness!.indexOf(String(b)) ? a : b;

interface Policy { value: Value; locked: boolean }
type Policies = Map<string, Policy>;

async function loadPolicies(executor: SqlExecutor): Promise<Policies> {
  const [rows] = await executor.execute<RowDataPacket[]>("SELECT setting_key, setting_value, locked FROM setting_policies WHERE target_kind = 'installation' AND target_id = ''");
  const policies: Policies = new Map();
  for (const row of rows) {
    const [scope, key] = String(row.setting_key).split('.', 2) as [SettingScope, string];
    const entry = STORAGE[scope] ? entryOf(scope, key) : undefined;
    const value = entry ? decode(entry.kind, String(row.setting_value)) : undefined;
    if (value !== undefined) policies.set(row.setting_key, { value, locked: !!Number(row.locked) });
  }
  return policies;
}

function resolve(scope: SettingScope, key: string, entry: Entry, stored: Value | undefined, policies: Policies): ResolvedSetting<Value> {
  const policy = policies.get(policyKey(scope, key));
  if (policy?.locked) return { value: policy.value, source: 'policy', locked: true };
  if (policy && entry.strictness) {
    const chosen = stored === undefined ? entry.default : stored;
    const value = stricter(entry, chosen, policy.value);
    return { value, source: value === chosen && stored !== undefined ? 'user' : value === chosen ? 'default' : 'policy', locked: false, floor: policy.value };
  }
  if (stored !== undefined) return { value: stored, source: 'user', locked: false };
  if (policy) return { value: policy.value, source: 'policy', locked: false };
  return { value: entry.default, source: 'default', locked: false };
}

function resolveAll<S extends SettingScope>(scope: S, stored: Map<string, string>, policies: Policies): ResolvedSettings<Values<S>> {
  const resolved: Record<string, ResolvedSetting<Value>> = {};
  for (const [key, entry] of Object.entries(entriesOf(scope))) {
    const text = stored.get(key);
    resolved[key] = resolve(scope, key, entry, text === undefined ? undefined : decode(entry.kind, text), policies);
  }
  return resolved as unknown as ResolvedSettings<Values<S>>;
}

/** Plain values of resolved settings, for workers and services. */
function valuesOf<T>(resolved: ResolvedSettings<T>): T {
  return Object.fromEntries(Object.entries(resolved).map(([key, setting]) => [key, (setting as ResolvedSetting<unknown>).value])) as T;
}

// The user's records of a scope (the user's own id for the user scope).
async function ownedTargets(scope: SettingScope, userId: string, executor: SqlExecutor, id?: string): Promise<string[]> {
  if (scope === 'user') return [userId];
  const parent = STORAGE[scope].parent!;
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT id FROM ${parent.table} WHERE user_id = ?${id ? ' AND id = ?' : ''} ORDER BY id`, id ? [userId, id] : [userId]);
  return rows.map(row => String(row.id));
}

async function storedValues(scope: SettingScope, userId: string, executor: SqlExecutor): Promise<Map<string, Map<string, string>>> {
  const { table, idColumn } = STORAGE[scope];
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT ${idColumn} AS target_id, setting_key, setting_value FROM ${table} WHERE user_id = ?`, [userId]);
  const byTarget = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const target = String(row.target_id);
    if (!byTarget.has(target)) byTarget.set(target, new Map());
    byTarget.get(target)!.set(String(row.setting_key), String(row.setting_value));
  }
  return byTarget;
}

/** The resolved settings of every record of a scope the user owns, by record id. */
async function getScopedSettings<S extends SettingScope>(scope: S, userId: string, executor: SqlExecutor = db): Promise<Record<string, ResolvedSettings<Values<S>>>> {
  const [targets, stored, policies] = await Promise.all([ownedTargets(scope, userId, executor), storedValues(scope, userId, executor), loadPolicies(executor)]);
  return Object.fromEntries(targets.map(target => [target, resolveAll(scope, stored.get(target) ?? new Map(), policies)]));
}

/** The resolved settings of one owned record of a scope; 404 for anyone else's. */
async function getSettings<S extends SettingScope>(scope: S, userId: string, id: string = userId, executor: SqlExecutor = db): Promise<ResolvedSettings<Values<S>>> {
  if (!(await ownedTargets(scope, userId, executor, id)).length) throw notFound('SETTINGS_TARGET_NOT_FOUND', `${STORAGE[scope].parent?.label ?? 'Record'} not found`);
  const { table, idColumn } = STORAGE[scope];
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT setting_key, setting_value FROM ${table} WHERE ${idColumn} = ? AND user_id = ?`, [id, userId]);
  return resolveAll(scope, new Map(rows.map(row => [String(row.setting_key), String(row.setting_value)])), await loadPolicies(executor));
}

/** The values a worker applies, for a record the caller already knows is the user's. */
async function settingValues<S extends SettingScope>(scope: S, userId: string, id: string = userId, executor: SqlExecutor = db): Promise<Values<S>> {
  return valuesOf(await getSettings(scope, userId, id, executor));
}

async function checkReference(userId: string, kind: Kind, value: Value, executor: SqlExecutor) {
  if (kind.type !== 'reference' || value === '') return;
  const [owned] = await executor.execute<RowDataPacket[]>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? AND is_active = TRUE AND disconnected_at IS NULL', [value, userId]);
  if (!owned.length) throw badRequest('SETTING_REFERENCE_INVALID', 'Choose one of your connected mail accounts');
}

// A folder named by id must be one of the user's folders.
async function checkFolders(userId: string, values: readonly string[], executor: SqlExecutor) {
  const ids = values.filter(value => value.startsWith('folder:')).map(value => value.slice(7));
  if (!ids.length) return;
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT id FROM mail_folders WHERE user_id = ? AND id IN (${ids.map(() => '?').join(', ')})`, [userId, ...ids]);
  if (rows.length !== ids.length) throw badRequest('SETTING_REFERENCE_INVALID', 'Choose folders of your own mail');
}

/**
 * Saves the given values of one owned record of a scope and returns its
 * settings. Every value is checked before any is written; unknown keys, a
 * locked setting or a value below an administrator's floor refuse the whole
 * request.
 */
async function updateSettings<S extends SettingScope>(scope: S, userId: string, id: string, input: unknown, executor: SqlExecutor = db): Promise<ResolvedSettings<Values<S>>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('SETTINGS_INVALID', 'Expected { values: { ... } }');
  const values = (input as { values?: unknown }).values;
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) throw badRequest('SETTINGS_INVALID', 'Expected { values: { ... } }');
  if (!(await ownedTargets(scope, userId, executor, id)).length) throw notFound('SETTINGS_TARGET_NOT_FOUND', `${STORAGE[scope].parent?.label ?? 'Record'} not found`);
  const policies = await loadPolicies(executor);
  const updates: [string, string][] = [];
  for (const [key, raw] of Object.entries(values)) {
    const entry = entryOf(scope, key);
    if (!entry) throw badRequest('SETTING_UNKNOWN', `Unknown setting ${key}`);
    const value = accept(entry.kind, raw);
    if (value === undefined) throw badRequest('SETTING_INVALID', `Invalid value for ${key}`);
    const policy = policies.get(policyKey(scope, key));
    if (policy?.locked) throw forbidden('POLICY_LOCKED', `Your administrator has set ${key}`);
    if (policy && entry.strictness && stricter(entry, value, policy.value) !== value) throw forbidden('POLICY_FLOOR', `Your administrator does not allow less than ${String(policy.value)} for ${key}`);
    await checkReference(userId, entry.kind, value, executor);
    if (key === 'notify_folders') await checkFolders(userId, value as string[], executor);
    updates.push([key, encode(entry.kind, value)]);
  }
  const { table, idColumn } = STORAGE[scope];
  for (const [key, text] of updates) {
    if (scope === 'user') {
      await executor.execute(`INSERT INTO user_settings (user_id, setting_key, setting_value) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [userId, key, text]);
    } else {
      await executor.execute(`INSERT INTO ${table} (${idColumn}, user_id, setting_key, setting_value) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [id, userId, key, text]);
    }
  }
  return getSettings(scope, userId, id, executor);
}

// Restore keeps archived values only for keys and values the registry knows;
// references are remapped by the caller.
function restorableValue(scope: SettingScope, key: string, text: unknown): string | null {
  const entry = entryOf(scope, key);
  if (!entry || typeof text !== 'string') return null;
  return decode(entry.kind, text) === undefined ? null : text;
}

/** The registry's keys of a scope whose values name a mail account, for restore. */
const MAIL_ACCOUNT_REFERENCE_KEYS: readonly string[] = Object.entries(SETTINGS.user)
  .filter(([, entry]) => (entry.kind as Kind).type === 'reference').map(([key]) => key);

// The four preferences before 0.24 (GET/PUT /api/settings/preferences), kept
// for clients from before the settings registry.
const LEGACY_PREFERENCE_KEYS = ['email_link_behavior', 'default_start_page', 'default_mail_account_id', 'accent_color'] as const;
type LegacyPreferences = Pick<UserSettingValues, typeof LEGACY_PREFERENCE_KEYS[number]>;

async function getUserPreferences(userId: string, executor: SqlExecutor = db): Promise<LegacyPreferences> {
  const values = await settingValues('user', userId, userId, executor);
  return Object.fromEntries(LEGACY_PREFERENCE_KEYS.map(key => [key, values[key]])) as LegacyPreferences;
}

/** Saves the known preferences in `input` (others are ignored); every value is checked before any is written. */
async function setUserPreferences(userId: string, input: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {};
  for (const key of LEGACY_PREFERENCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input || {}, key)) values[key] = String(input[key] ?? '').trim();
  }
  if (!Object.keys(values).length) return { preferences: await getUserPreferences(userId) };
  try {
    await updateSettings('user', userId, userId, { values });
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) return { error: error.message, status: error.status };
    throw error;
  }
  return { preferences: await getUserPreferences(userId) };
}

const SIGNUP_MODES = ['open', 'approval', 'disabled'] as const;
type SignupMode = typeof SIGNUP_MODES[number];
const isSignupMode = (value: unknown): value is SignupMode => SIGNUP_MODES.includes(value as SignupMode);

/** Who may create an account; anything unreadable counts as closed. */
async function getSignupMode(executor: SqlExecutor = db): Promise<SignupMode> {
  try {
    const [rows] = await executor.execute<RowDataPacket[]>("SELECT setting_value FROM system_settings WHERE setting_key = 'signup_mode'");
    return isSignupMode(rows[0]?.setting_value) ? rows[0].setting_value : 'disabled';
  } catch {
    return 'disabled';
  }
}

async function setSignupMode(mode: SignupMode, executor: SqlExecutor = db) {
  await executor.execute(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('signup_mode', ?)
    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [mode]);
}

export {
  SETTINGS,
  getSettings,
  getScopedSettings,
  settingValues,
  updateSettings,
  valuesOf,
  restorableValue,
  MAIL_ACCOUNT_REFERENCE_KEYS,
  getUserPreferences,
  setUserPreferences,
  SIGNUP_MODES,
  isSignupMode,
  getSignupMode,
  setSignupMode,
};
export type { SignupMode };
