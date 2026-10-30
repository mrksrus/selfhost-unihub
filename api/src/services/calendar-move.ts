import type { RowDataPacket } from 'mysql2/promise';
import type { ApiError, SqlExecutor } from '../types';
import type { CalendarEvent } from '../types/calendar';
import type { TaskMoveResponse } from '../contracts/tasks';
import type { SyncAccount, SyncCalendar, SyncTarget } from './calendar-sync';
import crypto from 'node:crypto';
import { db } from '../state';
import { log } from '../log';
import { badRequest, conflict, forbidden, notFound, ApiError as HttpError } from '../http/errors';
import { withTransaction } from './transactions';
import { canRunModule } from './access-policy';
import { publishCalendarChanged } from './realtime';
import { identityOf, rekey } from './task-order';
import { getCalendarEventWithSubtasks } from './calendar';
import * as caldav from './caldav';
import * as ical from './calendar-ical';
import * as calendarSync from './calendar-sync';

// Moving an event or task to another calendar or list (0.27). The event row
// stays the same row, so its ToDo state, done time, subtasks, attendees,
// source email and hand order (rekeyed) stay with it.
//
// A move that writes to a calendar server is journalled in
// calendar_event_moves before the first server write, with the UID and
// address of the new copy fixed up front:
//
//   creating  the new copy is to be stored at the target server (PUT with
//             If-None-Match: *). A lost answer is not a failure: the retry
//             sends the same object to the same address, and a 412 there is
//             adopted when the server holds our UID. Never a second UID.
//   (commit)  one transaction: link the row to the new copy (or the UniHub
//             list), drop the old link, move the hand rank, and go on to
//             removing (or finish, when the old copy was UniHub's own).
//   removing  the old copy is to be deleted at the source server, If-Match
//             the version the move started from. Until then the sync never
//             applies it again, so it cannot come back as a second event.
//             404/410 count as removed. A 412 means it was changed elsewhere
//             since: it is kept there and shows as an event of its own with
//             the next sync; nothing is lost.
//
// A step that cannot finish now waits in the journal and is retried by the
// sync pass (1, 5, 30 minutes, then hourly), or at once when the person
// moves the item to the same calendar again. A sync that finds the new copy
// before the move recorded it (a crash between the PUT and the commit) links
// it to the moved row instead of making another (calendar-sync.ts).
// Removing a calendar or account ends the moves that need it; a move still
// removing an old copy outlives its task and its new calendar.

type MoveState = 'creating' | 'removing';
interface MoveRow extends RowDataPacket {
  id: string;
  user_id: string;
  event_id: string | null;
  source_calendar_id: string | null;
  source_object_id: string | null;
  source_etag: string | null;
  target_calendar_id: string | null;
  target_uid: string;
  target_href: string | null;
  target_ics: string | null;
  state: MoveState;
  attempts: number;
}
interface MoveOutcome { pending?: MoveState; sourceKept?: boolean }
/** The new server copy of a moved event, stored or about to be. */
interface NewCopy { account: SyncAccount; calendar: SyncCalendar; timeZone: string; object: { id?: string; href: string; etag: string | null; ics: string } }
type Attempt = { copy: NewCopy } | { refused: unknown } | { wait: unknown };

const RETRY_SECONDS = [60, 300, 1800];
const LATER_SECONDS = 3600;
// After about three days of failures a new copy's fate is settled by looking
// at the target server (createCopy).
const GIVE_UP_ATTEMPTS = 72;
const MOVES_PER_PASS = 20;
const ID_PATTERN = /^[0-9a-f-]{36}$/i;

const movePending = () => conflict('CALENDAR_MOVE_PENDING',
  'This item is still being moved to another calendar. UniHub finishes the move when the calendar server answers; try again then.');
const recurringMove = () => badRequest('CALENDAR_RECURRING_MOVE', 'Recurring events cannot be moved to another calendar.');

// --- The journal, as the sync sees it ----------------------------------------

