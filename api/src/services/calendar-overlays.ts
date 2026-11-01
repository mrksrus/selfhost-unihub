import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import crypto from 'node:crypto';
import { db } from '../state';

// UniHub's own additions to a synced event or task (F2 `local` overlay): its
// ToDo state, done time, source email and subtasks. The calendar server holds
// the item itself (a mirror), so an archive or the bin keeps only these, keyed
// by the item's provider identity: its calendar, its iCal UID and its
// recurrence id. The hand order has its own table (task-order.ts), keyed the
// same way.
//
// calendar_overlay_restores holds an overlay until its item exists in UniHub:
// a restore writes it (backup-import.ts), or the bin before it creates a
// synced item at its server again (bin.ts). The sync that creates the item's
// row takes it in the same transaction (calendar-sync.ts applyObjectRows);
// one whose row already exists is applied at once (applyOverlaysToLiveRows).
// An overlay goes with its calendar (foreign key). 'uid' overlays wait while
// the calendar exists (an occurrence outside the sync window comes back
// later); 'shape' overlays, from archives without UIDs, match by title and
// start and expire.

/**
 * UIDs compare byte for byte: two UIDs that differ only in case, accents or
 * trailing spaces name different items. The uid columns inherit the table's
 * utf8mb4_unicode_ci, so every UID comparison names this collation.
 */
const EXACT = 'COLLATE utf8mb4_nopad_bin';

const TODO_STATUSES = new Set(['done', 'changed', 'time_moved', 'cancelled']);
const TITLE_MAX = 255;
const DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ID_PATTERN = /^[0-9a-f-]{36}$/i;

interface OverlaySubtask { title: string; is_done: boolean; position: number }
/** The payload of a calendar_overlay_restores row, and of each occurrence of a synced item in the bin. */
interface OverlayState {
  todo_status: string | null;
  /** UTC, 'YYYY-MM-DD HH:MM:SS'. */
  done_at: string | null;
  source_email_id: string | null;
  source_email_json: unknown;
  subtasks: OverlaySubtask[];
}
/** Where an overlay applies. recurrenceId is calendar_event_external_refs.recurrence_id, '' for none. */
interface OverlayTarget { userId: string; calendarId: string; uid: string; recurrenceId: string }
interface PendingOverlay extends OverlayTarget {
  state: OverlayState;
  /** The account the calendar belonged to, as the archive names it, for the restore's own matching. */
  accountIdentity?: string;
  matchKind?: 'uid' | 'shape';
  shape?: { title: string; start: string };
  expiresAt?: string | null;
}
/** new: a row the sync just made; fill: only what the row lacks; replace: as the overlay has it. */
type ApplyMode = 'new' | 'fill' | 'replace';

