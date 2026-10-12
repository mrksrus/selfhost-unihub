import { formatEventTime, type CalendarEvent } from '@/lib/calendar-api';

/** "28 Sep, 18:00", "Today 11:00 to 11:30", "1 Oct" for all-day tasks. */
export function taskWhen(task: CalendarEvent, timezone: string | null, now = new Date()) {
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