/** Ids of a calendar's server copies that an open move still has to remove. */
async function movedAwayObjects(executor: SqlExecutor, calendarId: string) {
  const [rows] = await executor.execute<RowDataPacket[]>(
    "SELECT source_object_id FROM calendar_event_moves WHERE source_calendar_id = ? AND state = 'removing' AND source_object_id IS NOT NULL",
    [calendarId]
  );
  return new Set(rows.map(row => String(row.source_object_id)));
}

/**
 * In a sync's transaction, before it reads the object's rows: whether a move
 * took its event away from this server copy. Locks the journal row, so a move
 * committing at this moment is waited for and then seen.
 */
async function lockMovedAway(connection: SqlExecutor, objectId: string) {
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT state FROM calendar_event_moves WHERE source_object_id = ? FOR UPDATE', [objectId]);
  return rows.some(row => row.state === 'removing');
}

/** In a sync's transaction: the open move whose new copy is this object (its calendar and UID), locked. */
async function lockCreatingMove(connection: SqlExecutor, calendarId: string, uid: string) {
  const [rows] = await connection.execute<MoveRow[]>('SELECT * FROM calendar_event_moves WHERE target_calendar_id = ? AND target_uid = ? FOR UPDATE', [calendarId, uid]);
  return rows.find(row => row.state === 'creating') ?? null;
}

