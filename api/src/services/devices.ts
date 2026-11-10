import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AuthRequest, SqlExecutor } from '../types';
import type {
  AppLockApplied, AppLockArea, AppLockRequiredDetails, CurrentDeviceResponse, DeviceCapabilities, DeviceKeyResponse, DeviceKind,
  DeviceLockStateRequest, DeviceLockStateResponse, DeviceRemovedResponse, DeviceSummary, LockMethod, RelockAfter,
} from '../contracts/devices';

import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, notFound, unauthorized } from '../http/errors';
import { liveSession } from './sessions';
import { withTransaction } from './transactions';
import { recordAudit } from './audit';
import { appLockRequirementFor, getSettings, resolvePolicy, settingValues } from './settings';

// The one owner of devices (F5). A device is one browser profile, installed
// web app or Android app installation of one person; its sessions
// (sessions.device_id) and push channels (push_subscriptions.device_id) hang
// off it, and so does everything that behaves per device: the app lock, the
// lock state it reports, later its chat keys and its ringing. Per-device
// behaviour is keyed by the device id, never by a session token or a push
// endpoint. Routes, workers and the request boundary go through this file;
// the lint fence keeps the table's SQL here (eslint.config.js).
//
// Devices are installation state (data-inventory.ts): never in a personal
// backup, never restored, and an instance restore deletes them with the
// sessions (instance-restore.ts).

const APP_LOCK_AREAS: readonly AppLockArea[] = ['app', 'mail', 'contacts', 'calendar', 'recordings'];
const RELOCK_AFTER: readonly RelockAfter[] = ['0', '60', '300', '900'];
const LOCK_METHODS: readonly LockMethod[] = ['biometric', 'device_credential', 'pin'];

// The Android app's user agent: `UniHubAndroid/<name> (<code>) UniHubBridge/<level>`;
// apps up to 0.24 send no bridge level and count as level 1 (src/lib/platform.ts).
const ANDROID_AGENT = /UniHubAndroid\/([\w.-]{1,32}) \(\d+\)(?: UniHubBridge\/(\d{1,4}))?/;

/** What a session's user agent says about its device: the Android app with its version and bridge level, or a browser. */
function deviceFromUserAgent(userAgent: string | null | undefined): { kind: Extract<DeviceKind, 'web' | 'android'>; app_version: string | null; bridge_level: number | null } {
  const match = ANDROID_AGENT.exec(String(userAgent ?? ''));
  if (!match) return { kind: 'web', app_version: null, bridge_level: null };
  return { kind: 'android', app_version: match[1], bridge_level: match[2] === undefined ? 1 : Number(match[2]) };
}

function jsonOrNull(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** A reported lock as stored, or null when it is absent or not one the server would have taken. */
function parseLockApplied(value: unknown): AppLockApplied | null {
  const parsed = (typeof value === 'string' ? jsonOrNull(value) : value) as Partial<AppLockApplied> | null;
  if (!parsed || typeof parsed !== 'object') return null;
  const { scope, relock_after, on_device_lock, method } = parsed;
  if (!Array.isArray(scope) || !scope.every(area => APP_LOCK_AREAS.includes(area))) return null;
  if (!RELOCK_AFTER.includes(relock_after as RelockAfter) || typeof on_device_lock !== 'boolean' || !LOCK_METHODS.includes(method as LockMethod)) return null;
  return { scope: [...new Set(scope)], relock_after: relock_after as RelockAfter, on_device_lock, method: method as LockMethod };
}

/** A device as the lock decisions read it. */
interface DeviceLockState {
  id: string;
  user_id: string;
  kind: DeviceKind;
  /** What the device reports it enforces; null while it reports no lock. */
  lock_applied: AppLockApplied | null;
  /** Until when the device counts as unlocked; null when it never said so. */
  open_until: Date | null;
}

interface DeviceRow extends RowDataPacket {
  id: string;
  user_id: string;
  kind: string;
  lock_applied: unknown;
  open_until: Date | string | null;
}

const KINDS: readonly DeviceKind[] = ['web', 'pwa', 'android'];
function toLockState(row: DeviceRow): DeviceLockState {
  const openUntil = row.open_until === null ? null : new Date(row.open_until instanceof Date ? row.open_until : `${String(row.open_until).replace(' ', 'T')}Z`);
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    kind: KINDS.includes(row.kind as DeviceKind) ? row.kind as DeviceKind : 'web',
    lock_applied: parseLockApplied(row.lock_applied),
    open_until: openUntil && !Number.isNaN(openUntil.getTime()) ? openUntil : null,
  };
}

