import { formatEventTime, type CalendarCalendar, type CalendarEvent } from '@/lib/calendar-api';

/** "28 Sep, 18:00", "Today 11:00 to 11:30", "1 Oct" for all-day tasks. */
export function taskWhen(task: Pick<CalendarEvent, 'is_todo_only' | 'all_day' | 'start_time' | 'end_time'>, timezone: string | null, now = new Date()) {
  if (task.is_todo_only) return 'No date';
  const day = formatEventTime(task.start_time, 'yyyy-MM-dd', timezone);
  const today = formatEventTime(now.toISOString(), 'yyyy-MM-dd', timezone);
  const dayLabel = day === today ? 'Today' : formatEventTime(task.start_time, 'd MMM', timezone);
  if (task.all_day) return dayLabel;
  const start = formatEventTime(task.start_time, 'HH:mm', timezone);
  const end = formatEventTime(task.end_time, 'HH:mm', timezone);
  return `${dayLabel} ${start}${end && end !== start ? ` to ${end}` : ''}`;
}

export const isOverdue = (task: CalendarEvent, now = Date.now()) => !task.is_todo_only && new Date(task.end_time).getTime() < now;

// The server's rank scale (api/src/services/task-order.ts RANK_SCALE): one
// second of start time spans this many ranks. A task from an older answer or
// snapshot without a rank gets one from its date on the same scale, so a
// mixed list still reads in date order.
const RANK_SCALE = 32768;

type Ranked = Pick<CalendarEvent, 'id' | 'start_time' | 'created_at' | 'is_todo_only'> & Partial<Pick<CalendarEvent, 'sort_rank'>>;

/** Where a task stands: its rank from the server, else a rank from its date (its creation for a task without a date). */
export function effectiveRank(task: Ranked) {
  if (typeof task.sort_rank === 'number' && Number.isFinite(task.sort_rank)) return task.sort_rank;
  const ms = new Date(task.is_todo_only ? task.created_at : task.start_time).getTime();
  return Math.floor((Number.isNaN(ms) ? 0 : ms) / 1000) * RANK_SCALE;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The person's order of tasks: by rank, equal ranks by id, as the server
 * orders them. ToDo applies it within each date section and Today to its
 * list; a task never placed by hand stays at its date's place.
 */
export function orderTasks<T extends Ranked>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => effectiveRank(a) - effectiveRank(b) || byId(a, b));
}

/**
 * A rank that sorts strictly between two neighbours until the server answers
 * with the rank it stored: the midpoint, or one step past the end. Ranks are
 * only compared, so a fraction is fine in the browser.
 */
export function rankBetween(after: Ranked | null, before: Ranked | null) {
  if (after && before) return (effectiveRank(after) + effectiveRank(before)) / 2;
  if (after) return effectiveRank(after) + 1;
  if (before) return effectiveRank(before) - 1;
  return 0;
}

/**
 * The neighbours a task gets when it moves to `index` within its section
 * (`after` just above it, `before` just below), as PUT …/position expects.
 */
export function neighboursAt<T extends { id: string }>(section: readonly T[], taskId: string, index: number): { after: T | null; before: T | null } {
  const others = section.filter(task => task.id !== taskId);
  const at = Math.max(0, Math.min(index, others.length));
  return { after: others[at - 1] ?? null, before: others[at] ?? null };
}

/** The reason a list cannot take a new item, in the words the chooser shows; null when it can. */
export function listRefusal(calendar: CalendarCalendar, { undated }: { undated: boolean }): string | null {
  if (calendar.write_block === 'read_only') return 'Read-only';
  if (calendar.write_block === 'sync_paused') return 'Sync is paused';
  if (undated && !calendar.takes_undated_tasks) return 'Tasks without a date stay in UniHub';
  return null;
}

/**
 * The list new tasks go to: the one the server marks (the default setting or
 * UniHub's fallback). An answer from an older server marks nothing; then the
 * first of the person's own lists shown in ToDo stands in.
 */
export function defaultTaskList(calendars: readonly CalendarCalendar[]) {
  return calendars.find(calendar => calendar.default_for_tasks)
    ?? calendars.find(calendar => calendar.takes_undated_tasks && calendar.auto_todo_enabled)
    ?? calendars.find(calendar => calendar.takes_undated_tasks)
    ?? null;
}

/** The calendar new events go to: the server's mark, else the first writable calendar. */
export function defaultEventCalendar(calendars: readonly CalendarCalendar[]) {
  return calendars.find(calendar => calendar.default_for_events)
    ?? calendars.find(calendar => !calendar.write_block)
    ?? null;
}

/** The name of a calendar's account as the chooser groups it: the person's own UniHub, or the server account. */
export function accountLabel(calendar: Pick<CalendarCalendar, 'account_provider' | 'account_display_name' | 'account_email'>) {
  if ((calendar.account_provider ?? 'local') === 'local') return 'On this UniHub';
  return calendar.account_display_name || calendar.account_email || 'Calendar server';
}

/** Calendars grouped by account, in the order the server lists them (oldest account first). */
export function groupByAccount<T extends CalendarCalendar>(calendars: readonly T[]) {
  const groups = new Map<string, { label: string; calendars: T[] }>();
  for (const calendar of calendars) {
    const group = groups.get(calendar.account_id) ?? { label: accountLabel(calendar), calendars: [] };
    group.calendars.push(calendar);
    groups.set(calendar.account_id, group);
  }
  return [...groups.values()];
}
