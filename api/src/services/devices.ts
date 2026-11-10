import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { AppLockApplied, AppLockArea, AppLockRequiredDetails, DeviceKind, LockMethod, RelockAfter } from '../contracts/devices';

import { db } from '../state';
import { safeJsonParse } from './calendar';

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

/** A reported lock as stored, or null when it is absent or not one the server would have taken. */
function parseLockApplied(value: unknown): AppLockApplied | null {
  const parsed = (typeof value === 'string' ? safeJsonParse(value, null) : value) as Partial<AppLockApplied> | null;
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

export { deviceFromUserAgent, parseLockApplied, deviceForSession, deviceLockFor, lockCovers, appLockShortfall };
export type { DeviceLockState };
