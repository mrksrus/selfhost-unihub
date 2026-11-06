import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { CalendarEvent } from '../types/calendar';
import type { BinItemType, BinRestored } from '../contracts/bin';
import type { BinKind, BinRow, RestoreChoice } from './bin';
import type { OverlayState } from './calendar-overlays';
import type { SyncAccount, SyncCalendar, SyncTarget } from './calendar-sync';
import crypto from 'node:crypto';
import { db } from '../state';
import { ApiError, conflict, notFound } from '../http/errors';
import { withTransaction } from './transactions';
import { putInBin, parsePayload, lockBinOwner } from './bin';
import { UID_EXACT, overlayStateOf, insertOverlays, applyOverlaysToLiveRows } from './calendar-overlays';
import { fencedWrite, calendarAdmission } from './calendar-move-state';
import { itemKey } from './task-order';
import { publishCalendarChanged } from './realtime';
import { ensureDefaultLocalCalendarForUser, resolveCalendarDefaults } from './calendar';
import * as calendarSync from './calendar-sync';
import * as calendarMove from './calendar-move';
import * as caldav from './caldav';

// Events, tasks and local calendars in the bin (bin.ts).
//
// - A UniHub event or task: its row with subtasks, attendees and hand rank;
//   restored into its list, or the default list when that is gone.
// - A local calendar: the calendar and its settings, with each of its events
//   as an item of the same group; restored together.
// - A synced one (CalDAV): the provider deletes it first, as before, with
//   If-Match; only once it confirmed are the rows removed and the item kept
//   here: the server copy (ICS, UID, address), each occurrence's own state
//   (calendar-overlays.ts) and the hand ranks. Restoring creates it at its
//   calendar again with the same UID through the move journal
//   (calendar-move.ts: If-None-Match, a lost answer adopted, never a second
//   copy), and the rows the commit makes take their state back. A calendar
//   that is gone or read-only now takes it into the default list instead.
//   Deleting one date of a repeating server event changes the series at the
//   provider; that date is not kept in the bin.

type Stored = Record<string, unknown>;
interface LocalPayload {
  provider: 'local';
  origin: string | null;
  event: Stored;
  subtasks: Stored[];
  attendees: Stored[];
  task_order: Stored[];
}
interface SyncedPayload extends Omit<LocalPayload, 'provider'> {
  provider: 'caldav';
  calendar: { id: string | null; account_id: string | null; external_id: string | null; name: string | null };
  object: { href: string; uid: string | null; ics: string };
  occurrences: { recurrence_id: string; state: OverlayState }[];
}
interface CalendarPayload {
  provider: 'local';
  origin: null;
  calendar: Stored;
  /** The calendar's settings the person chose (F1, calendar scope). */
  settings: Record<string, unknown>;
}
interface Copy { account: SyncAccount; calendar: SyncCalendar; timeZone: string; object: { id?: string; href: string; etag: string | null; ics: string } }

const EVENT_COLUMNS = ['id', 'user_id', 'calendar_id', 'title', 'description', 'start_time', 'end_time', 'all_day', 'location', 'color', 'recurrence', 'reminder_minutes',
  'reminders', 'todo_status', 'is_todo_only', 'done_at', 'created_at', 'updated_at', 'source_email_id', 'source_email_json', 'order_key', 'uid'] as const;
const SUBTASK_COLUMNS = ['id', 'event_id', 'user_id', 'title', 'is_done', 'position', 'created_at', 'updated_at'] as const;
const ATTENDEE_COLUMNS = ['id', 'user_id', 'event_id', 'email', 'display_name', 'response_status', 'is_organizer', 'optional_attendee', 'comment', 'created_at', 'updated_at'] as const;
const CALENDAR_COLUMNS = ['id', 'user_id', 'account_id', 'name', 'color', 'is_visible', 'auto_todo_enabled', 'read_only', 'is_primary', 'created_at', 'uid'] as const;
const TIME_COLUMNS = new Set(['start_time', 'end_time', 'done_at', 'created_at', 'updated_at']);
const JSON_COLUMNS = new Set(['reminders', 'source_email_json']);
const ID_PATTERN = /^[0-9a-f-]{36}$/i;
const GONE_NOTE = 'The list it was in is gone; restored to your default list.';

const placeholders = (items: readonly unknown[]) => items.map(() => '?').join(', ');
const toStored = (row: RowDataPacket): Stored => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
function sqlValue(column: string, value: unknown) {
  if (value == null) return null;
  if (TIME_COLUMNS.has(column)) { const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? null : date; }
  if (JSON_COLUMNS.has(column)) return typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}