async function loadMove(executor: SqlExecutor, moveId: string, lock = false) {
  const [rows] = await executor.execute<MoveRow[]>(`SELECT * FROM calendar_event_moves WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [moveId]);
  return rows[0] ?? null;
}

// The move creating this item's new copy. One whose new calendar was
// removed has ended; the sync pass closes it.
async function openMove(userId: string, eventId: string) {
  const [rows] = await db.execute<MoveRow[]>(
    "SELECT * FROM calendar_event_moves WHERE event_id = ? AND user_id = ? AND state = 'creating' AND target_calendar_id IS NOT NULL", [eventId, userId]);
  return rows[0] ?? null;
}

const closeMove = (moveId: string) => db.execute('DELETE FROM calendar_event_moves WHERE id = ?', [moveId]);

/**
 * Step 4, inside the caller's transaction, with the journal row locked: the
 * row moves to its new calendar (linked to its new copy when there is one).
 * Answers false when the move no longer waits for this (another run did it,
 * or the task is gone), so nothing is done twice.
 */
async function commitMove(connection: SqlExecutor, move: MoveRow, copy: NewCopy | null) {
  if (move.state !== 'creating') return false;
  const userId = move.user_id;
  const [events] = move.event_id && move.target_calendar_id
    ? await connection.execute<RowDataPacket[]>('SELECT id FROM calendar_events WHERE id = ? AND user_id = ? FOR UPDATE', [move.event_id, userId])
    : [[]];
  if (!events.length) {
    // The task or its new calendar was removed meanwhile. A copy the server
    // stored shows with the next sync as an event of its own.
    await connection.execute('DELETE FROM calendar_event_moves WHERE id = ?', [move.id]);
    return false;
  }
  const eventId = move.event_id!;
  const before = await identityOf(connection, userId, eventId);
  await connection.execute('DELETE FROM calendar_event_external_refs WHERE event_id = ? AND user_id = ?', [eventId, userId]);
  if (copy) {
    const object = await calendarSync.storeObject(connection, copy.account, copy.calendar, copy.object);
    await calendarSync.linkMovedObject(connection, copy.account, copy.calendar, object, eventId, copy.timeZone);
  }
  await connection.execute(
    `UPDATE calendar_events e JOIN calendar_calendars c ON c.id = ? AND c.user_id = e.user_id
     SET e.calendar_id = c.id, e.color = COALESCE(c.color, e.color) WHERE e.id = ? AND e.user_id = ?`,
    [move.target_calendar_id, eventId, userId]
  );
  if (before) await rekey(connection, userId, eventId, before);
  if (move.source_object_id) {
    await connection.execute(
      "UPDATE calendar_event_moves SET state = 'removing', target_etag = ?, attempts = 0, last_error = NULL, next_attempt_at = UTC_TIMESTAMP() WHERE id = ?",
      [copy?.object.etag ?? null, move.id]
    );
  } else {
    await connection.execute('DELETE FROM calendar_event_moves WHERE id = ?', [move.id]);
  }
  return true;
}

// --- Running a move -----------------------------------------------------------

// A refusal the server answered (not a lost answer, a server failure or a
// stop): retrying the same request will not change it.
function refusedByServer(error: unknown) {
  const { status, code } = (error || {}) as ApiError;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429 && (!code || code === 'OUTBOUND_HOST_BLOCKED');
}

function describe(error: unknown) {
  const { status, message } = (error || {}) as ApiError;
  return String(status ? `${status}: ${message || 'failed'}` : message || 'failed').slice(0, 255);
}

// Waits in the journal for the next attempt. A move never ends here: one
// that cannot reach its new server keeps its UID until the server shows the
// copy is absent (createCopy) or present.
async function postpone(move: MoveRow, error: unknown) {
  const attempts = Number(move.attempts) + 1;
  if (attempts >= GIVE_UP_ATTEMPTS && attempts % 24 === 0) {
    log.warn('calendar', 'A move is still waiting for a calendar server', { move: move.id, attempts, reason: describe(error) });
  }
  await db.execute('UPDATE calendar_event_moves SET attempts = ?, last_error = ?, next_attempt_at = UTC_TIMESTAMP() + INTERVAL ? SECOND WHERE id = ?',
    [attempts, describe(error), RETRY_SECONDS[attempts - 1] ?? LATER_SECONDS, move.id]);
}

/** Step 3: the new copy at the target server, or null while it waits. */
async function createCopy(move: MoveRow): Promise<NewCopy | null> {
  const target = move.target_calendar_id ? await calendarSync.loadCalendarContext(move.user_id, move.target_calendar_id) : null;
  if (!target) {
    // Its new calendar was removed from UniHub: the item stays where it is.
    await closeMove(move.id);
    throw notFound('CALENDAR_NOT_FOUND', 'The calendar this item was being moved to is gone.');
  }
  // After about three days of failures, the outcome of the earlier attempts
  // is settled by looking: absent, the move ends and the item stays; present,
  // it is adopted. Unknown, it keeps waiting with the same UID.
  const settle = Number(move.attempts) + 1 >= GIVE_UP_ATTEMPTS;
  let attempt: Attempt;
  try {
    attempt = await calendarSync.withWriteContext(target, async (ctx): Promise<Attempt> => {
      calendarSync.assertWritable(target);
      const url = calendarSync.objectUrl(ctx.account, { href: move.target_href! });
      const copy = (etag: string | null, ics: string) => ({ copy: { account: ctx.account, calendar: ctx.calendar, timeZone: ctx.timeZone, object: { href: move.target_href!, etag, ics } } });
      const look = async (otherwise: Attempt): Promise<Attempt> => {
        const found = await caldav.getCalendarObject({ url, ...ctx.login });
        if (found && ical.objectUid(found.ics) === move.target_uid) return copy(found.etag, found.ics);
        if (found) return { refused: conflict('CALDAV_CONFLICT', 'Another item already uses this address on the calendar server. Nothing was moved.') };
        return otherwise;
      };
      try {
        const { etag } = await caldav.putCalendarObject({ url, ics: move.target_ics!, etag: null, ...ctx.login });
        return copy(etag, move.target_ics!);
      } catch (error) {
        const taken = (error as ApiError)?.code === 'CALDAV_CONFLICT';
        const refused = refusedByServer(error);
        // Refused on the first attempt: nothing was stored. Otherwise an
        // earlier attempt may have stored it: look at what is there.
        if (!taken && !(refused && move.attempts > 0)) {
          if (refused) return { refused: error };
          return settle ? look({ refused: new HttpError(409, 'CALENDAR_MOVE_FAILED', 'The calendar server did not take the item, so it stays in its calendar.') }) : { wait: error };
        }
        return look(taken ? { wait: error } : { refused: error });
      }
    });
  } catch (error) {
    // No login now, the account paused or stopped, or the look failed: later.
    attempt = { wait: error };
  }
  if ('copy' in attempt) return attempt.copy;
  if ('refused' in attempt) {
    await closeMove(move.id);
    throw attempt.refused;
  }
  await postpone(move, attempt.wait);
  return null;
}

// How long the removal of an old copy waits for a sync of its account.
const REMOVE_LOCK_WAIT_SECONDS = 5;

/**
 * Step 5: the old copy at the source server. Runs under the source
 * account's sync lock, so no sync that read the old copy before can store it
 * again after it and its journal row are gone.
 */
async function removeOldCopy(move: MoveRow): Promise<MoveOutcome> {
  const source = move.source_calendar_id ? await calendarSync.loadCalendarContext(move.user_id, move.source_calendar_id) : null;
  if (!source) {
    await closeMove(move.id);
    return {};
  }
  const outcome = await calendarSync.withAccountLock(source.account.id, async (): Promise<MoveOutcome> => {
    const current = await loadMove(db, move.id);
    const [[object]] = await db.execute<RowDataPacket[]>('SELECT id, href, etag FROM calendar_remote_objects WHERE id = ? AND user_id = ?', [move.source_object_id, move.user_id]);
    if (current?.state !== 'removing') return {};
    if (!object) {
      await closeMove(move.id);
      return {};
    }
    // Kept at the server: changed elsewhere since the move started (412), or
    // a move without the version it started from (never deleted blindly).
    // The next sync downloads it again and shows it as an event of its own.
    const keep = async () => {
      log.warn('calendar', 'The old copy of a moved event changed in its old calendar and was kept there', { move: move.id, event: move.event_id });
      await closeMove(move.id);
      await db.execute('UPDATE calendar_remote_objects SET etag = NULL WHERE id = ?', [object.id]);
      await db.execute('UPDATE calendar_calendars SET remote_ctag = NULL WHERE id = ?', [source.calendar.id]);
      return { sourceKept: true };
    };
    if (!current.source_etag) return keep();
    try {
      await calendarSync.withWriteContext(source, async ctx => {
        calendarSync.assertWritable(source);
        await caldav.deleteCalendarObject({ url: calendarSync.objectUrl(ctx.account, { href: object.href }), etag: current.source_etag, ...ctx.login });
      });
    } catch (error) {
      if ((error as ApiError)?.code === 'CALDAV_CONFLICT') return keep();
      await postpone(current, error);
      return { pending: 'removing' };
    }
    // Removed (or already gone): the journal row goes with the stored copy.
    await db.execute('DELETE FROM calendar_remote_objects WHERE id = ? AND user_id = ?', [object.id, move.user_id]);
    return {};
  }, REMOVE_LOCK_WAIT_SECONDS);
  if ('skipped' in outcome) {
    // A sync of the old calendar is running: the pass removes it afterwards.
    await postpone(move, new Error('A sync of the old calendar was running'));
    return { pending: 'removing' };
  }
  if (outcome.sourceKept) calendarSync.syncCalendarAccountInBackground(source.account.id, { userId: move.user_id, reason: 'conflict' });
  publishCalendarChanged(move.user_id, source.account.id, 'local');
  return outcome;
}

async function advance(moveId: string): Promise<MoveOutcome> {
  let move = await loadMove(db, moveId);
  if (move?.state === 'creating') {
    const copy = move.target_href ? await createCopy(move) : null;
    if (move.target_href && !copy) return { pending: 'creating' };
    const committed = await withTransaction(async connection => {
      const locked = await loadMove(connection, moveId, true);
      return !!locked && commitMove(connection, locked, copy);
    });
    if (committed) publishCalendarChanged(move.user_id, null, 'local');
    move = await loadMove(db, moveId);
  }
  return move?.state === 'removing' ? removeOldCopy(move) : {};
}

// One run per move in this process: a retry joins the run going on.
const inProgress = new Map<string, Promise<MoveOutcome>>();
function runMove(moveId: string): Promise<MoveOutcome> {
  const running = inProgress.get(moveId);
  if (running) return running;
  const run = advance(moveId).finally(() => inProgress.delete(moveId));
  inProgress.set(moveId, run);
  return run;
}

/** For the sync pass: moves whose next attempt is due. Paused with the Calendar module and during a calendar restore. */
async function resumeDueMoves(signal?: AbortSignal) {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT id, user_id FROM calendar_event_moves WHERE next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP()
     ORDER BY next_attempt_at ASC LIMIT ${MOVES_PER_PASS}`
  );
  let resumed = 0;
  for (const row of rows) {
    if (signal?.aborted) break;
    if (!await canRunModule(row.user_id, 'calendar')) {
      await db.execute('UPDATE calendar_event_moves SET next_attempt_at = UTC_TIMESTAMP() + INTERVAL ? SECOND WHERE id = ?', [RETRY_SECONDS[1], row.id]);
      continue;
    }
    try {
      await runMove(row.id);
      resumed += 1;
    } catch (error) {
      log.warn('calendar', 'A move could not finish', { move: row.id, reason: describe(error) });
    }
  }
  return { resumed };
}

