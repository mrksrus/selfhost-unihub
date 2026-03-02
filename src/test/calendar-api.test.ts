import { describe, expect, it } from 'vitest';
import { calendarQueryKeys, localDatetimeToIso, toDatetimeLocalValue } from '@/lib/calendar-api';

describe('calendar query keys', () => {
  it('separates includeTodos variants to avoid cache collisions', () => {
    const todosKey = calendarQueryKeys.list({ includeTodos: true });
    const calendarKey = calendarQueryKeys.list({ includeTodos: false });
    expect(todosKey[0]).toBe(calendarKey[0]);
    expect(todosKey[1]).not.toBe(calendarKey[1]);
  });
});

describe('datetime helpers', () => {
  it('round-trips local datetime values consistently', () => {
    const localValue = '2026-03-02T14:45';
    const isoValue = localDatetimeToIso(localValue);
    expect(toDatetimeLocalValue(isoValue)).toBe(localValue);
  });
});