const LOCK_COLUMNS = 'd.id, d.user_id, d.kind, d.lock_applied, d.open_until';

/** The device of a session, by the session's id; null for a session without one (from before 0.29, until it binds). */
async function deviceForSession(sessionId: string, executor: SqlExecutor = db): Promise<DeviceLockState | null> {
  const [rows] = await executor.execute<DeviceRow[]>(`SELECT ${LOCK_COLUMNS} FROM sessions s JOIN devices d ON d.id = s.device_id AND d.user_id = s.user_id WHERE s.id = ?`, [sessionId]);
  return rows.length ? toLockState(rows[0]) : null;
}

/** The lock state of each named device, by id; an unknown id is absent from the map. */
async function deviceLockFor(deviceIds: readonly string[], executor: SqlExecutor = db): Promise<Map<string, DeviceLockState>> {
  const ids = [...new Set(deviceIds)];
  if (!ids.length) return new Map();
  const [rows] = await executor.execute<DeviceRow[]>(`SELECT ${LOCK_COLUMNS} FROM devices d WHERE d.id IN (${ids.map(() => '?').join(', ')})`, ids);
  return new Map(rows.map(row => [String(row.id), toLockState(row)]));
}

/** Whether a reported lock covers an area: the whole app covers every module. */
function lockCovers(applied: AppLockApplied | null, area: AppLockArea): boolean {
  return !!applied && (applied.scope.includes('app') || applied.scope.includes(area));
}

/**
 * Whether a device falls short of what the person's policies require: it
 * reports no lock covering every required area, or one that waits longer in
 * the background than the maximum. With no area required it never is: the
 * maximum alone only shortens a lock the person chose (it is the floor of
 * their app_lock_relock_after), it requires none.
 */
function appLockShortfall(applied: AppLockApplied | null, requirement: Pick<AppLockRequiredDetails, 'required' | 'max_background'>): boolean {
  if (!requirement.required.length) return false;
  if (!applied) return true;
  if (!requirement.required.every(area => lockCovers(applied, area))) return true;
  return requirement.max_background !== null && Number(applied.relock_after) > Number(requirement.max_background);
}

// A DATETIME as the API answers it; the pool reads DATETIME as UTC.
function utcIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
  return date.toISOString();
}

// --- Binding a session to its device -------------------------------------

// The device key: 32 random bytes as base64url, kept by the page in its
// browser profile (contracts/devices.ts DeviceBinding). It is no credential:
// the session authenticates, the key only says which device a sign-in comes
// from, so the server keeps its hash and matches it per person only.
const DEVICE_KEY = /^[A-Za-z0-9_-]{43}$/;
function deviceKeyHash(key: unknown): string | null {
  if (typeof key !== 'string' || !DEVICE_KEY.test(key)) return null;
  const bytes = Buffer.from(key, 'base64url');
  return bytes.length === 32 ? crypto.createHash('sha256').update(bytes).digest('hex') : null;
}

/** The device a sign-in names: its key's hash (null without one) and the kind the page claims. */
interface DeviceClaim { keyHash: string | null; kind: DeviceKind }

/**
 * The device fields of a sign-in, sign-up or two-factor sign-in body: none
 * (a page from before 0.29, a script) or { key, kind }. Anything else is
 * refused with 400 DEVICE_INVALID before the credentials are looked at.
 */
