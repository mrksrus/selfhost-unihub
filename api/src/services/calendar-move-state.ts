import { AsyncLocalStorage } from 'node:async_hooks';
import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { TaskMovePending } from '../contracts/tasks';
import { db } from '../state';
import { conflict, forbidden } from '../http/errors';
import { isModuleEnabled } from './module-settings';
import { getActiveRestoreSections } from './restore-locks';
import { withNamedLock, stillHeld } from './named-locks';
import type { Lease } from './named-locks';
import { withTransaction } from './transactions';

const CHUNK = 500;
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value ?? '');

/**
 * Adds move_pending to each event of the person (contracts/tasks.ts): the
 * move of it to another calendar that a calendar server has not finished
 * (calendar-move.ts), or null.
 */
async function attachMoveState<T extends { id: string }>(userId: string, events: readonly T[], executor: SqlExecutor = db): Promise<(T & { move_pending: TaskMovePending | null })[]> {
  const pending = new Map<string, TaskMovePending>();
  const ids = events.map(event => event.id);
  for (let index = 0; index < ids.length; index += CHUNK) {
    const chunk = ids.slice(index, index + CHUNK);
    const [rows] = await executor.execute<RowDataPacket[]>(
      `SELECT event_id, state, target_calendar_id, created_at, attempts FROM calendar_event_moves
       WHERE user_id = ? AND state IN ('creating', 'removing') AND event_id IN (${chunk.map(() => '?').join(', ')})`,
      [userId, ...chunk]
    );
    for (const row of rows) {
      pending.set(String(row.event_id), { state: row.state, target_calendar_id: row.target_calendar_id ?? null, since: iso(row.created_at), attempts: Number(row.attempts) });
    }
  }
  return events.map(event => ({ ...event, move_pending: pending.get(event.id) ?? null }));
}

const movePending = () => conflict('CALENDAR_MOVE_PENDING',
  'This item is still being moved to another calendar. UniHub finishes the move when the calendar server answers; try again then, or cancel the move.');

/**
 * Inside a transaction that holds the event's row lock: refuses a change of
 * the fields a move's new copy carries while that copy is being created
 * (calendar-move.ts admits a move under the same lock).
 */
async function refuseWhileMoving(connection: SqlExecutor, eventId: string) {
  const [rows] = await connection.execute<RowDataPacket[]>(
    "SELECT id FROM calendar_event_moves WHERE event_id = ? AND state = 'creating' AND target_calendar_id IS NOT NULL", [eventId]);
  if (rows.length) throw movePending();
}

const eventChanged = () => conflict('CALENDAR_EVENT_CHANGED',
  'This item moved to another calendar or changed in the meantime. It has been refreshed; please try again.');

/** What an edit's writeback decision rests on: the item's calendar and its server copy. */
interface WritebackIdentity { calendarId: string | null; objectId: string | null }