const sqlTime = (value: unknown) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 19).replace('T', ' ');
  if (typeof value !== 'string') return null;
  const text = value.includes('T') ? new Date(value).toISOString().slice(0, 19).replace('T', ' ') : value;
  return DATETIME.test(text) ? text : null;
};
function json(value: unknown) {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * An overlay payload as stored or archived; null when it holds nothing UniHub
 * keeps. Every subtask is kept, as many as the task has: the app sets no
 * limit, and an archive's size limit bounds what a restore reads.
 */
function parseOverlayState(value: unknown): OverlayState | null {
  const input = json(value) as Record<string, unknown> | null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const status = typeof input.todo_status === 'string' && TODO_STATUSES.has(input.todo_status) ? input.todo_status : null;
  let doneAt: string | null = null;
  try { doneAt = sqlTime(input.done_at); } catch { doneAt = null; }
  const emailId = typeof input.source_email_id === 'string' && ID_PATTERN.test(input.source_email_id) ? input.source_email_id : null;
  const email = json(input.source_email_json);
  const subtasks = (Array.isArray(input.subtasks) ? input.subtasks : []).flatMap((item, index) => {
    if (!item || typeof item !== 'object' || typeof (item as OverlaySubtask).title !== 'string') return [];
    const title = Array.from((item as OverlaySubtask).title).slice(0, TITLE_MAX).join('');
    if (!title.trim()) return [];
    const position = Number.isSafeInteger((item as OverlaySubtask).position) ? (item as OverlaySubtask).position : index;
    return [{ title, is_done: !!(item as OverlaySubtask).is_done, position }];
  });
  const state = { todo_status: status, done_at: status ? doneAt : null, source_email_id: emailId, source_email_json: email && typeof email === 'object' ? email : null, subtasks };
  return state.todo_status || state.source_email_id || state.source_email_json || state.subtasks.length ? state : null;
}

/** What UniHub keeps of its own on one event row, or null when it keeps nothing. */
async function overlayStateOf(executor: SqlExecutor, userId: string, eventId: string): Promise<OverlayState | null> {
  const [[event]] = await executor.execute<RowDataPacket[]>('SELECT todo_status, done_at, source_email_id, source_email_json FROM calendar_events WHERE id = ? AND user_id = ?', [eventId, userId]);
  if (!event) return null;
  const [subtasks] = await executor.execute<RowDataPacket[]>(
    'SELECT title, is_done, position FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ? ORDER BY position, created_at, id', [eventId, userId]);
  return parseOverlayState({
    todo_status: event.todo_status, done_at: event.done_at, source_email_id: event.source_email_id, source_email_json: event.source_email_json,
    subtasks: subtasks.map(row => ({ title: row.title, is_done: !!Number(row.is_done), position: Number(row.position) })),
  });
}

/**
 * Writes an overlay onto an owned event row. A source email that is not the
 * person's own is dropped (its snapshot stays): an archive's ids are not
 * trusted.
 */
async function applyOverlayState(connection: SqlExecutor, userId: string, eventId: string, state: OverlayState, mode: ApplyMode) {
  const [[row]] = await connection.execute<RowDataPacket[]>(
    'SELECT todo_status, source_email_id, source_email_json FROM calendar_events WHERE id = ? AND user_id = ? FOR UPDATE', [eventId, userId]);
  if (!row) return false;
  let emailId = state.source_email_id;
  if (emailId) {
    const [owned] = await connection.execute<RowDataPacket[]>('SELECT id FROM emails WHERE id = ? AND user_id = ? LIMIT 1', [emailId, userId]);
    if (!owned.length) emailId = null;
  }
  const replace = mode !== 'fill';
  const sets: string[] = []; const values: (string | null)[] = [];
  if (state.todo_status && (replace || !row.todo_status)) { sets.push('todo_status = ?', 'done_at = ?'); values.push(state.todo_status, state.done_at); }
  if ((emailId || state.source_email_json) && (replace || (!row.source_email_id && !row.source_email_json))) {
    sets.push('source_email_id = ?', 'source_email_json = ?');
    values.push(emailId, state.source_email_json ? JSON.stringify(state.source_email_json) : null);
  }
  if (sets.length) await connection.execute(`UPDATE calendar_events SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, [...values, eventId, userId]);
  if (state.subtasks.length) {
    const [[{ count }]] = await connection.execute<RowDataPacket[]>('SELECT COUNT(*) AS count FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ?', [eventId, userId]);
    if (mode === 'replace' || !Number(count)) {
      if (Number(count)) await connection.execute('DELETE FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ?', [eventId, userId]);
      for (let index = 0; index < state.subtasks.length; index += 100) {
        const chunk = state.subtasks.slice(index, index + 100);
        await connection.execute(`INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
          chunk.flatMap(subtask => [crypto.randomUUID(), eventId, userId, subtask.title, subtask.is_done ? 1 : 0, subtask.position]));
      }
    }
  }
  return true;
}

/**
 * Stores overlays that wait for their item. The calendar must be the
 * person's own; one already waiting for the same item is replaced, so a
 * second restore of the same archive leaves one.
 */
