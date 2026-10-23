import { addDays, addHours, addMonths, addWeeks, format, isSameDay, isSameYear, isThisYear, set } from 'date-fns';
import type { SnoozeChoice } from '@/lib/settings-api';

// The times Snooze and Send later offer (0.24). "Morning" is 08:00 in the
// browser's local time; "tomorrow" and "next week" land on that hour so a
// message comes back (or goes out) at the start of a working day.
export const MORNING_HOUR = 8;

export const morningOf = (date: Date) => set(date, { hours: MORNING_HOUR, minutes: 0, seconds: 0, milliseconds: 0 });
export const tomorrowMorning = (now: Date) => morningOf(addDays(now, 1));
/** Monday 08:00 of the next week; on a Sunday that is tomorrow. */
export function nextMondayMorning(now: Date) {
  const ahead = (8 - now.getDay()) % 7 || 7;
  return morningOf(addDays(now, ahead));
}

export interface WhenChoice { id: string; label: string; at: Date }

/** When a snooze choice ends. */
export function snoozeChoiceTime(choice: SnoozeChoice, now: Date): Date {
  switch (choice) {
    case '1h': return addHours(now, 1);
    case '3h': return addHours(now, 3);
    case 'tomorrow': return tomorrowMorning(now);
    case '1d': return addDays(now, 1);
    case '2d': return addDays(now, 2);
    case 'next_week': return nextMondayMorning(now);
    case '1w': return addWeeks(now, 1);
    case '2w': return addWeeks(now, 2);
    case '1mo': return addMonths(now, 1);
  }
}

const SNOOZE_LABELS: Record<SnoozeChoice, string> = {
  '1h': 'In 1 hour', '3h': 'In 3 hours', tomorrow: 'Tomorrow morning', '1d': 'In 1 day', '2d': 'In 2 days',
  next_week: 'Next week', '1w': 'In 1 week', '2w': 'In 2 weeks', '1mo': 'In 1 month',
};
export const snoozeChoiceLabel = (choice: SnoozeChoice) => SNOOZE_LABELS[choice];

/** The person's snooze choices (Settings, Mail) as menu entries; unknown tokens are left out. */
export function snoozeChoices(choices: readonly string[], now = new Date()): WhenChoice[] {
  return choices.filter((choice): choice is SnoozeChoice => choice in SNOOZE_LABELS)
    .map(choice => ({ id: choice, label: snoozeChoiceLabel(choice), at: snoozeChoiceTime(choice, now) }));
}

/** Send later: in an hour, tomorrow morning, and Monday morning before a weekend. */
export function sendLaterChoices(now = new Date()): WhenChoice[] {
  const choices: WhenChoice[] = [
    { id: '1h', label: 'In 1 hour', at: addHours(now, 1) },
    { id: 'tomorrow', label: 'Tomorrow morning', at: tomorrowMorning(now) },
  ];
  // On a Friday or Saturday the next working morning is Monday's; on a Sunday
  // "tomorrow morning" already is.
  if (now.getDay() === 5 || now.getDay() === 6) choices.push({ id: 'monday', label: 'Monday morning', at: nextMondayMorning(now) });
  return choices;
}

/** A time in the near future, as short as the distance allows: "10:41", "Fri 08:00", "15 Jun 08:00", "15 Jun 2027 08:00". */
export function formatWhen(value: Date | string, now = new Date()) {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  if (isSameDay(date, now)) return format(date, 'HH:mm');
  if (date.getTime() - now.getTime() < 6 * 24 * 60 * 60 * 1000 && date > now) return format(date, 'EEE HH:mm');
  return format(date, isThisYear(date) && isSameYear(date, now) ? 'd MMM HH:mm' : 'd MMM yyyy HH:mm');
}

/** The value of a datetime-local input for a date, in local time. */
export const toDateTimeLocal = (date: Date) => format(date, "yyyy-MM-dd'T'HH:mm");
/** The date a datetime-local input holds; null while it holds none. */
export function fromDateTimeLocal(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
