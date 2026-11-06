import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import crypto from 'node:crypto';
import { log } from '../log';
import { db } from '../state';

// UniHub's own additions to a synced event or task (F2 `local` overlay): its
// ToDo state, done time, source email, subtasks, and the attendees with their
// replies (UniHub never writes those to the server). The calendar server holds
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
const RESPONSES = new Set(['accepted', 'tentative', 'declined', 'needsAction']);
// What the subtask and attendee columns hold: varchar(255) counts characters,
// the comment is TEXT (65,535 bytes), the position a signed INT.
const COMMENT_MAX_BYTES = 65535;
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// Errors in which MariaDB refuses a value an overlay holds: the overlay is at
// fault, not the connection, so it is set aside instead of tried again.
// Data too long, out of range, incorrect value, duplicate entry, NULL, check
// constraint, foreign key.
const VALUE_ERRORS = new Set([1406, 1264, 1292, 1366, 1062, 1048, 4025, 1452]);

interface OverlaySubtask { title: string; is_done: boolean; position: number }
interface OverlayAttendee { email: string; display_name: string | null; response_status: string; is_organizer: boolean; optional_attendee: boolean; comment: string | null }
/** The payload of a calendar_overlay_restores row, and of each occurrence of a synced item in the bin. */
interface OverlayState {
  todo_status: string | null;
  /** UTC, 'YYYY-MM-DD HH:MM:SS'. */
  done_at: string | null;
  source_email_id: string | null;
  source_email_json: unknown;
  subtasks: OverlaySubtask[];
  attendees: OverlayAttendee[];
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
/** An overlay the database refused to write, as it was set aside: never applied, kept until its calendar goes. */
interface FailedOverlay extends Omit<PendingOverlay, 'state'> {
  /** The payload as it was, JSON text. */
  payload: string;
  failedAt: string;
  failure: string;
}
/** new: a row the sync just made; fill: only what the row lacks; replace: as the overlay has it. */
type ApplyMode = 'new' | 'fill' | 'replace';

/**
 * Whether a DATETIME column takes this 'YYYY-MM-DD HH:MM:SS' as it is: a real
 * date and time from the year 1000 to 9999. JavaScript dates roll a 30
 * February over into March, so the parts are compared after the round trip.
 */
function isStorableDateTime(text: string) {
  if (!DATETIME.test(text)) return false;
  const [year, month, day, hour, minute, second] = text.split(/[- :]/).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return year >= 1000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}
/** A time as a UTC DATETIME, or null; an ISO time with a zone is converted, never a date that does not exist. */
const sqlTime = (value: unknown): string | null => {
  if (value instanceof Date) {
    const text = Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 19).replace('T', ' ');
    return isStorableDateTime(text) ? text : null;
  }
  if (typeof value !== 'string') return null;
  if (!value.includes('T')) return isStorableDateTime(value) ? value : null;
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!iso || !isStorableDateTime(`${iso[1]} ${iso[2]}`)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : sqlTime(date);
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
  // A time a DATETIME cannot take stays as it is, so the check refuses it (overlayPayloadProblem).
  const doneAt = input.done_at == null ? null : sqlTime(input.done_at) ?? String(input.done_at);
  const emailId = typeof input.source_email_id === 'string' && ID_PATTERN.test(input.source_email_id) ? input.source_email_id : null;
  const email = json(input.source_email_json);
  const subtasks = (Array.isArray(input.subtasks) ? input.subtasks : []).flatMap((item, index) => {
    if (!item || typeof item !== 'object' || typeof (item as OverlaySubtask).title !== 'string') return [];
    const title = (item as OverlaySubtask).title;
    if (!title.trim()) return [];
    const position = Number.isSafeInteger((item as OverlaySubtask).position) ? (item as OverlaySubtask).position : index;
    return [{ title, is_done: !!(item as OverlaySubtask).is_done, position }];
  });
  // Names and replies are carried as they are stored, never cut or trimmed;
  // the address takes the attendee writer's form (calendar.ts
  // replaceEventAttendees), which is also how two entries for one person are
  // told apart.
  const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : null;
  const seen = new Set<string>();
  const attendees = (Array.isArray(input.attendees) ? input.attendees : []).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const attendee = item as Record<string, unknown>;
    const address = typeof attendee.email === 'string' ? attendee.email.trim().toLowerCase() : '';
    if (!address || seen.has(address)) return [];
    seen.add(address);
    const response = typeof attendee.response_status === 'string' && RESPONSES.has(attendee.response_status) ? attendee.response_status : 'needsAction';
    return [{ email: address, display_name: text(attendee.display_name), response_status: response, is_organizer: !!attendee.is_organizer,
      optional_attendee: !!attendee.optional_attendee, comment: text(attendee.comment) }];
  });
  const state = { todo_status: status, done_at: status ? doneAt : null, source_email_id: emailId, source_email_json: email && typeof email === 'object' ? email : null, subtasks, attendees };
  return state.todo_status || state.source_email_id || state.source_email_json || state.subtasks.length || state.attendees.length ? state : null;
}

