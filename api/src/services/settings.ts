import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type {
  ResolvedSetting,
  ResolvedSettings,
  SettingScope,
  SettingValuesByScope,
  UserSettingValues,
} from '../contracts/settings';
import type { AuthRequest } from '../types';
import type {
  AcknowledgePoliciesResponse,
  AdminPoliciesResponse,
  AdminPolicyGroup,
  BinMinimumRetention,
  EffectivePoliciesResponse,
  EffectivePolicy,
  PolicyForbidsDetails,
  PolicyKey,
  PolicySource,
  PolicyValues,
} from '../contracts/policies';
import type { AppLockRequiredDetails } from '../contracts/devices';

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { db } from '../state';
import { ApiError, badRequest, forbidden, notFound } from '../http/errors';
import { log } from '../log';
import { SETTINGS, POLICIES, BIN_MIN_RETENTION, POLICY_EFFECTS } from './settings-registry';
import { MODULE_CATALOG, PAGE_CATALOG } from './module-catalog';
import type { Entry, Kind, PolicyEntry, ReferenceTarget, Union, Value } from './settings-registry';

// The one owner of settings and policies (F1). Every option is one entry of
// the registry (settings-registry.ts). Values are stored per scope:
// - user: user_settings (Settings backup section; module and page choices in
//   the same table belong to module-settings.ts)
// - mail_account: mail_account_settings (Mail section, follows its account)
// - calendar: calendar_settings (Calendar section, follows its calendar)
// - device: device_settings (0.29; one device of the person, F5: never in a
//   backup, goes with its device record)
// Policies live in setting_policies as (target_kind, target_id, key, value,
// locked) for the installation (Everyone) and for groups (0.30); resolution
// is installation -> the person's groups (a group only makes a rule
// stricter, the strictest group wins) -> user -> default. Server settings (sign-up mode) live in system_settings, outside
// user recovery. Identity-bound values such as signatures are columns of
// their record, not settings.

type Values<S extends SettingScope> = SettingValuesByScope[S];

const STORAGE: Record<SettingScope, { table: string; idColumn: string; parent?: { table: string; label: string } }> = {
  user: { table: 'user_settings', idColumn: 'user_id' },
  mail_account: { table: 'mail_account_settings', idColumn: 'mail_account_id', parent: { table: 'mail_accounts', label: 'Mail account' } },
  calendar: { table: 'calendar_settings', idColumn: 'calendar_id', parent: { table: 'calendar_calendars', label: 'Calendar' } },
  device: { table: 'device_settings', idColumn: 'device_id', parent: { table: 'devices', label: 'Device' } },
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

// A key with an order (strictness) or a containment order (union) can have a floor.
const ordered = (entry: Pick<Entry, 'strictness' | 'union'>) => !!(entry.strictness || entry.union);
// Two values of one key are the same value (lists compare item by item).
const sameValue = (a: Value, b: Value) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => item === b[index]));

// The union of list values in the kind's allowed order; `alone` covers every
// other item and stands alone. Unknown items are dropped.
function unionOf(kind: Kind, union: Union, ...values: Value[]): string[] {
  const items = new Set(values.flatMap(value => Array.isArray(value) ? value : []));
  if (items.has(union.alone)) return [union.alone];
  const order = kind.type === 'list' && kind.allowed ? kind.allowed : [...items].sort();
  return order.filter(item => items.has(item));
}

// The stricter of two values of a key with an order: later in its
// strictness, or the union of the two for a containment order. A value
// outside the order counts as the least strict.
function stricterValue(entry: Pick<Entry, 'kind' | 'strictness' | 'union'>, a: Value, b: Value): Value {
  if (entry.union) return unionOf(entry.kind, entry.union, a, b);
  return entry.strictness!.indexOf(String(a)) >= entry.strictness!.indexOf(String(b)) ? a : b;
}
const stricter = (entry: Entry, a: Value, b: Value) => stricterValue(entry, a, b);
// A value as stored: a containment list in its canonical form.
const canonical = (entry: Pick<Entry, 'kind' | 'union'>, value: Value) => entry.union ? unionOf(entry.kind, entry.union, value) : value;

// reason: the plain words of a floor that comes from a data-safety policy.
interface Policy { value: Value; locked: boolean; reason?: string }
type Policies = Map<string, Policy>;

// The policies on the person's settings: the installation's, with the floors
// that data-safety policies put on settings (bin, app lock, notifications).
async function loadPolicies(executor: SqlExecutor, userId: string | null): Promise<Policies> {
  const { levels, floors } = await loadRules(executor, { userId });
  return withNotificationFloor(withAppLockFloor(withBinFloor(new Map(floors), levels), levels), levels);
}

function resolve(scope: SettingScope, key: string, entry: Entry, stored: Value | undefined, policies: Policies): ResolvedSetting<Value> {
  const policy = policies.get(policyKey(scope, key));
  if (policy?.locked) return { value: policy.value, source: 'policy', locked: true };
  if (policy && ordered(entry)) {
    const chosen = canonical(entry, stored === undefined ? entry.default : stored);
    const value = stricter(entry, chosen, policy.value);
    const own = sameValue(value, chosen);
    return { value, source: own && stored !== undefined ? 'user' : own ? 'default' : 'policy', locked: false, floor: policy.value };
  }
  if (stored !== undefined) return { value: stored, source: 'user', locked: false };
  if (policy) return { value: policy.value, source: 'policy', locked: false };
  return { value: entry.default, source: 'default', locked: false };
}

