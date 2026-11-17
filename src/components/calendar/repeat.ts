// The repeat rules UniHub's own calendars offer (contracts/calendar-series.ts),
// in the words of the event dialog. The server checks every rule again.
import { format } from 'date-fns';
import type { CalendarEvent } from '@/lib/calendar-api';
import type { RepeatRule } from '../../../api/src/contracts/calendar-series';

export type { RepeatRule };

const CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Monday first, as the weekday boxes of a custom rule stand. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0].map(day => ({ code: CODES[day], name: WEEKDAYS[day] }));
const ORDINALS: Record<string, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };

/** Whether an event is a date of a series. An old local event that only stores a rule never repeated. */
export const isRepeating = (event: Pick<CalendarEvent, 'series_key' | 'recurrence'>) => event.series_key === undefined ? !!event.recurrence : !!event.series_key;

const valid = (date: Date) => !Number.isNaN(date.getTime());
/** "2TU" for the second Tuesday; a fifth one is the month's last. */
const nthWeekday = (date: Date) => `${date.getDate() > 28 ? -1 : Math.ceil(date.getDate() / 7)}${CODES[date.getDay()]}`;

const key = (rule: RepeatRule | null | undefined) => rule
  ? [rule.freq, rule.interval ?? 1, [...(rule.by_day ?? [])].sort(), rule.by_month_day ?? '', rule.count ?? '', rule.until ?? ''].join('|') : '';
export const sameRule = (a: RepeatRule | null | undefined, b: RepeatRule | null | undefined) => key(a) === key(b);

/** The two ways a month repeats for an event that starts on `start`. */
export function monthlyRules(start: Date): { label: string; rule: RepeatRule }[] {
  const nth = nthWeekday(start);
  return [
    { label: `on day ${start.getDate()}`, rule: { freq: 'MONTHLY', by_month_day: start.getDate() } },
    { label: `on the ${ORDINALS[nth.slice(0, -2)]} ${WEEKDAYS[start.getDay()]}`, rule: { freq: 'MONTHLY', by_day: [nth] } },
  ];
}

/** The ready-made choices for an event that starts on `start`; anything else is a custom rule. */
export function repeatChoices(start: Date): { label: string; rule: RepeatRule | null }[] {
  return [
    { label: 'Does not repeat', rule: null },
    { label: 'Daily', rule: { freq: 'DAILY' } },
    { label: `Weekly on ${WEEKDAYS[start.getDay()]}`, rule: { freq: 'WEEKLY', by_day: [CODES[start.getDay()]] } },
    { label: 'Every weekday', rule: { freq: 'WEEKLY', by_day: ['MO', 'TU', 'WE', 'TH', 'FR'] } },
    ...monthlyRules(start).map(({ label, rule }) => ({ label: `Monthly ${label}`, rule })),
    { label: `Yearly on ${format(start, 'd MMMM')}`, rule: { freq: 'YEARLY' } },
  ];
}

/**
 * The rule after its event's start moved to another day: the weekdays of a
 * weekly rule and the day of a monthly one move with it. Sent with the moved
 * time, a series changed for all its dates then keeps them instead of
 * dropping the old weekday's dates and making new ones.
 */
export function followStart(rule: RepeatRule | null, from: Date, to: Date): RepeatRule | null {
  if (!rule || !valid(from) || !valid(to)) return rule;
  if (rule.freq === 'WEEKLY' && rule.by_day && !rule.by_day.includes(CODES[to.getDay()])) {
    const shift = to.getDay() - from.getDay() + 7;
    return { ...rule, by_day: rule.by_day.map(day => CODES[(CODES.indexOf(day) + shift) % 7]) };
  }
  if (rule.freq === 'MONTHLY' && rule.by_month_day === from.getDate()) return { ...rule, by_month_day: to.getDate() };
  if (rule.freq === 'MONTHLY' && rule.by_day?.[0] === nthWeekday(from)) return { ...rule, by_day: [nthWeekday(to)] };
  return rule;
}
