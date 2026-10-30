import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, conflict, notFound } from '../http/errors';
import { withTransaction } from './transactions';
import { publishCalendarChanged } from './realtime';

// The one owner of the hand order of tasks (0.27, D31, D32).
//
// Every task has an effective rank: its hand rank when the person placed it,
// otherwise a date rank (its start time, or its creation time for a task
// without a date, plus a fixed offset from its id so tasks of the same second
// rarely tie). ToDo keeps its date sections and orders each by rank; a task
// never placed by hand stays at its date's place. Only placing writes, and
// usually only the placed task: ranks are sparse.
//
// Hand ranks are UniHub's own overlay (F2 `local`), kept in task_order and
// never written to a calendar server (D32). A row is keyed by the item's
// identity, not by the derived event row: a local task by its event id, a
// synced one by (calendar, UID, recurrence id), so the order survives a
// re-sync or a restore that rebuilds the rows.

// One second of start time spans RANK_SCALE ranks: room for about 15
// halvings between tasks a second apart, and every DATETIME (years 1000 to
// 9999) stays a safe integer.
const RANK_SCALE = 32768;
const ID_OFFSET_SPAN = 16384;
// The least spacing a spread leaves between neighbours.
const SPREAD_GAP = 1024;
const ID_PATTERN = /^[0-9a-f-]{36}$/i;
const CHUNK = 500;

interface RankedRow { id: string; start_time: unknown; created_at: unknown; is_todo_only: unknown }

interface TaskIdentity {
  eventId: string;
  key: string;
  // Set for a synced item only: the calendar its server copy is in.
  calendarId: string | null;
  uid: string | null;
  recurrenceId: string;
}

const hash = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function identityFor(eventId: string, remote: { calendarId: string; uid: string; recurrenceId: string } | null): TaskIdentity {
  if (!remote) return { eventId, key: hash(`event\n${eventId}`), calendarId: null, uid: null, recurrenceId: '' };
  return { eventId, key: hash(`remote\n${remote.calendarId}\n${remote.uid}\n${remote.recurrenceId}`), ...remote };
}

/** The key of a task_order row from its stored identity columns (restore rebuilds it). */
function itemKey(row: { event_id?: unknown; calendar_id?: unknown; remote_uid?: unknown; recurrence_id?: unknown }) {
  if (row.remote_uid) return identityFor('', { calendarId: String(row.calendar_id), uid: String(row.remote_uid), recurrenceId: String(row.recurrence_id ?? '') }).key;
  return identityFor(String(row.event_id), null).key;
}

