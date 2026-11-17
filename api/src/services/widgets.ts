import type { RowDataPacket } from 'mysql2/promise';
import type { CalendarPermission } from '../contracts/calendar-shares';
import type { WidgetAgendaItem, WidgetTask, WidgetsResponse } from '../contracts/widgets';

import { db } from '../state';
import { seriesKeySql } from './calendar';
import { reachedCalendars, viewsOfCalendars } from './calendar-shares';
import { settingValues } from './settings';
import { attachRanks, compareRanked } from './task-order';

// The Android widgets' one answer (contracts/widgets.ts): the next 14 days
// and the open tasks of the calendars the person has on, their own and those
// they reach, read like GET /api/calendar/events reads them. Titles follow
// the person's notification detail, never the app lock; free/busy calendars
// give "Busy" and no tasks; a tick is offered only where the person edits.

const LIMIT = 50;
const AGENDA_DAYS = 14;

const iso = (value: unknown) => (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString();

function zoneOrNull(zone: unknown) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return null;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); return zone; } catch { return null; }
}

/** "Today", "Tomorrow", "Mon 3 Feb" (with the year when not this one), and the time for a timed task, in the person's zone. */
function dateText(start: Date, allDay: boolean, zone: string, now: Date) {
  // All-day dates are stored at UTC midnight; reading them in another zone would move them a day.
  const tz = allDay ? 'UTC' : zone;
  const dayKey = (date: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const today = dayKey(now, zone);
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const day = dayKey(start, tz);
  const words = day === today ? 'Today' : day === tomorrow.toISOString().slice(0, 10) ? 'Tomorrow'
    : new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }) }).format(start);
  return allDay ? words : `${words} ${new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(start)}`;
}

/** GET /api/widgets. `deviceZone` stands in when the person has set no time zone. */
async function widgets(userId: string, deviceZone: string | null): Promise<WidgetsResponse> {
  const now = new Date();
  const [[person]] = await db.execute<RowDataPacket[]>('SELECT timezone FROM users WHERE id = ?', [userId]);
  const zone = zoneOrNull(person?.timezone) ?? zoneOrNull(deviceZone) ?? 'UTC';
  const detail = (await settingValues('user', userId)).reminder_notification_detail === 'none' ? 'none' : 'full';

  // The calendars others share with the person that they have on, at their level.
  const levels = await reachedCalendars(userId);
  const views = await viewsOfCalendars(userId, [...levels.keys()]);
  const reached = [...levels.keys()].filter(id => views.get(id)?.is_visible);
  const tasksFrom = reached.filter(id => levels.get(id) !== 'freebusy');
  const inList = (ids: readonly string[]) => ids.length ? ` OR e.calendar_id IN (${ids.map(() => '?').join(', ')})` : '';
  const own = '(e.user_id = ? AND (c.is_visible = TRUE OR c.is_visible IS NULL))';

  const [agendaRows] = await db.execute<RowDataPacket[]>(`SELECT e.id, e.calendar_id, e.user_id, e.title, e.start_time, e.end_time, e.all_day, e.color,
      c.color AS calendar_color
    FROM calendar_events e LEFT JOIN calendar_calendars c ON c.id = e.calendar_id
    WHERE (${own}${inList(reached)}) AND e.is_todo_only = FALSE
      AND e.end_time >= UTC_TIMESTAMP() AND e.start_time < UTC_TIMESTAMP() + INTERVAL ${AGENDA_DAYS} DAY
    ORDER BY e.start_time, e.id LIMIT ${LIMIT}`, [userId, ...reached]);
  const agenda: WidgetAgendaItem[] = agendaRows.map(row => {
    const calendarId = String(row.calendar_id ?? '');
    const mine = row.user_id === userId;
    const freebusy = !mine && levels.get(calendarId) === 'freebusy';
    return {
      id: String(row.id), calendar_id: calendarId,
      title: freebusy ? 'Busy' : detail === 'none' ? 'Event' : String(row.title),
      start_time: iso(row.start_time), end_time: iso(row.end_time), all_day: !!Number(row.all_day),
      color: String((mine ? row.color || row.calendar_color : views.get(calendarId)?.color) || '#2563eb'),
    };
  });

  const [taskRows] = await db.execute<RowDataPacket[]>(`SELECT e.id, e.calendar_id, e.user_id, e.title, e.start_time, e.end_time, e.all_day, e.is_todo_only,
      e.created_at, e.order_key, c.archived_at, ${seriesKeySql('e')} AS series_key
    FROM calendar_events e LEFT JOIN calendar_calendars c ON c.id = e.calendar_id
    WHERE (${own}${inList(tasksFrom)}) AND (c.auto_todo_enabled = TRUE OR c.auto_todo_enabled IS NULL)
      AND (e.todo_status IS NULL OR e.todo_status NOT IN ('done', 'cancelled'))`, [userId, ...tasksFrom]);
  const ranked = (await attachRanks(userId, taskRows as (RowDataPacket & { id: string; start_time: unknown; created_at: unknown; is_todo_only: unknown })[])).sort(compareRanked);
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const seen = new Set<string>();
  const open = ranked.flatMap(row => {
    const undated = !!Number(row.is_todo_only);
    const start = new Date(iso(row.start_time));
    const overdue = !undated && new Date(iso(row.end_time)).getTime() < now.getTime();
    const today = !undated && new Intl.DateTimeFormat('en-CA', { timeZone: row.all_day ? 'UTC' : zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(start) === todayKey;
    // A repeating item shows once among the tasks not yet due: its next date.
    if (!undated && !overdue && !today && row.series_key != null) {
      if (seen.has(String(row.series_key))) return [];
      seen.add(String(row.series_key));
    }
    const mine = row.user_id === userId;
    const level: CalendarPermission | undefined = mine ? (row.archived_at ? 'read' : 'manage') : levels.get(String(row.calendar_id));
    const task: WidgetTask = {
      id: row.id, calendar_id: String(row.calendar_id ?? ''),
      title: detail === 'none' ? null : String(row.title),
      date_text: undated ? null : dateText(start, !!Number(row.all_day), zone, now),
      overdue,
      can_tick: detail === 'full' && (level === 'edit' || level === 'manage'),
    };
    return [task];
  });
  return { detail, agenda, tasks: open.slice(0, LIMIT), more_tasks: Math.max(0, open.length - LIMIT), generated_at: now.toISOString() };
}

export { widgets, dateText };
