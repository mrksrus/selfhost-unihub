import { useCallback, useEffect, useMemo, useState } from 'react';
import { addDays, addMonths, endOfDay, endOfMonth, endOfWeek, startOfDay, startOfMonth, startOfWeek, subDays, subMonths } from 'date-fns';
import type { CalendarCalendar } from '@/lib/calendar-api';

export type CalendarViewMode = 'day' | 'week' | 'month';

// Kept in this browser so the calendar opens where it was left.
const STORAGE_VIEW_KEY = 'calendar_view_mode';
const STORAGE_CURRENT_DATE_KEY = 'calendar_current_date';
const STORAGE_SELECTED_DATE_KEY = 'calendar_selected_date';
const STORAGE_SELECTED_CALENDAR_IDS_KEY = 'calendar_selected_ids';
const WEEK = { weekStartsOn: 1 as const };

function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Storage may be disabled. */ }
}
function readDate(key: string) {
  const raw = read(key);
  const date = raw ? new Date(raw) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function viewDateRange(viewMode: CalendarViewMode, baseDate: Date) {
  if (viewMode === 'day') return { start: startOfDay(baseDate), end: endOfDay(baseDate) };
  if (viewMode === 'week') return { start: startOfWeek(baseDate, WEEK), end: endOfWeek(baseDate, WEEK) };
  return { start: startOfWeek(startOfMonth(baseDate), WEEK), end: endOfWeek(endOfMonth(baseDate), WEEK) };
}

/** Which period and which calendars the Calendar page shows. */
export function useCalendarView(calendars: CalendarCalendar[]) {
  const [viewMode, setViewMode] = useState<CalendarViewMode>(() => {
    const raw = read(STORAGE_VIEW_KEY);
    return raw === 'day' || raw === 'week' || raw === 'month' ? raw : 'month';
  });
  const [currentDate, setCurrentDate] = useState(() => readDate(STORAGE_CURRENT_DATE_KEY));
  const [selectedDate, setSelectedDate] = useState(() => readDate(STORAGE_SELECTED_DATE_KEY));
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>(() => {
    try {
      const parsed: unknown = JSON.parse(read(STORAGE_SELECTED_CALENDAR_IDS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  });

  // Until the user chooses, show the calendars marked visible (or all of them).
  useEffect(() => {
    if (selectedCalendarIds.length > 0 || calendars.length === 0) return;
    const visible = calendars.filter(calendar => calendar.is_visible).map(calendar => calendar.id);
    setSelectedCalendarIds(visible.length > 0 ? visible : calendars.map(calendar => calendar.id));
  }, [calendars, selectedCalendarIds.length]);

  useEffect(() => { write(STORAGE_VIEW_KEY, viewMode); }, [viewMode]);
  useEffect(() => { write(STORAGE_CURRENT_DATE_KEY, currentDate.toISOString()); }, [currentDate]);
  useEffect(() => { write(STORAGE_SELECTED_DATE_KEY, selectedDate.toISOString()); }, [selectedDate]);
  useEffect(() => { write(STORAGE_SELECTED_CALENDAR_IDS_KEY, JSON.stringify(selectedCalendarIds)); }, [selectedCalendarIds]);
  useEffect(() => { if (viewMode === 'day') setCurrentDate(selectedDate); }, [viewMode, selectedDate]);

  const range = useMemo(() => viewDateRange(viewMode, currentDate), [viewMode, currentDate]);

  const shiftPeriod = useCallback((direction: -1 | 1) => {
    if (viewMode === 'month') {
      setCurrentDate(prev => direction > 0 ? addMonths(prev, 1) : subMonths(prev, 1));
      return;
    }
    const days = viewMode === 'week' ? 7 : 1;
    const move = (date: Date) => direction > 0 ? addDays(date, days) : subDays(date, days);
    setCurrentDate(move);
    setSelectedDate(move);
  }, [viewMode]);

  const goToday = useCallback(() => {
    const today = new Date();
    setCurrentDate(today);
    setSelectedDate(today);
  }, []);

  /** Shows a day: selects it and moves the period there. */
  const selectDay = useCallback((day: Date) => {
    setSelectedDate(day);
    setCurrentDate(day);
  }, []);

  const showCalendar = useCallback((calendarId: string, shown: boolean) => {
    setSelectedCalendarIds(prev => shown ? Array.from(new Set([...prev, calendarId])) : prev.filter(id => id !== calendarId));
  }, []);

  return { viewMode, setViewMode, currentDate, selectedDate, selectedCalendarIds, range, shiftPeriod, goToday, selectDay, showCalendar };
}

export type CalendarView = ReturnType<typeof useCalendarView>;