const storableText = (value: string, max: number) => Array.from(value).length <= max;
const isBoolean = (value: unknown) => typeof value === 'boolean';
const isTextOrNull = (value: unknown) => value === null || value === undefined || typeof value === 'string';

/**
 * Why an overlay payload cannot be written as it is, or null. 'form': not as
 * UniHub writes one (every overlay comes from its own export, the bin or the
 * conversion of an older archive, which write exactly this form); 'capacity':
 * a value its column cannot take, judged on the exact value applyOverlayState
 * writes (parseOverlayState). An archive with either refuses its restore
 * (backup-overlays.ts); a waiting one is set aside (applyWaitingOverlay).
 * What it checks, per written column:
 * - calendar_events: todo_status one of the ToDo states; done_at a real
 *   DATETIME; source_email_id a UUID (the email must be the person's own,
 *   applyOverlayState); source_email_json an object.
 * - calendar_event_subtasks: title a non-blank string of at most 255
 *   characters; is_done a boolean; position an integer in the INT range.
 * - calendar_event_attendees: email a non-empty string of at most 255
 *   characters as written (trimmed, lower case), once per overlay;
 *   display_name null or at most 255 characters; response_status one of the
 *   replies; is_organizer and optional_attendee booleans; comment null or at
 *   most 65,535 UTF-8 bytes. Text must be valid Unicode, which utf8mb4 stores
 *   unchanged.
 */
