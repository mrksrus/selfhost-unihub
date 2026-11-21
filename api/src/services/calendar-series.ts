// Repeating events in UniHub's own calendars (contracts/calendar-series.ts).
// A series is one calendar_series row holding its iCalendar text: the rule,
// its creator's zone (DTSTART's TZID and the calendar's X-WR-TIMEZONE),
// removed dates (EXDATE) and changed ones (RECURRENCE-ID), as calendar-ical.ts
// reads and writes them for synced series. Each date in the sync's window is
// a calendar_events row (series_id, recurrence_id) applied in place by its
// recurrence key, so it keeps its id and with it its ToDo state, points,
// attendees, order and reminders. Every reader keeps reading rows.
import type { ExecuteValues, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { CalendarEvent } from '../types/calendar';
import type { RepeatRule, SeriesDetail, SeriesScope } from '../contracts/calendar-series';
import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, conflict, notFound } from '../http/errors';
import { withTransaction } from './transactions';
import * as ical from './calendar-ical';
import { toMysqlDatetime, parseDatetimeToMillis, replaceEventAttendees } from './calendar';
import { fenceTaskLocks, calendarAdmission } from './calendar-move-state';
import { binLocalEvents, binSeries } from './bin-calendar';
import { calendarWrite, lockEventWrite, setOwnReminders } from './calendar-shares';

type Row = RowDataPacket & CalendarEvent;
interface SeriesRow { id: string; calendar_id: string; ics: string }
type Fields = Parameters<typeof ical.updateEventIcs>[1];

const DAY_MS = 86400000;
const WINDOW_PAST_MS = 365 * DAY_MS;
const WINDOW_FUTURE_MS = 730 * DAY_MS;
// A daily series fills the window.
const MAX_DATES = 1100;
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const WEEK_STARTS: Readonly<Record<string, string>> = { monday: 'MO', sunday: 'SU', saturday: 'SA' };

const unsupported = (part: string) => badRequest('RRULE_UNSUPPORTED', `This repeat rule is not offered (${part}).`);
const pad = (value: number) => String(value).padStart(2, '0');
const placeholders = (items: readonly unknown[]) => items.map(() => '?').join(', ');
const utcKey = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
// A recurrence key (calendar-ical.ts recurrenceKey: a date, or a UTC time) as a time.
const keyMs = (key: string) => key.length === 8 ? Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8))
  : Date.parse(key.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
const shiftedKey = (key: string, deltaMs: number, anchorMs: number, timeZone: string) => key.length === 8
  ? new Date(keyMs(key) + Math.round(deltaMs / DAY_MS) * DAY_MS).toISOString().slice(0, 10).replace(/-/g, '') : utcKey(ical.shiftInZone(keyMs(key), deltaMs, anchorMs, timeZone));

/** The RRULE of a rule the boundary accepts; UNTIL is the end of that day in the series' zone. */
function ruleText(input: unknown, { allDay, timeZone, weekStart }: { allDay: boolean; timeZone: string; weekStart: string }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw unsupported('expected { freq, … }');
  const { freq, interval = 1, by_day: byDay, by_month_day: byMonthDay, count, until, ...rest } = input as RepeatRule;
  if (Object.keys(rest).length) throw unsupported(Object.keys(rest).join(', '));
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) throw unsupported('freq');
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) throw unsupported('interval 1 to 99');
  const parts = [`FREQ=${freq}`, ...(interval > 1 ? [`INTERVAL=${interval}`] : [])];
  if (byDay !== undefined) {
    const days = Array.isArray(byDay) ? byDay.map(String) : [];
    const weekly = freq === 'WEEKLY' && days.length > 0 && new Set(days).size === days.length && days.every(day => DAYS.includes(day));
    const monthly = freq === 'MONTHLY' && byMonthDay === undefined && days.length === 1 && /^-?[1-5](MO|TU|WE|TH|FR|SA|SU)$/.test(days[0]);
    if (!weekly && !monthly) throw unsupported('by_day');
    parts.push(`BYDAY=${days.join(',')}`);
  }
  if (byMonthDay !== undefined) {
    if (freq !== 'MONTHLY' || !Number.isInteger(byMonthDay) || byMonthDay < 1 || byMonthDay > 31) throw unsupported('by_month_day');
    parts.push(`BYMONTHDAY=${byMonthDay}`);
  }
  if (count !== undefined && until !== undefined) throw unsupported('count or until, not both');
  if (count !== undefined) {
    if (!Number.isInteger(count) || count < 1 || count > 999) throw unsupported('count 1 to 999');
    parts.push(`COUNT=${count}`);
  }
  if (until !== undefined) {
    const [year, month, day] = (/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(until)) ?? []).slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw unsupported('until as YYYY-MM-DD');
    parts.push(`UNTIL=${allDay ? `${year}${pad(month)}${pad(day)}` : utcKey(ical.zonedWallTimeToUtc({ year, month, day, hour: 23, minute: 59, second: 59 }, timeZone))}`);
  }
  if (freq === 'WEEKLY') parts.push(`WKST=${WEEK_STARTS[weekStart] ?? 'MO'}`);
  return parts.join(';');
}

