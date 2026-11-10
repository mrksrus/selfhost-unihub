// When this person last used UniHub in this browser, and what the lock
// covers: the `timeline` record of unihub-lock-v1 (db.ts). Every tab of the
// person writes it; the service worker reads it to hide notification text of
// a locked module (workers/sw-custom.ts keeps a copy of `isOpen` and
// `covers`, since it cannot import page code; keep them equal).
//
// - an unlocked, visible tab notes `lastActiveAt` every HEARTBEAT_MS
// - an unlocked tab going to the background notes `hiddenAt`
// - a tab that locks notes `lockedAt`
//
// A new tab or a reload opens without asking while the person was active
// within the relock time; with "Every time UniHub opens" ('0') it always asks.
import type { AppLockArea, LockMethod } from '../../../api/src/contracts/devices';
import { readRecord, updateRecord } from '@/lib/app-lock/db';

export const HEARTBEAT_MS = 15_000;
/** A visible tab's last note may be this old: two missed heartbeats (a busy or frozen tab, or a crash) and it counts as gone. */
export const VISIBLE_GRACE_MS = 2 * HEARTBEAT_MS;

export interface TimelineRecord {
  v: 1;
  userId: string;
  scope: AppLockArea[];
  relockAfterMs: number;
  onDeviceLock: boolean;
  /** The method that applied the lock here; null while none did. "The lock was on here" for a lost PIN. */
  method: LockMethod | null;
  /** The administrator forbids screenshots (the Android app's FLAG_SECURE), as last heard; kept for an offline start. */
  blockScreenshots?: boolean;
  lastActiveAt: number | null;
  hiddenAt: number | null;
  lockedAt: number | null;
}

/** Whether a lock with this scope covers `area`. A notification kind without a module is covered by the whole-app lock only. */
export function covers(scope: readonly AppLockArea[], area: AppLockArea | null) {
  return scope.includes('app') || (area !== null && area !== 'app' && scope.includes(area));
}

/** The lock's scope as stored: `app` stands alone, no repeats. */
export function normalScope(scope: readonly AppLockArea[]): AppLockArea[] {
  return scope.includes('app') ? ['app'] : [...new Set(scope)];
}

/**
 * Whether this person counts as using UniHub here now: some tab was unlocked
 * and visible within the grace, or went to the background less than the
 * relock time ago, and no tab locked since.
 */
export function isOpen(record: TimelineRecord | undefined, now: number) {
  if (!record?.scope.length) return true;
  if (record.lastActiveAt === null) return false;
  if (record.lockedAt !== null && record.lockedAt >= record.lastActiveAt) return false;
  if (record.hiddenAt !== null && record.hiddenAt >= record.lastActiveAt) return now - record.hiddenAt < record.relockAfterMs;
  return now - record.lastActiveAt < record.relockAfterMs + VISIBLE_GRACE_MS;
}

/** Whether a tab that was in the background for `hiddenForMs` locks on its return. */
export function dueOnReturn(hiddenForMs: number | null, relockAfterMs: number) {
  return hiddenForMs !== null && hiddenForMs >= relockAfterMs;
}

export function readTimeline(userId: string) {
  return readRecord<TimelineRecord>('timeline', userId);
}

const empty = (userId: string): TimelineRecord => ({
  v: 1, userId, scope: [], relockAfterMs: 60_000, onDeviceLock: false, method: null, lastActiveAt: null, hiddenAt: null, lockedAt: null,
});

// The times change an existing record only: a tab still running after a
// sign-out in another tab must not bring back the record that removed.
function note(userId: string, change: (record: TimelineRecord) => TimelineRecord) {
  return updateRecord<TimelineRecord>('timeline', userId, record => record?.v === 1 ? change(record) : undefined);
}

/** What the lock covers now and how it applies, after the server's settings or a change here. */
export function writeTimelineConfig(userId: string, config: Pick<TimelineRecord, 'scope' | 'relockAfterMs' | 'onDeviceLock' | 'method' | 'blockScreenshots'>) {
  return updateRecord<TimelineRecord>('timeline', userId, record => ({ ...(record?.v === 1 ? record : empty(userId)), ...config, scope: normalScope(config.scope) }));
}

/** An unlocked tab is visible now. */
export function noteActive(userId: string, now: number) {
  return note(userId, record => ({ ...record, lastActiveAt: now, hiddenAt: null }));
}

/** An unlocked tab went to the background. */
export function noteHidden(userId: string, now: number) {
  return note(userId, record => ({ ...record, lastActiveAt: now, hiddenAt: now }));
}

/** A tab locked. */
export function noteLocked(userId: string, now: number) {
  return note(userId, record => ({ ...record, lockedAt: now }));
}