function deviceClaim(input: unknown): DeviceClaim {
  if (input === undefined || input === null) return { keyHash: null, kind: 'web' };
  const { key, kind } = (typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const keyHash = deviceKeyHash(key);
  if (!keyHash || !KINDS.includes(kind as DeviceKind)) throw badRequest('DEVICE_INVALID', 'Invalid device');
  return { keyHash, kind: kind as DeviceKind };
}

// `android` comes from the app's user agent only, whatever the page claims;
// `pwa` only from the page (an installed web app sends a browser's agent).
function kindOf(claimed: DeviceKind, userAgent: string | null) {
  const agent = deviceFromUserAgent(userAgent);
  return agent.kind === 'android' ? agent : { ...agent, kind: claimed === 'pwa' ? 'pwa' as const : 'web' as const };
}

/**
 * The device of a new session: the person's device with this key, or a new
 * one (always new without a key). Its kind, app version and user agent become
 * the new session's. Runs on the executor that creates the session, so the
 * two commit together.
 */
async function bindDevice(userId: string, claim: DeviceClaim, userAgent: string | null, executor: SqlExecutor = db): Promise<string> {
  const id = crypto.randomUUID();
  const { kind, app_version, bridge_level } = kindOf(claim.kind, userAgent);
  await executor.execute(`INSERT INTO devices (id, user_id, key_hash, kind, app_version, bridge_level, user_agent, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE kind = VALUES(kind), app_version = VALUES(app_version), bridge_level = VALUES(bridge_level),
      user_agent = VALUES(user_agent), last_seen_at = VALUES(last_seen_at)`,
  [id, userId, claim.keyHash, kind, app_version, bridge_level, userAgent?.slice(0, 512) || null]);
  if (!claim.keyHash) return id;
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT id FROM devices WHERE user_id = ? AND key_hash = ?', [userId, claim.keyHash]);
  return String(rows[0].id);
}

/**
 * The live session of the request and its device. A session without a device
 * (none is left after upgrade step 26; every 0.29 writer binds one) gets a
 * device of its own here, so per-device behaviour never falls back to the
 * session. 401 SESSION_EXPIRED without a live session.
 */
async function currentDevice(userId: string, token: string | null, executor: SqlExecutor = db): Promise<{ sessionId: string; deviceId: string }> {
  const session = await liveSession(userId, token, executor);
  if (!session) throw unauthorized('SESSION_EXPIRED', 'Session expired');
  if (session.device_id) return { sessionId: session.id, deviceId: session.device_id };
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT user_agent FROM sessions WHERE id = ?', [session.id]);
  const made = await bindDevice(userId, { keyHash: null, kind: 'web' }, rows[0]?.user_agent ?? null, executor);
  const [bound] = await executor.execute<ResultSetHeader>('UPDATE sessions SET device_id = ? WHERE id = ? AND device_id IS NULL', [made, session.id]);
  if (bound.affectedRows) return { sessionId: session.id, deviceId: made };
  await executor.execute('DELETE FROM devices WHERE id = ? AND user_id = ?', [made, userId]);
  return currentDevice(userId, token, executor);
}

// Joins the device `from` into `into`, both the person's: sessions and push
// channels move, and `from` with its own settings and lock report goes. Of
// two channels of one transport the one used last stays, as upgrade step 26
// keeps it; the device registers again at its next start.
async function mergeDevice(cx: SqlExecutor, from: string, into: string) {
  await cx.execute(`DELETE p FROM push_subscriptions p
    JOIN push_subscriptions q ON q.transport = p.transport AND q.device_id IN (?, ?) AND q.id <> p.id
      AND (q.updated_at > p.updated_at OR (q.updated_at = p.updated_at AND q.id > p.id))
    WHERE p.device_id IN (?, ?)`, [from, into, from, into]);
  await cx.execute('UPDATE push_subscriptions SET device_id = ?, updated_at = updated_at WHERE device_id = ?', [into, from]);
  await cx.execute('UPDATE sessions SET device_id = ? WHERE device_id = ?', [into, from]);
  // The session moving over is the newest one, so its agent names the device.
  await cx.execute(`UPDATE devices t JOIN devices f ON f.id = ?
    SET t.kind = f.kind, t.app_version = f.app_version, t.bridge_level = f.bridge_level, t.user_agent = f.user_agent,
      t.last_seen_at = GREATEST(t.last_seen_at, f.last_seen_at)
    WHERE t.id = ?`, [from, into]);
  await cx.execute('DELETE FROM devices WHERE id = ?', [from]);
}

/**
 * POST /api/devices/current/key: the page names its device key, at every
 * start. The session's device takes the key when it has none (a session from
 * before 0.29) or another one (the browser lost its storage but kept the
 * session cookie: the session shows it is the same device). When another
 * device of the person already has the key, the session joins that device
 * with its push channels, and its own device goes: each browser is one device
 * again and nobody is signed out.
 */
async function adoptDeviceKey(userId: string, token: string | null, input: unknown): Promise<DeviceKeyResponse> {
  const keyHash = deviceKeyHash((input && typeof input === 'object' ? input as { key?: unknown } : {}).key);
  if (!keyHash) throw badRequest('DEVICE_KEY_INVALID', 'Invalid device key');
  const adopt = (cx: SqlExecutor) => adoptIn(cx, userId, token, keyHash);
  try {
    return await withTransaction(adopt);
  } catch (error) {
    // Two sessions naming one new key at once: one device took it, so the
    // other session joins that one when it runs again.
    if ((error as NodeJS.ErrnoException)?.code !== 'ER_DUP_ENTRY') throw error;
    return withTransaction(adopt);
  }
}

async function adoptIn(cx: SqlExecutor, userId: string, token: string | null, keyHash: string): Promise<DeviceKeyResponse> {
  const { sessionId } = await currentDevice(userId, token, cx);
  // Lock order: the session, its device, then the device with the key. Two
  // tabs of one browser send the key at once; the second sees the first's result.
  const [[session]] = await cx.execute<RowDataPacket[]>('SELECT device_id FROM sessions WHERE id = ? AND user_id = ? FOR UPDATE', [sessionId, userId]);
  if (!session?.device_id) throw unauthorized('SESSION_EXPIRED', 'Session expired');
  const current = String(session.device_id);
  const [[own]] = await cx.execute<RowDataPacket[]>('SELECT key_hash FROM devices WHERE id = ? AND user_id = ? FOR UPDATE', [current, userId]);
  if (own?.key_hash === keyHash) return { device_id: current, merged: false };
  const [[other]] = await cx.execute<RowDataPacket[]>('SELECT id FROM devices WHERE user_id = ? AND key_hash = ? FOR UPDATE', [userId, keyHash]);
  if (!other) {
    await cx.execute('UPDATE devices SET key_hash = ? WHERE id = ? AND user_id = ?', [keyHash, current, userId]);
    return { device_id: current, merged: false };
  }
  await mergeDevice(cx, current, String(other.id));
  return { device_id: String(other.id), merged: true };
}

// --- The person's devices -------------------------------------------------

interface SummaryRow extends RowDataPacket {
  id: string; kind: string; app_version: string | null; user_agent: string | null; lock_applied: unknown;
  created_at: Date | string; last_seen_at: Date | string; notifications: number | string;
}

// Devices with a live session only: a signed-out device keeps its record (and
// its lock settings, for its next sign-in) until the clean-up, but is no
// longer one of the person's devices. A push channel counts while its session lives.
async function summaries(userId: string, currentId: string, onlyId: string | null = null): Promise<DeviceSummary[]> {
  const [rows] = await db.execute<SummaryRow[]>(`SELECT d.id, d.kind, d.app_version, d.user_agent, d.lock_applied, d.created_at, d.last_seen_at,
      EXISTS (SELECT 1 FROM push_subscriptions p JOIN sessions ps ON ps.id = p.session_id
        WHERE p.device_id = d.id AND p.user_id = d.user_id AND ps.expires_at > UTC_TIMESTAMP()) AS notifications
    FROM devices d
    WHERE d.user_id = ?${onlyId ? ' AND d.id = ?' : ''}
      AND EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.user_id = d.user_id AND s.expires_at > UTC_TIMESTAMP())
    ORDER BY d.id = ? DESC, d.last_seen_at DESC, d.id`, onlyId ? [userId, onlyId, currentId] : [userId, currentId]);
  return rows.map(row => {
    const lock = parseLockApplied(row.lock_applied);
    return {
      id: String(row.id),
      current: String(row.id) === currentId,
      kind: KINDS.includes(row.kind as DeviceKind) ? row.kind as DeviceKind : 'web',
      app_version: row.app_version,
      user_agent: row.user_agent,
      created_at: utcIso(row.created_at),
      last_seen_at: utcIso(row.last_seen_at),
      lock: lock && lock.scope.length ? { scope: lock.scope, method: lock.method } : null,
      notifications: Number(row.notifications) > 0,
    };
  });
}

/** GET /api/devices: the person's signed-in devices, the current one first, then by last use. */
async function listDevices(userId: string, token: string | null): Promise<DeviceSummary[]> {
  const { deviceId } = await currentDevice(userId, token);
  return summaries(userId, deviceId);
}

/** GET /api/devices/current: this device, its app lock settings, and whether it meets the lock the person's policies require. */
async function describeCurrentDevice(userId: string, token: string | null): Promise<CurrentDeviceResponse> {
  const { deviceId } = await currentDevice(userId, token);
  const [[device], settings, requirement, screenshots, locks] = await Promise.all([
    summaries(userId, deviceId, deviceId),
    getSettings('device', userId, deviceId),
    appLockRequirementFor(userId),
    resolvePolicy(userId, 'app_lock.screenshots'),
    deviceLockFor([deviceId]),
  ]);
  if (!device) throw unauthorized('SESSION_EXPIRED', 'Session expired');
  return {
    device,
    settings,
    compliance: { meets: !appLockShortfall(locks.get(deviceId)?.lock_applied ?? null, requirement), ...requirement },
    policy: { screenshots: screenshots.value },
  };
}

const CAPABILITY_FLAGS = ['secure_window', 'recents_hidden', 'device_lock_signal'] as const;
function parseCapabilities(value: unknown): DeviceCapabilities | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!(input.lock === 'none' || LOCK_METHODS.includes(input.lock as LockMethod))) return null;
  if (!CAPABILITY_FLAGS.every(flag => typeof input[flag] === 'boolean')) return null;
  return { lock: input.lock as DeviceCapabilities['lock'], secure_window: !!input.secure_window, recents_hidden: !!input.recents_hidden, device_lock_signal: !!input.device_lock_signal };
}