/** The rule a stored RRULE says, for the event dialog. */
function repeatOf(rrule: string | null, timeZone: string): RepeatRule | null {
  if (!rrule) return null;
  const parts = new Map(rrule.split(';').map(part => part.split('=') as [string, string]));
  const until = parts.get('UNTIL');
  const date = !until ? null : until.length === 8 ? { year: +until.slice(0, 4), month: +until.slice(4, 6), day: +until.slice(6, 8) } : ical.utcToZonedFields(keyMs(until), timeZone);
  const number = (name: string, key: keyof RepeatRule) => parts.has(name) ? { [key]: Number(parts.get(name)) } : {};
  return {
    freq: parts.get('FREQ') as RepeatRule['freq'], ...number('INTERVAL', 'interval'),
    ...(parts.has('BYDAY') ? { by_day: parts.get('BYDAY')!.split(',') } : {}), ...number('BYMONTHDAY', 'by_month_day'), ...number('COUNT', 'count'),
    ...(date ? { until: `${date.year}-${pad(date.month)}-${pad(date.day)}` } : {}),
  };
}

/** scope of a change or delete of a date of a local series: occurrence when left out. */
function seriesScope(value: unknown): SeriesScope {
  if (value == null || value === 'occurrence' || value === 'series') return (value ?? 'occurrence') as SeriesScope;
  throw badRequest('SERIES_SCOPE_INVALID', 'scope is occurrence or series.');
}

/** The zone a new series keeps: the one sent, else the person's own. */
async function seriesZone(executor: SqlExecutor, userId: string, given: unknown) {
  if (given != null) {
    if (!ical.isValidTimeZone(given)) throw badRequest('TIME_ZONE_INVALID', 'Choose a valid time zone.');
    return given;
  }
  const [[user]] = await executor.execute<RowDataPacket[]>('SELECT timezone FROM users WHERE id = ?', [userId]);
  return ical.resolveUserTimeZone(user?.timezone);
}

async function rule(executor: SqlExecutor, userId: string, repeat: unknown, allDay: boolean, timeZone: string) {
  const { getSettings } = require('./settings') as typeof import('./settings');
  const weekStart = String((await getSettings('user', userId, userId, executor)).week_start?.value ?? 'monday');
  return ruleText(repeat, { allDay, timeZone, weekStart });
}