function millis(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (value == null || value === '') return null;
  const text = String(value).trim().replace(' ', 'T');
  const ms = new Date(/[zZ]$|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function dateRank(row: RankedRow) {
  const ms = millis(Number(row.is_todo_only) ? row.created_at : row.start_time) ?? millis(row.created_at) ?? 0;
  const offset = parseInt(hash(`rank\n${row.id}`).slice(0, 8), 16) % ID_OFFSET_SPAN;
  return Math.floor(ms / 1000) * RANK_SCALE + offset;
}

/**
 * The order identity of each event: synced when its row is linked to a
 * server copy with a UID, else local by its id. A link without a server copy
 * (after a restore, before the first sync) counts as local until the sync
 * links it again.
 */
async function identities(userId: string, eventIds: readonly string[], executor: SqlExecutor = db): Promise<Map<string, TaskIdentity>> {
  const result = new Map<string, TaskIdentity>();
  for (let index = 0; index < eventIds.length; index += CHUNK) {
    const chunk = eventIds.slice(index, index + CHUNK);
    const [rows] = await executor.execute<RowDataPacket[]>(
      `SELECT e.id, o.calendar_id AS object_calendar_id, o.uid, r.recurrence_id
       FROM calendar_events e
       LEFT JOIN calendar_event_external_refs r ON r.event_id = e.id AND r.user_id = e.user_id
       LEFT JOIN calendar_remote_objects o ON o.id = r.remote_object_id AND o.user_id = e.user_id
       WHERE e.user_id = ? AND e.id IN (${chunk.map(() => '?').join(', ')})`,
      [userId, ...chunk]
    );
    for (const row of rows) {
      const remote = row.uid && row.object_calendar_id ? { calendarId: String(row.object_calendar_id), uid: String(row.uid), recurrenceId: String(row.recurrence_id ?? '') } : null;
      result.set(String(row.id), identityFor(String(row.id), remote));
    }
  }
  return result;
}

/** The identity of one owned event, or null. Read it before a change that relinks the event (a move) and pass it to rekey(). */
async function identityOf(executor: SqlExecutor, userId: string, eventId: string) {
  return (await identities(userId, [eventId], executor)).get(eventId) ?? null;
}

async function handRanks(userId: string, executor: SqlExecutor) {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT item_key, sort_rank FROM task_order WHERE user_id = ?', [userId]);
  return new Map(rows.map(row => [String(row.item_key), Number(row.sort_rank)]));
}

/** Adds sort_rank and hand_ordered to each event of the user (contracts/tasks.ts TaskRankFields). */
async function attachRanks<T extends RankedRow>(userId: string, events: readonly T[], executor: SqlExecutor = db): Promise<(T & { sort_rank: number; hand_ordered: boolean })[]> {
  const ranks = events.length ? await handRanks(userId, executor) : new Map<string, number>();
  const ids = ranks.size ? await identities(userId, events.map(event => event.id), executor) : new Map<string, TaskIdentity>();
  return events.map(event => {
    const key = ids.get(event.id)?.key;
    const hand = key === undefined ? undefined : ranks.get(key);
    return { ...event, sort_rank: hand ?? dateRank(event), hand_ordered: hand !== undefined };
  });
}

async function writeRank(executor: SqlExecutor, userId: string, identity: TaskIdentity, rank: number) {
  await executor.execute(
    `INSERT INTO task_order (user_id, item_key, calendar_id, event_id, remote_uid, recurrence_id, sort_rank)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE calendar_id = VALUES(calendar_id), event_id = VALUES(event_id), remote_uid = VALUES(remote_uid),
       recurrence_id = VALUES(recurrence_id), sort_rank = VALUES(sort_rank)`,
    [userId, identity.key, identity.calendarId, identity.uid ? null : identity.eventId, identity.uid, identity.recurrenceId, rank]
  );
}

const stale = () => conflict('ORDER_STALE', 'The list changed in the meantime. It has been reloaded; try again.');

function parsePosition(taskId: string, input: unknown) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const neighbour = (value: unknown) => value === null || value === undefined ? null : typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined;
  const before = neighbour(body?.before);
  const after = neighbour(body?.after);
  if (!body || before === undefined || after === undefined || (!before && !after) || before === after || before === taskId || after === taskId) {
    throw badRequest('ORDER_INVALID', 'Expected { before, after }: the ids of the tasks next to the new place');
  }
  return { before, after };
}

// `count` ranks in order strictly between the bounds (null: open-ended), evenly spaced.
function spreadRanks(count: number, low: number | null, high: number | null) {
  if (low !== null && high !== null) {
    const step = Math.floor((high - low) / (count + 1));
    return Array.from({ length: count }, (_, index) => low + step * (index + 1));
  }
  if (high !== null) return Array.from({ length: count }, (_, index) => high - RANK_SCALE * (count - index));
  return Array.from({ length: count }, (_, index) => (low ?? 0) + RANK_SCALE * (index + 1));
}

/**
 * Places an open task between two open tasks the person sees next to each
 * other (`after` above it, `before` below it; either may be null at a
 * section's end). Other tasks may lie between the two in the full order
 * (other lists, other sections): the new rank only needs to be between
 * theirs. When there is no room, the tightest run around the place is spread
 * out, as few tasks as possible. Answers the changed ranks by task id.
 */
async function place(userId: string, taskId: string, input: unknown): Promise<{ ranks: Record<string, number> }> {
  if (!ID_PATTERN.test(taskId)) throw notFound('TASK_NOT_FOUND', 'Task not found');
  const { before, after } = parsePosition(taskId, input);
  const ranks = await withTransaction(async connection => {
    // One placement at a time per person: ranks are read and written together.
    await connection.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
    const [own] = await connection.execute<RowDataPacket[]>('SELECT id FROM calendar_events WHERE id = ? AND user_id = ?', [taskId, userId]);
    if (!own.length) throw notFound('TASK_NOT_FOUND', 'Task not found');
    // The open tasks: what ToDo lists (lists with ToDo on) and not done.
    const [rows] = await connection.execute<(RowDataPacket & RankedRow)[]>(
      `SELECT e.id, e.start_time, e.created_at, e.is_todo_only
       FROM calendar_events e LEFT JOIN calendar_calendars c ON c.id = e.calendar_id
       WHERE e.user_id = ? AND (e.todo_status IS NULL OR e.todo_status NOT IN ('done', 'cancelled'))
         AND (c.auto_todo_enabled = TRUE OR c.auto_todo_enabled IS NULL)`,
      [userId]
    );
    const tasks = await attachRanks(userId, rows, connection);
    const byId = new Map(tasks.map(task => [String(task.id), task]));
    // A neighbour that is gone, done or not this person's reads the same:
    // the list the person saw is out of date.
    if (!byId.has(taskId) || (after && !byId.has(after)) || (before && !byId.has(before))) throw stale();
    const order = tasks.filter(task => task.id !== taskId)
      .sort((a, b) => a.sort_rank - b.sort_rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const position = (id: string) => order.findIndex(task => task.id === id);
    const afterIndex = after ? position(after) : -1;
    const beforeIndex = before ? position(before) : -1;
    if (after && before && afterIndex >= beforeIndex) throw stale();

    let window: { start: number; end: number; insertAt: number };
    let assigned: number[];
    if (after && before && order[beforeIndex].sort_rank - order[afterIndex].sort_rank >= 2) {
      window = { start: afterIndex + 1, end: afterIndex + 1, insertAt: afterIndex + 1 };
      assigned = [order[afterIndex].sort_rank + Math.floor((order[beforeIndex].sort_rank - order[afterIndex].sort_rank) / 2)];
    } else if (!before) {
      window = { start: afterIndex + 1, end: afterIndex + 1, insertAt: afterIndex + 1 };
      assigned = [order[afterIndex].sort_rank + RANK_SCALE];
    } else if (!after) {
      window = { start: beforeIndex, end: beforeIndex, insertAt: beforeIndex };
      assigned = [order[beforeIndex].sort_rank - RANK_SCALE];
    } else {
      // No room: widen the run from the two neighbours until its bounds leave
      // SPREAD_GAP per task, then spread it (the moved task right after `after`).
      let start = afterIndex, end = beforeIndex + 1;
      const bounds = () => [start > 0 ? order[start - 1].sort_rank : null, end < order.length ? order[end].sort_rank : null] as const;
      for (;;) {
        const [low, high] = bounds();
        if (low === null || high === null || high - low >= (end - start + 2) * SPREAD_GAP) break;
        if (start > 0) start -= 1;
        if (end < order.length) end += 1;
      }
      window = { start, end, insertAt: afterIndex + 1 };
      const [low, high] = bounds();
      assigned = spreadRanks(end - start + 1, low, high);
    }
    if (assigned.some(rank => !Number.isSafeInteger(rank))) throw stale();

    const placed = [...order.slice(window.start, window.insertAt), byId.get(taskId)!, ...order.slice(window.insertAt, window.end)];
    const changed = placed.map((task, index) => ({ task, rank: assigned[index] })).filter(({ task, rank }) => task.id === taskId || task.sort_rank !== rank);
    const ids = await identities(userId, changed.map(({ task }) => String(task.id)), connection);
    for (const { task, rank } of changed) await writeRank(connection, userId, ids.get(String(task.id))!, rank);
    return Object.fromEntries(changed.map(({ task, rank }) => [String(task.id), rank]));
  });
  publishCalendarChanged(userId, null, 'local');
  return { ranks };
}

/**
 * Forgets a task's hand rank, so it goes back to its date's place: after a
 * date or time changed in UniHub. Pass the identity read before the change
 * when the change may relink or replace the row.
 */
async function clearRank(executor: SqlExecutor, userId: string, eventId: string, before?: TaskIdentity | null) {
  const keys = new Set([identityFor(eventId, null).key]);
  if (before) keys.add(before.key);
  const current = await identityOf(executor, userId, eventId);
  if (current) keys.add(current.key);
  await executor.execute(`DELETE FROM task_order WHERE user_id = ? AND item_key IN (${[...keys].map(() => '?').join(', ')})`, [userId, ...keys]);
}

/**
 * Carries a task's hand rank over a change of its identity (a move between
 * a UniHub list and a server calendar, or between server calendars). Call
 * inside the move's local commit, after the new link is stored, with the
 * identity read before the change.
 */
async function rekey(executor: SqlExecutor, userId: string, eventId: string, before: TaskIdentity) {
  const after = await identityOf(executor, userId, eventId);
  if (!after || after.key === before.key) return;
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT sort_rank FROM task_order WHERE user_id = ? AND item_key = ? FOR UPDATE', [userId, before.key]);
  if (!rows.length) return;
  await executor.execute('DELETE FROM task_order WHERE user_id = ? AND item_key = ?', [userId, before.key]);
  await writeRank(executor, userId, after, Number(rows[0].sort_rank));
}

/**
 * Removes the hand ranks of synced items of a calendar that are gone. With
 * `uids`, only those UIDs (objects a sync verified as deleted) and only when
 * no server copy with that UID remains. Without, after a full expansion that
 * read every object: every ranked item whose UID and recurrence id no longer
 * has a row. Never call it after an incomplete listing.
 */
async function sweepRemoteRanks(executor: SqlExecutor, userId: string, calendarId: string, uids?: readonly string[]) {
  if (uids) {
    const present = [...new Set(uids.filter(Boolean))];
    for (let index = 0; index < present.length; index += CHUNK) {
      const chunk = present.slice(index, index + CHUNK);
      await executor.execute(
        `DELETE t FROM task_order t
         WHERE t.user_id = ? AND t.calendar_id = ? AND t.remote_uid IN (${chunk.map(() => '?').join(', ')})
           AND NOT EXISTS (SELECT 1 FROM calendar_remote_objects o WHERE o.calendar_id = t.calendar_id AND o.uid = t.remote_uid)`,
        [userId, calendarId, ...chunk]
      );
    }
    return;
  }
  await executor.execute(
    `DELETE t FROM task_order t
     WHERE t.user_id = ? AND t.calendar_id = ? AND t.remote_uid IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM calendar_event_external_refs r
         JOIN calendar_remote_objects o ON o.id = r.remote_object_id
         WHERE o.calendar_id = t.calendar_id AND o.uid = t.remote_uid AND COALESCE(r.recurrence_id, '') = t.recurrence_id)`,
    [userId, calendarId]
  );
}

export { place, attachRanks, identities, identityOf, clearRank, rekey, sweepRemoteRanks, itemKey, dateRank, RANK_SCALE };
export type { TaskIdentity };