async function writebackIdentity(executor: SqlExecutor, userId: string, eventId: string): Promise<WritebackIdentity> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT e.calendar_id, (SELECT r.remote_object_id FROM calendar_event_external_refs r WHERE r.event_id = e.id AND r.user_id = e.user_id LIMIT 1) AS object_id
     FROM calendar_events e WHERE e.id = ? AND e.user_id = ?`, [eventId, userId]);
  return { calendarId: rows[0]?.calendar_id ?? null, objectId: rows[0]?.object_id ?? null };
}

/**
 * Inside a transaction that holds the event's row lock: refuses a local
 * write whose writeback decision (provider or UniHub only) was made for
 * another calendar or server copy, as when a move finished meanwhile.
 */
async function refuseIfMoved(connection: SqlExecutor, userId: string, eventId: string, expected: WritebackIdentity) {
  const now = await writebackIdentity(connection, userId, eventId);
  if (now.calendarId !== expected.calendarId || now.objectId !== expected.objectId) throw eventChanged();
}

const eventBusy = () => conflict('CALENDAR_EVENT_CHANGED',
  'Another change to this item is still being saved. It has been refreshed; please try again.');

// Longer than one calendar server request (DAV_TIMEOUT_MS, 20 s), so a
// change waits out the one before it; more than two waiting are refused.
const EVENT_LOCK_WAIT_SECONDS = 25;
const WAITERS_PER_ITEM = 2;
const heldEventLocks = new AsyncLocalStorage<{ key: string; held: boolean; lease: Lease }[]>();

// A change that waited may find the Calendar module turned off or a calendar
// restore begun meanwhile: the request boundary's checks, made again.
async function assertStillAdmitted(userId: string) {
  if (!await isModuleEnabled(userId, 'calendar')) throw forbidden('MODULE_DISABLED', 'This module is disabled. Enable it in Settings.');
  if ((await getActiveRestoreSections(userId)).has('calendar')) {
    throw conflict('RESTORE_IN_PROGRESS', 'Restore in progress for calendar. This section is temporarily read-only.');
  }
}

/**
 * One change of an item's server copy, link or calendar at a time, across
 * processes (named-locks.ts): creating it on a server, an edit, a time move,
 * a deletion, a move, its cancel, its background run and its adoption by a
 * sync each hold it from reading the item to the local write, so none acts
 * on what another one is changing. Taken before an account's sync lock and
 * row locks; a sync holding its lock only tries it, never waits. Nested
 * calls in the same request (an edit starting a move) share it.
 */
async function underEventLock<T>(userId: string, eventId: string, fn: () => Promise<T>, { waitSeconds, request }: { waitSeconds: number; request: boolean }): Promise<{ value: T } | null> {
  const key = `${userId}:${eventId}`;
  const outer = heldEventLocks.getStore() ?? [];
  // Background work never shares it: a sync a request set off runs beside it.
  if (request && outer.some(lock => lock.key === key && lock.held)) return { value: await fn() };
  return withNamedLock('calendar-event', key, lease => {
    const lock = { key, held: true, lease };
    return heldEventLocks.run([...outer, lock], async () => {
      // Work left running past the end (none should be) takes the lock again itself.
      try {
        if (request) await assertStillAdmitted(userId);
        return await fn();
      } finally { lock.held = false; }
    });
  }, { waitSeconds, maxWaiters: WAITERS_PER_ITEM });
}

/**
 * Before a write to a server, and inside the transaction of a local write,
 * of work holding items' locks: refuses (409 CALENDAR_EVENT_CHANGED) when
 * one of them was lost meanwhile, as its connection's session ended, so the
 * work writes nothing more after another change may have taken the lock.
 * Nothing to check outside such work (a sync, a test calling a service).
 */
async function fenceTaskLocks(executor: SqlExecutor = db) {
  for (const lock of heldEventLocks.getStore() ?? []) {
    if (lock.held && !await stillHeld(executor, lock.lease)) throw eventChanged();
  }
}

/** A local write of work holding items' locks, in a transaction fenced by them. */
async function fencedWrite<T>(write: (connection: SqlExecutor) => Promise<T>): Promise<T> {
  return withTransaction(async connection => {
    await fenceTaskLocks(connection);
    return write(connection);
  });
}

/** For a request: waits up to 25 s for the change going on, then answers 409 CALENDAR_EVENT_CHANGED. */
async function withEventLock<T>(userId: string, eventId: string, fn: () => Promise<T>): Promise<T> {
  const done = await underEventLock(userId, eventId, fn, { waitSeconds: EVENT_LOCK_WAIT_SECONDS, request: true });
  if (!done) throw eventBusy();
  return done.value;
}

/** For background work, which checks its own gates: null at once while a request holds the item. */
async function tryEventLock<T>(userId: string, eventId: string, fn: () => Promise<T>): Promise<{ value: T } | null> {
  return underEventLock(userId, eventId, fn, { waitSeconds: 0, request: false });
}

export { attachMoveState, refuseWhileMoving, refuseIfMoved, writebackIdentity, movePending, eventChanged, withEventLock, tryEventLock, fenceTaskLocks, fencedWrite };
export type { WritebackIdentity };