function overlayPayloadProblem(value: unknown): { kind: 'form' | 'capacity'; problem: string } | null {
  const input = json(value) as Record<string, unknown> | null;
  const form = (problem: string) => ({ kind: 'form' as const, problem });
  const capacity = (problem: string) => ({ kind: 'capacity' as const, problem });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return form('the state is not an object');
  if (input.todo_status != null && !TODO_STATUSES.has(input.todo_status as string)) return form('a ToDo state UniHub does not have');
  if (input.done_at != null && (typeof input.done_at !== 'string' || !isStorableDateTime(input.done_at))) return capacity('a done time that is not a real date and time');
  if (input.source_email_id != null && (typeof input.source_email_id !== 'string' || !ID_PATTERN.test(input.source_email_id))) return form('a source email that is not an id');
  if (input.source_email_json != null) {
    const email = json(input.source_email_json);
    if (!email || typeof email !== 'object') return form('a source email snapshot that is not an object');
  }
  if (input.subtasks !== undefined && !Array.isArray(input.subtasks)) return form('subtasks that are not a list');
  if (input.attendees !== undefined && !Array.isArray(input.attendees)) return form('attendees that are not a list');
  const texts = [...((input.subtasks ?? []) as Record<string, unknown>[]).map(item => item?.title),
    ...((input.attendees ?? []) as Record<string, unknown>[]).flatMap(item => [item?.email, item?.display_name, item?.comment])];
  if (texts.some(text => typeof text === 'string' && LONE_SURROGATE.test(text))) return capacity('text that is not valid Unicode');
  for (const item of (input.subtasks ?? []) as unknown[]) {
    const subtask = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    if (typeof subtask.title !== 'string' || !subtask.title.trim() || !isBoolean(subtask.is_done) || !Number.isInteger(subtask.position)) return form('a subtask UniHub does not write');
    if (!storableText(subtask.title, TITLE_MAX)) return capacity('a subtask title is longer than 255 characters');
    if ((subtask.position as number) < INT_MIN || (subtask.position as number) > INT_MAX) return capacity('a subtask position is outside the range its column holds');
  }
  const addresses = new Set<string>();
  for (const item of (input.attendees ?? []) as unknown[]) {
    const attendee = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const address = typeof attendee.email === 'string' ? attendee.email.trim().toLowerCase() : '';
    if (!address || addresses.has(address) || !isTextOrNull(attendee.display_name) || !RESPONSES.has(attendee.response_status as string)
      || !isBoolean(attendee.is_organizer) || !isBoolean(attendee.optional_attendee) || !isTextOrNull(attendee.comment)) return form('an attendee UniHub does not write');
    addresses.add(address);
    if (!storableText(address, TITLE_MAX) || (typeof attendee.display_name === 'string' && !storableText(attendee.display_name, TITLE_MAX))) {
      return capacity('an attendee address or name is longer than 255 characters');
    }
    if (typeof attendee.comment === 'string' && Buffer.byteLength(attendee.comment, 'utf8') > COMMENT_MAX_BYTES) {
      return capacity('a reply comment is longer than 65,535 bytes');
    }
  }
  return null;
}

/**
 * Why an overlay's key cannot be stored exactly, or null: each part must be
 * valid Unicode and fit its column in characters (uid and account_identity
 * VARCHAR(500), recurrence_id VARCHAR(64), shape_title VARCHAR(255)). A key
 * is never shortened: a shorter one names another item.
 */
function overlayKeyProblem({ uid, recurrenceId, accountIdentity, shapeTitle }: { uid?: unknown; recurrenceId?: unknown; accountIdentity?: unknown; shapeTitle?: unknown }) {
  for (const [value, max] of [[uid, 500], [recurrenceId, 64], [accountIdentity, 500], [shapeTitle, TITLE_MAX]] as const) {
    if (value == null) continue;
    if (typeof value !== 'string' || LONE_SURROGATE.test(value) || Array.from(value).length > max) return 'an item identity is longer than its column or not valid text';
  }
  return null;
}

/** An attendee row as an overlay holds it. */
const overlayAttendee = (row: Record<string, unknown>) => ({ email: row.email, display_name: row.display_name, response_status: row.response_status,
  is_organizer: !!Number(row.is_organizer), optional_attendee: !!Number(row.optional_attendee), comment: row.comment });

