import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { TaskMovePending } from '../contracts/tasks';
import { db } from '../state';
import { conflict } from '../http/errors';

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

export { attachMoveState, refuseWhileMoving, refuseIfMoved, writebackIdentity, movePending, eventChanged };
export type { WritebackIdentity };
