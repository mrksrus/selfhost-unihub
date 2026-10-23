import { useMemo } from 'react';
import { eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, isToday, parseISO, startOfMonth, startOfWeek } from 'date-fns';
import { CheckCircle2, MapPin, Plus, Repeat } from 'lucide-react';
import { formatEventTime, type CalendarEvent } from '@/lib/calendar-api';
import type { CalendarView } from '@/hooks/use-calendar-view';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayKey = (date: Date) => format(date, 'yyyy-MM-dd');

function groupByDay(events: CalendarEvent[]) {
  const map = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = format(parseISO(event.start_time), 'yyyy-MM-dd');
    map.set(key, [...(map.get(key) || []), event]);
  }
  for (const list of map.values()) list.sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.start_time.localeCompare(b.start_time));
  return map;
}

const timeRange = (event: CalendarEvent, timezone: string | null) => event.all_day ? 'All day'
  : `${formatEventTime(event.start_time, 'HH:mm', timezone)} to ${formatEventTime(event.end_time, 'HH:mm', timezone)}`;

/** A small colored pill inside a month or week cell. */
function Pill({ event, timezone, onOpen }: { event: CalendarEvent; timezone: string | null; onOpen: (event: CalendarEvent) => void }) {
  return (
    <button type="button" onClick={(click) => { click.stopPropagation(); onOpen(event); }}
      title={`${event.title}, ${timeRange(event, timezone)}`}
      className="flex w-full min-w-0 items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-left text-[11px] leading-4 hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ backgroundColor: `${event.color}26`, boxShadow: `inset 2px 0 0 ${event.color}` }}>
      {!event.all_day && <span className="shrink-0 tabular-nums text-muted-foreground">{formatEventTime(event.start_time, 'HH:mm', timezone)}</span>}
      <span className={cn('min-w-0 truncate', event.todo_status === 'done' && 'line-through opacity-70')}>{event.title}</span>
    </button>
  );
}