/** Whether a calendar takes a series: UniHub's own, or one no person owns; never a synced one. */
async function isLocalCalendar(executor: SqlExecutor, calendarId: string | null | undefined) {
  if (!calendarId) return false;
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT a.provider FROM calendar_calendars c LEFT JOIN calendar_accounts a ON a.id = c.account_id WHERE c.id = ?`, [calendarId]);
  return !!row && (row.provider == null || row.provider === 'local');
}

const lockSeries = async (cx: SqlExecutor, seriesId: string) =>
  ((await cx.execute<RowDataPacket[]>('SELECT id, calendar_id, ics FROM calendar_series WHERE id = ? FOR UPDATE', [seriesId]))[0][0] as SeriesRow | undefined) ?? null;
const saveIcs = (cx: SqlExecutor, seriesId: string, ics: string) => cx.execute('UPDATE calendar_series SET ics = ? WHERE id = ?', [ics, seriesId]);

/**
 * Brings a series' dates in the window to what its iCalendar text says, in
 * place: a date found by its recurrence key keeps its row, a new one is
 * inserted. addOnly (the daily extension) only adds. Otherwise a date that
 * left the rule goes to the bin when it holds something of its own (a ToDo
 * state, points, attendees) and is removed when not. Dates before the window
 * keep their rows: they are the person's history.
 */
async function applySeries(cx: SqlExecutor, series: SeriesRow, ownerId: string | null, { addOnly = false } = {}) {
  const now = Date.now();
  const windowStartMs = now - WINDOW_PAST_MS;
  const expanded = ical.expandCalendarObject(series.ics, { windowStartMs, windowEndMs: now + WINDOW_FUTURE_MS, userTimeZone: ical.seriesRule(series.ics).timeZone, maxOccurrences: MAX_DATES });
  // A capped expansion says nothing about the dates after its last one.
  const coveredUntil = expanded.occurrences.length >= MAX_DATES ? Math.max(...expanded.occurrences.map(date => keyMs(date.recurrenceId))) : now + WINDOW_FUTURE_MS;
  const [rows] = await cx.execute<Row[]>('SELECT id, recurrence_id FROM calendar_events WHERE series_id = ? FOR UPDATE', [series.id]);
  const byKey = new Map(rows.map(row => [String(row.recurrence_id), String(row.id)]));
  const [[calendar]] = await cx.execute<RowDataPacket[]>('SELECT color FROM calendar_calendars WHERE id = ?', [series.calendar_id]);
  const recurrence = expanded.rrule?.slice(0, 100) ?? null;
  const keep = new Set<string>();
  let added = 0;
  for (const date of expanded.occurrences) {
    keep.add(date.recurrenceId);
    const id = byKey.get(date.recurrenceId);
    if (id && addOnly) continue;
    const values = [series.calendar_id, date.title, date.description, date.location, toMysqlDatetime(new Date(date.startMs).toISOString()),
      toMysqlDatetime(new Date(date.endMs).toISOString()), date.allDay ? 1 : 0, date.reminders.length ? JSON.stringify(date.reminders) : null, recurrence];
    if (id) {
      await cx.execute(`UPDATE calendar_events SET calendar_id = ?, title = ?, description = ?, location = ?, start_time = ?, end_time = ?, all_day = ?, reminders = ?, recurrence = ?
        WHERE id = ?`, [...values, id]);
      continue;
    }
    const newId = crypto.randomUUID();
    await cx.execute(`INSERT INTO calendar_events (calendar_id, title, description, location, start_time, end_time, all_day, reminders, recurrence, id, user_id, color, series_id, recurrence_id, uid)
      VALUES (${placeholders(values)}, ?, ?, ?, ?, ?, ?)`, [...values, newId, ownerId, calendar?.color ?? '#2563eb', series.id, date.recurrenceId, newId]);
    added += 1;
  }
  if (addOnly) return added;
  const left = rows.filter(row => !keep.has(String(row.recurrence_id)) && keyMs(String(row.recurrence_id)) >= windowStartMs && keyMs(String(row.recurrence_id)) <= coveredUntil).map(row => String(row.id));
  await dropDates(cx, ownerId, left);
  return added;
}

/** Dates that left the rule: to the bin when they hold something of their own (a ToDo state, points, attendees), else removed. */
async function dropDates(cx: SqlExecutor, ownerId: string | null, left: readonly string[]) {
  if (!left.length) return;
  const [held] = await cx.execute<RowDataPacket[]>(`SELECT e.id FROM calendar_events e WHERE e.id IN (${placeholders(left)}) AND (e.todo_status IS NOT NULL
    OR EXISTS (SELECT 1 FROM calendar_event_subtasks s WHERE s.event_id = e.id) OR EXISTS (SELECT 1 FROM calendar_event_attendees a WHERE a.event_id = e.id))`, [...left]);
  const kept = held.map(row => String(row.id));
  await binLocalEvents(cx, ownerId, kept);
  const gone = left.filter(id => !kept.includes(id));
  if (gone.length) await cx.execute(`DELETE FROM calendar_events WHERE id IN (${placeholders(gone)})`, gone);
}

/**
 * In the caller's transaction, after the calendar's guard: a single local
 * event becomes the first date of a new series, the others are added.
 */
async function startSeries(cx: SqlExecutor, userId: string, ownerId: string | null, eventId: string, repeat: unknown, timeZoneInput?: unknown) {
  const [[event]] = await cx.execute<Row[]>('SELECT * FROM calendar_events WHERE id = ? AND user_id <=> ? FOR UPDATE', [eventId, ownerId]);
  if (!event) throw notFound('CALENDAR_EVENT_NOT_FOUND', 'Event not found');
  if (Number(event.is_todo_only)) throw unsupported('a task without a date does not repeat');
  if (event.source_email_id) throw unsupported('a task from an email does not repeat');
  if (!await isLocalCalendar(cx, event.calendar_id)) throw unsupported('a synced calendar takes repeating events from its server only');
  const timeZone = await seriesZone(cx, userId, timeZoneInput);
  const allDay = !!Number(event.all_day);
  const startMs = parseDatetimeToMillis(event.start_time)!;
  const reminders = typeof event.reminders === 'string' ? JSON.parse(event.reminders) : event.reminders;
  const { uid, ics } = ical.createEventIcs({ title: event.title, description: event.description, location: event.location, startMs, endMs: parseDatetimeToMillis(event.end_time)!, allDay, reminders },
    { userTimeZone: timeZone, rrule: await rule(cx, userId, repeat, allDay, timeZone) });
  const series = { id: crypto.randomUUID(), calendar_id: String(event.calendar_id), ics };
  await cx.execute('INSERT INTO calendar_series (id, calendar_id, uid, ics) VALUES (?, ?, ?, ?)', [series.id, series.calendar_id, uid, ics]);
  const [first] = ical.expandCalendarObject(ics, { windowStartMs: startMs - DAY_MS, windowEndMs: startMs + DAY_MS, userTimeZone: timeZone, maxOccurrences: 1 }).occurrences;
  await cx.execute('UPDATE calendar_events SET series_id = ?, recurrence_id = ? WHERE id = ?', [series.id, first?.recurrenceId ?? utcKey(startMs), eventId]);
  await applySeries(cx, series, ownerId);
  return series.id;
}

interface SeriesChange {
  /** The row's own columns (routes/calendar.ts eventFieldUpdates), for one date and for an event a rule is added to or removed from. */
  updates: string[];
  params: ExecuteValues[];
  /** The fields the iCalendar text holds, as changed. */
  fields: Fields;
  /** Every date's colour, when all dates change (one date's is in updates). */
  color?: string;
  /** Left out: unchanged; null: the rule removed. */
  repeat?: unknown;
  timeZone?: unknown;
  scope: SeriesScope;
  moveTo: string | null;
  attendees?: unknown;
  /** The caller's own reminders (they do not own the event or keep their own), or undefined. */
  ownReminders?: unknown[];
}

/**
 * PUT /api/calendar/events/:id of a date of a local series, or of a local
 * event a rule is added to, under the calendar's guard: one date (an
 * exception and its row), every date (the series, then its rows in place),
 * the rule changed, or removed (the date stays single, the series goes to
 * the bin). A series moves only whole, to a local calendar of the same owner.
 */
async function changeSeriesEvent(userId: string, target: { event: CalendarEvent; ownerId: string | null }, change: SeriesChange) {
  const { event, ownerId } = target;
  const { updates, params, fields, repeat, scope, moveTo, attendees, ownReminders } = change;
  const edits = updates.length > 0 || Object.keys(fields).length > 0 || change.color !== undefined || repeat !== undefined || !!moveTo || Array.isArray(attendees);
  await withTransaction(async cx => {
    const locked = await lockEventWrite(cx, userId, event.id, ownerId, edits ? 'edit' : 'read', event.calendar_id ?? null);
    if (!locked) throw notFound('CALENDAR_EVENT_NOT_FOUND', 'Event not found');
    await fenceTaskLocks(cx);
    const row = locked.event;
    const series = row.series_id ? await lockSeries(cx, String(row.series_id)) : null;
    const wholeSeries = !!series && (scope === 'series' || (repeat !== undefined && repeat !== null));
    if (moveTo) {
      if (series && !wholeSeries) throw conflict('SERIES_MOVE_REFUSED', 'A repeating event moves only as a whole.');
      if ((await calendarWrite(cx, userId, moveTo, 'edit')).ownerId !== ownerId || !await isLocalCalendar(cx, moveTo)) {
        throw conflict('SERIES_MOVE_REFUSED', 'A repeating event moves only to another UniHub calendar of the same owner.');
      }
    }
    const setRow = (sets: string[], values: ExecuteValues[]) => sets.length ? cx.execute(`UPDATE calendar_events SET ${sets.join(', ')} WHERE id = ?`, [...values, row.id]) : null;
    const rowMove = moveTo && !series ? { sets: ['calendar_id = ?'], values: [moveTo] } : { sets: [], values: [] };
    if (!series || repeat === null) {
      // A single event (a rule added makes it the first date), or the date a removed rule leaves single.
      await setRow([...updates, ...rowMove.sets, ...(series ? ['series_id = NULL', 'recurrence_id = NULL', 'recurrence = NULL'] : [])], [...params, ...rowMove.values]);
      if (series) await binSeries(cx, ownerId, series.id);
      const seriesId = !series && repeat ? await startSeries(cx, userId, ownerId, row.id, repeat, change.timeZone) : null;
      if (ownReminders) await setOwnReminders(cx, userId, seriesId ? { seriesId } : row.id, ownReminders);
    } else if (!wholeSeries) {
      const { timeZone } = ical.seriesRule(series.ics);
      if (Object.keys(fields).length) {
        // An exception starts as a copy of the first date: it keeps this date's own times.
        const times = { startMs: parseDatetimeToMillis(row.start_time)!, endMs: parseDatetimeToMillis(row.end_time)!, allDay: !!Number(row.all_day) };
        await saveIcs(cx, series.id, ical.updateEventIcs(series.ics, { ...times, ...fields }, { recurrenceId: String(row.recurrence_id), scope: 'occurrence', userTimeZone: timeZone, tzid: timeZone }));
      }
      await setRow(updates, params);
      if (ownReminders) await setOwnReminders(cx, userId, row.id, ownReminders);
    } else {
      const { timeZone } = ical.seriesRule(series.ics);
      const previousStartMs = parseDatetimeToMillis(row.start_time);
      let ics = Object.keys(fields).length ? ical.updateEventIcs(series.ics, fields, { recurrenceId: String(row.recurrence_id), scope: 'series', previousStartMs, userTimeZone: timeZone, tzid: timeZone }) : series.ics;
      if (repeat) ics = ical.seriesRule(ics, await rule(cx, userId, repeat, fields.allDay ?? !!Number(row.all_day), timeZone)).ics;
      // Moving the series moves each date's key with it, as its EXDATEs and exceptions move (calendar-ical.ts).
      const deltaMs = fields.startMs !== undefined && previousStartMs !== null && !!fields.allDay === !!Number(row.all_day) ? fields.startMs - previousStartMs : 0;
      if (deltaMs) {
        const [dates] = await cx.execute<Row[]>(`SELECT id, recurrence_id FROM calendar_events WHERE series_id = ? ORDER BY recurrence_id ${deltaMs > 0 ? 'DESC' : 'ASC'} FOR UPDATE`, [series.id]);
        for (const date of dates) await cx.execute('UPDATE calendar_events SET recurrence_id = ? WHERE id = ?', [shiftedKey(String(date.recurrence_id), deltaMs, previousStartMs!, timeZone), date.id]);
      }
      const calendarId = moveTo ?? series.calendar_id;
      if (moveTo) {
        await cx.execute('UPDATE calendar_series SET calendar_id = ? WHERE id = ?', [moveTo, series.id]);
        await cx.execute('UPDATE calendar_events SET calendar_id = ? WHERE series_id = ?', [moveTo, series.id]);
      }
      await saveIcs(cx, series.id, ics);
      await applySeries(cx, { ...series, calendar_id: calendarId, ics }, ownerId);
      if (change.color !== undefined) await cx.execute('UPDATE calendar_events SET color = ? WHERE series_id = ?', [change.color, series.id]);
      if (ownReminders) await setOwnReminders(cx, userId, { seriesId: series.id }, ownReminders);
    }
    // Attendees are each date's own, as its points are (a date a new rule left has none).
    const [[still]] = await cx.execute<RowDataPacket[]>('SELECT id FROM calendar_events WHERE id = ?', [row.id]);
    if (Array.isArray(attendees) && still) await replaceEventAttendees(ownerId, row.id, attendees, cx);
  });
  return edits;
}

/** A date's own times (a ToDo "Moved" time) as its exception, so a change to every date keeps them. */
async function keepDateTimes(cx: SqlExecutor, eventId: string) {
  const [[row]] = await cx.execute<Row[]>('SELECT series_id, recurrence_id, start_time, end_time, all_day FROM calendar_events WHERE id = ?', [eventId]);
  const series = row?.series_id ? await lockSeries(cx, String(row.series_id)) : null;
  if (!series) return;
  const { timeZone } = ical.seriesRule(series.ics);
  const times = { startMs: parseDatetimeToMillis(row.start_time)!, endMs: parseDatetimeToMillis(row.end_time)!, allDay: !!Number(row.all_day) };
  await saveIcs(cx, series.id, ical.updateEventIcs(series.ics, times, { recurrenceId: String(row.recurrence_id), scope: 'occurrence', userTimeZone: timeZone, tzid: timeZone }));
}

/** DELETE /api/calendar/events/:id of a date of a local series: one date (an EXDATE, the row to the bin) or the whole series as one bin item. */
async function deleteSeriesEvent(userId: string, target: { event: CalendarEvent; ownerId: string | null }, scope: SeriesScope) {
  const { event, ownerId } = target;
  return withTransaction(async cx => {
    const locked = await lockEventWrite(cx, userId, event.id, ownerId, 'edit', event.calendar_id ?? null);
    if (!locked) return null;
    await fenceTaskLocks(cx);
    const series = locked.event.series_id ? await lockSeries(cx, String(locked.event.series_id)) : null;
    if (series && scope === 'series') return binSeries(cx, ownerId, series.id, { first: event.id });
    if (series) {
      const { timeZone } = ical.seriesRule(series.ics);
      await saveIcs(cx, series.id, ical.removeOccurrenceIcs(series.ics, String(locked.event.recurrence_id), { userTimeZone: timeZone })!);
    }
    return (await binLocalEvents(cx, ownerId, [event.id]))[0] ?? null;
  });
}

/** An event as GET answers it, with its rule and zone when it is a date of a local series. */
async function withSeriesDetail<T extends Record<string, unknown>>(event: T | null): Promise<(T & Partial<SeriesDetail>) | null> {
  if (!event?.series_id) return event;
  const [[series]] = await db.execute<RowDataPacket[]>('SELECT ics FROM calendar_series WHERE id = ?', [String(event.series_id)]);
  if (!series) return event;
  const { rrule, timeZone } = ical.seriesRule(series.ics);
  return { ...event, repeat: repeatOf(rrule, timeZone), time_zone: timeZone };
}

/**
 * Once a day per calendar (from the calendar sync pass): the dates that came
 * into the window are added; nothing is changed or removed. A calendar whose
 * owner's calendar restore runs waits; one whose owner has Calendar off waits
 * for the next day.
 */
async function extendSeries() {
  const [calendars] = await db.execute<RowDataPacket[]>(`SELECT DISTINCT c.id, c.user_id FROM calendar_series s JOIN calendar_calendars c ON c.id = s.calendar_id
    WHERE c.remote_expanded_on IS NULL OR c.remote_expanded_on < UTC_DATE() LIMIT 100`);
  let added = 0;
  for (const calendar of calendars) {
    const ownerId = calendar.user_id == null ? null : String(calendar.user_id);
    const refusal = ownerId ? await calendarAdmission(ownerId) : null;
    if (refusal?.code === 'RESTORE_IN_PROGRESS') continue;
    added += await withTransaction(async cx => {
      await cx.execute('SELECT id FROM calendar_calendars WHERE id = ? FOR UPDATE', [calendar.id]);
      let count = 0;
      const [series] = refusal ? [[]] : await cx.execute<RowDataPacket[]>('SELECT id, calendar_id, ics FROM calendar_series WHERE calendar_id = ? FOR UPDATE', [calendar.id]);
      for (const row of series) count += await applySeries(cx, row as SeriesRow, ownerId, { addOnly: true });
      await cx.execute('UPDATE calendar_calendars SET remote_expanded_on = UTC_DATE() WHERE id = ?', [calendar.id]);
      return count;
    });
  }
  return added;
}

export { ruleText, repeatOf, seriesScope, isLocalCalendar, startSeries, applySeries, dropDates, changeSeriesEvent, keepDateTimes, deleteSeriesEvent, withSeriesDetail, extendSeries };