/** What UniHub keeps of its own on one event row, or null when it keeps nothing. */
async function overlayStateOf(executor: SqlExecutor, userId: string, eventId: string): Promise<OverlayState | null> {
  const [[event]] = await executor.execute<RowDataPacket[]>('SELECT todo_status, done_at, source_email_id, source_email_json FROM calendar_events WHERE id = ? AND user_id = ?', [eventId, userId]);
  if (!event) return null;
  const [subtasks] = await executor.execute<RowDataPacket[]>(
    'SELECT title, is_done, position FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ? ORDER BY position, created_at, id', [eventId, userId]);
  const [attendees] = await executor.execute<RowDataPacket[]>(
    'SELECT email, display_name, response_status, is_organizer, optional_attendee, comment FROM calendar_event_attendees WHERE event_id = ? AND user_id = ? ORDER BY created_at, id', [eventId, userId]);
  return parseOverlayState({
    todo_status: event.todo_status, done_at: event.done_at, source_email_id: event.source_email_id, source_email_json: event.source_email_json,
    subtasks: subtasks.map(row => ({ title: row.title, is_done: !!Number(row.is_done), position: Number(row.position) })),
    attendees: attendees.map(overlayAttendee),
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
  // A restore's Replace takes the archive's state as it is: what the archive
  // has none of (no ToDo state, no source email, no subtasks) is cleared too.
  const exact = mode === 'replace';
  const sets: string[] = []; const values: (string | null)[] = [];
  if (exact || (state.todo_status && (replace || !row.todo_status))) { sets.push('todo_status = ?', 'done_at = ?'); values.push(state.todo_status, state.done_at); }
  if (exact || ((emailId || state.source_email_json) && (replace || (!row.source_email_id && !row.source_email_json)))) {
    sets.push('source_email_id = ?', 'source_email_json = ?');
    values.push(emailId, state.source_email_json ? JSON.stringify(state.source_email_json) : null);
  }
  if (sets.length) await connection.execute(`UPDATE calendar_events SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, [...values, eventId, userId]);
  if (exact || state.subtasks.length) {
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
  if (exact || state.attendees.length) {
    const [[{ count }]] = await connection.execute<RowDataPacket[]>('SELECT COUNT(*) AS count FROM calendar_event_attendees WHERE event_id = ? AND user_id = ?', [eventId, userId]);
    if (mode === 'replace' || !Number(count)) {
      // As the overlay has them: the attendee writer's input normalisation
      // (trimmed names) is for edits, not for state UniHub stored already.
      await connection.execute('DELETE FROM calendar_event_attendees WHERE event_id = ? AND user_id = ?', [eventId, userId]);
      for (const attendee of state.attendees) {
        await connection.execute(`INSERT INTO calendar_event_attendees (id, user_id, event_id, email, display_name, response_status, is_organizer, optional_attendee, comment)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [crypto.randomUUID(), userId, eventId, attendee.email, attendee.display_name, attendee.response_status,
          attendee.is_organizer ? 1 : 0, attendee.optional_attendee ? 1 : 0, attendee.comment]);
      }
    }
  }
  return true;
}

/**
 * Stores overlays that wait for their item. The calendar must be the
 * person's own; one already waiting for the same item is replaced, so a
 * second restore of the same archive leaves one. One set aside as failed is
 * not waiting and stays. Keys are stored exactly; one that does not fit is
 * refused (validation refuses such an archive first).
 */