/** One event as a row: used for the selected day and the day view. */
export function EventLine({ event, timezone, onOpen }: { event: CalendarEvent; timezone: string | null; onOpen: (event: CalendarEvent) => void }) {
  return (
    <li>
      <button type="button" onClick={() => onOpen(event)}
        className="grid w-full grid-cols-[5.5rem_3px_1fr] items-stretch gap-3 border-b border-border py-2.5 text-left touch:py-3 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="pt-0.5 text-sm tabular-nums text-muted-foreground">
          {event.all_day ? 'All day' : <>{formatEventTime(event.start_time, 'HH:mm', timezone)}<span className="block text-xs">{formatEventTime(event.end_time, 'HH:mm', timezone)}</span></>}
        </span>
        <span aria-hidden="true" className="rounded-full" style={{ backgroundColor: event.color }} />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            {event.recurrence && <Repeat className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Repeats" />}
            <span className={cn('min-w-0 break-words', event.todo_status === 'done' && 'text-muted-foreground line-through')}>{event.title}</span>
            {event.todo_status === 'done' && <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-label="Done" />}
          </span>
          {event.location && <span className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground"><MapPin aria-hidden="true" className="h-3.5 w-3.5" />{event.location}</span>}
        </span>
      </button>
    </li>
  );
}

interface GridProps {
  view: CalendarView;
  events: CalendarEvent[];
  timezone: string | null;
  onOpen: (event: CalendarEvent) => void;
  onNew: (date: Date) => void;
}

/** The period: a month of days, a week of columns or one day as a list. */
export function CalendarGrid({ view, events, timezone, onOpen, onNew }: GridProps) {
  const byDay = useMemo(() => groupByDay(events), [events]);
  const { viewMode, currentDate, selectedDate, selectDay, weekStartsOn } = view;
  const week = { weekStartsOn };

  if (viewMode === 'day') {
    const list = byDay.get(dayKey(selectedDate)) || [];
    return list.length === 0
      ? <DayEmpty date={selectedDate} onNew={onNew} />
      : <ul className="border-t border-border">{list.map(event => <EventLine key={event.id} event={event} timezone={timezone} onOpen={onOpen} />)}</ul>;
  }

  const days = viewMode === 'week'
    ? eachDayOfInterval({ start: startOfWeek(currentDate, week), end: endOfWeek(currentDate, week) })
    : eachDayOfInterval({ start: startOfWeek(startOfMonth(currentDate), week), end: endOfWeek(endOfMonth(currentDate), week) });
  const weekdays = [...WEEKDAYS.slice(weekStartsOn), ...WEEKDAYS.slice(0, weekStartsOn)];
  const month = viewMode === 'month';
  const limit = month ? 3 : 8;

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div aria-hidden="true" className="grid grid-cols-7 border-b border-border bg-card text-xs text-muted-foreground">
        {weekdays.map(day => <div key={day} className="px-2 py-1.5">{day}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day, index) => {
          const list = byDay.get(dayKey(day)) || [];
          const selected = isSameDay(day, selectedDate);
          const outside = month && !isSameMonth(day, currentDate);
          return (
            <div key={dayKey(day)} onClick={() => selectDay(day)}
              className={cn('flex cursor-pointer flex-col gap-0.5 border-border p-1 transition-colors',
                index % 7 !== 6 && 'border-r', index < days.length - 7 && 'border-b',
                month ? 'min-h-[5.5rem] md:min-h-[6.75rem]' : 'min-h-[14rem]',
                selected ? 'bg-muted/70' : 'hover:bg-muted/30', outside && 'text-muted-foreground/60')}>
              <button type="button" onClick={(click) => { click.stopPropagation(); selectDay(day); }}
                aria-label={`${format(day, 'EEEE d MMMM')}${list.length ? `, ${list.length} ${list.length === 1 ? 'event' : 'events'}` : ''}`}
                aria-pressed={selected} aria-current={isToday(day) ? 'date' : undefined}

                className={cn('mb-0.5 flex h-6 min-w-6 items-center justify-center self-start rounded-full px-1.5 text-xs tabular-nums touch:h-7 touch:min-w-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isToday(day) ? 'bg-accent font-semibold text-accent-foreground' : selected ? 'font-semibold text-foreground' : '')}>
                {!month ? format(day, 'EEE d') : format(day, 'd')}
              </button>
              {/* Phones show dots in the month; the selected day lists its events below. */}
              {month && list.length > 0 && (
                <span aria-hidden="true" className="flex flex-wrap gap-0.5 px-1 md:hidden">
                  {list.slice(0, 4).map(event => <span key={event.id} className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: event.color }} />)}
                </span>
              )}
              <div className={cn('min-w-0 space-y-0.5', month && 'hidden md:block')}>
                {list.slice(0, limit).map(event => <Pill key={event.id} event={event} timezone={timezone} onOpen={onOpen} />)}
                {list.length > limit && <span className="block px-1.5 text-[11px] text-muted-foreground">{list.length - limit} more</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DayEmpty({ date, onNew }: { date: Date; onNew: (date: Date) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-y border-border py-3 text-sm text-muted-foreground">
      Nothing on {format(date, 'EEEE d MMMM')}.
      <Button variant="ghost" size="sm" onClick={() => onNew(date)}><Plus aria-hidden="true" />Add event</Button>
    </div>
  );
}

/** The events of the selected day, shown next to (or below) the month and week. */
export function SelectedDay({ date, events, timezone, onOpen, onNew }: { date: Date; events: CalendarEvent[]; timezone: string | null; onOpen: (event: CalendarEvent) => void; onNew: (date: Date) => void }) {
  const list = useMemo(() => groupByDay(events).get(dayKey(date)) || [], [events, date]);
  return (
    <section aria-label={format(date, 'EEEE d MMMM')}>
      <div className="mb-1 flex items-center justify-between gap-2 border-b border-border pb-2">
        <h2 className="text-sm font-medium">{isToday(date) ? 'Today' : format(date, 'EEEE')}<span className="ml-1.5 font-normal text-muted-foreground">{format(date, 'd MMMM')}</span></h2>
        <Button variant="ghost" size="sm" className="-mr-2 h-8" onClick={() => onNew(date)}><Plus aria-hidden="true" />Add</Button>
      </div>
      {list.length === 0
        ? <p className="py-2.5 text-sm text-muted-foreground">Nothing scheduled.</p>
        : <ul>{list.map(event => <EventLine key={event.id} event={event} timezone={timezone} onOpen={onOpen} />)}</ul>}
    </section>
  );
}
