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
  BinMinimumRetention,
  EffectivePoliciesResponse,
  EffectivePolicy,
  PolicyForbidsDetails,
  PolicyKey,
  PolicySource,
  PolicyValues,
} from '../contracts/policies';

import { db } from '../state';
import { ApiError, badRequest, forbidden, notFound } from '../http/errors';
import { SETTINGS, POLICIES, BIN_MIN_RETENTION, POLICY_EFFECTS } from './settings-registry';
import type { Entry, Kind, PolicyEntry, ReferenceTarget, Value } from './settings-registry';

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

// reason: the plain words of a floor that comes from a data-safety policy.
interface Policy { value: Value; locked: boolean; reason?: string }
type Policies = Map<string, Policy>;

async function loadPolicies(executor: SqlExecutor): Promise<Policies> {
  const [rows] = await executor.execute<RowDataPacket[]>("SELECT setting_key, setting_value, locked FROM setting_policies WHERE target_kind = 'installation' AND target_id = '' AND setting_key NOT LIKE 'policy.%'");
  const policies: Policies = new Map();
  for (const row of rows) {
    const [scope, key] = String(row.setting_key).split('.', 2) as [SettingScope, string];
    const entry = STORAGE[scope] ? entryOf(scope, key) : undefined;
    // A reference names one person's record, so it cannot be an
    // installation's policy; such a row is ignored.
    const value = entry && entry.kind.type !== 'reference' ? decode(entry.kind, String(row.setting_value)) : undefined;
    if (value !== undefined) policies.set(row.setting_key, { value, locked: !!Number(row.locked) });
  }
  return withBinFloor(policies, await loadPolicyLevels(executor));
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

/** The values that apply where no record of the scope holds its own: the defaults under the installation's policies. */
async function defaultSettingValues<S extends SettingScope>(scope: S, executor: SqlExecutor = db): Promise<Values<S>> {
  return valuesOf(resolveAll(scope, new Map(), await loadPolicies(executor)));
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
  const policies = await loadPolicies(executor);
  const updates: [string, string][] = [];
  for (const [key, raw] of Object.entries(values)) {
    const entry = entryOf(scope, key);
    if (!entry) throw badRequest('SETTING_UNKNOWN', `Unknown setting ${key}`);
    const value = accept(entry.kind, raw);
    if (value === undefined) throw badRequest('SETTING_INVALID', `Invalid value for ${key}`);
    const policy = policies.get(policyKey(scope, key));
    if (policy?.locked) throw forbidden('POLICY_LOCKED', `Your administrator has set ${key}`);
    if (policy && entry.strictness && stricter(entry, value, policy.value) !== value) throw forbidden('POLICY_FLOOR', policy.reason ?? `Your administrator does not allow less than ${String(policy.value)} for ${key}`);
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
// assertAllowed and the same code. Groups arrive in 0.30 as one more level
// after the installation's.
const POLICY_PREFIX = 'policy.';
const BIN_MIN_KEY = 'bin.min_retention';
type StoredPolicyKey = PolicyKey | typeof BIN_MIN_KEY;
const isPolicyKey = (key: string): key is PolicyKey => Object.prototype.hasOwnProperty.call(POLICIES, key);
const policyEntry = (key: StoredPolicyKey): PolicyEntry => (key === BIN_MIN_KEY ? BIN_MIN_RETENTION : POLICIES[key]) as PolicyEntry;
type PolicyLevel = Map<StoredPolicyKey, Policy[]>;

// The levels from the broadest to the narrowest. A stored value that is no
// longer valid for its key reads as absent.
async function loadPolicyLevels(executor: SqlExecutor, { lock = false } = {}): Promise<PolicyLevel[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT setting_key, setting_value, locked FROM setting_policies
    WHERE target_kind = 'installation' AND target_id = '' AND setting_key LIKE 'policy.%'${lock ? ' LOCK IN SHARE MODE' : ''}`);
  const installation: PolicyLevel = new Map();
  for (const row of rows) {
    const key = String(row.setting_key).slice(POLICY_PREFIX.length);
    if (!isPolicyKey(key) && key !== BIN_MIN_KEY) continue;
    const value = decode(policyEntry(key).kind, String(row.setting_value));
    if (value !== undefined) installation.set(key, [{ value, locked: !!Number(row.locked) }]);
  }
  return [installation];
}

// The stricter of two values of a key with an order; a value outside the
// order counts as the least strict.
const stricterPolicy = (order: readonly string[], a: Value, b: Value) => order.indexOf(String(a)) >= order.indexOf(String(b)) ? a : b;

// The one value of a level with several targets (a person's groups): the
// strictest along the key's order, else the first that refuses the action.
function levelPolicy(entry: PolicyEntry, policies: readonly Policy[]): Policy {
  if (entry.strictness) {
    const value = policies.map(policy => policy.value).reduce((a, b) => stricterPolicy(entry.strictness!, a, b));
    return { value, locked: policies.some(policy => policy.locked && policy.value === value) };
  }
  return policies.find(policy => entry.refuses.includes(policy.value)) ?? policies[0];
}

/** A key's value and source from its policies, level by level from the broadest (installation) to the narrowest. */
function resolvePolicyValue(entry: PolicyEntry, levels: readonly (readonly Policy[] | undefined)[]): { value: Value; source: PolicySource } {
  let value = entry.default;
  let source: PolicySource = 'default';
  for (const policies of levels) {
    if (!policies?.length) continue;
    const policy = levelPolicy(entry, policies);
    value = source === 'policy' && entry.strictness ? stricterPolicy(entry.strictness, value, policy.value) : policy.value;
    source = 'policy';
    if (policy.locked) break;
  }
  return { value, source };
}

function effectivePolicy<K extends PolicyKey>(key: K, levels: readonly PolicyLevel[]): EffectivePolicy<K> {
  const entry = POLICIES[key] as unknown as PolicyEntry<PolicyValues[K]>;
  const { value, source } = resolvePolicyValue(entry as PolicyEntry, levels.map(level => level.get(key)));
  const own = entry.refuses.includes(value as PolicyValues[K]);
  // A key implied by another refuses with its own reason when that one refuses.
  const implied = !own && entry.impliedBy ? effectivePolicy(entry.impliedBy, levels) : null;
  if (implied && !implied.allowed) return { value: value as PolicyValues[K], source: implied.source, allowed: false, reason: entry.reasons.forbidden ?? implied.reason };
  return { value: value as PolicyValues[K], source, allowed: !own, reason: entry.reasons[String(value)] ?? null };
}

/**
 * The bin's minimum retention in force (D34): while bin.delete is forbidden,
 * the administrator's minimum (by default forever); otherwise none.
 */
function binFloor(levels: readonly PolicyLevel[]): BinMinimumRetention | null {
  if (effectivePolicy('bin.delete', levels).allowed) return null;
  return resolvePolicyValue(BIN_MIN_RETENTION as PolicyEntry, levels.map(level => level.get(BIN_MIN_KEY))).value as BinMinimumRetention;
}

/** The bin's minimum retention in force for the person (D34); null while bin.delete is allowed. */
async function binRetentionFloor(_userId: string, executor: SqlExecutor = db, { lock = false }: PolicyRead = {}): Promise<BinMinimumRetention | null> {
  return binFloor(await policyLevels(executor, lock));
}

// The bin's minimum becomes a floor of the person's bin_retention, together
// with any policy of that setting itself (the stricter holds), so the
// settings answer, a refused choice, new bin items and the purge all see it.
function withBinFloor(policies: Policies, levels: readonly PolicyLevel[]): Policies {
  const floor = binFloor(levels);
  if (floor === null) return policies;
  const key = policyKey('user', 'bin_retention');
  const own = policies.get(key);
  const value = own ? stricter(SETTINGS.user.bin_retention as Entry, own.value, floor) : floor;
  policies.set(key, { value, locked: own?.locked ?? false, ...(value === floor ? { reason: BIN_MIN_RETENTION.reasons[floor] } : {}) });
  return policies;
}

/** Every policy key as it applies to the person, from one read of the stored policies. */
async function resolvePolicies(userId: string, executor: SqlExecutor = db): Promise<{ [K in PolicyKey]: EffectivePolicy<K> }> {
  const levels = await loadPolicyLevels(executor);
  return Object.fromEntries((Object.keys(POLICIES) as PolicyKey[]).map(key => [key, effectivePolicy(key, levels)])) as { [K in PolicyKey]: EffectivePolicy<K> };
}

/** One policy key as it applies to the person, for workers and services. */
async function resolvePolicy<K extends PolicyKey>(userId: string, key: K, executor: SqlExecutor = db, { lock = false }: PolicyRead = {}): Promise<EffectivePolicy<K>> {
  return effectivePolicy(key, await policyLevels(executor, lock));
}

/**
 * Runs `work` once if the policy allows the person the action, holding the
 * rules revision shared on a connection of its own until the work ends: an
 * administrator's save that forbids it waits for work in flight, and none
 * starts after that save committed (F13). For a provider command, which
 * never runs inside a transaction that could be retried: the work must not
 * use the database. Returns whether the work ran.
 */
async function whilePolicyAllows(userId: string, key: PolicyKey, work: () => Promise<unknown>): Promise<boolean> {
  const cx = await db.getConnection();
  try {
    await cx.beginTransaction();
    const allowed = effectivePolicy(key, await policyLevels(cx, true)).allowed;
    if (allowed) await work();
    await cx.commit();
    return allowed;
  } catch (error) {
    await cx.rollback().catch(() => undefined);
    throw error;
  } finally { cx.release(); }
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
async function assertAllowed(userId: string, keys: PolicyKey | readonly PolicyKey[], { adminId }: PolicyActor = {}, executor: SqlExecutor = db, { lock = false }: PolicyRead = {}): Promise<void> {
  if (adminId) return;
  const list = typeof keys === 'string' ? [keys] : keys;
  if (!list.length) return;
  const levels = await policyLevels(executor, lock);
  for (const key of list) {
    const resolved = effectivePolicy(key, levels);
    if (!resolved.allowed) throw policyForbids(key, resolved.reason ?? 'Your administrator does not allow this.');
  }
}

// --- The rules people are told about (D38) -----------------------------------

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
    if ((policy.allowed && policy.value === POLICIES[key].default) || !policy.reason) continue;
    rules.push(policy.reason);
  }
  const floor = binFloor(levels);
  if (floor) rules.push(BIN_MIN_RETENTION.reasons[floor]);
  return [...new Set(rules)];
}


const REVISION_KEY = 'policy_revision';

// An administrator's save locks the revision row first and holds it until
// it commits (updateAdminPolicies). A destructive step that holds the row
// shared and then reads the policies with a locking read, which sees the
// latest committed rows whatever the transaction read before, acts on the
// rules in force: a save commits either before that read or after the step.
async function policyLevels(executor: SqlExecutor, lock: boolean): Promise<PolicyLevel[]> {
  if (!lock) return loadPolicyLevels(executor);
  await executor.execute('SELECT setting_value FROM system_settings WHERE setting_key = ? LOCK IN SHARE MODE', [REVISION_KEY]);
  return loadPolicyLevels(executor, { lock: true });
}

/** The installation's rules revision (system_settings policy_revision); 0 before any rule changed. */
async function policyRevision(executor: SqlExecutor = db, { lock = false } = {}): Promise<number> {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT setting_value FROM system_settings WHERE setting_key = ?${lock ? ' FOR UPDATE' : ''}`, [REVISION_KEY]);
  const revision = Number(rows[0]?.setting_value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

async function acknowledgedRevision(userId: string, executor: SqlExecutor = db): Promise<number> {
  const [[row]] = await executor.execute<RowDataPacket[]>('SELECT COALESCE(MAX(revision), 0) AS revision FROM policy_notices WHERE user_id = ?', [userId]);
  return Number(row.revision) || 0;
}

// Records that the person saw the rules of a revision; nothing for revision 0.
async function recordAcknowledged(userId: string, revision: number, executor: SqlExecutor) {
  if (revision > 0) await executor.execute('INSERT IGNORE INTO policy_notices (user_id, revision) VALUES (?, ?)', [userId, revision]);
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

/** GET /api/policies/effective: every key for the person, the rules and where their notice stands. */
async function getEffectivePolicies(userId: string): Promise<EffectivePoliciesResponse> {
  return inSnapshot(async cx => {
    const levels = await loadPolicyLevels(cx);
    const policies = Object.fromEntries((Object.keys(POLICIES) as PolicyKey[]).map(key => [key, effectivePolicy(key, levels)])) as EffectivePoliciesResponse['policies'];
    const revision = await policyRevision(cx);
    const acknowledged = await acknowledgedRevision(userId, cx);
    return { policies, revision, acknowledged_revision: Math.min(acknowledged, revision), rules: rulesOf(levels) };
  });
}

/** The rules in force for the sign-up form (GET /api/auth/signup-mode), with their revision. */
async function signupRules(): Promise<{ data_rules: string[]; rules_revision: number }> {
  return inSnapshot(async cx => ({ data_rules: rulesOf(await loadPolicyLevels(cx)), rules_revision: await policyRevision(cx) }));
}

/** POST /api/policies/acknowledge: the person confirmed the rules of `revision`. */
async function acknowledgePolicies(userId: string, input: unknown): Promise<AcknowledgePoliciesResponse> {
  const revision = (input as { revision?: unknown } | null)?.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw badRequest('POLICY_REVISION_INVALID', 'Expected { revision: <number> }');
  if ((revision as number) > await policyRevision()) throw badRequest('POLICY_REVISION_INVALID', 'That revision of the rules does not exist yet');
  await recordAcknowledged(userId, revision as number, db);
  return { acknowledged_revision: await acknowledgedRevision(userId) };
}

/**
 * A new person saw the rules of `shown` (the revision GET signup-mode sent
 * with them) on the sign-up form; their account starts with that revision
 * confirmed. Without one, or with one that does not exist yet, nothing is:
 * the notice then shows the rules after the first sign-in.
 */
async function acknowledgeAtSignup(userId: string, shown: unknown, executor: SqlExecutor = db) {
  if (!Number.isSafeInteger(shown) || (shown as number) <= 0 || (shown as number) > await policyRevision(executor)) return;
  await recordAcknowledged(userId, shown as number, executor);
}

// --- The administrator's policies page ----------------------------------------

function policyValues(entry: PolicyEntry): Value[] {
  const { kind } = entry;
  if (kind.type === 'enum') return [...kind.values];
  if (kind.type === 'integer') return [...(kind.nullable ? [null] : []), ...(kind.values ?? [])];
  return [entry.default];
}

function adminView(levels: readonly PolicyLevel[], revision: number): AdminPoliciesResponse {
  const policies = Object.fromEntries((Object.keys(POLICIES) as PolicyKey[]).map(key => {
    const entry = POLICIES[key] as PolicyEntry;
    const { value, source } = resolvePolicyValue(entry, levels.map(level => level.get(key)));
    return [key, { value, source, default: entry.default, values: policyValues(entry), effect: POLICY_EFFECTS[key] ?? null }];
  })) as unknown as AdminPoliciesResponse['policies'];
  const minimum = resolvePolicyValue(BIN_MIN_RETENTION as PolicyEntry, levels.map(level => level.get(BIN_MIN_KEY)));
  return {
    policies,
    bin_min_retention: { value: minimum.value as BinMinimumRetention, source: minimum.source, default: 'forever', values: [...BIN_MIN_RETENTION.kind.type === 'enum' ? BIN_MIN_RETENTION.kind.values : []] as BinMinimumRetention[],
      applies: binFloor(levels) !== null, effect: POLICY_EFFECTS[BIN_MIN_KEY]! },
    revision,
  };
}

/** GET /api/admin/policies. */
async function getAdminPolicies(executor: SqlExecutor = db): Promise<AdminPoliciesResponse> {
  return adminView(await loadPolicyLevels(executor), await policyRevision(executor));
}

const policyConflict = (message: string) => badRequest('POLICY_CONFLICT', message);

// Combinations that cannot hold: refused before anything is stored.
function checkPolicyCombination(levels: readonly PolicyLevel[]) {
  const value = <K extends PolicyKey>(key: K) => effectivePolicy(key, levels).value;
  if (value('mail.mode.download') === 'forbidden' && value('mail.mode.sync') === 'forbidden') throw policyConflict('Allow at least one mail mode. To stop new mail accounts, forbid adding accounts instead.');
  const forced = value('mail.mode.new_accounts');
  if ((forced === 'download' || forced === 'download_delete') && value('mail.mode.download') === 'forbidden') throw policyConflict('New accounts cannot use Download mode while Download mode is not allowed.');
  if (forced === 'sync' && value('mail.mode.sync') === 'forbidden') throw policyConflict('New accounts cannot use Sync mode while Sync mode is not allowed.');
  if (forced === 'download_delete' && value('mail.provider_delete') === 'forbidden') throw policyConflict('New accounts cannot delete at the provider while deleting there is not allowed.');
}

interface PolicyUpdate { key: StoredPolicyKey; value: Value }

function parsePolicyUpdates(input: unknown): PolicyUpdate[] {
  const body = input as { values?: unknown; bin_min_retention?: unknown } | null;
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
  if (!updates.length) throw badRequest('POLICY_INVALID', 'Nothing to change');
  return updates;
}

/**
 * PUT /api/admin/policies, after the route checked the administrator's
 * password: the changed values in one transaction with an activity-log
 * entry for each; the revision goes up when the rules people see change,
 * and the administrator who saved them has seen them. A value equal to the
 * key's default removes its policy. Changing a policy deletes nothing:
 * services read the rules when they act.
 */
async function updateAdminPolicies(adminId: string, input: unknown, { req = null }: { req?: AuthRequest | null } = {}): Promise<AdminPoliciesResponse> {
  const updates = parsePolicyUpdates(input);
  const { recordAudit } = require('./audit') as typeof import('./audit');
  const { withTransaction } = require('./transactions') as typeof import('./transactions');
  return withTransaction(async cx => {
    // The revision row is the lock between administrators saving at once.
    await cx.execute("INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES (?, '0')", [REVISION_KEY]);
    const revision = await policyRevision(cx, { lock: true });
    const before = await loadPolicyLevels(cx);
    const after: PolicyLevel[] = before.map(level => new Map(level));
    const changed: { key: StoredPolicyKey; from: Value; to: Value }[] = [];
    for (const { key, value } of updates) {
      const entry = policyEntry(key);
      const from = resolvePolicyValue(entry, before.map(level => level.get(key))).value;
      const stored = before[0].get(key);
      if (value === entry.default) after[0].delete(key); else after[0].set(key, [{ value, locked: false }]);
      if (from !== value || (stored !== undefined) !== (value !== entry.default)) changed.push({ key, from, to: value });
    }
    checkPolicyCombination(after);
    for (const { key, to } of changed) {
      const entry = policyEntry(key);
      if (to === entry.default) {
        await cx.execute("DELETE FROM setting_policies WHERE target_kind = 'installation' AND target_id = '' AND setting_key = ?", [POLICY_PREFIX + key]);
      } else {
        await cx.execute(`INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked, updated_by) VALUES ('installation', '', ?, ?, FALSE, ?)
          ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), locked = FALSE, updated_by = VALUES(updated_by)`, [POLICY_PREFIX + key, encode(entry.kind, to), adminId]);
      }
    }
    for (const { key, from, to } of changed) {
      if (from === to) continue;
      await recordAudit({ action: 'admin.policy_changed', actorId: adminId, req, details: { key, from: from as string | number | null, to: to as string | number | null } }, cx);
    }
    const stored = await loadPolicyLevels(cx);
    let next = revision;
    if (JSON.stringify(rulesOf(stored)) !== JSON.stringify(rulesOf(before))) {
      next = revision + 1;
      await cx.execute('UPDATE system_settings SET setting_value = ? WHERE setting_key = ?', [String(next), REVISION_KEY]);
      await recordAcknowledged(adminId, next, cx);
    }
    return adminView(stored, next);
  });
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
  whilePolicyAllows,
  policyRevision,
  getAdminPolicies,
  updateAdminPolicies,
  resolvePolicyValue,
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
export type { SignupMode, PolicyActor };