function resolveAll<S extends SettingScope>(scope: S, stored: Map<string, string>, policies: Policies): ResolvedSettings<Values<S>> {
  const resolved: Record<string, ResolvedSetting<Value>> = {};
  for (const [key, entry] of Object.entries(entriesOf(scope))) {
    const text = stored.get(key);
    const value = text === undefined ? undefined : decode(entry.kind, text);
    resolved[key] = resolve(scope, key, entry, value === undefined ? undefined : canonical(entry, value), policies);
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
  const [targets, stored, policies] = await Promise.all([ownedTargets(scope, userId, executor), storedValues(scope, userId, executor), loadPolicies(executor, userId)]);
  return Object.fromEntries(targets.map(target => [target, resolveAll(scope, stored.get(target) ?? new Map(), policies)]));
}

/** The resolved settings of one owned record of a scope; 404 for anyone else's. */
async function getSettings<S extends SettingScope>(scope: S, userId: string, id: string = userId, executor: SqlExecutor = db): Promise<ResolvedSettings<Values<S>>> {
  if (!(await ownedTargets(scope, userId, executor, id)).length) throw notFound('SETTINGS_TARGET_NOT_FOUND', `${STORAGE[scope].parent?.label ?? 'Record'} not found`);
  const { table, idColumn } = STORAGE[scope];
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT setting_key, setting_value FROM ${table} WHERE ${idColumn} = ? AND user_id = ?`, [id, userId]);
  return resolveAll(scope, new Map(rows.map(row => [String(row.setting_key), String(row.setting_value)])), await loadPolicies(executor, userId));
}

/** The values a worker applies, for a record the caller already knows is the user's. */
async function settingValues<S extends SettingScope>(scope: S, userId: string, id: string = userId, executor: SqlExecutor = db): Promise<Values<S>> {
  return valuesOf(await getSettings(scope, userId, id, executor));
}

/** The values that apply where no record of the scope holds its own: the defaults under the person's policies. */
async function defaultSettingValues<S extends SettingScope>(scope: S, userId: string, executor: SqlExecutor = db): Promise<Values<S>> {
  return valuesOf(resolveAll(scope, new Map(), await loadPolicies(executor, userId)));
}

async function checkReference(userId: string, kind: Kind, value: Value, executor: SqlExecutor) {
  if (kind.type !== 'reference' || value === '') return;
  if (kind.target === 'mail_account') {
    const [owned] = await executor.execute<RowDataPacket[]>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? AND is_active = TRUE AND disconnected_at IS NULL', [value, userId]);
    if (!owned.length) throw badRequest('SETTING_REFERENCE_INVALID', 'Choose one of your connected mail accounts');
    return;
  }
  // The same rules decide where new items go when the value is read
  // (services/calendar.ts resolveCalendarDefaults).
  const calendar = require('./calendar') as typeof import('./calendar');
  const refusal = calendar.calendarChoiceRefusal(kind.target, (await calendar.loadCalendarChoices(userId, executor)).find(choice => choice.id === value));
  if (refusal) throw badRequest('SETTING_REFERENCE_INVALID', refusal);
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
  const policies = await loadPolicies(executor, userId);
  const updates: [string, string][] = [];
  for (const [key, raw] of Object.entries(values)) {
    const entry = entryOf(scope, key);
    if (!entry) throw badRequest('SETTING_UNKNOWN', `Unknown setting ${key}`);
    const accepted = accept(entry.kind, raw);
    if (accepted === undefined) throw badRequest('SETTING_INVALID', `Invalid value for ${key}`);
    const value = canonical(entry, accepted);
    const policy = policies.get(policyKey(scope, key));
    if (policy?.locked) throw forbidden('POLICY_LOCKED', `Your administrator has set ${key}`);
    if (policy && ordered(entry) && !sameValue(stricter(entry, value, policy.value), value)) throw forbidden('POLICY_FLOOR', policy.reason ?? `Your administrator does not allow less than ${String(policy.value)} for ${key}`);
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

/**
 * The registry's user keys whose values name a record of the target, for
 * restore: each is remapped with its own target's id map ('task_list' and
 * 'calendar' both name calendars).
 */
function referenceKeys(...targets: ReferenceTarget[]): string[] {
  return Object.entries(SETTINGS.user).filter(([, entry]) => {
    const kind = entry.kind as Kind;
    return kind.type === 'reference' && targets.includes(kind.target);
  }).map(([key]) => key);
}

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

// Data-safety policies (F13), stored in setting_policies as policy.<key>. A
// key resolves user -> group policies -> installation -> default, as the
// policies on settings do: a locked value stands, and no narrower target
// changes it; a value of a key with an order is a floor a narrower target
// can only make stricter; without an order, the narrower target's value
// replaces an unlocked one. Among one person's groups the strictest value wins.
// A policy names an action, not a choice of the person, so the user step
// holds nothing: what a person may choose (the mail mode, the provider
// deletion switch) is checked by the service that takes the choice, with
// assertAllowed and the same code. The person's groups are one level after
// the installation's (0.30).
const POLICY_PREFIX = 'policy.';
const BIN_MIN_KEY = 'bin.min_retention';
type StoredPolicyKey = PolicyKey | typeof BIN_MIN_KEY;
const isPolicyKey = (key: string): key is PolicyKey => Object.prototype.hasOwnProperty.call(POLICIES, key);
const policyEntry = (key: StoredPolicyKey): PolicyEntry => (key === BIN_MIN_KEY ? BIN_MIN_RETENTION : POLICIES[key]) as PolicyEntry;
type PolicyLevel = Map<StoredPolicyKey, Policy[]>;

// What applies to one person, from one read: the policy levels from the
// broadest to the narrowest (the installation, then the person's groups
// when any sets a policy) and the policies on settings.
interface Rules { levels: PolicyLevel[]; floors: Policies }

interface PolicyRow extends RowDataPacket { target_kind: string; target_id: string; setting_key: string; setting_value: string; locked: unknown }

// A stored value that is no longer valid for its key reads as absent.
function addPolicyRow(level: PolicyLevel, row: PolicyRow) {
  const key = String(row.setting_key).slice(POLICY_PREFIX.length);
  if (!isPolicyKey(key) && key !== BIN_MIN_KEY) return;
  const value = decode(policyEntry(key).kind, String(row.setting_value));
  if (value !== undefined) level.set(key, [...level.get(key) ?? [], { value: canonical(policyEntry(key), value), locked: !!Number(row.locked) }]);
}

function rulesFrom(rows: readonly PolicyRow[]): Rules {
  const installation: PolicyLevel = new Map();
  const groups: PolicyLevel = new Map();
  const floors: Policies = new Map();
  for (const row of rows) {
    if (String(row.setting_key).startsWith(POLICY_PREFIX)) { addPolicyRow(row.target_kind === 'group' ? groups : installation, row); continue; }
    // shortcut: a group's policy on a setting is not read, as no route writes one; read it when the Policies page sets setting floors per group.
    if (row.target_kind !== 'installation') continue;
    const [scope, key] = String(row.setting_key).split('.', 2) as [SettingScope, string];
    const entry = STORAGE[scope] ? entryOf(scope, key) : undefined;
    // A reference names one person's record, so it cannot be an
    // installation's policy; such a row is ignored.
    const value = entry && entry.kind.type !== 'reference' ? decode(entry.kind, String(row.setting_value)) : undefined;
    if (value !== undefined) floors.set(row.setting_key, { value: canonical(entry!, value), locked: !!Number(row.locked) });
  }
  return { levels: groups.size ? [installation, groups] : [installation], floors };
}

// The installation's rows and the policies of the person's groups in one
// query (none without a person: the sign-up form, the installation's page).
// Locked (a destructive step's final check, policyLevels): the person's
// memberships and then the rows with locking reads, which see the latest
// committed rows and hold them until the transaction ends.
async function readRules(executor: SqlExecutor, { userId = null, lock = false }: { userId?: string | null; lock?: boolean }): Promise<Rules> {
  const installation = "(target_kind = 'installation' AND target_id = '')";
  if (!userId) {
    const [rows] = await executor.execute<PolicyRow[]>(`SELECT target_kind, setting_key, setting_value, locked FROM setting_policies WHERE ${installation}${lock ? ' LOCK IN SHARE MODE' : ''}`);
    return rulesFrom(rows);
  }
  if (!lock) {
    const [rows] = await executor.execute<PolicyRow[]>(`SELECT target_kind, setting_key, setting_value, locked FROM setting_policies WHERE ${installation}
      OR (target_kind = 'group' AND setting_key LIKE 'policy.%' AND target_id IN (SELECT group_id FROM org_group_members WHERE user_id = ?))
      ORDER BY target_kind, target_id, setting_key`, [userId]);
    return rulesFrom(rows);
  }
  const [memberships] = await executor.execute<RowDataPacket[]>('SELECT group_id FROM org_group_members WHERE user_id = ? ORDER BY group_id LOCK IN SHARE MODE', [userId]);
  const groups = memberships.map(row => String(row.group_id));
  const [rows] = await executor.execute<PolicyRow[]>(`SELECT target_kind, setting_key, setting_value, locked FROM setting_policies WHERE ${installation}
    ${groups.length ? `OR (target_kind = 'group' AND setting_key LIKE 'policy.%' AND target_id IN (${groups.map(() => '?').join(', ')}))` : ''}
    ORDER BY target_kind, target_id, setting_key LOCK IN SHARE MODE`, groups);
  return rulesFrom(rows);
}

// Everyone's policies at once, for workers that scan every person, a save's
// checks and the installation's page: the installation's level, each
// group's, each person's groups, and every person.
interface RuleSet {
  installation: PolicyLevel;
  groups: Map<string, { name: string; level: PolicyLevel }>;
  membersOf: Map<string, string[]>;
  users: string[];
}

// shortcut: reads every group, membership and person in one pass, fine for one organisation; page through people if installations grow to many thousands.
async function loadRuleSet(executor: SqlExecutor, { lock = false } = {}): Promise<RuleSet> {
  const share = lock ? ' LOCK IN SHARE MODE' : '';
  const [rows] = await executor.execute<PolicyRow[]>(`SELECT target_kind, target_id, setting_key, setting_value, locked FROM setting_policies
    WHERE setting_key LIKE 'policy.%' AND ((target_kind = 'installation' AND target_id = '') OR target_kind = 'group') ORDER BY target_kind, target_id, setting_key${share}`);
  const [groupRows] = await executor.execute<RowDataPacket[]>(`SELECT id, name FROM org_groups ORDER BY id${share}`);
  const [memberRows] = await executor.execute<RowDataPacket[]>(`SELECT group_id, user_id FROM org_group_members ORDER BY user_id, group_id${share}`);
  const [userRows] = await executor.execute<RowDataPacket[]>('SELECT id FROM users ORDER BY id');
  const installation: PolicyLevel = new Map();
  const groups = new Map(groupRows.map(row => [String(row.id), { name: String(row.name), level: new Map() as PolicyLevel }]));
  for (const row of rows) {
    if (row.target_kind === 'installation') addPolicyRow(installation, row);
    else { const group = groups.get(String(row.target_id)); if (group) addPolicyRow(group.level, row); }
  }
  const membersOf = new Map<string, string[]>();
  for (const row of memberRows) membersOf.set(String(row.user_id), [...membersOf.get(String(row.user_id)) ?? [], String(row.group_id)]);
  return { installation, groups, membersOf, users: userRows.map(row => String(row.id)) };
}

// One person's levels from the rule set, as readRules builds them.
function levelsIn(set: RuleSet, userId: string): PolicyLevel[] {
  const groups: PolicyLevel = new Map();
  for (const id of set.membersOf.get(userId) ?? []) {
    for (const [key, policies] of set.groups.get(id)?.level ?? []) groups.set(key, [...groups.get(key) ?? [], ...policies]);
  }
  return groups.size ? [set.installation, groups] : [set.installation];
}

// The request boundary reads a person's rules once and keeps them for the
// request's checks before its route runs: the session's lifetime (in
// verifyToken), the module, phone contacts, data-safety, app lock and
// two-factor gates. They agree and cost one query. Only plain reads on the
// pool use them; a transaction's or a locking read is always fresh, and the
// route itself runs outside, so a change it makes is seen by what it reads next.
const requestRules = new AsyncLocalStorage<Map<string, Promise<Rules>>>();

/** Runs `admit` (the request boundary's checks) with each person's rules read at most once, on first use. */
async function withRequestPolicies<T>(admit: () => Promise<T>): Promise<T> {
  return requestRules.run(new Map(), admit);
}

async function loadRules(executor: SqlExecutor, { userId = null, lock = false }: { userId?: string | null; lock?: boolean } = {}): Promise<Rules> {
  const held = requestRules.getStore();
  if (!held || lock || executor !== db || !userId) return readRules(executor, { userId, lock });
  let rules = held.get(userId);
  if (!rules) {
    rules = readRules(db, { userId });
    held.set(userId, rules);
    // A failed read is not kept: the next check reads again.
    rules.catch(() => held.delete(userId!));
  }
  return rules;
}

async function loadPolicyLevels(executor: SqlExecutor, options: { userId?: string | null; lock?: boolean } = {}): Promise<PolicyLevel[]> {
  return (await loadRules(executor, options)).levels;
}

// The stricter of two values of a key with an order (stricterValue).
const stricterPolicy = (entry: PolicyEntry, a: Value, b: Value) => stricterValue(entry, a, b);

// The one value of a level with several targets (a person's groups): the
// strictest along the key's order. Without an order, the first that refuses
// the action, else the value the groups agree on; groups that disagree set
// nothing (null) and the broader level's value holds.
function levelPolicy(entry: PolicyEntry, policies: readonly Policy[]): Policy | null {
  if (ordered(entry)) {
    const value = policies.map(policy => policy.value).reduce((a, b) => stricterPolicy(entry, a, b));
    return { value, locked: policies.some(policy => policy.locked && sameValue(policy.value, value)) };
  }
  return policies.find(policy => entry.refuses.includes(policy.value))
    ?? (policies.every(policy => sameValue(policy.value, policies[0].value)) ? policies[0] : null);
}

/**
 * A key's value and source from its policies, level by level from the
 * broadest (the installation, first) to the narrowest. The installation's
 * value replaces the default; a narrower level only makes the rule
 * stricter than what holds above it, the default included (the bin's
 * minimum defaults to its strictest value): a key with an order takes the
 * stricter value, and a key without one keeps a value that refuses the action.
 */
function resolvePolicyValue(entry: PolicyEntry, levels: readonly (readonly Policy[] | undefined)[]): { value: Value; source: PolicySource } {
  let value = entry.default;
  let source: PolicySource = 'default';
  for (const [index, policies] of levels.entries()) {
    if (!policies?.length) continue;
    const policy = levelPolicy(entry, policies);
    if (!policy) continue;
    if (index === 0) value = policy.value;
    else if (ordered(entry)) value = stricterPolicy(entry, value, policy.value);
    else if (!entry.refuses.includes(value)) value = policy.value;
    else continue;
    if (index === 0 || sameValue(value, policy.value)) source = 'policy';
    if (policy.locked) break;
  }
  return { value, source };
}

function effectivePolicy<K extends PolicyKey>(key: K, levels: readonly PolicyLevel[]): EffectivePolicy<K> {
  const entry = POLICIES[key] as unknown as PolicyEntry<PolicyValues[K]>;
  const { value, source } = resolvePolicyValue(entry as unknown as PolicyEntry, levels.map(level => level.get(key)));
  const own = entry.refuses.includes(value as PolicyValues[K]);
  // A key implied by another refuses with its own reason when that one refuses.
  const implied = !own && entry.impliedBy ? effectivePolicy(entry.impliedBy, levels) : null;
  if (implied && !implied.allowed) return { value: value as PolicyValues[K], source: implied.source, allowed: false, reason: entry.reasons.forbidden ?? implied.reason };
  const reason = entry.reasonOf ? entry.reasonOf(value as PolicyValues[K]) : entry.reasons[String(value)] ?? null;
  return { value: value as PolicyValues[K], source, allowed: !own, reason };
}

/**
 * The bin's minimum retention in force: while bin.delete is forbidden,
 * the administrator's minimum (by default forever); otherwise none.
 */
function binFloor(levels: readonly PolicyLevel[]): BinMinimumRetention | null {
  if (effectivePolicy('bin.delete', levels).allowed) return null;
  return resolvePolicyValue(BIN_MIN_RETENTION as PolicyEntry, levels.map(level => level.get(BIN_MIN_KEY))).value as BinMinimumRetention;
}

/** The bin's minimum retention in force for the person; null while bin.delete is allowed. */
async function binRetentionFloor(userId: string, executor: SqlExecutor = db, { lock = false }: PolicyRead = {}): Promise<BinMinimumRetention | null> {
  return binFloor(await policyLevels(executor, lock, userId));
}

// The bin's minimum becomes a floor of the person's bin_retention, together
// with any policy of that setting itself (the stricter holds), so the
// settings answer, a refused choice, new bin items and the purge all see it.
function withBinFloor(policies: Policies, levels: readonly PolicyLevel[]): Policies {
  const floor = binFloor(levels);
  if (floor === null) return policies;
  return withFloor(policies, 'user', 'bin_retention', floor, BIN_MIN_RETENTION.reasons[floor]);
}

// A data-safety policy that becomes the floor of a setting, together with
// any policy of that setting itself (the stricter holds); the reason is the
// policy's while its value is the one that holds.
function withFloor(policies: Policies, scope: SettingScope, key: string, floor: Value, reason: string | null): Policies {
  const name = policyKey(scope, key);
  const own = policies.get(name);
  const value = own ? stricter(entryOf(scope, key)!, own.value, floor) : floor;
  policies.set(name, { value, locked: own?.locked ?? false, ...(reason && sameValue(value, floor) ? { reason } : {}) });
  return policies;
}

/**
 * The app lock the person's policies require of every device (0.29): the
 * areas (app_lock.required) and the longest time in the background
 * (app_lock.max_background), with the administrator's reason.
 */
function appLockRequirement(levels: readonly PolicyLevel[]): AppLockRequiredDetails {
  const required = effectivePolicy('app_lock.required', levels);
  const longest = effectivePolicy('app_lock.max_background', levels);
  const max = longest.value === 'none' ? null : longest.value;
  const reason = required.value.length ? required.reason : null;
  return { required: [...required.value], max_background: max, reason: reason ?? (max ? longest.reason : null) };
}

/** The app lock the person's policies require of each of their devices, for the request boundary and the notification stage. */
async function appLockRequirementFor(userId: string, executor: SqlExecutor = db): Promise<AppLockRequiredDetails> {
  return appLockRequirement(await loadPolicyLevels(executor, { userId }));
}

// The requirement becomes the floors of each device's app lock: at least the
// required areas, and no longer in the background than the maximum, so the
// device's settings answer, a refused weaker choice and the lock the page
// applies all follow it.
function withAppLockFloor(policies: Policies, levels: readonly PolicyLevel[]): Policies {
  const { required, max_background } = appLockRequirement(levels);
  if (required.length) withFloor(policies, 'device', 'app_lock_scope', required, effectivePolicy('app_lock.required', levels).reason);
  if (max_background) withFloor(policies, 'device', 'app_lock_relock_after', max_background, effectivePolicy('app_lock.max_background', levels).reason);
  return policies;
}

// The least notification detail (0.30) becomes the floor of each mail
// account's notify_detail and of the reminders' detail, so notifications
// (F6, rendered before encryption) and the settings answer follow it. A
// reminder has no sender: 'sender' leaves reminders at full detail.
function withNotificationFloor(policies: Policies, levels: readonly PolicyLevel[]): Policies {
  const detail = effectivePolicy('notifications.detail', levels);
  if (detail.value === 'full') return policies;
  withFloor(policies, 'mail_account', 'notify_detail', detail.value, detail.reason);
  if (detail.value === 'none') withFloor(policies, 'user', 'reminder_notification_detail', 'none', detail.reason);
  return policies;
}

/** A module or page a policy turns off for the person: its key and the plain reason. */
interface PolicyOff { key: PolicyKey; reason: string }

// The modules (modules.<id>) and pages (pages.<id>) the levels turn off.
function policyOffOf(levels: readonly PolicyLevel[]): { modules: Map<string, PolicyOff>; pages: Map<string, PolicyOff> } {
  const off = (prefix: string, ids: readonly string[]) => new Map(ids.flatMap(id => {
    const key = `${prefix}.${id}`;
    if (!isPolicyKey(key)) return [];
    const policy = effectivePolicy(key, levels);
    return policy.allowed ? [] : [[id, { key, reason: policy.reason ?? 'Your administrator turned this off.' }] as const];
  }));
  return { modules: off('modules', MODULE_CATALOG.map(module => module.id)), pages: off('pages', PAGE_CATALOG.map(page => page.id)) };
}

/** The modules and pages the person's policies turn off (module-settings.ts applies them to the person's switches). */
async function policyOff(userId: string, executor: SqlExecutor = db) {
  return policyOffOf(await loadPolicyLevels(executor, { userId }));
}

/** The modules each person's policies turn off, for workers that scan everyone; `everyone` holds for a person not listed. */
async function policyOffByUser(executor: SqlExecutor = db): Promise<{ everyone: Set<string>; byUser: Map<string, Set<string>> }> {
  const set = await loadRuleSet(executor);
  const byUser = new Map([...set.membersOf.keys()].map(userId => [userId, new Set(policyOffOf(levelsIn(set, userId)).modules.keys())]));
  return { everyone: new Set(policyOffOf([set.installation]).modules.keys()), byUser };
}

/** Every policy key as it applies to the person, from one read of the stored policies. */
async function resolvePolicies(userId: string, executor: SqlExecutor = db): Promise<{ [K in PolicyKey]: EffectivePolicy<K> }> {
  const levels = await loadPolicyLevels(executor, { userId });
  return Object.fromEntries((Object.keys(POLICIES) as PolicyKey[]).map(key => [key, effectivePolicy(key, levels)])) as { [K in PolicyKey]: EffectivePolicy<K> };
}

/** One policy key as it applies to the person, for workers and services. */
async function resolvePolicy<K extends PolicyKey>(userId: string, key: K, executor: SqlExecutor = db, { lock = false }: PolicyRead = {}): Promise<EffectivePolicy<K>> {
  return effectivePolicy(key, await policyLevels(executor, lock, userId));
}

/**
 * Every key for the person as committed now, on a transaction's connection,
 * with the rules revision and the person's memberships held shared until it
 * ends (policyLevels): for the final check of a destructive step (final-step.ts).
 */
async function lockedPolicies(executor: SqlExecutor, userId: string): Promise<<K extends PolicyKey>(key: K) => EffectivePolicy<K>> {
  const levels = await policyLevels(executor, true, userId);
  return key => effectivePolicy(key, levels);
}

// The refusal of an action a policy forbids: 403 POLICY_FORBIDS with the key
// and the plain reason the person sees.
function policyForbids(policy: PolicyKey, reason: string) {
  return forbidden('POLICY_FORBIDS', reason, { policy, reason } satisfies PolicyForbidsDetails);
}

interface PolicyRead {
  // For a destructive step inside its transaction (F13), on that
  // transaction's connection: the policies as committed now, and no
  // administrator's save commits until the transaction ends (policyLevels).
  lock?: boolean;
}

interface PolicyActor {
  // An administrator acting for the person through the admin path (F13,
  // accounts.admin_manage): their route has already checked the role and the
  // password, and a policy never stops them.
  adminId?: string;
}

/**
 * Throws POLICY_FORBIDS for the first of the keys whose policy forbids the
 * person the action it names; the request boundary passes every key a
 * route declares, a service or worker the one its action needs.
 */
async function assertAllowed(userId: string, keys: PolicyKey | readonly PolicyKey[], { adminId }: PolicyActor = {}, executor: SqlExecutor = db): Promise<void> {
  if (adminId) return;
  const list = typeof keys === 'string' ? [keys] : keys;
  if (!list.length) return;
  const levels = await policyLevels(executor, false, userId);
  for (const key of list) {
    const resolved = effectivePolicy(key, levels);
    if (!resolved.allowed) throw policyForbids(key, resolved.reason ?? 'Your administrator does not allow this.');
  }
}

// --- The rules people are told about (the rules notice) ----------------------

/**
 * The rules in force, in plain words: every key an administrator set to
 * something other than its default or whose action is refused, then the
 * bin's minimum while it holds. The same list is shown at sign-up, in the
 * notice and in Settings → Profile; when it changes, so does the revision.
 */
function rulesOf(levels: readonly PolicyLevel[]): string[] {
  const rules: string[] = [];
  for (const key of Object.keys(POLICIES) as PolicyKey[]) {
    const policy = effectivePolicy(key, levels);
    if ((policy.allowed && sameValue(policy.value as Value, POLICIES[key].default as Value)) || !policy.reason) continue;
    rules.push(policy.reason);
  }
  const floor = binFloor(levels);
  if (floor) rules.push(BIN_MIN_RETENTION.reasons[floor]);
  return [...new Set(rules)];
}


const REVISION_KEY = 'policy_revision';

// A change of rules (lockRules: policy saves and group membership changes)
// locks the revision row first and holds it until it commits. A destructive
// step that holds the row shared and then reads the policies with a locking
// read, which sees the latest committed rows whatever the transaction read
// before, acts on the rules in force: a change commits either before that
// read or after the step.
async function policyLevels(executor: SqlExecutor, lock: boolean, userId: string): Promise<PolicyLevel[]> {
  if (!lock) return loadPolicyLevels(executor, { userId });
  await executor.execute('SELECT setting_value FROM system_settings WHERE setting_key = ? LOCK IN SHARE MODE', [REVISION_KEY]);
  return loadPolicyLevels(executor, { userId, lock: true });
}

/** The ids of the groups that set at least one policy. */
async function groupsWithPolicies(executor: SqlExecutor = db): Promise<Set<string>> {
  const [rows] = await executor.execute<RowDataPacket[]>("SELECT DISTINCT target_id FROM setting_policies WHERE target_kind = 'group'");
  return new Set(rows.map(row => String(row.target_id)));
}

/** The installation's rules revision (system_settings policy_revision); 0 before any rule changed. */
async function policyRevision(executor: SqlExecutor = db, { lock = false, share = false } = {}): Promise<number> {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT setting_value FROM system_settings WHERE setting_key = ?${lock ? ' FOR UPDATE' : share ? ' LOCK IN SHARE MODE' : ''}`, [REVISION_KEY]);
  const revision = Number(rows[0]?.setting_value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

// The rules a person confirmed, as a hash (policy_notices.rules_hash).
const rulesHash = (rules: readonly string[]) => crypto.createHash('sha256').update(JSON.stringify(rules)).digest('hex');

// The revision is one for the installation, but the notice is per person:
// a confirmation counts for the current revision while the person's rules
// are still the ones they confirmed, so a change of other people's rules (a
// group's policy, a membership) does not show them the notice. Without a
// confirmation, the person has confirmed no rules at revision 0; one
// without a hash (before 0.30, or of an older revision) counts as it is.
async function acknowledgedRevision(userId: string, revision: number, rules: readonly string[], executor: SqlExecutor = db): Promise<number> {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT revision, rules_hash FROM policy_notices WHERE user_id = ? ORDER BY revision DESC LIMIT 1', [userId]);
  const acknowledged = rows.length ? Number(rows[0].revision) || 0 : 0;
  const hash = rows.length ? rows[0].rules_hash : rulesHash([]);
  return acknowledged < revision && hash === rulesHash(rules) ? revision : Math.min(acknowledged, revision);
}

// Records that the person saw the rules of a revision (with their hash when
// they are the person's current rules); nothing for revision 0.
async function recordAcknowledged(userId: string, revision: number, rules: readonly string[] | null, executor: SqlExecutor) {
  if (revision > 0) await executor.execute(`INSERT INTO policy_notices (user_id, revision, rules_hash) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE rules_hash = COALESCE(VALUES(rules_hash), rules_hash)`, [userId, revision, rules ? rulesHash(rules) : null]);
}

// Reads in one consistent snapshot on one connection: rules shown with a
// revision are that revision's, whatever an administrator saves meanwhile,
// so confirming the revision never confirms rules the person did not see.
async function inSnapshot<T>(read: (cx: SqlExecutor) => Promise<T>): Promise<T> {
  const cx = await db.getConnection();
  try {
    await cx.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const result = await read(cx);
    await cx.commit();
    return result;
  } catch (error) {
    await cx.rollback().catch(() => undefined);
    throw error;
  } finally { cx.release(); }
}

/** GET /api/policies/effective: every key for the person, their rules and where their notice stands; the route adds two_factor (sign-in-policies.ts). */
async function getEffectivePolicies(userId: string): Promise<Omit<EffectivePoliciesResponse, 'two_factor'>> {
  return inSnapshot(async cx => {
    const levels = await loadPolicyLevels(cx, { userId });
    const policies = Object.fromEntries((Object.keys(POLICIES) as PolicyKey[]).map(key => [key, effectivePolicy(key, levels)])) as EffectivePoliciesResponse['policies'];
    const revision = await policyRevision(cx);
    const rules = rulesOf(levels);
    return { policies, revision, acknowledged_revision: await acknowledgedRevision(userId, revision, rules, cx), rules };
  });
}

/** The rules in force for the sign-up form (GET /api/auth/signup-mode), with their revision: a new person is in no group. */
async function signupRules(): Promise<{ data_rules: string[]; rules_revision: number }> {
  return inSnapshot(async cx => ({ data_rules: rulesOf(await loadPolicyLevels(cx)), rules_revision: await policyRevision(cx) }));
}

/** POST /api/policies/acknowledge: the person confirmed the rules of `revision`. */
async function acknowledgePolicies(userId: string, input: unknown): Promise<AcknowledgePoliciesResponse> {
  const revision = (input as { revision?: unknown } | null)?.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw badRequest('POLICY_REVISION_INVALID', 'Expected { revision: <number> }');
  const { withTransaction } = require('./transactions') as typeof import('./transactions');
  return withTransaction(async cx => {
    // Held shared: no change of rules commits between reading them and recording what was confirmed.
    const current = await policyRevision(cx, { share: true });
    if ((revision as number) > current) throw badRequest('POLICY_REVISION_INVALID', 'That revision of the rules does not exist yet');
    const rules = rulesOf(await loadPolicyLevels(cx, { userId }));
    await recordAcknowledged(userId, revision as number, revision === current ? rules : null, cx);
    return { acknowledged_revision: await acknowledgedRevision(userId, current, rules, cx) };
  });
}

/**
 * A new person saw the rules of `shown` (the revision GET signup-mode sent
 * with them) on the sign-up form; their account starts with that revision
 * confirmed. Without one, or with one that does not exist yet, nothing is:
 * the notice then shows the rules after the first sign-in.
 */
async function acknowledgeAtSignup(userId: string, shown: unknown, executor: SqlExecutor = db) {
  const current = await policyRevision(executor);
  if (!Number.isSafeInteger(shown) || (shown as number) <= 0 || (shown as number) > current) return;
  await recordAcknowledged(userId, shown as number, shown === current ? rulesOf(await loadPolicyLevels(executor, { userId })) : null, executor);
}

// --- The administrator's policies page ----------------------------------------

function policyValues(entry: PolicyEntry): Value[] {
  const { kind } = entry;
  if (kind.type === 'enum') return [...kind.values];
  if (kind.type === 'integer') return [...(kind.nullable ? [null] : []), ...(kind.values ?? [])];
  return [entry.default];
}

const policyKeys = () => Object.keys(POLICIES) as PolicyKey[];
const binValues = () => [...BIN_MIN_RETENTION.kind.type === 'enum' ? BIN_MIN_RETENTION.kind.values : []] as BinMinimumRetention[];

// The installation's (Everyone's) page: each key's value, the groups that
// set it, and, for a key without an order, whether some person's groups
// disagree on it (the installation's value then holds for them).
function adminView(set: RuleSet, revision: number): AdminPoliciesResponse {
  const groupsSetting = (key: StoredPolicyKey) => [...set.groups].filter(([, group]) => group.level.has(key))
    .map(([id, group]) => ({ id, name: group.name, value: group.level.get(key)![0].value }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const conflict = (key: StoredPolicyKey, entry: PolicyEntry) => !ordered(entry) && [...set.membersOf.keys()].some(userId => {
    const policies = levelsIn(set, userId)[1]?.get(key);
    return !!policies && levelPolicy(entry, policies) === null;
  });
  const policies = Object.fromEntries(policyKeys().map(key => {
    const entry = POLICIES[key] as PolicyEntry;
    const { value, source } = resolvePolicyValue(entry, [set.installation.get(key)]);
    const groups = groupsSetting(key);
    // Sent only when they say something, so an installation without groups answers as before 0.30.
    return [key, { value, source, default: entry.default, values: policyValues(entry), effect: POLICY_EFFECTS[key] ?? null,
      ...(groups.length ? { groups } : {}), ...(conflict(key, entry) ? { conflict: true } : {}) }];
  })) as unknown as AdminPoliciesResponse['policies'];
  const minimum = resolvePolicyValue(BIN_MIN_RETENTION as PolicyEntry, [set.installation.get(BIN_MIN_KEY)]);
  const minimumGroups = groupsSetting(BIN_MIN_KEY) as AdminPolicyGroup<BinMinimumRetention>[];
  return {
    policies,
    bin_min_retention: { value: minimum.value as BinMinimumRetention, source: minimum.source, default: 'forever', values: binValues(),
      applies: binFloor([set.installation]) !== null, effect: POLICY_EFFECTS[BIN_MIN_KEY]!, ...(minimumGroups.length ? { groups: minimumGroups } : {}) },
    revision,
  };
}

// A group's page: the group's own value where it sets one (source policy),
// else Everyone's (source default); `default` is Everyone's value, and a key
// with an order offers only the values at least as strict as Everyone's.
function groupView(set: RuleSet, groupId: string, revision: number): AdminPoliciesResponse {
  const group = set.groups.get(groupId)!;
  const view = (key: StoredPolicyKey) => {
    const entry = policyEntry(key);
    const everyone = resolvePolicyValue(entry, [set.installation.get(key)]).value;
    const own = group.level.get(key)?.[0];
    const values = entry.kind.type === 'list' ? [everyone]
      : key === BIN_MIN_KEY ? binValues() : policyValues(entry);
    return { value: own ? own.value : everyone, source: own ? 'policy' : 'default', default: everyone,
      values: ordered(entry) ? values.filter(value => sameValue(stricterPolicy(entry, value, everyone), value)) : values, effect: POLICY_EFFECTS[key] ?? null };
  };
  const minimum = view(BIN_MIN_KEY);
  return {
    policies: Object.fromEntries(policyKeys().map(key => [key, view(key)])) as unknown as AdminPoliciesResponse['policies'],
    bin_min_retention: { ...minimum, value: minimum.value as BinMinimumRetention, default: minimum.default as BinMinimumRetention, values: minimum.values as BinMinimumRetention[],
      source: minimum.source as PolicySource, applies: binFloor(levelsOfGroup(set, groupId)) !== null, effect: minimum.effect! },
    revision,
    target: { kind: 'group', id: groupId, name: group.name },
  };
}

// The levels of a person in the group alone.
const levelsOfGroup = (set: RuleSet, groupId: string): PolicyLevel[] => [set.installation, set.groups.get(groupId)?.level ?? new Map()];

/** GET /api/admin/policies: the installation's (Everyone's) policies. */
async function getAdminPolicies(executor: SqlExecutor = db): Promise<AdminPoliciesResponse> {
  return adminView(await loadRuleSet(executor), await policyRevision(executor));
}

const groupNotFound = () => notFound('GROUP_NOT_FOUND', 'Group not found');

/** GET /api/admin/groups/:id/policies: a group's policies. */
async function getGroupPolicies(groupId: string, executor: SqlExecutor = db): Promise<AdminPoliciesResponse> {
  const set = await loadRuleSet(executor);
  if (!set.groups.has(groupId)) throw groupNotFound();
  return groupView(set, groupId, await policyRevision(executor));
}

const policyConflict = (message: string) => badRequest('POLICY_CONFLICT', message);

// Combinations that cannot hold: refused before anything is stored. `who`
// names the group or the person whose combination it is.
function checkPolicyCombination(levels: readonly PolicyLevel[], who?: string) {
  const conflict = (message: string) => policyConflict(who ? `For ${who}: ${message}` : message);
  const value = <K extends PolicyKey>(key: K) => effectivePolicy(key, levels).value;
  if (value('mail.mode.download') === 'forbidden' && value('mail.mode.sync') === 'forbidden') throw conflict('Allow at least one mail mode. To stop new mail accounts, forbid adding accounts instead.');
  const forced = value('mail.mode.new_accounts');
  if ((forced === 'download' || forced === 'download_delete') && value('mail.mode.download') === 'forbidden') throw conflict('New accounts cannot use Download mode while Download mode is not allowed.');
  if (forced === 'sync' && value('mail.mode.sync') === 'forbidden') throw conflict('New accounts cannot use Sync mode while Sync mode is not allowed.');
  if (forced === 'download_delete' && value('mail.provider_delete') === 'forbidden') throw conflict('New accounts cannot delete at the provider while deleting there is not allowed.');
  // The app lock covers the whole app or modules of the catalog; the lock
  // gate refuses a module's routes by its id, so an area no module has would lock nothing.
  const unknown = value('app_lock.required').filter(area => area !== 'app' && !MODULE_CATALOG.some(module => module.id === area));
  if (unknown.length) throw conflict(`The app lock cannot be required for ${unknown.join(', ')}: there is no such module.`);
}

const sameLevels = (a: readonly PolicyLevel[], b: readonly PolicyLevel[]) => JSON.stringify(a.map(level => [...level])) === JSON.stringify(b.map(level => [...level]));
const sameRules = (a: readonly PolicyLevel[], b: readonly PolicyLevel[]) => JSON.stringify(rulesOf(a)) === JSON.stringify(rulesOf(b));

// A change of rules is three calls (services/groups.ts underRulesLock, and
// withRulesChange below for policy saves): lockRules, the change, then
// checkPeoplePolicies before the commit; after it, applyPolicyChange
// (module-lifecycle.ts). The rules before the change, by its transaction:
const changing = new WeakMap<object, { revision: number; before: RuleSet }>();
// Per person whose policies changed and whose running work has not followed
// yet: the modules policies turned off as that work last followed them. The
// oldest stays, so two changes before one apply give the net change, and a
// change that rolled back leaves what is still true.
const unapplied = new Map<string, ReadonlyMap<string, PolicyOff>>();

/**
 * The rules lock: the revision row, exclusively, until the transaction ends,
 * so a destructive step's final check (final-step.ts) acts before or after
 * a whole policy save or membership change, never on half of it. Reads the
 * rules as they are before the change. Returns the revision.
 */
async function lockRules(executor: SqlExecutor): Promise<number> {
  await executor.execute("INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES (?, '0')", [REVISION_KEY]);
  const revision = await policyRevision(executor, { lock: true });
  changing.set(executor, { revision, before: await loadRuleSet(executor, { lock: true }) });
  return revision;
}

/**
 * Under the rules lock, after the change and before it commits, for every
 * person whose policies it changed (the people it reached):
 * - refuses a combination that cannot hold for the installation, for a
 *   group with it or for a person (400 POLICY_CONFLICT naming the group or
 *   the person; the transaction rolls back);
 * - moves the revision when anyone's rules in plain words changed, so the
 *   notice shows to those people only; `actorId`: the actor saw theirs.
 * Returns the revision, the rules after and the people whose policies changed.
 */
async function checkPeoplePolicies(executor: SqlExecutor, _reached: readonly string[] = [], { actorId }: { actorId?: string } = {}) {
  const held = changing.get(executor);
  if (!held) throw new Error('checkPeoplePolicies runs after lockRules, in the same transaction');
  changing.delete(executor);
  const { revision, before } = held;
  const after = await loadRuleSet(executor, { lock: true });

  const installationChanged = !sameLevels([before.installation], [after.installation]);
  if (installationChanged) checkPolicyCombination([after.installation]);
  for (const [id, group] of after.groups) {
    if (installationChanged || !sameLevels([before.groups.get(id)?.level ?? new Map()], [group.level])) checkPolicyCombination(levelsOfGroup(after, id), `the group ${group.name}`);
  }
  let rulesMoved = !sameRules([before.installation], [after.installation]);
  const users: { userId: string; modulesOff: ReadonlyMap<string, PolicyOff> }[] = [];
  for (const userId of after.users) {
    const was = levelsIn(before, userId);
    const now = levelsIn(after, userId);
    if (sameLevels(was, now)) continue;
    try { checkPolicyCombination(now); } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'POLICY_CONFLICT') throw error;
      const [[person]] = await executor.execute<RowDataPacket[]>('SELECT full_name, email FROM users WHERE id = ?', [userId]);
      throw policyConflict(`For ${String(person.full_name || person.email)}: ${error.message}`);
    }
    if (!sameRules(was, now)) rulesMoved = true;
    users.push({ userId, modulesOff: policyOffOf(was).modules });
  }
  let next = revision;
  if (rulesMoved) {
    next = revision + 1;
    await executor.execute('UPDATE system_settings SET setting_value = ? WHERE setting_key = ?', [String(next), REVISION_KEY]);
    if (actorId) await recordAcknowledged(actorId, next, rulesOf(levelsIn(after, actorId)), executor);
  }
  for (const { userId, modulesOff } of users) if (!unapplied.has(userId)) unapplied.set(userId, modulesOff);
  return { revision: next, rules: after, users: users.map(user => user.userId) };
}

/** For applyPolicyChange: the modules policies turned off as the person's running work last followed them, once; undefined when it follows already. */
function takeUnappliedModules(userId: string): ReadonlyMap<string, PolicyOff> | undefined {
  const modules = unapplied.get(userId);
  unapplied.delete(userId);
  return modules;
}

/**
 * A policy save as one change of rules in a transaction of its own:
 * lockRules, `write` with the rules before it, checkPeoplePolicies, and
 * after the commit applyPolicyChange for the people it reached.
 */
async function withRulesChange<T>(write: (cx: SqlExecutor, before: RuleSet) => Promise<T>, { actorId, actorSawRules = false }: { actorId: string; actorSawRules?: boolean }) {
  const { withTransaction } = require('./transactions') as typeof import('./transactions');
  const done = await withTransaction(async cx => {
    await lockRules(cx);
    const result = await write(cx, changing.get(cx)!.before);
    return { result, ...await checkPeoplePolicies(cx, [], actorSawRules ? { actorId } : {}) };
  });
  try {
    await (require('./module-lifecycle') as typeof import('./module-lifecycle')).applyPolicyChange(done.users);
  } catch (error) {
    // The rules are saved; workers ask canRunModule on every pass anyway.
    log.error('POLICY', 'Applying a change of rules to running work failed', error);
  }
  return done;
}

/** In the transaction that deletes a group (services/groups.ts): its policies go with it. */
async function deleteGroupPolicies(executor: SqlExecutor, groupId: string): Promise<void> {
  await executor.execute("DELETE FROM setting_policies WHERE target_kind = 'group' AND target_id = ?", [groupId]);
}

interface PolicyUpdate { key: StoredPolicyKey; value: Value }

function parsePolicyUpdates(input: unknown, { group = false } = {}): { updates: PolicyUpdate[]; clear: StoredPolicyKey[] } {
  const body = input as { values?: unknown; bin_min_retention?: unknown; clear?: unknown } | null;
  const values = body?.values ?? {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw badRequest('POLICY_INVALID', 'Expected { values: { ... }, current_password }');
  const updates: PolicyUpdate[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (!isPolicyKey(key)) throw badRequest('POLICY_UNKNOWN', `Unknown policy ${key}`);
    const value = accept(POLICIES[key].kind, raw);
    if (value === undefined) throw badRequest('POLICY_INVALID', `Invalid value for ${key}`);
    updates.push({ key, value });
  }
  if (body && Object.prototype.hasOwnProperty.call(body, 'bin_min_retention')) {
    const value = accept(BIN_MIN_RETENTION.kind, body.bin_min_retention);
    if (value === undefined) throw badRequest('POLICY_INVALID', 'Invalid value for bin_min_retention');
    updates.push({ key: BIN_MIN_KEY, value });
  }
  // A group's policy is removed by name: Everyone's value then holds.
  const clear = group && body?.clear !== undefined ? body.clear : [];
  if (!Array.isArray(clear) || clear.some(key => typeof key !== 'string' || (!isPolicyKey(key) && key !== BIN_MIN_KEY))) throw badRequest('POLICY_UNKNOWN', 'Expected clear: [policy keys]');
  if (!updates.length && !clear.length) throw badRequest('POLICY_INVALID', 'Nothing to change');
  return { updates, clear: clear as StoredPolicyKey[] };
}

// A list is recorded as its items joined by commas, an empty one as null.
const plainValue = (value: Value | undefined) => (value === undefined ? null : Array.isArray(value) ? value.join(',') || null : value) as string | number | null;

/**
 * PUT /api/admin/policies and PUT /api/admin/groups/:id/policies, after the
 * route checked the administrator's password: the changed values in one
 * change of rules (withRulesChange) with an activity-log entry for each. For the
 * installation a value equal to the key's default removes its policy; a
 * group's value must be at least as strict as Everyone's, and `clear`
 * removes the group's policy of a key. Changing a policy deletes nothing:
 * services read the rules when they act.
 */
async function savePolicies(adminId: string, groupId: string | null, input: unknown, req: AuthRequest | null): Promise<AdminPoliciesResponse> {
  const { updates, clear } = parsePolicyUpdates(input, { group: !!groupId });
  const { recordAudit } = require('./audit') as typeof import('./audit');
  const { revision, rules } = await withRulesChange(async (cx, before) => {
    // Once the rules are ours: the administrator still as their route proved them (caller-proof.ts).
    await (require('./caller-proof') as typeof import('./caller-proof')).assertCaller(cx);
    if (groupId && !before.groups.has(groupId)) throw groupNotFound();
    const own = groupId ? before.groups.get(groupId)!.level : before.installation;
    const changes: { key: StoredPolicyKey; from: Value | undefined; to: Value | undefined }[] = [];
    for (const { key, value } of updates) {
      const entry = policyEntry(key);
      const to = canonical(entry, value);
      const stored = own.get(key)?.[0]?.value;
      if (!groupId) {
        const from = resolvePolicyValue(entry, [before.installation.get(key)]).value;
        const isDefault = sameValue(to, entry.default);
        if (sameValue(from, to) && (stored !== undefined) !== isDefault) continue;
        changes.push({ key, from, to: isDefault ? undefined : to });
        continue;
      }
      const everyone = resolvePolicyValue(entry, [before.installation.get(key)]).value;
      if (ordered(entry) && !sameValue(stricterPolicy(entry, to, everyone), to)) throw badRequest('POLICY_INVALID', `A group can only make ${key} stricter than it is for everyone.`);
      if (stored === undefined || !sameValue(stored, to)) changes.push({ key, from: stored, to });
    }
    for (const key of clear) if (own.has(key)) changes.push({ key, from: own.get(key)![0].value, to: undefined });
    for (const { key, to } of changes) {
      if (to === undefined) {
        await cx.execute('DELETE FROM setting_policies WHERE target_kind = ? AND target_id = ? AND setting_key = ?', [groupId ? 'group' : 'installation', groupId ?? '', POLICY_PREFIX + key]);
      } else {
        await cx.execute(`INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked, updated_by) VALUES (?, ?, ?, ?, FALSE, ?)
          ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), locked = FALSE, updated_by = VALUES(updated_by)`,
        [groupId ? 'group' : 'installation', groupId ?? '', POLICY_PREFIX + key, encode(policyEntry(key).kind, to), adminId]);
      }
    }
    for (const { key, from, to } of changes) {
      const shown = groupId ? to : to ?? policyEntry(key).default;
      if (from !== undefined && shown !== undefined && sameValue(from, shown)) continue;
      // A group's change names the group; one without a target is Everyone's, as before 0.30.
      await recordAudit({ action: 'admin.policy_changed', actorId: adminId, req, details: { key, from: plainValue(from), to: plainValue(shown), ...(groupId ? { target: groupId } : {}) } }, cx);
    }
  }, { actorId: adminId, actorSawRules: true });
  return groupId ? groupView(rules, groupId, revision) : adminView(rules, revision);
}

/** PUT /api/admin/policies. */
async function updateAdminPolicies(adminId: string, input: unknown, { req = null }: { req?: AuthRequest | null } = {}): Promise<AdminPoliciesResponse> {
  return savePolicies(adminId, null, input, req);
}

/** PUT /api/admin/groups/:id/policies. */
async function updateGroupPolicies(adminId: string, groupId: string, input: unknown, { req = null }: { req?: AuthRequest | null } = {}): Promise<AdminPoliciesResponse> {
  return savePolicies(adminId, groupId, input, req);
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
  POLICIES,
  resolvePolicy,
  resolvePolicies,
  getEffectivePolicies,
  binRetentionFloor,
  acknowledgePolicies,
  acknowledgeAtSignup,
  signupRules,
  lockedPolicies,
  policyRevision,
  lockRules,
  checkPeoplePolicies,
  groupsWithPolicies,
  deleteGroupPolicies,
  getAdminPolicies,
  updateAdminPolicies,
  getGroupPolicies,
  updateGroupPolicies,
  withRulesChange,
  takeUnappliedModules,
  withRequestPolicies,
  policyOff,
  policyOffByUser,
  resolvePolicyValue,
  appLockRequirementFor,
  assertAllowed,
  policyForbids,
  getSettings,
  getScopedSettings,
  settingValues,
  defaultSettingValues,
  updateSettings,
  valuesOf,
  restorableValue,
  referenceKeys,
  getUserPreferences,
  setUserPreferences,
  SIGNUP_MODES,
  isSignupMode,
  getSignupMode,
  setSignupMode,
};
export type { SignupMode, PolicyActor, PolicyOff };