/**
 * PUT /api/devices/current/lock: what this device enforces now and what it
 * can do, stored as reported (a modified app can lie; the server cannot see
 * the screen). `applied: null`, or an empty scope, is no lock. The whole app
 * stands alone. 400 DEVICE_LOCK_INVALID for any other shape.
 */
async function reportDeviceLock(userId: string, token: string | null, input: unknown): Promise<CurrentDeviceResponse> {
  const body = (input && typeof input === 'object' ? input : {}) as { applied?: unknown; capabilities?: unknown };
  const parsed = body.applied === null ? null : body.applied && typeof body.applied === 'object' ? parseLockApplied(body.applied) : undefined;
  const capabilities = parseCapabilities(body.capabilities);
  if (parsed === undefined || (body.applied !== null && !parsed) || !capabilities) throw badRequest('DEVICE_LOCK_INVALID', 'Invalid app lock report');
  const applied = parsed && parsed.scope.length ? { ...parsed, scope: parsed.scope.includes('app') ? ['app' as const] : parsed.scope } : null;
  const { deviceId } = await currentDevice(userId, token);
  await db.execute('UPDATE devices SET lock_applied = ?, capabilities = ?, lock_reported_at = UTC_TIMESTAMP() WHERE id = ? AND user_id = ?',
    [applied ? JSON.stringify(applied) : null, JSON.stringify(capabilities), deviceId, userId]);
  return describeCurrentDevice(userId, token);
}