// Only the named columns are written: a payload from an archive is not trusted.
async function insertRows(cx: SqlExecutor, table: string, columns: readonly string[], rows: readonly Stored[]) {
  for (const row of rows) {
    await cx.execute(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders(columns)})`, columns.map(column => sqlValue(column, row[column])) as (string | number | Date | null)[]);
  }
}
async function freeIds(cx: SqlExecutor, table: string, rows: readonly Stored[]) {
  const ids = rows.map(row => String(row.id)).filter(id => ID_PATTERN.test(id));
  const used = new Set<string>();
  // In chunks: a task may have any number of subtasks.
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const [taken] = await cx.execute<RowDataPacket[]>(`SELECT id FROM ${table} WHERE id IN (${placeholders(chunk)})`, chunk);
    for (const row of taken) used.add(String(row.id));
  }
  return rows.map(row => ID_PATTERN.test(String(row.id)) && !used.has(String(row.id)) ? row : { ...row, id: crypto.randomUUID() });
}
const itemTypeOf = (event: Stored): BinItemType => Number(event.is_todo_only) || event.todo_status ? 'task' : 'event';

// --- Into the bin ---------------------------------------------------------------

async function snapshotLocalEvent(cx: SqlExecutor, userId: string, eventId: string): Promise<LocalPayload | null> {
  const [[event]] = await cx.execute<RowDataPacket[]>('SELECT * FROM calendar_events WHERE id = ? AND user_id = ? FOR UPDATE', [eventId, userId]);
  if (!event) return null;
  const [subtasks] = await cx.execute<RowDataPacket[]>('SELECT * FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ? ORDER BY position, created_at, id', [eventId, userId]);
  const [attendees] = await cx.execute<RowDataPacket[]>('SELECT * FROM calendar_event_attendees WHERE event_id = ? AND user_id = ? ORDER BY created_at, id', [eventId, userId]);
  const [ranks] = await cx.execute<RowDataPacket[]>('SELECT * FROM task_order WHERE user_id = ? AND event_id = ?', [userId, eventId]);
  const [[calendar]] = await cx.execute<RowDataPacket[]>('SELECT name FROM calendar_calendars WHERE id = ? AND user_id = ?', [event.calendar_id, userId]);
  return { provider: 'local', origin: calendar?.name ?? null, event: toStored(event), subtasks: subtasks.map(toStored), attendees: attendees.map(toStored), task_order: ranks.map(toStored) };
}

/** In the caller's transaction: UniHub events and tasks into the bin, then their rows removed. */
async function binLocalEvents(cx: SqlExecutor, userId: string, eventIds: readonly string[], { reason = 'deleted' as const, groupId = null as string | null }: { reason?: 'deleted' | 'calendar_deleted'; groupId?: string | null } = {}) {
  const items = [];
  const removed: string[] = [];
  for (const eventId of eventIds) {
    const payload = await snapshotLocalEvent(cx, userId, eventId);
    if (!payload) continue;
    items.push({ module: 'calendar' as const, itemType: itemTypeOf(payload.event), itemId: eventId, title: String(payload.event.title ?? ''), reason, groupId, payload });
    removed.push(eventId);
  }
  const binIds = await putInBin(cx, userId, items);
  for (let index = 0; index < removed.length; index += 200) {
    const chunk = removed.slice(index, index + 200);
    await cx.execute(`DELETE FROM calendar_events WHERE user_id = ? AND id IN (${placeholders(chunk)})`, [userId, ...chunk]);
  }
  return binIds;
}

// A synced item, inside the transaction that removes its rows after the
// server confirmed the deletion (calendar-sync.ts removeObjects).
async function binSyncedObject(cx: SqlExecutor, userId: string, objectId: string) {
  const [[object]] = await cx.execute<RowDataPacket[]>(
    `SELECT o.href, o.uid, o.ics, o.calendar_id, c.name, c.external_id, c.account_id FROM calendar_remote_objects o
     JOIN calendar_calendars c ON c.id = o.calendar_id AND c.user_id = o.user_id WHERE o.id = ? AND o.user_id = ?`, [objectId, userId]);
  if (!object) return null;
  const [rows] = await cx.execute<RowDataPacket[]>(
    `SELECT e.*, COALESCE(r.recurrence_id, '') AS link_recurrence_id FROM calendar_event_external_refs r
     JOIN calendar_events e ON e.id = r.event_id AND e.user_id = r.user_id WHERE r.remote_object_id = ? AND r.user_id = ?
     ORDER BY COALESCE(r.recurrence_id, '') = '' DESC, e.start_time, e.id FOR UPDATE`, [objectId, userId]);
  if (!rows.length) return null;
  const occurrences = [];
  for (const row of rows) {
    const state = await overlayStateOf(cx, userId, String(row.id));
    if (state) occurrences.push({ recurrence_id: String(row.link_recurrence_id), state });
  }
  const { link_recurrence_id: _link, ...master } = rows[0];
  void _link;
  const [subtasks] = await cx.execute<RowDataPacket[]>('SELECT * FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ? ORDER BY position, created_at, id', [master.id, userId]);
  const [attendees] = await cx.execute<RowDataPacket[]>('SELECT * FROM calendar_event_attendees WHERE event_id = ? AND user_id = ? ORDER BY created_at, id', [master.id, userId]);
  const [ranks] = object.uid ? await cx.execute<RowDataPacket[]>(`SELECT * FROM task_order WHERE user_id = ? AND calendar_id = ? AND remote_uid = ? ${UID_EXACT}`,
    [userId, object.calendar_id, object.uid]) : [[] as RowDataPacket[]];
  const payload: SyncedPayload = {
    provider: 'caldav', origin: object.name ?? null,
    calendar: { id: object.calendar_id, account_id: object.account_id, external_id: object.external_id ?? null, name: object.name ?? null },
    object: { href: object.href, uid: object.uid || null, ics: object.ics }, occurrences,
    event: toStored(master as RowDataPacket), subtasks: subtasks.map(toStored), attendees: attendees.map(toStored), task_order: ranks.map(toStored),
  };
  const [id] = await putInBin(cx, userId, [{ module: 'calendar', itemType: itemTypeOf(payload.event), itemId: String(master.id), title: String(master.title ?? ''), reason: 'deleted', payload }]);
  return id;
}

// How long a delete of a synced item waits for a sync of its account.
const DELETE_SYNC_WAIT_SECONDS = 20;
type Refusal = ReturnType<typeof calendarSync.calendarErrorResponse>;
const syncBusy = (): Refusal => ({ error: 'This calendar is being synced right now. Try again in a moment.', status: 409, code: 'CALENDAR_SYNC_BUSY' });

/**
 * DELETE /api/calendar/events/:id, under the item's lock (routes/calendar.ts).
 * A synced item is deleted at its server first; a refusal there changes
 * nothing and is answered as the route's response. Otherwise the bin item's
 * id, or null when nothing was binned (one date of a repeating server event,
 * an item already gone).
 *
 * A synced delete holds its account's sync lock from before the server is
 * written until the bin item is committed: a sync running meanwhile would
 * see the item gone at the server and remove its rows before the bin took
 * them. Deleting one date of a repeating server event removes it at the
 * server for good, so bin.delete must allow it (F13), checked before.
 */
async function deleteEventToBin(userId: string, event: CalendarEvent, scope: 'series' | 'occurrence'): Promise<{ binned: string | null } | { refused: Refusal }> {
  const write = await calendarSync.describeEventWrite(userId, event);
  if (!write.remote) return { binned: await binLocally(userId, event.id) };
  if (write.link && write.recurring && write.link.recurrenceId && scope !== 'series') {
    const { assertAllowed } = require('./settings') as typeof import('./settings');
    await assertAllowed(userId, ['bin.delete']);
  }
  const outcome = await calendarSync.withAccountLock(write.ctx.account.id, async (): Promise<{ binned: string | null } | { refused: Refusal; conflict?: boolean }> => {
    // Set by the transaction that removes the rows, again on each of its
    // retries (a deadlock victim runs it again): only the attempt that
    // commits counts.
    let binned: string | null = null;
    let pushed: Awaited<ReturnType<typeof calendarSync.pushEventDelete>>;
    try {
      pushed = await calendarSync.pushEventDelete({
        userId, event, scope,
        beforeRemove: async (connection, objectIds) => { binned = objectIds[0] ? await binSyncedObject(connection, userId, objectIds[0]) : null; },
      });
    } catch (error) {
      return { refused: calendarSync.calendarErrorResponse(error, 'Could not delete the event on the calendar server'), conflict: (error as { code?: string })?.code === 'CALDAV_CONFLICT' };
    }
    if (pushed && 'scope' in pushed) {
      // One date removed from the series at the server: the row goes as before.
      if (pushed.scope === 'occurrence') await fencedWrite(connection => connection.execute('DELETE FROM calendar_events WHERE id = ? AND user_id = ?', [event.id, userId]));
      return { binned };
    }
    // Not linked to a server copy: UniHub's own row.
    return { binned: await binLocally(userId, event.id) };
  }, DELETE_SYNC_WAIT_SECONDS);
  if ('skipped' in outcome) return { refused: syncBusy() };
  // The refresh a conflict asks for could not run while the lock was held.
  if ('refused' in outcome && outcome.conflict) calendarSync.syncCalendarAccountInBackground(write.ctx.account.id, { userId, reason: 'conflict' });
  return 'refused' in outcome ? { refused: outcome.refused } : outcome;
}

async function binLocally(userId: string, eventId: string) {
  const [id] = await fencedWrite(connection => binLocalEvents(connection, userId, [eventId]));
  return id ?? null;
}

/** DELETE /api/calendar/calendars/:id for a UniHub calendar, after the route's checks: the calendar and its events into the bin as one group. */
async function deleteCalendarToBin(userId: string, calendarId: string) {
  return withTransaction(async cx => {
    const [[calendar]] = await cx.execute<RowDataPacket[]>('SELECT * FROM calendar_calendars WHERE id = ? AND user_id = ? FOR UPDATE', [calendarId, userId]);
    if (!calendar) throw notFound('CALENDAR_NOT_FOUND', 'Calendar not found');
    const { getSettings } = require('./settings') as typeof import('./settings');
    const resolved = Object.entries(await getSettings('calendar', userId, calendarId, cx)) as [string, { value: unknown; source: string }][];
    const settings = Object.fromEntries(resolved.filter(([, setting]) => setting.source === 'user').map(([key, setting]) => [key, setting.value]));
    const groupId = crypto.randomUUID();
    const payload: CalendarPayload = { provider: 'local', origin: null, calendar: toStored(calendar), settings };
    const binItemIds = await putInBin(cx, userId, [{ module: 'calendar', itemType: 'calendar', itemId: calendarId, title: String(calendar.name ?? ''), reason: 'deleted', groupId, payload }]);
    const [events] = await cx.execute<RowDataPacket[]>('SELECT id FROM calendar_events WHERE calendar_id = ? AND user_id = ? ORDER BY start_time, id FOR UPDATE', [calendarId, userId]);
    binItemIds.push(...await binLocalEvents(cx, userId, events.map(row => String(row.id)), { reason: 'calendar_deleted', groupId }));
    await cx.execute('DELETE FROM calendar_calendars WHERE id = ? AND user_id = ?', [calendarId, userId]);
    return { deletedEvents: events.length, binItemIds };
  });
}

// --- Out of the bin -------------------------------------------------------------

async function lockItems(cx: SqlExecutor, userId: string, rows: readonly BinRow[]) {
  const ids = rows.map(row => row.id);
  const [locked] = await cx.execute<BinRow[]>(`SELECT * FROM bin_items WHERE user_id = ? AND restored_at IS NULL AND id IN (${placeholders(ids)}) ORDER BY deleted_at, id FOR UPDATE`, [userId, ...ids]);
  return locked;
}
const dropItems = (cx: SqlExecutor, userId: string, ids: readonly string[]) => ids.length
  ? cx.execute(`DELETE FROM bin_items WHERE user_id = ? AND id IN (${placeholders(ids)})`, [userId, ...ids]) : null;

/** The UniHub list an event goes back to: its own when it is still there and writable, else the default list. */
async function localTarget(cx: SqlExecutor, userId: string, calendarId: unknown) {
  if (typeof calendarId === 'string' && ID_PATTERN.test(calendarId)) {
    const [[own]] = await cx.execute<RowDataPacket[]>(
      `SELECT c.id FROM calendar_calendars c JOIN calendar_accounts a ON a.id = c.account_id AND a.user_id = c.user_id
       WHERE c.id = ? AND c.user_id = ? AND a.provider = 'local' AND NOT COALESCE(c.read_only, 0)`, [calendarId, userId]);
    if (own) return { id: String(own.id), note: null };
  }
  return { id: (await resolveCalendarDefaults(userId, cx)).taskListId, note: GONE_NOTE };
}

/** Writes an event from its snapshot into an owned UniHub list; its id and identity stay unless taken. Returns the row's id. */
async function restoreLocalEvent(cx: SqlExecutor, userId: string, payload: Pick<LocalPayload, 'event' | 'subtasks' | 'attendees' | 'task_order'>, calendarId: string) {
  const event = payload.event || {};
  const [[idTaken]] = ID_PATTERN.test(String(event.id)) ? await cx.execute<RowDataPacket[]>('SELECT id FROM calendar_events WHERE id = ?', [String(event.id)]) : [[{ id: '' }]];
  const id = idTaken ? crypto.randomUUID() : String(event.id);
  const own = typeof event.uid === 'string' && event.uid && event.uid.length <= 500 ? event.uid : id;
  const [[uidTaken]] = await cx.execute<RowDataPacket[]>(`SELECT id FROM calendar_events WHERE user_id = ? AND uid = ? ${UID_EXACT} LIMIT 1`, [userId, own]);
  let emailId = typeof event.source_email_id === 'string' && ID_PATTERN.test(event.source_email_id) ? event.source_email_id : null;
  if (emailId) {
    const [owned] = await cx.execute<RowDataPacket[]>('SELECT id FROM emails WHERE id = ? AND user_id = ? LIMIT 1', [emailId, userId]);
    if (!owned.length) emailId = null;
  }
  const [[calendar]] = await cx.execute<RowDataPacket[]>('SELECT color FROM calendar_calendars WHERE id = ? AND user_id = ?', [calendarId, userId]);
  await insertRows(cx, 'calendar_events', EVENT_COLUMNS, [{
    ...event, id, user_id: userId, calendar_id: calendarId, uid: uidTaken ? id : own, source_email_id: emailId,
    color: calendar?.color ?? event.color ?? '#2563eb', title: String(event.title ?? '').slice(0, 255) || 'Untitled',
    start_time: event.start_time ?? new Date().toISOString(), end_time: event.end_time ?? event.start_time ?? new Date().toISOString(),
  }]);
  await insertRows(cx, 'calendar_event_subtasks', SUBTASK_COLUMNS, await freeIds(cx, 'calendar_event_subtasks', (payload.subtasks || []).map(row => ({ ...row, event_id: id, user_id: userId }))));
  await insertRows(cx, 'calendar_event_attendees', ATTENDEE_COLUMNS, await freeIds(cx, 'calendar_event_attendees', (payload.attendees || []).map(row => ({ ...row, event_id: id, user_id: userId }))));
  // Its hand place, now keyed as a UniHub task.
  const rank = (payload.task_order || []).find(row => Number.isSafeInteger(Number(row.sort_rank)));
  if (rank) {
    await cx.execute(`INSERT IGNORE INTO task_order (user_id, item_key, calendar_id, event_id, remote_uid, recurrence_id, sort_rank) VALUES (?, ?, NULL, ?, NULL, '', ?)`,
      [userId, itemKey({ event_id: id }), id, Number(rank.sort_rank)]);
  }
  return id;
}

/** A local calendar from its snapshot, under its own id and identity unless taken, in the person's UniHub account. */
async function restoreCalendar(cx: SqlExecutor, userId: string, payload: CalendarPayload) {
  const calendar = payload.calendar || {};
  const [[idTaken]] = ID_PATTERN.test(String(calendar.id)) ? await cx.execute<RowDataPacket[]>('SELECT id FROM calendar_calendars WHERE id = ?', [String(calendar.id)]) : [[{ id: '' }]];
  const id = idTaken ? crypto.randomUUID() : String(calendar.id);
  const [[account]] = await cx.execute<RowDataPacket[]>("SELECT id FROM calendar_accounts WHERE id = ? AND user_id = ? AND provider = 'local'", [String(calendar.account_id ?? ''), userId]);
  const accountId = account ? String(account.id) : (await ensureDefaultLocalCalendarForUser(userId, cx)).accountId;
  const own = typeof calendar.uid === 'string' && ID_PATTERN.test(calendar.uid) ? calendar.uid : id;
  const [[uidTaken]] = await cx.execute<RowDataPacket[]>('SELECT id FROM calendar_calendars WHERE user_id = ? AND uid = ? LIMIT 1', [userId, own]);
  await insertRows(cx, 'calendar_calendars', CALENDAR_COLUMNS, [{
    ...calendar, id, user_id: userId, account_id: accountId, uid: uidTaken ? id : own, is_primary: 0, read_only: 0, name: String(calendar.name ?? '').slice(0, 255) || 'Restored list',
  }]);
  // Its own settings back, each as the registry checks it; one the
  // registry or a policy no longer takes stays at its default.
  const { updateSettings } = require('./settings') as typeof import('./settings');
  const settings = payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings) ? payload.settings : {};
  for (const [key, value] of Object.entries(settings)) {
    await updateSettings('calendar', userId, id, { values: { [key]: value } }, cx).catch(error => {
      if (!(error instanceof ApiError && error.expose)) throw error;
    });
  }
  return id;
}

const restoredOf = (row: BinRow, itemId: string, note: string | null, extra: Partial<BinRestored> = {}): BinRestored => ({ id: row.id, item_type: row.item_type, item_id: itemId, note, ...extra });

async function restoreGroupWithCalendar(userId: string, group: readonly BinRow[]) {
  const restored = await withTransaction(async cx => {
    await lockBinOwner(cx, userId);
    const refusal = await calendarAdmission(userId, cx);
    if (refusal) throw refusal;
    const locked = await lockItems(cx, userId, group);
    const calendarRow = locked.find(row => row.item_type === 'calendar');
    if (!calendarRow) throw conflict('BIN_ITEM_CHANGED', 'These items changed in the meantime. Try again.');
    const calendarId = await restoreCalendar(cx, userId, parsePayload<CalendarPayload>(calendarRow)!);
    const answers = [restoredOf(calendarRow, calendarId, null)];
    for (const row of locked.filter(item => item !== calendarRow)) {
      const payload = parsePayload<LocalPayload>(row);
      if (!payload?.event) continue;
      answers.push(restoredOf(row, await restoreLocalEvent(cx, userId, payload, calendarId), null));
    }
    await dropItems(cx, userId, locked.map(row => row.id));
    return answers;
  });
  publishCalendarChanged(userId, null, 'local');
  return restored;
}

const listGone = () => conflict('BIN_RESTORE_CALENDAR_NOT_FOUND', 'That calendar was not found. Choose one of your calendars.');

/**
 * A calendar the person chose to restore to: their own, and one an item can
 * be written to (a UniHub list, or a writable calendar of a server account).
 */
async function chosenCalendar(userId: string, calendarId: string) {
  const [[row]] = await db.execute<RowDataPacket[]>(
    `SELECT c.id, COALESCE(c.read_only, 0) AS read_only, a.provider FROM calendar_calendars c
     JOIN calendar_accounts a ON a.id = c.account_id AND a.user_id = c.user_id WHERE c.id = ? AND c.user_id = ?`, [calendarId, userId]);
  if (!row) throw listGone();
  if (row.provider !== 'local' && row.provider !== 'caldav') throw conflict('CALENDAR_READ_ONLY', 'That calendar is a subscription, which cannot take items. Choose another one.');
  if (Number(row.read_only)) throw conflict('CALENDAR_READ_ONLY', 'That calendar is read-only. Choose one that can take the item.');
  return { id: String(row.id), local: row.provider === 'local' };
}

/** A UniHub item, or a synced one a list can hold, into its own list, the chosen one, or the default list. */
async function restoreLocalItem(userId: string, row: BinRow, note?: string | null, chosenList?: string) {
  const answer = await withTransaction(async cx => {
    await lockBinOwner(cx, userId);
    const refusal = await calendarAdmission(userId, cx);
    if (refusal) throw refusal;
    // A synced item whose re-creation at a server began meanwhile goes there, not here.
    if (await restoreJournal(cx, userId, row.id, { lock: true })) throw restorePending();
    const [locked] = await lockItems(cx, userId, [row]);
    if (!locked) throw notFound('BIN_ITEM_NOT_FOUND', 'Not in the bin');
    const payload = parsePayload<LocalPayload>(locked);
    if (!payload?.event) throw conflict('BIN_ITEM_UNREADABLE', 'This item cannot be restored.');
    const target = await localTarget(cx, userId, chosenList ?? (payload.provider === 'local' ? payload.event.calendar_id : null));
    if (chosenList && target.id !== chosenList) throw listGone();
    const id = await restoreLocalEvent(cx, userId, payload, target.id);
    await dropItems(cx, userId, [locked.id]);
    return restoredOf(locked, id, note ?? target.note);
  });
  publishCalendarChanged(userId, null, 'local');
  return answer;
}

// Where the new copy goes: its old address when that is still in the
// calendar's collection, else one named after its UID.
function copyHref(target: SyncTarget, href: string, uid: string) {
  const collection = calendarSync.calendarUrl(target.account, target.calendar);
  const base = collection.endsWith('/') ? collection : `${collection}/`;
  try { if (href && calendarSync.objectUrl(target.account, { href }).startsWith(base)) return href; } catch { /* a new address below */ }
  return caldav.canonicalHref(new URL(`${encodeURIComponent(uid)}.ics`, base).toString());
}

async function restoreRemoteRanks(cx: SqlExecutor, userId: string, ranks: readonly Stored[], calendarId: string, uid: string) {
  for (const rank of ranks || []) {
    if (!Number.isSafeInteger(Number(rank.sort_rank))) continue;
    const recurrenceId = String(rank.recurrence_id ?? '').slice(0, 64);
    await cx.execute('INSERT IGNORE INTO task_order (user_id, item_key, calendar_id, event_id, remote_uid, recurrence_id, sort_rank) VALUES (?, ?, ?, NULL, ?, ?, ?)',
      [userId, itemKey({ calendar_id: calendarId, remote_uid: uid, recurrence_id: recurrenceId }), calendarId, uid, recurrenceId, Number(rank.sort_rank)]);
  }
}

async function addOverlays(cx: SqlExecutor, userId: string, payload: SyncedPayload, calendarId: string, uid: string) {
  await insertOverlays(cx, (payload.occurrences || []).map(occurrence => ({ userId, calendarId, uid, recurrenceId: occurrence.recurrence_id, state: occurrence.state })));
}

async function restoredEventId(userId: string, calendarId: string, uid: string) {
  const [[row]] = await db.execute<RowDataPacket[]>(`SELECT id FROM calendar_events WHERE user_id = ? AND calendar_id = ? AND uid = ? ${UID_EXACT} ORDER BY start_time, id LIMIT 1`,
    [userId, calendarId, uid]);
  return row ? String(row.id) : null;
}

function serverRefusal(error: unknown): never {
  if (error instanceof ApiError && error.expose) throw error;
  const answer = calendarSync.calendarErrorResponse(error, 'The calendar server did not take the item back');
  const status = answer.status ?? 409;
  throw new ApiError(status >= 500 ? 409 : status, answer.code || 'BIN_RESTORE_FAILED', `${answer.error} It stays in the bin.`);
}

// What a UniHub list would lose of a synced repeating event: it holds one
// row with a rule, so a date of its own (an exception, an added or removed
// date), a rule longer than the list keeps, or the state of a date (done,
// subtasks, source email) would be lost or apply to every date. Null when
// the copy loses nothing.
function localCopyLoses(payload: SyncedPayload) {
  const ics = String(payload.object?.ics || '').replace(/\r?\n[ \t]/g, '');
  const rule = /^RRULE[:;](.*)$/im.exec(ics)?.[1] ?? null;
  if (!rule && !/^(RDATE|RECURRENCE-ID)[:;]/im.test(ics)) return null;
  if (/^(RECURRENCE-ID|RDATE|EXDATE)[:;]/im.test(ics)) return 'dates changed on their own';
  if (rule && rule.replace(/^[^:]*:/, '').length > 100) return 'a long rule';
  if ((payload.occurrences || []).length) return 'details kept for single dates';
  return null;
}

/**
 * A synced item back to its calendar server: to its own calendar, or to the
 * calendar the person chose (another server calendar re-creates it there
 * under its UID; a UniHub list takes it when a list can hold it).
 */
async function restoreSyncedItem(userId: string, row: BinRow, choice: RestoreChoice = {}): Promise<BinRestored> {
  const payload = parsePayload<SyncedPayload>(row);
  if (!payload?.event) throw conflict('BIN_ITEM_UNREADABLE', 'This item cannot be restored.');
  const uid = payload.object?.uid;
  // An earlier attempt the server may have taken (its answer was lost) pins
  // the item to that calendar until the outcome is known: the retry finishes
  // it there, and no other destination is tried, else the server's copy
  // would show beside a second one. A journal whose calendar is gone ends.
  let pinned = await restoreJournal(db, userId, row.id);
  if (pinned && !pinned.calendarId) {
    await calendarMove.runBinRestore(pinned.id).catch(() => undefined);
    pinned = await restoreJournal(db, userId, row.id);
  }
  if (pinned) {
    if (choice.calendarId && choice.calendarId !== pinned.calendarId) throw restorePending();
    return finishJournal(userId, row, pinned.id, String(pinned.calendarId), String(uid ?? ''));
  }
  const chosen = choice.calendarId ? await chosenCalendar(userId, choice.calendarId) : null;
  if (chosen?.local) {
    const lost = localCopyLoses(payload);
    if (lost) throw conflict('BIN_RESTORE_NEEDS_CALENDAR', `A UniHub list cannot hold this repeating event as it was (${lost}). Choose a calendar on a server to restore it to.`);
    return restoreLocalItem(userId, row, null, chosen.id);
  }
  const calendarOf = chosen?.id ?? payload.calendar?.id;
  const target = calendarOf ? await calendarSync.loadCalendarContext(userId, calendarOf) : null;
  if (chosen && !target) throw listGone();
  const writable = !!target && target.account.provider === 'caldav' && !target.calendar.read_only;
  if (!target || !writable || !uid || !payload.object?.ics) {
    const lost = localCopyLoses(payload);
    if (lost) throw conflict('BIN_RESTORE_NEEDS_CALENDAR', `${!target || !uid ? 'Its calendar is gone' : 'Its calendar is read-only now'}, and a UniHub list cannot hold this repeating event as it was (${lost}). It stays in the bin: choose another calendar on a server to restore it to.`);
    return restoreLocalItem(userId, row, !target || !uid ? 'Its calendar is gone; restored to your default list.' : 'Its calendar is read-only now; restored to your default list.');
  }
  if (!target.account.is_active) throw conflict('CALENDAR_SYNC_PAUSED', 'Sync is paused for this calendar account. Resume it to restore this item to its calendar.');
  // The login before anything is written, so a missing password changes nothing.
  await calendarSync.resolveLogin(target.account).catch(serverRefusal);
  const calendarId = target.calendar.id;
  const plan = await withTransaction(async cx => {
    await lockBinOwner(cx, userId);
    // The login was a wait: the gates again, under the person's lock.
    const refusal = await calendarAdmission(userId, cx);
    if (refusal) throw refusal;
    const [[account]] = await cx.execute<RowDataPacket[]>('SELECT is_active FROM calendar_accounts WHERE id = ? AND user_id = ?', [target.account.id, userId]);
    if (!account) throw listGone();
    if (!Number(account.is_active)) throw conflict('CALENDAR_SYNC_PAUSED', 'Sync is paused for this calendar account. Resume it to restore this item to its calendar.');
    const journal = await restoreJournal(cx, userId, row.id, { lock: true });
    const [locked] = await lockItems(cx, userId, [row]);
    if (!locked) throw notFound('BIN_ITEM_NOT_FOUND', 'Not in the bin');
    // The item as it is now, not as read before the login: a Gmail merge
    // may have pointed its source emails at the kept copy meanwhile
    // (bin.ts redirectBinEmails). Where it is created stays as decided.
    const current = parsePayload<SyncedPayload>(locked);
    if (!current?.event || current.object?.uid !== uid || current.object?.href !== payload.object.href || current.object?.ics !== payload.object.ics
      || (current.calendar?.id ?? null) !== (payload.calendar?.id ?? null)) throw conflict('BIN_ITEM_CHANGED', 'This item changed in the meantime. Try again.');
    // Another request journalled it meanwhile: it goes where that one sends it.
    if (journal) {
      if (journal.calendarId !== calendarId && choice.calendarId) throw restorePending();
      return { moveId: journal.id, calendarId: String(journal.calendarId ?? calendarId) };
    }
    const [held] = await cx.execute<RowDataPacket[]>(`SELECT id FROM calendar_remote_objects WHERE calendar_id = ? AND user_id = ? AND uid = ? ${UID_EXACT} LIMIT 1`, [calendarId, userId, uid]);
    if (held.length) {
      // Back on the server already (another app, an earlier attempt): it gets UniHub's own details.
      await addOverlays(cx, userId, current, calendarId, uid);
      await applyOverlaysToLiveRows(cx, userId, { calendarIds: [calendarId], uid });
      await restoreRemoteRanks(cx, userId, current.task_order, calendarId, uid);
      await dropItems(cx, userId, [row.id]);
      return { adopted: true };
    }
    return { moveId: await calendarMove.journalBinRestore(cx, userId, row.id, { calendarId, uid, href: copyHref(target, current.object.href, uid), ics: current.object.ics }), calendarId };
  });
  if ('adopted' in plan) {
    publishCalendarChanged(userId, target.account.id, 'local');
    return restoredOf(row, await restoredEventId(userId, calendarId, uid) ?? row.item_id, 'It was on its calendar again already; UniHub\'s own details were added to it.');
  }
  return finishJournal(userId, row, plan.moveId, plan.calendarId, uid);
}

/** A restore journal of this bin item: the re-creation at a server an attempt began. */
async function restoreJournal(executor: SqlExecutor, userId: string, binItemId: string, { lock = false } = {}) {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT id, target_calendar_id FROM calendar_event_moves WHERE bin_item_id = ? AND user_id = ?${lock ? ' FOR UPDATE' : ''}`, [binItemId, userId]);
  return rows[0] ? { id: String(rows[0].id), calendarId: rows[0].target_calendar_id ? String(rows[0].target_calendar_id) : null } : null;
}