async function insertOverlays(connection: SqlExecutor, overlays: readonly PendingOverlay[]) {
  let stored = 0;
  for (const overlay of overlays) {
    const kind = overlay.matchKind ?? 'uid';
    if (kind === 'uid' && !overlay.uid) continue;
    if (kind === 'shape' && (!overlay.shape?.title || !sqlTime(overlay.shape.start))) continue;
    const [owned] = await connection.execute<RowDataPacket[]>('SELECT id FROM calendar_calendars WHERE id = ? AND user_id = ? FOR UPDATE', [overlay.calendarId, overlay.userId]);
    if (!owned.length) continue;
    const recurrenceId = String(overlay.recurrenceId || '').slice(0, 64);
    if (kind === 'uid') {
      await connection.execute(`DELETE FROM calendar_overlay_restores WHERE user_id = ? AND calendar_id = ? AND match_kind = 'uid' AND uid = ? ${EXACT} AND recurrence_id = ? ${EXACT}`,
        [overlay.userId, overlay.calendarId, overlay.uid, recurrenceId]);
    } else {
      await connection.execute(`DELETE FROM calendar_overlay_restores WHERE user_id = ? AND calendar_id = ? AND match_kind = 'shape' AND shape_title = ? ${EXACT} AND shape_start = ?`,
        [overlay.userId, overlay.calendarId, overlay.shape!.title, sqlTime(overlay.shape!.start)]);
    }
    await connection.execute(`INSERT INTO calendar_overlay_restores
      (id, user_id, calendar_id, account_identity, uid, recurrence_id, match_kind, shape_title, shape_start, payload, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      crypto.randomUUID(), overlay.userId, overlay.calendarId, String(overlay.accountIdentity || '').slice(0, 500), kind === 'uid' ? overlay.uid.slice(0, 500) : null,
      recurrenceId, kind, kind === 'shape' ? Array.from(overlay.shape!.title).slice(0, TITLE_MAX).join('') : null, kind === 'shape' ? sqlTime(overlay.shape!.start) : null,
      JSON.stringify(overlay.state), overlay.expiresAt ? sqlTime(overlay.expiresAt) : null,
    ]);
    stored += 1;
  }
  return stored;
}

/**
 * In the sync's transaction, for a row it has just created: the overlay
 * waiting for this item by its exact identity, applied to the row and
 * removed. Shape overlays (archives without UIDs) wait for the end of the
 * calendar's sync (applyOverlaysToLiveRows), when every row that could match
 * them exists and a match can be told to be the only one.
 */
async function takeOverlayForNewRow(connection: SqlExecutor, target: OverlayTarget & { eventId: string }) {
  if (!target.uid) return false;
  const [[found]] = await connection.execute<RowDataPacket[]>(
    `SELECT id, payload FROM calendar_overlay_restores WHERE user_id = ? AND calendar_id = ? AND match_kind = 'uid' AND uid = ? ${EXACT} AND recurrence_id = ? ${EXACT}
     ORDER BY created_at, id LIMIT 1 FOR UPDATE`, [target.userId, target.calendarId, target.uid, target.recurrenceId || '']);
  if (!found) return false;
  await connection.execute('DELETE FROM calendar_overlay_restores WHERE id = ?', [found.id]);
  const state = parseOverlayState(found.payload);
  return state ? applyOverlayState(connection, target.userId, target.eventId, state, 'new') : false;
}

/**
 * Applies the waiting overlays whose item already has rows: after a restore
 * into the installation that still has the item, when the bin finds the item
 * back at its server, and at the end of a calendar's complete sync. By exact
 * identity; a shape overlay only when exactly one row of its calendar has its
 * title and start and that row keeps nothing of its own yet. An ambiguous one
 * stays pending until it expires (the restore note counts it as not
 * matched). Returns how many were applied.
 */
async function applyOverlaysToLiveRows(connection: SqlExecutor, userId: string, { calendarIds, uid, mode = 'fill' }: { calendarIds?: readonly string[]; uid?: string; mode?: Exclude<ApplyMode, 'new'> } = {}) {
  if (calendarIds && !calendarIds.length) return 0;
  const scope = `${calendarIds ? ` AND p.calendar_id IN (${calendarIds.map(() => '?').join(', ')})` : ''}${uid !== undefined ? ` AND p.uid = ? ${EXACT}` : ''}`;
  const scopeValues = [...(calendarIds ?? []), ...(uid !== undefined ? [uid] : [])];
  const [byUid] = await connection.execute<RowDataPacket[]>(
    `SELECT p.id, p.payload, e.id AS event_id FROM calendar_overlay_restores p
     JOIN calendar_events e ON e.user_id = p.user_id AND e.calendar_id = p.calendar_id AND e.uid = p.uid ${EXACT}
     JOIN calendar_event_external_refs r ON r.event_id = e.id AND r.user_id = e.user_id AND COALESCE(r.recurrence_id, '') = p.recurrence_id ${EXACT}
     WHERE p.user_id = ? AND p.match_kind = 'uid'${scope} ORDER BY p.created_at, p.id FOR UPDATE`, [userId, ...scopeValues]);
  // Every row with the shape counts, also one that keeps state: the match must be the only one.
  const [shapes] = uid !== undefined ? [[] as RowDataPacket[]] : await connection.execute<RowDataPacket[]>(
    `SELECT p.id, p.payload, MIN(e.id) AS event_id, COUNT(e.id) AS matches FROM calendar_overlay_restores p
     JOIN calendar_events e ON e.user_id = p.user_id AND e.calendar_id = p.calendar_id AND e.title = p.shape_title ${EXACT} AND e.start_time = p.shape_start
     WHERE p.user_id = ? AND p.match_kind = 'shape' AND (p.expires_at IS NULL OR p.expires_at > UTC_TIMESTAMP())${scope}
     GROUP BY p.id, p.payload, p.created_at ORDER BY p.created_at, p.id`, [userId, ...scopeValues]);
  const byShape = [];
  for (const row of shapes) {
    if (Number(row.matches) !== 1) continue;
    const [[own]] = await connection.execute<RowDataPacket[]>(
      `SELECT e.todo_status, EXISTS (SELECT 1 FROM calendar_event_subtasks s WHERE s.event_id = e.id) AS has_subtasks
       FROM calendar_events e WHERE e.id = ? AND e.user_id = ? FOR UPDATE`, [row.event_id, userId]);
    if (own && !own.todo_status && !Number(own.has_subtasks)) byShape.push(row);
  }
  let applied = 0;
  const claimed = new Set<string>();
  for (const row of [...byUid, ...byShape]) {
    if (claimed.has(String(row.event_id))) continue;
    claimed.add(String(row.event_id));
    await connection.execute('DELETE FROM calendar_overlay_restores WHERE id = ?', [row.id]);
    const state = parseOverlayState(row.payload);
    if (state && await applyOverlayState(connection, userId, String(row.event_id), state, mode)) applied += 1;
  }
  return applied;
}

/** Whether a calendar has overlays waiting, so a sync applies them only when there are some. */
async function hasPendingOverlays(executor: SqlExecutor, calendarId: string) {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT 1 FROM calendar_overlay_restores WHERE calendar_id = ? LIMIT 1', [calendarId]);
  return rows.length > 0;
}

/** Shape overlays past their time (the restore note counted them as not matched). */
async function sweepExpiredOverlays(executor: SqlExecutor = db) {
  const [result] = await executor.execute<ResultSetHeader>('DELETE FROM calendar_overlay_restores WHERE expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP() LIMIT 1000');
  return result.affectedRows || 0;
}

export {
  EXACT as UID_EXACT,
  parseOverlayState,
  overlayStateOf,
  applyOverlayState,
  insertOverlays,
  takeOverlayForNewRow,
  applyOverlaysToLiveRows,
  hasPendingOverlays,
  sweepExpiredOverlays,
};
export type { OverlayState, OverlaySubtask, OverlayTarget, PendingOverlay };