// --- Starting a move ----------------------------------------------------------

async function loadCalendar(userId: string, calendarId: string) {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT c.id, c.read_only, a.provider FROM calendar_calendars c
     JOIN calendar_accounts a ON a.id = c.account_id AND a.user_id = c.user_id
     WHERE c.id = ? AND c.user_id = ? LIMIT 1`,
    [calendarId, userId]
  );
  if (!rows[0]) return null;
  const remote: SyncTarget | null = calendarSync.REMOTE_PROVIDERS.has(rows[0].provider) ? await calendarSync.loadCalendarContext(userId, calendarId) : null;
  return { id: String(rows[0].id), readOnly: !!Number(rows[0].read_only), remote };
}

// The only shape a move can carry whole: one event that is not part of a
// series. Removing the old copy removes the whole server object, so an
// object that also holds other components (or a series' dates) stays.
function unmovableShape(ics: unknown) {
  const text = String(ics || '').replace(/\r?\n[ \t]/g, '');
  if (/^(RRULE|RDATE|RECURRENCE-ID)[:;]/im.test(text)) return recurringMove();
  const components = text.match(/^BEGIN:(VEVENT|VTODO|VJOURNAL)\b/gim) || [];
  if (components.length !== 1 || !/^BEGIN:VEVENT/i.test(components[0])) {
    return badRequest('CALENDAR_MOVE_UNSUPPORTED', 'This item shares its calendar entry with other items, so it cannot be moved on its own.');
  }
  return null;
}

// Whether a same-target retry carries field changes of its own: the copy
// being created holds the fields of the first request.
function changesFields(event: CalendarEvent, changes: Partial<CalendarEvent>) {
  if (!Object.keys(changes).length) return false;
  const merged = { ...event, ...changes };
  return JSON.stringify(calendarSync.eventFields(event)) !== JSON.stringify(calendarSync.eventFields(merged))
    || !!Number(merged.is_todo_only) !== !!Number(event.is_todo_only)
    || (merged.recurrence || null) !== (event.recurrence || null);
}

const millis = (value: unknown) => value == null ? null : new Date(value as string).getTime();
// The event, its calendar or its server link changed after this request read them.
const STALE = Symbol('stale');

/**
 * Moves an owned event or task to another owned calendar or list. `changes`
 * are field changes saved with the move (the event dialog): the new copy
 * carries them. Every check runs before any write. Answers `pending` when a
 * calendar server has not confirmed a step yet; the move then finishes in
 * the background.
 */
async function moveEvent(userId: string, eventId: string, targetCalendarId: string, { changes = {} }: { changes?: Partial<CalendarEvent> } = {}): Promise<MoveOutcome> {
  // A request that read the item before another one moved or changed it
  // starts over from what is there now.
  for (let round = 1; ; round += 1) {
    const outcome = await admitMove(userId, eventId, targetCalendarId, changes);
    if (outcome !== STALE) return outcome;
    if (round === 3) throw movePending();
  }
}

async function admitMove(userId: string, eventId: string, targetCalendarId: string, changes: Partial<CalendarEvent>): Promise<MoveOutcome | typeof STALE> {
  const [[event]] = await db.execute<(RowDataPacket & CalendarEvent)[]>('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [eventId, userId]);
  if (!event) throw notFound('TASK_NOT_FOUND', 'Task not found');
  const target = await loadCalendar(userId, targetCalendarId);
  if (!target) throw notFound('CALENDAR_NOT_FOUND', 'Calendar not found');
  // Moving again to where it is going resumes the move now; edits sent
  // with it would be lost with the copy being created, so they wait.
  const open = await openMove(userId, eventId);
  if (open) {
    if (open.target_calendar_id !== targetCalendarId || changesFields(event, changes)) throw movePending();
    return runMove(open.id);
  }
  if (event.calendar_id === targetCalendarId) return {};

  const merged = { ...event, ...changes };
  if (target.remote) calendarSync.assertWritable(target.remote);
  else if (target.readOnly) throw forbidden('CALENDAR_READ_ONLY', 'This list is read-only.');
  if (target.remote && Number(merged.is_todo_only)) {
    throw badRequest('CALENDAR_TODO_REMOTE', 'Tasks without a date stay in UniHub: a server calendar holds dated events only.');
  }
  const source = event.calendar_id ? await loadCalendar(userId, event.calendar_id) : null;
  const link = source?.remote ? await calendarSync.loadEventLink(userId, eventId) : null;
  if (source?.remote) {
    if (link) {
      const shape = unmovableShape(link.object.ics);
      if (shape) throw shape;
    }
    calendarSync.assertWritable(source.remote);
    // Linked before 0.17 and not synced since: the next sync replaces it.
    if (!link && await calendarSync.hasEventLink(userId, eventId)) throw conflict('CALENDAR_SYNC_PENDING', 'This event is still being synced. Try again in a moment.');
  }
  // A repeating UniHub event would reach the server as one date only.
  if (target.remote && !link && (merged.recurrence as string | null | undefined)) throw recurringMove();

  const sourceObjectId: string | null = link?.object.id ?? null;
  // Both logins before anything is written, so a refusal changes nothing.
  if (sourceObjectId) await calendarSync.resolveLogin(source!.remote!.account);
  if (target.remote) await calendarSync.resolveLogin(target.remote.account);
  // The version of the old copy the move may delete. A stored copy without
  // an ETag is read again: the same content gives its version; anything else
  // means the server has news, and the sync reads it first.
  let sourceEtag: string | null = link?.object.etag ?? null;
  if (link && !sourceEtag) {
    const found = await calendarSync.withWriteContext(source!.remote!, ctx =>
      caldav.getCalendarObject({ url: calendarSync.objectUrl(ctx.account, { href: link.object.href }), ...ctx.login }));
    if (!found?.etag || found.ics !== link.object.ics) {
      await db.execute('UPDATE calendar_calendars SET remote_ctag = NULL WHERE id = ?', [source!.id]);
      calendarSync.syncCalendarAccountInBackground(source!.remote!.account.id, { userId, reason: 'conflict' });
      throw conflict('CALDAV_CONFLICT', found?.etag || !found
        ? 'The event was changed on the calendar server in the meantime. It is being refreshed; please review it and try again.'
        : 'This calendar server does not report versions of its events, so UniHub cannot move this one safely.');
    }
    sourceEtag = found.etag;
  }

  // The journal, with the new copy's UID, address and content fixed before
  // the first server write: every attempt sends exactly this.
  const uid = crypto.randomUUID();
  let href: string | null = null;
  let ics: string | null = null;
  if (target.remote) {
    const timeZone = await calendarSync.resolveTimeZone(target.remote.account);
    ics = ical.createEventIcs(calendarSync.eventFields(merged), { uid, userTimeZone: timeZone }).ics;
    const collection = calendarSync.calendarUrl(target.remote.account, target.remote.calendar);
    href = caldav.canonicalHref(new URL(`${encodeURIComponent(uid)}.ics`, collection.endsWith('/') ? collection : `${collection}/`).toString());
  }
  const moveId = crypto.randomUUID();
  let admitted: 'local' | 'journal' | typeof STALE;
  try {
    admitted = await withTransaction(async connection => {
      // What this request read must still hold, under the event's lock: its
      // calendar, its row, its server link and that link's version, and no
      // move of it begun meanwhile.
      const [[current]] = await connection.execute<RowDataPacket[]>('SELECT calendar_id, updated_at FROM calendar_events WHERE id = ? AND user_id = ? FOR UPDATE', [eventId, userId]);
      if (!current) throw notFound('TASK_NOT_FOUND', 'Task not found');
      const [links] = await connection.execute<RowDataPacket[]>(
        `SELECT r.remote_object_id, o.etag FROM calendar_event_external_refs r LEFT JOIN calendar_remote_objects o ON o.id = r.remote_object_id
         WHERE r.event_id = ? AND r.user_id = ? FOR UPDATE`, [eventId, userId]);
      const [begun] = await connection.execute<RowDataPacket[]>("SELECT id FROM calendar_event_moves WHERE event_id = ? AND state = 'creating' FOR UPDATE", [eventId]);
      const linked = links[0] ? { id: links[0].remote_object_id ?? null, etag: links[0].etag ?? null } : null;
      const moved = (current.calendar_id || null) !== (event.calendar_id || null) || millis(current.updated_at) !== millis(event.updated_at) || begun.length > 0;
      const relinked = (linked?.id ?? null) !== sourceObjectId || (link ? linked?.etag !== link.object.etag : links.length > 0);
      if (moved || relinked) return STALE;
      if (!target.remote && !sourceObjectId) {
        // Between UniHub lists: only the list changes.
        await connection.execute(
          `UPDATE calendar_events e JOIN calendar_calendars c ON c.id = ? AND c.user_id = e.user_id
           SET e.calendar_id = c.id, e.color = COALESCE(c.color, e.color) WHERE e.id = ? AND e.user_id = ?`,
          [targetCalendarId, eventId, userId]
        );
        return 'local';
      }
      // A move still removing an older copy of this item goes on without it.
      await connection.execute("UPDATE calendar_event_moves SET event_id = NULL WHERE event_id = ? AND user_id = ? AND state = 'removing'", [eventId, userId]);
      await connection.execute(
        `INSERT INTO calendar_event_moves (id, user_id, event_id, source_calendar_id, source_object_id, source_etag, target_calendar_id, target_uid, target_href, target_ics, state, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', UTC_TIMESTAMP() + INTERVAL 1 MINUTE)`,
        [moveId, userId, eventId, event.calendar_id || null, sourceObjectId, sourceEtag, targetCalendarId, uid, href, ics]
      );
      return 'journal';
    });
  } catch (error) {
    // Another request started a move of this item at the same moment.
    if ((error as NodeJS.ErrnoException)?.code === 'ER_DUP_ENTRY') return STALE;
    throw error;
  }
  if (admitted === STALE) return STALE;
  if (admitted === 'local') {
    publishCalendarChanged(userId, null, 'local');
    return {};
  }
  return runMove(moveId);
}

