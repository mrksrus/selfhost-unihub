import { describe, expect, it } from 'vitest';
import { followStart, repeatChoices, sameRule } from '@/components/calendar/repeat';
import { onceInLater } from '@/lib/tasks';

const day = (date: string) => new Date(`${date}T09:00`);

describe('a repeat rule follows its event\'s start', () => {
  it('moves the weekday of a weekly series with the moved time, so its dates are kept', () => {
    // Tuesday 9 June 2026 to Thursday: the rule sent with the new time names Thursday.
    expect(followStart({ freq: 'WEEKLY', by_day: ['TU'] }, day('2026-06-09'), day('2026-06-11'))).toEqual({ freq: 'WEEKLY', by_day: ['TH'] });
    // Several weekdays move together when the new day is not one of them, and stay when it is.
    expect(followStart({ freq: 'WEEKLY', interval: 2, by_day: ['MO', 'WE'] }, day('2026-06-08'), day('2026-06-09'))).toEqual({ freq: 'WEEKLY', interval: 2, by_day: ['TU', 'TH'] });
    expect(followStart({ freq: 'WEEKLY', by_day: ['MO', 'WE'] }, day('2026-06-08'), day('2026-06-10'))).toEqual({ freq: 'WEEKLY', by_day: ['MO', 'WE'] });
    // A later hour on the same day changes nothing, and neither does a start still being typed.
    const tuesdays = { freq: 'WEEKLY' as const, by_day: ['TU'] };
    expect(followStart(tuesdays, day('2026-06-09'), new Date('2026-06-09T15:00'))).toBe(tuesdays);
    expect(followStart(tuesdays, day('2026-06-09'), new Date(''))).toBe(tuesdays);
  });

  it('moves a monthly rule\'s day or weekday, and leaves a rule of its own alone', () => {
    expect(followStart({ freq: 'MONTHLY', by_month_day: 9 }, day('2026-06-09'), day('2026-06-12'))).toEqual({ freq: 'MONTHLY', by_month_day: 12 });
    expect(followStart({ freq: 'MONTHLY', by_day: ['2TU'] }, day('2026-06-09'), day('2026-06-30'))).toEqual({ freq: 'MONTHLY', by_day: ['-1TU'] });
    const fifteenth = { freq: 'MONTHLY' as const, by_month_day: 15 };
    expect(followStart(fifteenth, day('2026-06-09'), day('2026-06-12'))).toBe(fifteenth);
  });

  it('names the ready-made rules after the start day', () => {
    const choices = repeatChoices(day('2026-06-09'));
    expect(choices.map(choice => choice.label)).toEqual(['Does not repeat', 'Daily', 'Weekly on Tuesday', 'Every weekday', 'Monthly on day 9', 'Monthly on the second Tuesday', 'Yearly on 9 June']);
    // The server answers a rule without the parts it leaves at their default.
    expect(sameRule(choices[2].rule, { freq: 'WEEKLY', interval: 1, by_day: ['TU'] })).toBe(true);
    expect(sameRule(choices[2].rule, { freq: 'WEEKLY', by_day: ['TU'], count: 5 })).toBe(false);
  });
});

describe('repeating items in ToDo', () => {
  const now = new Date('2026-06-15T10:00:00Z');
  const item = (id: string, start: string, patch: object = {}) => ({
    id, series_key: 'standup' as string | null, todo_status: null as 'done' | null, is_todo_only: false, start_time: `${start}T09:00:00Z`, end_time: `${start}T09:30:00Z`, ...patch,
  });

  it('shows a repeating item once in Later, at its next date; overdue and today\'s dates all stay', () => {
    const tasks = [
      item('missed-1', '2026-06-11'), item('missed-2', '2026-06-12'), item('today', '2026-06-15', { start_time: '2026-06-15T15:00:00Z', end_time: '2026-06-15T15:30:00Z' }),
      item('after', '2026-06-17'), item('next', '2026-06-16'), item('far', '2026-06-18'),
      // A date already ticked stays for Done; a single task and another series are not touched.
      item('done-ahead', '2026-06-19', { todo_status: 'done' }), item('single', '2026-06-20', { series_key: null }), item('other', '2026-06-21', { series_key: 'review' }),
    ];
    expect(onceInLater(tasks, 'UTC', now).map(task => task.id)).toEqual(['missed-1', 'missed-2', 'today', 'next', 'done-ahead', 'single', 'other']);
  });
});
