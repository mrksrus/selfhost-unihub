import type { ExecuteValues, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { RouteRequest, ApiError, StoredFlag } from '../types';
import type { CalendarAccount, CalendarCalendar, CalendarEvent, CalendarAttendee, CalendarSubtask } from '../types/calendar';
import crypto from 'crypto';
import { db } from '../state';
import { clientError, conflict, forbidden, notFound } from '../http/errors';
import { withTransaction } from '../services/transactions';
import { sourceEmailPresentSql, snapshotSourceEmail, sourceEmailLinkRefusal } from '../services/email-tasks';
import {
  CALENDAR_MULTI_ENABLED,
} from '../config';

type Request = RouteRequest & { url: string; params: Record<string, string> };
interface Input extends Record<string, unknown> {
  provider?: string;
  password?: unknown;
  username?: unknown;
  account_email?: string;
  display_name?: string;
  url?: unknown;
  time_zone?: unknown;
  is_active?: unknown;
  default_calendar_name?: string;
  default_calendar_color?: string;
  account_id?: string;
  name?: string;
  external_id?: string;
  color?: string;
  is_visible?: unknown;
  auto_todo_enabled?: unknown;
  is_primary?: unknown;
  title?: string;
  description?: string;
  start_time?: string | null;
  end_time?: string | null;
  all_day?: unknown;
  location?: string;
  recurrence?: string;
  reminder_minutes?: number | null;
  reminders?: unknown;
  is_todo_only?: unknown;
  calendar_id?: string | null;
  attendees?: unknown;
  todo_status?: string;
  response_status?: unknown;
  email?: unknown;
  position?: number;
  subtask_ids?: unknown;
  is_done?: unknown;
}
type AccountRow = RowDataPacket & CalendarAccount;
type CalendarRecordRow = RowDataPacket & CalendarCalendar;
type EventRow = RowDataPacket & CalendarEvent;
type SubtaskRow = RowDataPacket & CalendarSubtask;
type CountRow = RowDataPacket & { count: number };
type PushResult = Record<string, unknown> & { error?: string; status?: number; scope?: string; pending?: 'creating' | 'removing'; sourceKept?: boolean };

const {
  CALENDAR_PROVIDER_DEFAULT_CAPABILITIES,
  normalizeCalendarAccountProvider,
  toMysqlDatetime,
  serializeCalendarAccount,
  getCalendarAccountIdFromReq,
  getCalendarCalendarIdFromReq,
  serializeCalendarCalendar,
  ensureDefaultLocalCalendarForUser,
  formatProviderDateRange,
  presentEvents,
  seriesKeySql,
  parseDatetimeToMillis,
  replaceEventAttendees,
  applyLocalEventUpdate,
  getCalendarEventWithSubtasks,
  getCalendarSubtasksForEvents,
  getCalendarEventIdFromReq,
  normalizeResponseStatus,
  loadCalendarWithAccount,
  getCalendarSubtaskIdFromReq,
  serializeCalendarSubtask,
  MAIL_CONNECTED_SQL,
  resolveCalendarDefaults,
  calendarWriteBlock,
  takesUndatedTasks,
} = require('../services/calendar') as typeof import('../services/calendar');
const taskOrder = require('../services/task-order') as typeof import('../services/task-order');
const { movePending, eventChanged, writebackIdentity, withEventLock, fenceTaskLocks, fencedWrite } = require('../services/calendar-move-state') as typeof import('../services/calendar-move-state');
const calendarSync = require('../services/calendar-sync') as typeof import('../services/calendar-sync');
const calendarMove = require('../services/calendar-move') as typeof import('../services/calendar-move');
const binCalendar = require('../services/bin-calendar') as typeof import('../services/bin-calendar');
const calendarAccounts = require('../services/calendar-accounts') as typeof import('../services/calendar-accounts');
const calendarAccountChanges = require('../services/calendar-account-changes') as typeof import('../services/calendar-account-changes');
const calendarShares = require('../services/calendar-shares') as typeof import('../services/calendar-shares');
const calendarSeries = require('../services/calendar-series') as typeof import('../services/calendar-series');

const has = (body: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(body, key);

/** An event the caller may read: their own, or one of a calendar they reach (free/busy redacted); a date of a local series with its rule. */
const readEvent = async (userId: string, id: string) => calendarSeries.withSeriesDetail(await getCalendarEventWithSubtasks(userId, id) ?? await calendarShares.reachedEvent(userId, id));
const pointRefused = () => clientError(forbidden('CALENDAR_FORBIDDEN', 'You can change only the points you added.'), 'Failed to update subtask');
const remindersOf = (body: Input) => Array.isArray(body.reminders) ? body.reminders : body.reminder_minutes == null ? [] : [body.reminder_minutes];

// The fields of an event change, checked; the reminders only when they are the event's (not the person's own).
function eventFieldUpdates(body: Input, current: CalendarEvent, { remote, reminders }: { remote: boolean; reminders: boolean }) {
  const updates: string[] = [];
  const params: ExecuteValues[] = [];
  if (has(body, 'title')) {
    if (!body.title?.trim()) return { error: 'Title is required', status: 400 };
    updates.push('title = ?');
    params.push(body.title.trim());
  }
  if (has(body, 'description')) {
    updates.push('description = ?');
    params.push(body.description || null);
  }

  const startProvided = has(body, 'start_time');
  const endProvided = has(body, 'end_time');
  const resolvedStart = startProvided ? toMysqlDatetime(body.start_time) : toMysqlDatetime(current.start_time);
  const resolvedEnd = endProvided ? toMysqlDatetime(body.end_time) : toMysqlDatetime(current.end_time);
  if (startProvided && !resolvedStart) return { error: 'Valid start time is required', status: 400 };
  if (endProvided && !resolvedEnd) return { error: 'Valid end time is required', status: 400 };
  if (!resolvedStart || !resolvedEnd) return { error: 'Valid start and end time are required', status: 400 };
  if (parseDatetimeToMillis(resolvedEnd)! < parseDatetimeToMillis(resolvedStart)!) {
    return { error: 'End time must be after start time', status: 400 };
  }
  if (startProvided) {
    updates.push('start_time = ?');
    params.push(resolvedStart);
  }
  if (endProvided) {
    updates.push('end_time = ?');
    params.push(resolvedEnd);
  }

  if (has(body, 'all_day')) {
    updates.push('all_day = ?');
    params.push(!!body.all_day);
  }
  if (has(body, 'location')) {
    updates.push('location = ?');
    params.push(body.location?.trim() || null);
  }
  if (has(body, 'color')) {
    updates.push('color = ?');
    params.push(body.color || '#2563eb');
  }
  if (has(body, 'recurrence') && !remote) {
    updates.push('recurrence = ?');
    params.push(body.recurrence || null);
  }
  if (has(body, 'reminders') && body.reminders !== null && body.reminders !== undefined && !Array.isArray(body.reminders)) {
    return { error: 'Reminders must be an array or null', status: 400 };
  }
  if (reminders && has(body, 'reminder_minutes')) {
    updates.push('reminder_minutes = ?');
    params.push(body.reminder_minutes ?? null);
  }
  if (reminders && has(body, 'reminders')) {
    updates.push('reminders = ?');
    params.push(body.reminders ? JSON.stringify(body.reminders) : null);
  }
  if (has(body, 'is_todo_only')) {
    updates.push('is_todo_only = ?');
    params.push(!!body.is_todo_only);
  }
  const dateChanged = (startProvided && resolvedStart !== toMysqlDatetime(current.start_time))
    || (has(body, 'is_todo_only') && !!body.is_todo_only !== !!current.is_todo_only);
  return { updates, params, resolvedStart, resolvedEnd, dateChanged };
}

/**
 * PUT /api/calendar/events/:id of an event in a calendar another person or
 * nobody owns: UniHub's rows only, under the calendar's guard. Every field
 * needs edit; the caller's own reminders need read. An event moves only to
 * another calendar of the same owner.
 */
async function updateReachedEvent(userId: string, target: { event: CalendarEvent; ownerId: string | null }, body: Input) {
  const { event, ownerId } = target;
  if (has(body, 'source_email_id')) return { error: 'A task keeps its email link in your own lists only.', status: 400 };
  const fields = eventFieldUpdates(body, event, { remote: false, reminders: false });
  if ('error' in fields) return fields;
  const { updates, params } = fields;
  const moveTo = has(body, 'calendar_id') && body.calendar_id !== event.calendar_id ? body.calendar_id || null : null;
  if (has(body, 'calendar_id') && !body.calendar_id) return { error: 'Choose a calendar for this event.', status: 400 };
  const changes = updates.length > 0 || Array.isArray(body.attendees) || !!moveTo;
  const ownReminders = has(body, 'reminders') || has(body, 'reminder_minutes');
  await withTransaction(async cx => {
    if (!await calendarShares.lockEventWrite(cx, userId, event.id, ownerId, changes ? 'edit' : 'read', event.calendar_id ?? null)) throw notFound('CALENDAR_EVENT_NOT_FOUND', 'Event not found');
    if (moveTo) {
      // Another owner's calendar would take the event's rows, reminders and bin with it.
      if ((await calendarShares.calendarWrite(cx, userId, moveTo, 'edit')).ownerId !== ownerId) {
        throw conflict('CALENDAR_MOVE_SHARED', 'An event moves only between calendars of the same owner.');
      }
      updates.push('calendar_id = ?');
      params.push(moveTo);
    }
    if (updates.length) await cx.execute(`UPDATE calendar_events SET ${updates.join(', ')} WHERE id = ? AND user_id <=> ?`, [...params, event.id, ownerId]);
    if (Array.isArray(body.attendees)) await replaceEventAttendees(ownerId, event.id, body.attendees, cx);
    if (ownReminders) await calendarShares.setOwnReminders(cx, userId, event.id, remindersOf(body));
  });
  if (fields.dateChanged) await taskOrder.clearRank(db, userId, event.id);
  if (changes) await calendarShares.afterEventWrite(userId, moveTo ?? event.calendar_id ?? null, { eventId: event.id, seriesKey: event.series_id as string | null, action: 'changed' });
  return { event: await readEvent(userId, event.id) };
}

/**
 * PUT /api/calendar/events/:id of a date of a local series, or with a rule
 * for a single event (contracts/calendar-series.ts): the fields the
 * iCalendar text holds go to the series or the date's exception, the rest
 * to the row(s) (services/calendar-series.ts).
 */
async function updateSeriesEvent(userId: string, target: { event: CalendarEvent; ownerId: string | null }, body: Input) {
  const { event } = target;
  if (has(body, 'source_email_id')) return { error: 'A repeating event keeps no email link.', status: 400 };
  if (body.is_todo_only) return { error: 'A repeating event has a date.', status: 400 };
  const scope = calendarSeries.seriesScope(body.scope);
  const ownReminders = (has(body, 'reminders') || has(body, 'reminder_minutes')) && await calendarShares.remindersAreOwn(db, userId, event);
  const fields = eventFieldUpdates(body, event, { remote: false, reminders: !ownReminders });
  if ('error' in fields) return fields;
  if (has(body, 'calendar_id') && !body.calendar_id) return { error: 'Choose a calendar for this event.', status: 400 };
  const timed = has(body, 'start_time') || has(body, 'end_time') || has(body, 'all_day');
  const edits = await calendarSeries.changeSeriesEvent(userId, target, {
    updates: fields.updates, params: fields.params, scope, repeat: body.repeat, timeZone: body.time_zone, attendees: body.attendees,
    moveTo: has(body, 'calendar_id') && body.calendar_id !== event.calendar_id ? body.calendar_id! : null,
    color: has(body, 'color') ? body.color || '#2563eb' : undefined,
    ownReminders: ownReminders ? remindersOf(body) : undefined,
    fields: {
      ...(has(body, 'title') ? { title: body.title!.trim() } : {}),
      ...(has(body, 'description') ? { description: body.description || null } : {}),
      ...(has(body, 'location') ? { location: body.location?.trim() || null } : {}),
      ...(timed ? { startMs: parseDatetimeToMillis(fields.resolvedStart)!, endMs: parseDatetimeToMillis(fields.resolvedEnd)!, allDay: has(body, 'all_day') ? !!body.all_day : !!Number(event.all_day) } : {}),
      ...(!ownReminders && (has(body, 'reminders') || has(body, 'reminder_minutes')) ? { reminders: remindersOf(body) } : {}),
    },
  });
  if (fields.dateChanged && scope === 'occurrence') await taskOrder.clearRank(db, userId, event.id);
  if (edits) await calendarShares.afterEventWrite(userId, event.calendar_id ?? null, { eventId: event.id, seriesKey: (event.series_id as string | null) ?? event.id, action: 'changed' });
  const updated = await readEvent(userId, event.id);
  return { event: updated, ...(updated ? {} : { replaced: true }) };
}

async function loadCalendarAccountRow(userId: string, calendarId: string) {
  const [rows] = await db.execute<(CalendarRecordRow & { provider: string; is_active: StoredFlag })[]>(
    `SELECT c.id, c.read_only, a.provider, a.is_active FROM calendar_calendars c
     JOIN calendar_accounts a ON a.id = c.account_id WHERE c.id = ? AND c.user_id = ? LIMIT 1`,
    [calendarId, userId]
  );
  return rows[0] || null;
}

function isRemoteProvider(provider: string | undefined) {
  return calendarSync.REMOTE_PROVIDERS.has(provider!);
}

// A change that writes to an item's server copy, link or calendar holds the
// item's lock from its first read to its local write
// (calendar-move-state.ts): an edit, a move or a deletion running meanwhile
// would act on what this one is changing. `when` limits it to such changes.
function oneChangeAtATime<B, R>(failure: string, handler: (req: Request, userId: string | null, body: B) => Promise<R>,
  when: (body: B) => boolean = () => true) {
  return async (req: Request, userId: string | null, body: B) => {
    const id = userId ? getCalendarEventIdFromReq(req) : null;
    if (!userId || !id || !when(body)) return handler(req, userId, body);
    try {
      return await withEventLock(userId, id, () => handler(req, userId, body));
    } catch (error) {
      return clientError(error, failure);
    }
  };
}

// Write an event change to its calendar server before it is saved locally.
// body says which fields changed; values holds them normalized.
async function pushEventChanges(userId: string, event: CalendarEvent, body: Input, values: Partial<CalendarEvent>): Promise<PushResult> {
  const changes: Partial<CalendarEvent> = {};
  for (const key of ['title', 'description', 'start_time', 'end_time', 'all_day', 'location', 'reminders', 'reminder_minutes']) {
    if (has(body, key)) changes[key] = values[key];
  }
  try {
    const moving = has(body, 'calendar_id') && body.calendar_id && body.calendar_id !== event.calendar_id;
    if (moving) {
      // The same move as POST …/move (services/calendar-move.ts); the new
      // copy carries the fields changed with it.
      if (has(body, 'is_todo_only')) changes.is_todo_only = !!body.is_todo_only;
      if (has(body, 'recurrence')) changes.recurrence = body.recurrence || null;
      return { ...await calendarMove.moveEvent(userId, event.id, body.calendar_id!, { changes }) };
    }
    // While its new copy is being created, an edit would be lost with the old one.
    if (Object.keys(changes).length || body.is_todo_only === true) await calendarMove.assertNotMoving(userId, event.id);
    if (body.is_todo_only === true && event.calendar_id_remote) {
      return { error: 'ToDos without a date cannot be saved to a server calendar.', status: 400 };
    }
    if (!Object.keys(changes).length) return {};
    const scope = body.scope === 'series' ? 'series' : 'occurrence';
    return (await calendarSync.pushEventUpdate({ userId, event, changes, scope })) || {};
  } catch (error) {
    return calendarSync.calendarErrorResponse(error, 'Could not save the change to the calendar server');
  }
}

export = {
  // Calendar accounts + calendars + events
  'GET /api/calendar/accounts': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!CALENDAR_MULTI_ENABLED) return { error: 'Calendar multi-account feature disabled', status: 503 };
    try {
      await ensureDefaultLocalCalendarForUser(userId);
      // With the state of a linked mail account, whose login a calendar uses.
      const [rows] = await db.execute<(AccountRow & { mail_connected: number })[]>(
        `SELECT ca.*, (${MAIL_CONNECTED_SQL}) AS mail_connected FROM calendar_accounts ca
         LEFT JOIN mail_accounts m ON m.id = ca.mail_account_id AND m.user_id = ca.user_id
         WHERE ca.user_id = ? ORDER BY ca.created_at ASC`,
        [userId]
      );
      return { accounts: rows.map((row) => serializeCalendarAccount(row)) };
    } catch (error) {
      console.error('Get calendar accounts error:', error);
      return { error: 'Failed to get calendar accounts', status: 500 };
    }
  },

  // The same steps as the administrator's path (services/calendar-account-changes.ts).
  'POST /api/calendar/accounts': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return await calendarAccountChanges.createCalendarAccount(userId, body);
    } catch (error) {
      return calendarSync.calendarErrorResponse(error, 'Failed to connect the calendar');
    }
  },

  'PUT /api/calendar/accounts/:id': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return await calendarAccountChanges.updateCalendarAccount(userId, getCalendarAccountIdFromReq(req)!, body);
    } catch (error) {
      console.error('Update calendar account error:', error);
      return clientError(error, 'Failed to update calendar account');
    }
  },

  'DELETE /api/calendar/accounts/:id': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return await calendarAccountChanges.deleteCalendarAccount(userId, getCalendarAccountIdFromReq(req)!);
    } catch (error) {
      console.error('Delete calendar account error:', error);
      return clientError(error, 'Failed to delete calendar account');
    }
  },

  'POST /api/calendar/accounts/:id/sync': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const id = getCalendarAccountIdFromReq(req)!;
      if (!id) return { error: 'Invalid account id', status: 400 };
      const [rows] = await db.execute<AccountRow[]>('SELECT provider, is_active FROM calendar_accounts WHERE id = ? AND user_id = ?', [id, userId]);
      if (!rows.length) return { error: 'Calendar account not found', status: 404 };
      if (!isRemoteProvider(rows[0].provider)) return { error: 'Local calendars do not sync', status: 400 };
      if (!rows[0].is_active) return { error: 'Sync is paused for this account.', status: 409, code: 'CALENDAR_SYNC_PAUSED' };
      let result;
      try {
        result = await calendarSync.syncCalendarAccount(id, { userId, reason: 'manual', full: body?.full === true });
      } catch (error) {
        // The failure is stored on the account and shown with it.
        result = { ok: false, ...calendarSync.calendarErrorResponse(error, 'Calendar sync failed') };
        delete result.status;
      }
      const [account] = await db.execute<AccountRow[]>('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?', [id, userId]);
      return { result, account: account[0] ? serializeCalendarAccount(account[0]) : null };
    } catch (error) {
      return calendarSync.calendarErrorResponse(error, 'Calendar sync failed');
    }
  },

  'GET /api/calendar/calendars': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!CALENDAR_MULTI_ENABLED) return { error: 'Calendar multi-account feature disabled', status: 503 };
    try {
      await ensureDefaultLocalCalendarForUser(userId);
      const [rows] = await db.execute<CalendarRecordRow[]>(
        `SELECT c.*, a.provider, a.display_name AS account_display_name, a.account_email
         FROM calendar_calendars c
         INNER JOIN calendar_accounts a ON a.id = c.account_id
         WHERE c.user_id = ? AND a.user_id = ?
         ORDER BY a.created_at ASC, c.created_at ASC`,
        [userId, userId]
      );
      // Where new items go and what each calendar can take, from the
      // server's rules (contracts/tasks.ts CalendarChoiceFields).
      const defaults = await resolveCalendarDefaults(userId);
      const choices = new Map(defaults.choices.map(choice => [choice.id, choice]));
      // Then the calendars others share with the person, at their level and in their view (contracts/calendar-shares.ts).
      const calendars = (await calendarShares.calendarsWithAccess(userId, rows, db, { offers: true })).map(({ row, mine, access }) => {
        const writes = access.permission === 'edit' || access.permission === 'manage';
        if (!mine) {
          return {
            ...serializeCalendarCalendar(row as CalendarRecordRow),
            is_visible: access.view.is_visible,
            color: access.view.color,
            account_provider: row.provider ?? 'local',
            account_display_name: null,
            account_email: null,
            default_for_tasks: false,
            default_for_events: false,
            write_block: writes ? null : 'read_only',
            takes_undated_tasks: writes,
            // Free/busy shows no tasks: not a list in ToDo.
            ...(access.permission === 'freebusy' ? { auto_todo_enabled: false } : {}),
            ...access,
          };
        }
        const choice = choices.get(row.id);
        return {
          ...serializeCalendarCalendar(row as CalendarRecordRow),
          account_provider: row.provider,
          account_display_name: row.account_display_name || null,
          account_email: row.account_email || null,
          default_for_tasks: row.id === defaults.taskListId,
          default_for_events: row.id === defaults.calendarId,
          write_block: !writes ? 'read_only' : choice ? calendarWriteBlock(choice) : 'read_only',
          takes_undated_tasks: writes && choice ? takesUndatedTasks(choice) : false,
          ...access,
        };
      });
      return { calendars };
    } catch (error) {
      console.error('Get calendars error:', error);
      return clientError(error, 'Failed to get calendars');
    }
  },

  'POST /api/calendar/calendars': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!CALENDAR_MULTI_ENABLED) return { error: 'Calendar multi-account feature disabled', status: 503 };
    try {
      const accountId = body.account_id;
      if (!accountId) return { error: 'account_id is required', status: 400 };
      if (!body.name?.trim()) return { error: 'name is required', status: 400 };
      const [accounts] = await db.execute<AccountRow[]>('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
      if (accounts.length === 0) return { error: 'Calendar account not found', status: 404 };
      const account = accounts[0];
      if (isRemoteProvider(account.provider)) {
        return { error: 'Calendars of this account come from its server. Create the calendar there; it appears after the next sync.', status: 400 };
      }

      const calendarId = crypto.randomUUID();
      await db.execute(
        `INSERT INTO calendar_calendars
          (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          calendarId,
          userId,
          accountId,
          body.name.trim(),
          body.external_id || null,
          body.color || '#2563eb',
          body.is_visible === false ? 0 : 1,
          body.auto_todo_enabled === false ? 0 : 1,
          0,
          !!body.is_primary,
        ]
      );
      const [rows] = await db.execute<CalendarRecordRow[]>('SELECT * FROM calendar_calendars WHERE id = ? AND user_id = ? LIMIT 1', [calendarId, userId]);
      return { calendar: serializeCalendarCalendar(rows[0]) };
    } catch (error) {
      console.error('Create calendar error:', error);
      return clientError(error, 'Failed to create calendar');
    }
  },

  'PUT /api/calendar/calendars/:id': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!CALENDAR_MULTI_ENABLED) return { error: 'Calendar multi-account feature disabled', status: 503 };
    try {
      const id = getCalendarCalendarIdFromReq(req)!;
      if (!id) return { error: 'Invalid calendar id', status: 400 };
      const [existingRows] = await db.execute<CalendarRecordRow[]>('SELECT * FROM calendar_calendars WHERE id = ? AND user_id = ?', [id, userId]);
      if (existingRows.length === 0) return { error: 'Calendar not found', status: 404 };
      const existing = existingRows[0];
      // An archived calendar keeps only its owner's name and colour changes.
      if (existing.archived_at && Object.keys(body ?? {}).some(key => key !== 'name' && key !== 'color')) throw forbidden('CALENDAR_FORBIDDEN', 'You cannot change this calendar.');
      const [[owner]] = await db.execute<AccountRow[]>('SELECT provider FROM calendar_accounts WHERE id = ?', [existing.account_id]);
      const remote = isRemoteProvider(owner?.provider);
      if (remote && has(body, 'name') && body.name?.trim() !== existing.name) {
        return { error: 'Rename this calendar on its server; the new name appears after the next sync.', status: 400 };
      }

      const updates = [];
      const params: ExecuteValues[] = [];
      if (!remote && Object.prototype.hasOwnProperty.call(body, 'name')) {
        if (!body.name?.trim()) return { error: 'name cannot be empty', status: 400 };
        updates.push('name = ?');
        params.push(body.name.trim());
      }
      if (Object.prototype.hasOwnProperty.call(body, 'color')) {
        updates.push('color = ?');
        params.push(body.color || '#2563eb');
      }
      if (Object.prototype.hasOwnProperty.call(body, 'is_visible')) {
        updates.push('is_visible = ?');
        params.push(body.is_visible === false ? 0 : 1);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'auto_todo_enabled')) {
        updates.push('auto_todo_enabled = ?');
        params.push(body.auto_todo_enabled === false ? 0 : 1);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'is_primary')) {
        updates.push('is_primary = ?');
        params.push(body.is_primary === true ? 1 : 0);
      }
      if (updates.length === 0) return { error: 'No fields to update', status: 400 };

      // Keep only one primary calendar per account when requested.
      if (body.is_primary === true) {
        await db.execute('UPDATE calendar_calendars SET is_primary = FALSE WHERE account_id = ? AND user_id = ?', [existing.account_id, userId]);
      }

      params.push(id, userId);
      await db.execute(`UPDATE calendar_calendars SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
      if (Object.prototype.hasOwnProperty.call(body, 'is_visible')) {
        await db.execute('UPDATE notification_config SET reminder_revision = reminder_revision + 1 WHERE id = 1');
      }
      // Synced events take their calendar's color.
      if (remote && has(body, 'color')) {
        await db.execute('UPDATE calendar_events SET color = ? WHERE calendar_id = ? AND user_id = ?', [body.color || '#2563eb', id, userId]);
      }
      const [rows] = await db.execute<CalendarRecordRow[]>('SELECT * FROM calendar_calendars WHERE id = ? AND user_id = ? LIMIT 1', [id, userId]);
      return { calendar: serializeCalendarCalendar(rows[0]) };
    } catch (error) {
      console.error('Update calendar error:', error);
      return clientError(error, 'Failed to update calendar');
    }
  },

  'DELETE /api/calendar/calendars/:id': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!CALENDAR_MULTI_ENABLED) return { error: 'Calendar multi-account feature disabled', status: 503 };
    try {
      const id = getCalendarCalendarIdFromReq(req)!;
      if (!id) return { error: 'Invalid calendar id', status: 400 };

      const [rows] = await db.execute<CalendarRecordRow[]>(
        'SELECT * FROM calendar_calendars WHERE id = ? AND user_id = ? LIMIT 1',
        [id, userId]
      );
      if (rows.length === 0) return { error: 'Calendar not found', status: 404 };
      const calendar = rows[0];
      if (calendar.archived_at) throw forbidden('CALENDAR_FORBIDDEN', 'You cannot change this calendar.');
      const [[owner]] = await db.execute<AccountRow[]>('SELECT provider FROM calendar_accounts WHERE id = ?', [calendar.account_id]);
      if (isRemoteProvider(owner?.provider)) {
        return { error: 'Calendars of this account come from its server. Delete the calendar there, or remove the whole account here.', status: 400 };
      }

      const [accountCalendarCountRows] = await db.execute<CountRow[]>(
        'SELECT COUNT(*) AS count FROM calendar_calendars WHERE account_id = ? AND user_id = ?',
        [calendar.account_id, userId]
      );
      const accountCalendarCount = Number(accountCalendarCountRows[0]?.count || 0);
      if (accountCalendarCount <= 1) {
        return { error: 'Cannot delete the last calendar in this account. Delete the account instead.', status: 400 };
      }

      // The list and its events go to the bin together (bin-calendar.ts).
      const { deletedEvents, binItemIds } = await binCalendar.deleteCalendarToBin(userId, id);
      return {
        message: `Calendar moved to the bin with its ${deletedEvents} event(s).`,
        deleted_events: deletedEvents,
        bin_item_ids: binItemIds,
      };
    } catch (error) {
      console.error('Delete calendar error:', error);
      return clientError(error, 'Failed to delete calendar');
    }
  },

  'GET /api/calendar/events': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      await ensureDefaultLocalCalendarForUser(userId);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const includeTodos = url.searchParams.get('include_todos') === 'true';
      const includeDoneParam = url.searchParams.get('include_done');
      const includeDone = includeDoneParam === null ? true : includeDoneParam === 'true';
      const respectAutoTodo = url.searchParams.get('respect_auto_todo') === 'true';
      const visibleOnly = url.searchParams.get('visible_only') === 'true';
      const rangeStart = formatProviderDateRange(url.searchParams.get('range_start'));
      const rangeEnd = formatProviderDateRange(url.searchParams.get('range_end'));
      const calendarIds = (url.searchParams.get('calendar_ids') || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      // The person's own events, and those of the calendars others share
      // with them that they have on (their own view, not the owner's).
      const levels = await calendarShares.reachedCalendars(userId);
      const views = await calendarShares.viewsOfCalendars(userId, [...levels.keys()]);
      // ToDo shows no task of a free/busy calendar, dated or not.
      const reached = [...levels.keys()].filter(id => (!visibleOnly || views.get(id)?.is_visible) && !(respectAutoTodo && levels.get(id) === 'freebusy'));
      let query = `
        SELECT e.*, c.auto_todo_enabled, c.is_visible, ${sourceEmailPresentSql('e')} AS source_email_present, ${seriesKeySql('e')} AS series_key
        FROM calendar_events e
        LEFT JOIN calendar_calendars c ON c.id = e.calendar_id
        WHERE ((e.user_id = ?${visibleOnly ? ' AND (c.is_visible = TRUE OR c.is_visible IS NULL)' : ''})${reached.length ? ` OR e.calendar_id IN (${reached.map(() => '?').join(', ')})` : ''})`;
      const params: (string | null)[] = [userId, ...reached];

      if (!includeTodos) {
        query += ' AND e.is_todo_only = FALSE';
      }
      if (!includeDone) {
        query += ` AND (e.todo_status IS NULL OR e.todo_status NOT IN ('done', 'cancelled'))`;
      }
      if (respectAutoTodo) {
        query += ' AND (c.auto_todo_enabled = TRUE OR c.auto_todo_enabled IS NULL)';
      }
      if (rangeStart) {
        query += ' AND e.end_time >= ?';
        params.push(toMysqlDatetime(rangeStart));
      }
      if (rangeEnd) {
        query += ' AND e.start_time <= ?';
        params.push(toMysqlDatetime(rangeEnd));
      }
      if (calendarIds.length > 0) {
        const placeholders = calendarIds.map(() => '?').join(', ');
        query += ` AND e.calendar_id IN (${placeholders})`;
        params.push(...calendarIds);
      }
      query += ' ORDER BY e.start_time ASC';

      const [rows] = await db.execute<EventRow[]>(query, params);
      const own = rows.filter(row => row.user_id === userId);
      const shared = await calendarShares.presentReached(userId, rows.filter(row => row.user_id !== userId), levels);
      const order = new Map(rows.map((row, index) => [row.id, index]));
      const events = [...await presentEvents(userId, own), ...shared].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      return { events };
    } catch (error) {
      console.error('Get events error:', error);
      return { error: 'Failed to get events', status: 500 };
    }
  },

  'POST /api/calendar/events': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!body.title?.trim()) return { error: 'Title is required', status: 400 };

    try {
      const { title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes, reminders, is_todo_only, source_email_id } = body;
      // A task made from an email keeps the email's header with it.
      if (source_email_id) {
        const refusal = await sourceEmailLinkRefusal(userId, req.sessionDeviceId ?? null);
        if (refusal) return refusal;
      }
      const sourceEmail = source_email_id ? await snapshotSourceEmail(userId, source_email_id) : null;
      if (source_email_id && !sourceEmail) return { error: 'Email not found', status: 404 };
      let start = toMysqlDatetime(start_time);
      let end = toMysqlDatetime(end_time);

      if (!!is_todo_only && (!start || !end)) {
        const now = Date.now();
        start = toMysqlDatetime(new Date(now).toISOString());
        end = toMysqlDatetime(new Date(now + 30 * 60 * 1000).toISOString());
      }
      if (!start || !end) return { error: 'Valid start and end time are required', status: 400 };
      if (parseDatetimeToMillis(end)! < parseDatetimeToMillis(start)!) {
        return { error: 'End time must be after start time', status: 400 };
      }

      let calendarId = body.calendar_id || null;
      let remoteTarget = null;
      if (calendarId) {
        remoteTarget = await loadCalendarAccountRow(userId, calendarId);
        // Another person's calendar, or one no person owns: the guard below asks for edit.
        const reached = !remoteTarget && await calendarShares.levelOn(userId, calendarId);
        if (!remoteTarget && !reached) return { error: 'Invalid calendar_id', status: 400 };
        if (reached && source_email_id) return { error: 'A task from an email goes to one of your own lists.', status: 400 };
        if (!remoteTarget || !isRemoteProvider(remoteTarget.provider)) remoteTarget = null;
        else if (is_todo_only) return { error: 'ToDos without a date cannot be saved to a server calendar.', status: 400 };
        else if (remoteTarget.provider === 'ics' || remoteTarget.read_only) return { error: 'This calendar is read-only.', status: 403, code: 'CALENDAR_READ_ONLY' };
        else if (!remoteTarget.is_active) return { error: 'Sync is paused for this calendar account, so events cannot be added to it.', status: 409, code: 'CALENDAR_SYNC_PAUSED' };
      } else {
        // Without a calendar (older apps, the new task dialog before 0.27):
        // the person's default task list, which takes tasks without a date.
        calendarId = (await resolveCalendarDefaults(userId)).taskListId;
      }

      const eventId = crypto.randomUUID();
      let ownerId: string | null = userId;
      // A copy for a server is created holding the new item's lock, taken
      // before its row is visible: a move or edit of it waits until the copy
      // is linked, or the row is gone again (calendar-move-state.ts).
      const create = async () => {
        const connection = await db.getConnection();
        try {
          await connection.beginTransaction();
          // The calendar's guard first. The rows carry its owner's user_id; the event's reminders are the owner's, anyone else's their own.
          ownerId = (await calendarShares.calendarWrite(connection, userId, calendarId!, 'edit')).ownerId;
          await fenceTaskLocks(connection);
          const own = ownerId === userId;
          // The email stays for the insert: a Gmail merge removing that copy
          // waits and then names the kept one in this task, or it has
          // removed it already (mail-sync-policy.ts).
          if (sourceEmail) {
            const [still] = await connection.execute<RowDataPacket[]>('SELECT id FROM emails WHERE id = ? AND user_id = ? LOCK IN SHARE MODE', [String(source_email_id), userId]);
            if (!still.length) { await connection.rollback(); return { error: 'Email not found', status: 404 }; }
          }
          await connection.execute(
            `INSERT INTO calendar_events
              (id, user_id, calendar_id, title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes, reminders, is_todo_only,
               source_email_id, source_email_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              eventId,
              ownerId,
              calendarId,
              title.trim(),
              description || null,
              start,
              end,
              !!all_day,
              location?.trim() || null,
              color || '#2563eb',
              recurrence || null,
              own ? reminder_minutes ?? null : null,
              own && reminders ? JSON.stringify(reminders) : null,
              !!is_todo_only,
              sourceEmail ? String(source_email_id) : null,
              sourceEmail ? JSON.stringify(sourceEmail) : null,
            ]
          );
          if (Array.isArray(body.attendees)) {
            await replaceEventAttendees(ownerId, eventId, body.attendees, connection);
          }
          const seriesId = body.repeat != null ? await calendarSeries.startSeries(connection, userId, ownerId, eventId, body.repeat, body.time_zone) : null;
          if (!own && (reminders || reminder_minutes != null)) await calendarShares.setOwnReminders(connection, userId, seriesId ? { seriesId } : eventId, remindersOf(body));

          await (require('../services/notifications') as typeof import('../services/notifications')).enqueueCalendarNotification({ userId, eventId }, connection);
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
        if (remoteTarget) {
          const [created] = await db.execute<EventRow[]>('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [eventId, userId]);
          try {
            await calendarSync.pushCreatedEvent({ userId, event: created[0] });
          } catch (error) {
            // Nothing is kept that the server did not accept.
            await fencedWrite(cleanup => cleanup.execute('DELETE FROM calendar_events WHERE id = ? AND user_id = ?', [eventId, userId]));
            return calendarSync.calendarErrorResponse(error, 'Could not save the event to the calendar server');
          }
        }
        return null;
      };
      const refused = remoteTarget ? await withEventLock(userId, eventId, create) : await create();
      if (refused) return refused;
      await calendarShares.afterEventWrite(userId, calendarId, { eventId, action: 'created' });
      return { event: await readEvent(userId, eventId) };
    } catch (error) {
      console.error('Create event error:', error);
      return clientError(error, 'Failed to create event');
    }
  },

  'GET /api/calendar/events/:id': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const id = getCalendarEventIdFromReq(req)!;
    if (!id) return { error: 'Invalid event id', status: 400 };
    try {
      const event = await readEvent(userId, id);
      return event ? { event } : { error: 'Event not found', status: 404 };
    } catch (error) {
      console.error('Get calendar event error:', error);
      return { error: 'Failed to get calendar event', status: 500 };
    }
  },

  'PUT /api/calendar/events/:id': oneChangeAtATime('Failed to update event', async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const id = getCalendarEventIdFromReq(req)!;
      if (!id) return { error: 'Invalid event id', status: 400 };

      // The calendar and server copy the writeback decision below rests on,
      // read first: the local write is refused if either changed meanwhile
      // (a second line behind the item's lock, which a sync does not take).
      const target = await calendarShares.eventTarget(userId, id);
      if (!target) return { error: 'Event not found', status: 404 };
      if (target.event.series_id || (has(body, 'repeat') && body.repeat !== null)) return await updateSeriesEvent(userId, target, body);
      if (!target.own) return await updateReachedEvent(userId, target, body);
      const decidedFor = await writebackIdentity(db, userId, id);
      const [events] = await db.execute<EventRow[]>('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [id, userId]);
      if (events.length === 0) return { error: 'Event not found', status: 404 };
      const currentEvent = events[0];
      if ((currentEvent.calendar_id || null) !== decidedFor.calendarId) return clientError(eventChanged(), 'Failed to update event');
      const currentCalendar = currentEvent.calendar_id ? await loadCalendarAccountRow(userId, currentEvent.calendar_id) : null;
      currentEvent.calendar_id_remote = isRemoteProvider(currentCalendar?.provider);
      // After a hand-over the owner may keep reminders of their own, which win.
      const ownReminders = (has(body, 'reminders') || has(body, 'reminder_minutes')) && await calendarShares.remindersAreOwn(db, userId, currentEvent);
      const fields = eventFieldUpdates(body, currentEvent, { remote: !!currentEvent.calendar_id_remote, reminders: !ownReminders });
      if ('error' in fields) return fields;
      const { updates, params, resolvedStart, resolvedEnd } = fields;
      if (Object.prototype.hasOwnProperty.call(body, 'calendar_id')) {
        if (!body.calendar_id) {
          // Without its calendar a synced event would keep its server link
          // but be edited locally only, until the next sync overwrote it.
          if (await calendarSync.hasEventLink(userId, id)) {
            return { error: 'This event is synced with a calendar server. Move it to another calendar or delete it instead.', status: 400 };
          }
          updates.push('calendar_id = NULL');
        } else {
          // Another calendar: moved by pushEventChanges below, not here.
          const [calRows] = await db.execute<CalendarRecordRow[]>('SELECT id FROM calendar_calendars WHERE id = ? AND user_id = ?', [body.calendar_id, userId]);
          if (calRows.length === 0 && await calendarShares.levelOn(userId, body.calendar_id)) {
            return clientError(conflict('CALENDAR_MOVE_SHARED', 'An event moves only between calendars of the same owner.'), 'Failed to update event');
          }
          if (calRows.length === 0) return { error: 'Invalid calendar_id', status: 400 };
        }
      }
      // The link to the email the task came from: null removes it (and the
      // kept summary); an email id links again, if the email is still here.
      let relink: { id: string; summary: string } | null = null;
      if (Object.prototype.hasOwnProperty.call(body, 'source_email_id')) {
        if (!body.source_email_id) {
          updates.push('source_email_id = NULL', 'source_email_json = NULL');
        } else {
          const refusal = await sourceEmailLinkRefusal(userId, req.sessionDeviceId ?? null);
          if (refusal) return refusal;
          const sourceEmail = await snapshotSourceEmail(userId, body.source_email_id);
          if (!sourceEmail) return { error: 'Email not found', status: 404 };
          // Written with the task's row, after the email is locked again (applyLocalEventUpdate).
          relink = { id: String(body.source_email_id), summary: JSON.stringify(sourceEmail) };
        }
      }

      // A date or time changed here returns the task to its date's place
      // (D31); one arriving from the server keeps its hand rank. The identity
      // is read first: a synced series' time change replaces the rows.
      const { dateChanged } = fields;
      const orderIdentity = dateChanged ? await taskOrder.identityOf(db, userId, id) : null;

      const writeback = await pushEventChanges(userId, currentEvent, body, {
        title: body.title?.trim(),
        description: body.description || null,
        start_time: resolvedStart,
        end_time: resolvedEnd,
        all_day: !!body.all_day,
        location: body.location?.trim() || null,
        reminders: Array.isArray(body.reminders) ? body.reminders : null,
        reminder_minutes: body.reminder_minutes ?? null,
      });
      if (writeback.error) return writeback;

      // Changing the time of a whole series replaces its occurrences, and
      // with them the edited id: then there is no local row left to update.
      // No move runs meanwhile (the item's lock); should one have, the
      // write is refused under the row lock. A move this request started
      // changes the identity itself and carries the fields.
      const startedMove = has(body, 'calendar_id') && !!body.calendar_id && body.calendar_id !== currentEvent.calendar_id;
      const fieldsOfMove = !startedMove && ['title', 'description', 'start_time', 'end_time', 'all_day', 'location', 'reminders', 'reminder_minutes', 'is_todo_only', 'recurrence', 'calendar_id'].some(key => has(body, key));
      const identity = startedMove ? null : { ...decidedFor, objectId: typeof writeback.objectId === 'string' ? writeback.objectId : decidedFor.objectId };
      let updatedEvent = await applyLocalEventUpdate(userId, id, { sets: updates, params }, body.attendees, { fieldsOfMove, identity, sourceEmail: relink });
      if (ownReminders && updatedEvent) {
        await withTransaction(cx => calendarShares.setOwnReminders(cx, userId, id, remindersOf(body)));
        updatedEvent = await getCalendarEventWithSubtasks(userId, id);
      }
      if (dateChanged) {
        await taskOrder.clearRank(db, userId, id, orderIdentity);
        if (updatedEvent) updatedEvent = await getCalendarEventWithSubtasks(userId, id);
      }
      if (updatedEvent && (updates.length || startedMove || Array.isArray(body.attendees))) {
        await calendarShares.afterEventWrite(userId, updatedEvent.calendar_id, { eventId: id, seriesKey: (currentEvent.series_id as string | null) ?? null, action: 'changed' });
      }
      // A move a calendar server has not confirmed yet finishes in the background.
      const moved = writeback.pending ? { pending: writeback.pending, status: 202 } : {};
      return { event: updatedEvent, ...(updatedEvent ? {} : { replaced: true }), ...(writeback.scope ? { scope: writeback.scope } : {}),
        ...(writeback.sourceKept ? { source_kept: true } : {}), ...moved };
    } catch (error) {
      console.error('Update event error:', error);
      return clientError(error, 'Failed to update event');
    }
  }),

  'PUT /api/calendar/events/:id/todo-status': oneChangeAtATime('Failed to update todo status', async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const id = getCalendarEventIdFromReq(req)!;
      if (!id) return { error: 'Invalid event id', status: 400 };

      if (!Object.prototype.hasOwnProperty.call(body, 'todo_status')) {
        return { error: 'todo_status is required', status: 400 };
      }

      const { todo_status, start_time, end_time } = body;
      // Set when the time changes: what its writeback decision rests on.
      let timeDecidedFor: import('../services/calendar-move-state').WritebackIdentity | null = null;
      if (!['done', 'changed', 'time_moved', 'cancelled', null].includes(todo_status!)) {
        return { error: 'Invalid todo_status', status: 400 };
      }

      const target = await calendarShares.eventTarget(userId, id);
      if (!target) return { error: 'Event not found', status: 404 };
      const currentEvents = [target.event];

      const updates = ['todo_status = ?'];
      const params = [todo_status || null];

      if (todo_status === 'done') {
        updates.push('done_at = NOW()');
      } else {
        updates.push('done_at = NULL');
      }

      if (todo_status === 'time_moved' && (start_time || end_time)) {
        const currentStartMs = parseDatetimeToMillis(currentEvents[0].start_time);
        const currentEndMs = parseDatetimeToMillis(currentEvents[0].end_time);
        const durationMs = currentStartMs !== null && currentEndMs !== null ? Math.max(0, currentEndMs - currentStartMs) : 0;

        const parsedStart = start_time ? toMysqlDatetime(start_time) : null;
        const parsedEnd = end_time ? toMysqlDatetime(end_time) : null;
        if (start_time && !parsedStart) return { error: 'Invalid start_time for time move', status: 400 };
        if (end_time && !parsedEnd) return { error: 'Invalid end_time for time move', status: 400 };

        let movedStart = parsedStart;
        let movedEnd = parsedEnd;

        if (movedStart && !movedEnd) {
          const computedEndMs = (parseDatetimeToMillis(movedStart) || 0) + durationMs;
          movedEnd = toMysqlDatetime(new Date(computedEndMs).toISOString());
        } else if (!movedStart && movedEnd) {
          const computedStartMs = (parseDatetimeToMillis(movedEnd) || 0) - durationMs;
          movedStart = toMysqlDatetime(new Date(computedStartMs).toISOString());
        }

        if (movedStart && movedEnd && parseDatetimeToMillis(movedEnd)! < parseDatetimeToMillis(movedStart)!) {
          return { error: 'End time must be after start time', status: 400 };
        }

        if (movedStart && movedEnd && !target.own) {
          // A calendar others share is UniHub's own: nothing to write back.
          if (movedStart !== toMysqlDatetime(target.event.start_time)) await taskOrder.clearRank(db, userId, id);
          updates.push('start_time = ?', 'end_time = ?');
          params.push(movedStart, movedEnd);
        } else if (movedStart && movedEnd) {
          timeDecidedFor = await writebackIdentity(db, userId, id);
          const [[current]] = await db.execute<EventRow[]>('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [id, userId]);
          if ((current.calendar_id || null) !== timeDecidedFor.calendarId) return clientError(eventChanged(), 'Failed to update todo status');
          const orderIdentity = await taskOrder.identityOf(db, userId, id);
          const writeback = await pushEventChanges(userId, current, { start_time: movedStart, end_time: movedEnd },
            { start_time: movedStart, end_time: movedEnd });
          if (writeback.error) return writeback;
          if (typeof writeback.objectId === 'string') timeDecidedFor.objectId = writeback.objectId;
          // "Move to another time" returns the task to its new date's place (D31).
          if (movedStart !== toMysqlDatetime(current.start_time)) await taskOrder.clearRank(db, userId, id, orderIdentity);
          updates.push('start_time = ?', 'end_time = ?');
          params.push(movedStart, movedEnd);
        }
      }

      // A new time is refused while a move's new copy is being created, and
      // when the calendar or server copy it was written back for changed
      // meanwhile (a move finished): checked in the same statement.
      const timeMoved = !!timeDecidedFor;
      const updateQuery = `UPDATE calendar_events SET ${updates.join(', ')} WHERE id = ? AND user_id <=> ?${timeMoved
        ? ` AND NOT EXISTS (SELECT 1 FROM calendar_event_moves m WHERE m.event_id = calendar_events.id AND m.state = 'creating' AND m.target_calendar_id IS NOT NULL)
           AND calendar_id <=> ? AND (SELECT r.remote_object_id FROM calendar_event_external_refs r WHERE r.event_id = calendar_events.id LIMIT 1) <=> ?` : ''}`;
      params.push(id, target.ownerId);
      if (timeDecidedFor) params.push(timeDecidedFor.calendarId, timeDecidedFor.objectId);
      // The calendar's guard first; a time move is fenced by the item's lock, which it holds (calendar-move-state.ts).
      const written = await withTransaction(async connection => {
        if (!await calendarShares.lockEventWrite(connection, userId, id, target.ownerId, 'edit', target.event.calendar_id ?? null)) return { affectedRows: 0 } as ResultSetHeader;
        if (timeMoved) await fenceTaskLocks(connection);
        const [result] = await connection.execute<ResultSetHeader>(updateQuery, params);
        if (result.affectedRows && updates.includes('start_time = ?')) await calendarSeries.keepDateTimes(connection, id);
        return result;
      });
      if (timeMoved && !written.affectedRows) {
        const [moving] = await db.execute<RowDataPacket[]>("SELECT id FROM calendar_event_moves WHERE event_id = ? AND state = 'creating'", [id]);
        return clientError(moving.length ? movePending() : eventChanged(), 'Failed to update todo status');
      }

      if (written.affectedRows) await calendarShares.afterEventWrite(userId, target.event.calendar_id ?? null, { eventId: id, seriesKey: (target.event.series_id as string | null) ?? null, action: 'ticked' });
      return { event: await readEvent(userId, id) };
    } catch (error) {
      console.error('Update todo status error:', error);
      return clientError(error, 'Failed to update todo status');
    }
  }, body => body?.todo_status === 'time_moved' && !!(body.start_time || body.end_time)),

  'PUT /api/calendar/events/:id/rsvp': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const id = getCalendarEventIdFromReq(req)!;
      if (!id) return { error: 'Invalid event id', status: 400 };
      const responseStatus = normalizeResponseStatus(body?.response_status);
      const attendeeEmail = body?.email ? String(body.email).trim().toLowerCase() : null;

      const event = await getCalendarEventWithSubtasks(userId, id);
      if (!event) return { error: 'Event not found', status: 404 };
      // An archived calendar refuses it, the owner's too.
      if (event.calendar_id) await calendarShares.assertCalendar(userId, event.calendar_id, 'edit');
      const context = event.calendar_id ? await loadCalendarWithAccount(userId, event.calendar_id) : null;
      const accountEmail = context?.account?.account_email?.toLowerCase() || null;
      const effectiveEmail = attendeeEmail || accountEmail;
      if (!effectiveEmail) {
        return { error: 'No attendee email available for RSVP update', status: 400 };
      }

      const nextAttendees: Partial<CalendarAttendee>[] = [...(event.attendees || [])];
      const existingIdx = nextAttendees.findIndex((attendee) => attendee.email === effectiveEmail);
      if (existingIdx >= 0) {
        nextAttendees[existingIdx] = {
          ...nextAttendees[existingIdx],
          response_status: responseStatus,
        };
      } else {
        nextAttendees.push({
          email: effectiveEmail,
          display_name: null,
          response_status: responseStatus,
          optional_attendee: false,
          is_organizer: false,
          comment: null,
        });
      }
      await replaceEventAttendees(userId, id, nextAttendees);
      const updated = await getCalendarEventWithSubtasks(userId, id);
      return { event: updated };
    } catch (error) {
      console.error('RSVP update error:', error);
      return clientError(error, 'Failed to update RSVP');
    }
  },

  'GET /api/calendar/events/:id/subtasks': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const eventId = getCalendarEventIdFromReq(req)!;
      if (!eventId) return { error: 'Invalid event id', status: 400 };

      const target = await calendarShares.eventTarget(userId, eventId);
      if (!target) return { error: 'Event not found', status: 404 };
      if (!target.own) await calendarShares.assertCalendar(userId, String(target.event.calendar_id), 'read');
      return { subtasks: (await getCalendarSubtasksForEvents(target.ownerId, [eventId])).get(eventId) ?? [] };
    } catch (error) {
      console.error('Get subtasks error:', error);
      return clientError(error, 'Failed to fetch subtasks');
    }
  },

  'POST /api/calendar/events/:id/subtasks': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!body.title?.trim()) return { error: 'Subtask title is required', status: 400 };

    try {
      const eventId = getCalendarEventIdFromReq(req)!;
      if (!eventId) return { error: 'Invalid event id', status: 400 };

      const target = await calendarShares.eventTarget(userId, eventId);
      if (!target) return { error: 'Event not found', status: 404 };
      const { ownerId } = target;
      const subtaskId = crypto.randomUUID();
      // A contributor adds at the end: placing a point among others reorders them.
      const added = await withTransaction(async cx => {
        const locked = await calendarShares.lockEventWrite(cx, userId, eventId, ownerId, 'contribute', target.event.calendar_id ?? null);
        if (!locked) return false;
        let position = calendarShares.atLeast(locked.level, 'edit') && Number.isInteger(body.position) && body.position! >= 0 ? body.position! : null;
        if (position === null) {
          const [maxRows] = await cx.execute<(RowDataPacket & { max_position: number })[]>(
            'SELECT COALESCE(MAX(position), -1) AS max_position FROM calendar_event_subtasks WHERE event_id = ? AND user_id <=> ?', [eventId, ownerId]);
          position = Number(maxRows[0]?.max_position ?? -1) + 1;
        } else {
          await cx.execute('UPDATE calendar_event_subtasks SET position = position + 1 WHERE event_id = ? AND user_id <=> ? AND position >= ?', [eventId, ownerId, position]);
        }
        await cx.execute('INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [subtaskId, eventId, ownerId, String(body.title).trim(), !!body.is_done, position, userId]);
        return true;
      });
      if (!added) return { error: 'Event not found', status: 404 };
      await calendarShares.afterEventWrite(userId, target.event.calendar_id ?? null, { eventId, seriesKey: (target.event.series_id as string | null) ?? null, action: 'point' });
      const subtasks = (await getCalendarSubtasksForEvents(ownerId, [eventId])).get(eventId) ?? [];
      return { subtask: subtasks.find((point: { id: string }) => point.id === subtaskId) ?? null };
    } catch (error) {
      console.error('Create subtask error:', error);
      return clientError(error, 'Failed to create subtask');
    }
  },

  'PUT /api/calendar/events/:id/subtasks/:subtaskId': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const eventId = getCalendarEventIdFromReq(req)!;
      const subtaskId = getCalendarSubtaskIdFromReq(req)!;
      if (!eventId || !subtaskId) return { error: 'Invalid subtask route', status: 400 };

      const target = await calendarShares.eventTarget(userId, eventId);
      if (!target) return { error: 'Subtask not found', status: 404 };
      const { ownerId } = target;
      const updates: string[] = [];
      const params: ExecuteValues[] = [];
      if (has(body, 'title')) {
        if (!body.title?.trim()) return { error: 'Subtask title is required', status: 400 };
        updates.push('title = ?');
        params.push(body.title.trim());
      }
      if (has(body, 'is_done')) {
        updates.push('is_done = ?');
        params.push(!!body.is_done);
      }
      if (has(body, 'position')) {
        if (!Number.isInteger(body.position) || body.position! < 0) {
          return { error: 'position must be a non-negative integer', status: 400 };
        }
        updates.push('position = ?');
        params.push(body.position!);
      }
      const outcome = await withTransaction(async cx => {
        const locked = await calendarShares.lockEventWrite(cx, userId, eventId, ownerId, 'contribute', target.event.calendar_id ?? null);
        const [[point]] = locked ? await cx.execute<SubtaskRow[]>('SELECT * FROM calendar_event_subtasks WHERE id = ? AND event_id = ? AND user_id <=> ? FOR UPDATE', [subtaskId, eventId, ownerId]) : [[]];
        if (!locked || !point) return 'missing';
        // A contributor changes and ticks only the points they added, and moves none.
        if (!calendarShares.atLeast(locked.level, 'edit') && (has(body, 'position') || point.created_by !== userId)) return 'refused';
        if (updates.length) await cx.execute(`UPDATE calendar_event_subtasks SET ${updates.join(', ')} WHERE id = ? AND event_id = ? AND user_id <=> ?`, [...params, subtaskId, eventId, ownerId]);
        return 'done';
      });
      if (outcome === 'missing') return { error: 'Subtask not found', status: 404 };
      if (outcome === 'refused') return pointRefused();
      if (updates.length) await calendarShares.afterEventWrite(userId, target.event.calendar_id ?? null, { eventId, seriesKey: (target.event.series_id as string | null) ?? null, action: 'changed' });
      const subtasks = (await getCalendarSubtasksForEvents(ownerId, [eventId])).get(eventId) ?? [];
      return { subtask: subtasks.find((point: { id: string }) => point.id === subtaskId) ?? null };
    } catch (error) {
      console.error('Update subtask error:', error);
      return clientError(error, 'Failed to update subtask');
    }
  },

  'DELETE /api/calendar/events/:id/subtasks/:subtaskId': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const eventId = getCalendarEventIdFromReq(req)!;
      const subtaskId = getCalendarSubtaskIdFromReq(req)!;
      if (!eventId || !subtaskId) return { error: 'Invalid subtask route', status: 400 };

      const target = await calendarShares.eventTarget(userId, eventId);
      if (!target) return { error: 'Subtask not found', status: 404 };
      const { ownerId } = target;
      const outcome = await withTransaction(async cx => {
        const locked = await calendarShares.lockEventWrite(cx, userId, eventId, ownerId, 'contribute', target.event.calendar_id ?? null);
        const [[point]] = locked ? await cx.execute<SubtaskRow[]>('SELECT created_by FROM calendar_event_subtasks WHERE id = ? AND event_id = ? AND user_id <=> ? FOR UPDATE', [subtaskId, eventId, ownerId]) : [[]];
        if (!locked || !point) return 'missing';
        if (!calendarShares.atLeast(locked.level, 'edit') && point.created_by !== userId) return 'refused';
        await cx.execute('DELETE FROM calendar_event_subtasks WHERE id = ? AND event_id = ? AND user_id <=> ?', [subtaskId, eventId, ownerId]);
        return 'done';
      });
      if (outcome === 'missing') return { error: 'Subtask not found', status: 404 };
      if (outcome === 'refused') return pointRefused();
      await calendarShares.afterEventWrite(userId, target.event.calendar_id ?? null, { eventId, seriesKey: (target.event.series_id as string | null) ?? null, action: 'changed' });
      return { message: 'Subtask deleted' };
    } catch (error) {
      console.error('Delete subtask error:', error);
      return clientError(error, 'Failed to delete subtask');
    }
  },

  'POST /api/calendar/events/:id/subtasks/reorder': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const eventId = getCalendarEventIdFromReq(req)!;
      if (!eventId) return { error: 'Invalid event id', status: 400 };

      const subtaskIds = Array.isArray(body.subtask_ids) ? body.subtask_ids : null;
      if (!subtaskIds || subtaskIds.length === 0) {
        return { error: 'subtask_ids must be a non-empty array', status: 400 };
      }

      const target = await calendarShares.eventTarget(userId, eventId);
      if (!target) return { error: 'Event not found', status: 404 };
      const { ownerId } = target;
      const complete = await withTransaction(async cx => {
        if (!await calendarShares.lockEventWrite(cx, userId, eventId, ownerId, 'edit', target.event.calendar_id ?? null)) return false;
        const [existingRows] = await cx.execute<SubtaskRow[]>('SELECT id FROM calendar_event_subtasks WHERE event_id = ? AND user_id <=> ?', [eventId, ownerId]);
        const existingIds = new Set(existingRows.map((row) => row.id));
        if (existingIds.size !== subtaskIds.length || subtaskIds.some((id) => !existingIds.has(id))) return false;
        for (let index = 0; index < subtaskIds.length; index += 1) {
          await cx.execute('UPDATE calendar_event_subtasks SET position = ? WHERE id = ? AND event_id = ? AND user_id <=> ?', [index, subtaskIds[index], eventId, ownerId]);
        }
        return true;
      });
      if (!complete) return { error: 'subtask_ids must include all subtasks for the event', status: 400 };
      return { subtasks: (await getCalendarSubtasksForEvents(ownerId, [eventId])).get(eventId) ?? [] };
    } catch (error) {
      console.error('Reorder subtasks error:', error);
      return clientError(error, 'Failed to reorder subtasks');
    }
  },

  'DELETE /api/calendar/events/:id': oneChangeAtATime('Failed to delete event', async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const id = getCalendarEventIdFromReq(req)!;
      if (!id) return { error: 'Invalid event id', status: 400 };
      const target = await calendarShares.eventTarget(userId, id);
      if (!target) return { message: 'Event deleted', bin_item_ids: [] };
      const deleted = { eventId: id, seriesKey: (target.event.series_id as string | null) ?? null, action: 'deleted' as const };
      if (target.event.series_id) {
        // One date, or the whole series as one bin item.
        const binned = await calendarSeries.deleteSeriesEvent(userId, target, calendarSeries.seriesScope(new URL(req.url, 'http://localhost').searchParams.get('scope')));
        if (binned) await calendarShares.afterEventWrite(userId, target.event.calendar_id ?? null, deleted);
        return { message: binned ? 'Event moved to the bin' : 'Event deleted', bin_item_ids: binned ? [binned] : [] };
      }
      if (!target.own) {
        // Into the calendar's bin, under its guard.
        const binned = await binCalendar.binLocally(userId, target.event);
        if (binned) await calendarShares.afterEventWrite(userId, target.event.calendar_id ?? null, deleted);
        return { message: binned ? 'Event moved to the bin' : 'Event deleted', bin_item_ids: binned ? [binned] : [] };
      }
      const events = [target.event];
      const scope = new URL(req.url, 'http://localhost').searchParams.get('scope');
      // To the bin; a synced one is deleted at its server first, and a
      // refusal there leaves it as it is (bin-calendar.ts).
      try {
        await calendarMove.assertNotMoving(userId, id);
      } catch (error) {
        return calendarSync.calendarErrorResponse(error, 'Could not delete the event on the calendar server');
      }
      const outcome = await binCalendar.deleteEventToBin(userId, events[0], scope === 'series' ? 'series' : 'occurrence');
      if ('refused' in outcome) return outcome.refused;
      if (outcome.binned) await calendarShares.afterEventWrite(userId, target.event.calendar_id ?? null, deleted);
      return { message: outcome.binned ? 'Event moved to the bin' : 'Event deleted', bin_item_ids: outcome.binned ? [outcome.binned] : [] };
    } catch (error) {
      console.error('Delete event error:', error);
      return clientError(error, 'Failed to delete event');
    }
  }),
};