async function insertOverlays(connection: SqlExecutor, overlays: readonly PendingOverlay[]) {
  let stored = 0;
  for (const overlay of overlays) {
    const kind = overlay.matchKind ?? 'uid';
    if (kind === 'uid' && !overlay.uid) continue;
    if (kind === 'shape' && (!overlay.shape?.title || !sqlTime(overlay.shape.start))) continue;
    const key = keyOf(overlay);
    const [owned] = await connection.execute<RowDataPacket[]>('SELECT id FROM calendar_calendars WHERE id = ? AND user_id = ? FOR UPDATE', [overlay.calendarId, overlay.userId]);
    if (!owned.length) continue;
    if (kind === 'uid') {
      await connection.execute(`DELETE FROM calendar_overlay_restores WHERE user_id = ? AND calendar_id = ? AND match_kind = 'uid' AND uid = ? ${EXACT} AND recurrence_id = ? ${EXACT}
        AND failed_at IS NULL`, [overlay.userId, overlay.calendarId, key.uid, key.recurrenceId]);
    } else {
      await connection.execute(`DELETE FROM calendar_overlay_restores WHERE user_id = ? AND calendar_id = ? AND match_kind = 'shape' AND shape_title = ? ${EXACT} AND shape_start = ?
        AND failed_at IS NULL`, [overlay.userId, overlay.calendarId, key.shapeTitle, key.shapeStart]);
    }
    await connection.execute(`INSERT INTO calendar_overlay_restores
      (id, user_id, calendar_id, account_identity, uid, recurrence_id, match_kind, shape_title, shape_start, payload, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      crypto.randomUUID(), overlay.userId, overlay.calendarId, key.accountIdentity, key.uid, key.recurrenceId, kind, key.shapeTitle, key.shapeStart,
      JSON.stringify(overlay.state), overlay.expiresAt ? sqlTime(overlay.expiresAt) : null,
    ]);
    stored += 1;
  }
  return stored;
}

/** An overlay's key as its columns store it, exactly; refused when it does not fit. */
function keyOf(overlay: Omit<PendingOverlay, 'state'>) {
  const kind = overlay.matchKind ?? 'uid';
  const key = { uid: kind === 'uid' ? overlay.uid : null, recurrenceId: String(overlay.recurrenceId || ''), accountIdentity: String(overlay.accountIdentity || ''),
    shapeTitle: kind === 'shape' ? overlay.shape!.title : null, shapeStart: kind === 'shape' ? sqlTime(overlay.shape!.start) : null };
  const problem = overlayKeyProblem(key);
  if (problem) throw Object.assign(new Error(`A synced-task state cannot be stored: ${problem}`), { status: 422 });
  return key;
}

/**
 * Keeps overlays an archive carries as set aside (failed): as they were,
 * never applied, never replaced by a waiting one. The same one twice (a
 * second restore of the archive) is kept once. Returns how many it holds.
 */
async function insertFailedOverlays(connection: SqlExecutor, overlays: readonly FailedOverlay[]) {
  let kept = 0;
  for (const overlay of overlays) {
    const key = keyOf(overlay);
    if ((overlay.matchKind ?? 'uid') === 'uid' ? !key.uid : !key.shapeTitle || !key.shapeStart) continue;
    const [owned] = await connection.execute<RowDataPacket[]>('SELECT id FROM calendar_calendars WHERE id = ? AND user_id = ? FOR UPDATE', [overlay.calendarId, overlay.userId]);
    if (!owned.length) continue;
    kept += 1;
    const [same] = await connection.execute<RowDataPacket[]>(`SELECT id FROM calendar_overlay_restores WHERE user_id = ? AND calendar_id = ? AND failed_at IS NOT NULL
      AND match_kind = ? AND uid <=> ? ${EXACT} AND recurrence_id = ? ${EXACT} AND shape_title <=> ? ${EXACT} AND shape_start <=> ? AND payload = ? ${EXACT} LIMIT 1`,
    [overlay.userId, overlay.calendarId, overlay.matchKind ?? 'uid', key.uid, key.recurrenceId, key.shapeTitle, key.shapeStart, overlay.payload]);
    if (same.length) continue;
    await connection.execute(`INSERT INTO calendar_overlay_restores
      (id, user_id, calendar_id, account_identity, uid, recurrence_id, match_kind, shape_title, shape_start, payload, expires_at, failed_at, failure)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      crypto.randomUUID(), overlay.userId, overlay.calendarId, key.accountIdentity, key.uid, key.recurrenceId, overlay.matchKind ?? 'uid', key.shapeTitle, key.shapeStart,
      overlay.payload, overlay.expiresAt ? sqlTime(overlay.expiresAt) : null, overlay.failedAt, overlay.failure,
    ]);
  }
  return kept;
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
     AND failed_at IS NULL ORDER BY created_at, id LIMIT 1 FOR UPDATE`, [target.userId, target.calendarId, target.uid, target.recurrenceId || '']);
  if (!found) return false;
  return applyWaitingOverlay(connection, target.userId, found, target.eventId, 'new');
}

/**
 * Applies one waiting overlay to its row and removes it. Its writes are its
 * own: a savepoint in the caller's transaction (the sync's, the restore's,
 * the bin's), or a transaction of their own outside one. An overlay that
 * cannot be written undoes only them, and stays, marked failed with the
 * reason, so the item still syncs, the overlay is not tried again and is
 * still there to look at. It is never expired or replaced by a waiting one,
 * backups carry it as it is, and it goes only with its calendar, account or
 * person. Any other error (the connection, a lock) goes to the caller as
 * before.
 */
async function applyWaitingOverlay(connection: SqlExecutor, userId: string, overlay: RowDataPacket, eventId: string, mode: ApplyMode) {
  const setAside = async (reason: string) => {
    await connection.execute('UPDATE calendar_overlay_restores SET failed_at = UTC_TIMESTAMP(), failure = ? WHERE id = ?', [reason.slice(0, 255), overlay.id]);
    log.warn('calendar', 'Synced-task state could not be applied; it is kept as failed', { overlayId: overlay.id, reason });
    return false;
  };
  const problem = overlayPayloadProblem(overlay.payload);
  if (problem) return setAside(problem.problem);
  const state = parseOverlayState(overlay.payload);
  const [[{ open }]] = await connection.query<RowDataPacket[]>('SELECT @@in_transaction AS open');
  const nested = Number(open) === 1;
  await connection.query(nested ? 'SAVEPOINT overlay_apply' : 'START TRANSACTION');
  let applied = false;
  try {
    if (state) applied = await applyOverlayState(connection, userId, eventId, state, mode);
    await connection.execute('DELETE FROM calendar_overlay_restores WHERE id = ?', [overlay.id]);
  } catch (error) {
    const errno = Number((error as { errno?: number }).errno);
    if (!VALUE_ERRORS.has(errno)) {
      if (!nested) await connection.query('ROLLBACK').catch(() => {});
      throw error;
    }
    await connection.query(nested ? 'ROLLBACK TO SAVEPOINT overlay_apply' : 'ROLLBACK');
    return setAside(String((error as { code?: string }).code || `MariaDB error ${errno}`));
  }
  await connection.query(nested ? 'RELEASE SAVEPOINT overlay_apply' : 'COMMIT');
  return applied;
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
     WHERE p.user_id = ? AND p.match_kind = 'uid' AND p.failed_at IS NULL${scope} ORDER BY p.created_at, p.id FOR UPDATE`, [userId, ...scopeValues]);
  // Every row with the shape counts, also one that keeps state: the match must be the only one.
  const [shapes] = uid !== undefined ? [[] as RowDataPacket[]] : await connection.execute<RowDataPacket[]>(
    `SELECT p.id, p.payload, MIN(e.id) AS event_id, COUNT(e.id) AS matches FROM calendar_overlay_restores p
     JOIN calendar_events e ON e.user_id = p.user_id AND e.calendar_id = p.calendar_id AND e.title = p.shape_title ${EXACT} AND e.start_time = p.shape_start
     WHERE p.user_id = ? AND p.match_kind = 'shape' AND p.failed_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > UTC_TIMESTAMP())${scope}
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
    if (await applyWaitingOverlay(connection, userId, row, String(row.event_id), mode)) applied += 1;
  }
  return applied;
}

/** Whether a calendar has overlays waiting, so a sync applies them only when there are some. */
async function hasPendingOverlays(executor: SqlExecutor, calendarId: string) {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT 1 FROM calendar_overlay_restores WHERE calendar_id = ? AND failed_at IS NULL LIMIT 1', [calendarId]);
  return rows.length > 0;
}

/**
 * Shape overlays past their time (the restore note counted them as not
 * matched). One set aside as failed has no such time: it stays until its
 * calendar, account or person is removed.
 */
async function sweepExpiredOverlays(executor: SqlExecutor = db) {
  const [result] = await executor.execute<ResultSetHeader>('DELETE FROM calendar_overlay_restores WHERE expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP() AND failed_at IS NULL LIMIT 1000');
  return result.affectedRows || 0;
}

export {
  overlayAttendee,
  EXACT as UID_EXACT,
  parseOverlayState,
  overlayPayloadProblem,
  overlayKeyProblem,
  insertFailedOverlays,
  sqlTime as overlaySqlTime,
  overlayStateOf,
  applyOverlayState,
  insertOverlays,
  takeOverlayForNewRow,
  applyOverlaysToLiveRows,
  hasPendingOverlays,
  sweepExpiredOverlays,
};
export type { FailedOverlay, OverlayAttendee, OverlayState, OverlaySubtask, OverlayTarget, PendingOverlay };