/** POST /api/calendar/events/:id/move (contracts/tasks.ts). */
async function moveTask(userId: string, eventId: string, input: unknown): Promise<TaskMoveResponse & { source_kept?: true }> {
  if (!ID_PATTERN.test(eventId)) throw notFound('TASK_NOT_FOUND', 'Task not found');
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const calendarId = body?.calendar_id;
  if (typeof calendarId !== 'string' || !ID_PATTERN.test(calendarId)) throw badRequest('MOVE_INVALID', 'Expected { calendar_id }: the calendar or list to move to');
  const outcome = await moveEvent(userId, eventId, calendarId);
  const event = await getCalendarEventWithSubtasks(userId, eventId);
  return { event: event as TaskMoveResponse['event'], ...(outcome.pending ? { pending: outcome.pending } : {}), ...(outcome.sourceKept ? { source_kept: true as const } : {}) };
}

/** Refuses an edit or deletion while the item's new copy is being created: it would be lost or come back. */
async function assertNotMoving(userId: string, eventId: string) {
  if (await openMove(userId, eventId)) throw movePending();
}

export {
  moveEvent,
  moveTask,
  assertNotMoving,
  resumeDueMoves,
  movedAwayObjects,
  lockMovedAway,
  lockCreatingMove,
  commitMove,
};
export type { MoveOutcome };