const restorePending = () => conflict('BIN_RESTORE_PENDING', 'This item is being created on a calendar server already, which has not confirmed it yet, so it cannot go to another calendar. Restore it again without choosing a calendar to finish it there.');

/** Runs a restore journal now and answers as the restore. */
async function finishJournal(userId: string, row: BinRow, moveId: string, calendarId: string, uid: string) {
  const state = await calendarMove.runBinRestore(moveId).catch(serverRefusal);
  if (state === 'pending') {
    // Held back by a gate (module off, a calendar restore): it says so; the journal waits.
    const refusal = await calendarAdmission(userId);
    if (refusal) throw refusal;
    return restoredOf(row, row.id, 'Being created on its calendar server again; it shows there once the server confirms.', { pending: true });
  }
  const [[still]] = await db.execute<RowDataPacket[]>('SELECT id FROM bin_items WHERE id = ?', [row.id]);
  // Nothing was sent: the server is not to blame. (A sync that adopted the copy meanwhile took the item out of the bin.)
  if (state === 'ended' && still) throw conflict('RESTORE_IN_PROGRESS', 'A calendar restore ended this attempt before anything was sent. The item stays in the bin; restore it again once the restore has finished.');
  if (still) throw conflict('BIN_RESTORE_FAILED', 'The calendar could not take the item back, so it stays in the bin.');
  return restoredOf(row, await restoredEventId(userId, calendarId, uid) ?? row.item_id, null);
}