const LOCK_STATES: readonly DeviceLockStateRequest['state'][] = ['open', 'background', 'locked'];
// An open device reports every 60 seconds; a page or app that stops (killed,
// offline) stops counting as unlocked this long after its last report.
const OPEN_GRACE_SECONDS = 90;

/**
 * POST /api/devices/current/lock-state: open (unlocked and in use),
 * background (hidden) or locked. Sets until when the device counts as
 * unlocked, with the time in the background its lock waits, never longer than
 * its settings allow under the person's policies.
 */
async function reportLockState(userId: string, token: string | null, input: unknown): Promise<DeviceLockStateResponse> {
  const state = (input && typeof input === 'object' ? input as { state?: unknown } : {}).state;
  if (!LOCK_STATES.includes(state as DeviceLockStateRequest['state'])) throw badRequest('DEVICE_LOCK_STATE_INVALID', 'Invalid lock state');
  const { deviceId } = await currentDevice(userId, token);
  const [settings, locks] = await Promise.all([settingValues('device', userId, deviceId), deviceLockFor([deviceId])]);
  const reported = locks.get(deviceId)?.lock_applied?.relock_after;
  const relock = Math.min(Number(settings.app_lock_relock_after), reported === undefined ? Infinity : Number(reported));
  const seconds = state === 'open' ? relock + OPEN_GRACE_SECONDS : state === 'background' ? relock : 0;
  await db.execute('UPDATE devices SET open_until = UTC_TIMESTAMP() + INTERVAL ? SECOND WHERE id = ? AND user_id = ?', [seconds, deviceId, userId]);
  const [[row]] = await db.execute<RowDataPacket[]>('SELECT open_until FROM devices WHERE id = ? AND user_id = ?', [deviceId, userId]);
  return { open_until: utcIso(row.open_until) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /api/devices/:id: signs one of the person's other devices out for
 * good. The record goes with its sessions, their push channels and pending
 * deliveries, and the device's settings; its live streams close. Its key no
 * longer matches anything, so a later sign-in there makes a new device.
 * 404 DEVICE_NOT_FOUND for an unknown id or anyone else's device, 400
 * DEVICE_CURRENT for the device of the request (Sign out ends that one).
 */
async function removeDevice(userId: string, token: string | null, id: unknown, req: AuthRequest | null = null): Promise<DeviceRemovedResponse> {
  if (typeof id !== 'string' || !UUID.test(id)) throw notFound('DEVICE_NOT_FOUND', 'Device not found');
  const deviceId = id.toLowerCase();
  const keys = await withTransaction(async cx => {
    // Under the session's lock, so a key adoption cannot move this session onto the device being removed.
    const { sessionId } = await currentDevice(userId, token, cx);
    const [[session]] = await cx.execute<RowDataPacket[]>('SELECT device_id FROM sessions WHERE id = ? AND user_id = ? FOR UPDATE', [sessionId, userId]);
    if (!session) throw unauthorized('SESSION_EXPIRED', 'Session expired');
    if (String(session.device_id) === deviceId) throw badRequest('DEVICE_CURRENT', 'Use Sign out to sign this device out');
    const [[device]] = await cx.execute<RowDataPacket[]>('SELECT id, kind FROM devices WHERE id = ? AND user_id = ? FOR UPDATE', [deviceId, userId]);
    if (!device) return null;
    const [sessions] = await cx.execute<RowDataPacket[]>('SELECT token FROM sessions WHERE device_id = ? AND user_id = ? FOR UPDATE', [deviceId, userId]);
    await cx.execute('DELETE FROM devices WHERE id = ? AND user_id = ?', [deviceId, userId]);
    await recordAudit({ action: 'device.removed', actorId: userId, targetUserId: userId, req, details: { device: deviceId, kind: String(device.kind), sessions: sessions.length } }, cx);
    return sessions.map(row => String(row.token));
  });
  if (!keys) throw notFound('DEVICE_NOT_FOUND', 'Device not found');
  // Loaded here: realtime loads the Android streams, which load this file's callers.
  const { realtime } = require('./realtime') as typeof import('./realtime');
  for (const key of keys) realtime.closeSessionKey(key, { reason: 'signed_out' });
  return { removed: true };
}

// --- Last use and clean-up ------------------------------------------------

// The request boundary records a device's last use at most every 5 minutes
// (auth.ts verifyToken): once per device and process by the memory below,
// and the statement itself writes nothing within the 5 minutes.
const SEEN_EVERY_MS = 5 * 60 * 1000;
const MAX_REMEMBERED = 10000;
const seenAt = new Map<string, number>();

async function touchDevice(deviceId: string, now = Date.now()) {
  const last = seenAt.get(deviceId);
  if (last !== undefined && now - last < SEEN_EVERY_MS) return;
  if (seenAt.size >= MAX_REMEMBERED) seenAt.clear();
  seenAt.set(deviceId, now);
  await db.execute('UPDATE devices SET last_seen_at = UTC_TIMESTAMP() WHERE id = ? AND last_seen_at < UTC_TIMESTAMP() - INTERVAL 5 MINUTE', [deviceId]);
}

// A device without any session (signed out, expired, its person's password
// changed) keeps its settings for a sign-in with its key; after 30 days
// unused it goes. Installation state, not the person's data.
const IDLE_DEVICE_DAYS = 30;

/** Deletes devices with no session left that were last used more than 30 days ago; returns how many. */
async function pruneIdleDevices(executor: SqlExecutor = db): Promise<number> {
  const [result] = await executor.execute<ResultSetHeader>(`DELETE FROM devices
    WHERE last_seen_at < UTC_TIMESTAMP() - INTERVAL ${IDLE_DEVICE_DAYS} DAY AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = devices.id)`);
  return result.affectedRows;
}

export {
  deviceFromUserAgent, parseLockApplied, deviceForSession, deviceLockFor, lockCovers, appLockShortfall,
  deviceKeyHash, deviceClaim, bindDevice, currentDevice, adoptDeviceKey, listDevices, describeCurrentDevice,
  reportDeviceLock, reportLockState, removeDevice, touchDevice, pruneIdleDevices,
};
export type { DeviceLockState, DeviceClaim };
