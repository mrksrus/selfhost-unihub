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

export { attachMoveState, refuseWhileMoving, movePending };