/**
 * The commit of a restore journalled by restoreSyncedItem, inside the move
 * journal's transaction (calendar-move.ts commitMove), from a request, the
 * sync pass or the sync that found the copy first: the copy stored, its rows
 * made with their state and hand ranks, the bin item gone. False when the
 * item left the bin meanwhile (deleted for good); the copy then shows with
 * the next sync as an item of its own.
 */
async function finishServerRestore(connection: SqlExecutor, userId: string, binItemId: string, copy: Copy) {
  await lockBinOwner(connection, userId);
  const [[item]] = await connection.execute<BinRow[]>('SELECT * FROM bin_items WHERE id = ? AND user_id = ? AND restored_at IS NULL FOR UPDATE', [binItemId, userId]);
  if (!item) return false;
  const payload = parsePayload<SyncedPayload>(item);
  const uid = payload?.object?.uid;
  if (!payload || !uid) return false;
  await addOverlays(connection, userId, payload, copy.calendar.id, uid);
  const object = await calendarSync.storeObject(connection, copy.account, copy.calendar, copy.object);
  await calendarSync.applyRestoredObject(connection as PoolConnection, copy.account, copy.calendar, object, copy.timeZone);
  // Rows a sync had made already take their state as well.
  await applyOverlaysToLiveRows(connection, userId, { calendarIds: [copy.calendar.id], uid });
  await restoreRemoteRanks(connection, userId, payload.task_order, copy.calendar.id, uid);
  await dropItems(connection, userId, [binItemId]);
  return true;
}

const eventBinKind: BinKind = {
  async restore(userId, group, choice) {
    if (group.some(row => row.item_type === 'calendar')) return restoreGroupWithCalendar(userId, group);
    const answers: BinRestored[] = [];
    for (const row of group) {
      const provider = parsePayload<{ provider?: string }>(row)?.provider;
      if (provider === 'caldav') { answers.push(await restoreSyncedItem(userId, row, choice)); continue; }
      // A UniHub item goes to a UniHub list only.
      const chosen = choice.calendarId ? await chosenCalendar(userId, choice.calendarId) : null;
      if (chosen && !chosen.local) throw conflict('BIN_RESTORE_NEEDS_LIST', 'This item is from a UniHub list. Choose one of your UniHub lists to restore it to.');
      answers.push(await restoreLocalItem(userId, row, undefined, chosen?.id));
    }
    return answers;
  },
};

export { binLocalEvents, deleteEventToBin, deleteCalendarToBin, finishServerRestore, eventBinKind };
