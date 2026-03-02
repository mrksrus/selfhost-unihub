import { format, parseISO, type Locale } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { api } from '@/lib/api';

export type TodoStatus = 'done' | 'changed' | 'time_moved' | 'cancelled' | null;

export interface CalendarSubtask {
  id: string;
  event_id: string;
  user_id: string;
  title: string;
  is_done: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  all_day: boolean;
  location: string | null;
  color: string;
  recurrence: string | null;
  reminder_minutes: number | null;
  reminders: number[] | null;
  todo_status: TodoStatus;
  is_todo_only: boolean;
  done_at: string | null;
  created_at: string;
  updated_at: string;
  subtasks: CalendarSubtask[];
}

export interface CalendarEventFilters {
  includeTodos?: boolean;
}

const normalizeEvent = (event: CalendarEvent): CalendarEvent => ({
  ...event,
  subtasks: Array.isArray(event.subtasks) ? event.subtasks : [],
  reminders: Array.isArray(event.reminders) ? event.reminders : (event.reminders ?? null),
});

const buildEventsQuery = (filters: CalendarEventFilters = {}) => {
  const params = new URLSearchParams();
  if (filters.includeTodos) params.set('include_todos', 'true');
  return params.toString();
};

const stableFilterKey = (filters: CalendarEventFilters = {}) => (
  `includeTodos=${filters.includeTodos ? '1' : '0'}`
);

export const calendarQueryKeys = {
  all: ['calendar-events'] as const,
  list: (filters: CalendarEventFilters = {}) => ['calendar-events', stableFilterKey(filters)] as const,
  upcomingEvents: ['upcoming-events'] as const,
  stats: ['stats'] as const,
};

export const calendarApi = {
  async fetchEvents(filters: CalendarEventFilters = {}): Promise<CalendarEvent[]> {
    const query = buildEventsQuery(filters);
    const endpoint = query ? `/calendar/events?${query}` : '/calendar/events';
    const response = await api.get<{ events: CalendarEvent[] }>(endpoint);
    if (response.error) throw new Error(response.error);
    return (response.data?.events || []).map(normalizeEvent);
  },

  async createEvent(payload: Partial<CalendarEvent> & { title: string }): Promise<CalendarEvent> {
    const response = await api.post<{ event: CalendarEvent }>('/calendar/events', payload);
    if (response.error) throw new Error(response.error);
    const event = response.data?.event;
    if (!event) throw new Error('Event response missing');
    return normalizeEvent(event);
  },

  async updateEvent(id: string, payload: Partial<CalendarEvent>): Promise<CalendarEvent> {
    const response = await api.put<{ event: CalendarEvent }>(`/calendar/events/${id}`, payload);
    if (response.error) throw new Error(response.error);
    const event = response.data?.event;
    if (!event) throw new Error('Event response missing');
    return normalizeEvent(event);
  },

  async updateTodoStatus(
    id: string,
    payload: { todo_status: TodoStatus; start_time?: string; end_time?: string }
  ): Promise<CalendarEvent> {
    const response = await api.put<{ event: CalendarEvent }>(`/calendar/events/${id}/todo-status`, payload);
    if (response.error) throw new Error(response.error);
    const event = response.data?.event;
    if (!event) throw new Error('Event response missing');
    return normalizeEvent(event);
  },

  async deleteEvent(id: string): Promise<void> {
    const response = await api.delete(`/calendar/events/${id}`);
    if (response.error) throw new Error(response.error);
  },

  async createSubtask(eventId: string, payload: { title: string; position?: number; is_done?: boolean }): Promise<CalendarSubtask> {
    const response = await api.post<{ subtask: CalendarSubtask }>(`/calendar/events/${eventId}/subtasks`, payload);
    if (response.error) throw new Error(response.error);
    if (!response.data?.subtask) throw new Error('Subtask response missing');
    return response.data.subtask;
  },

  async updateSubtask(
    eventId: string,
    subtaskId: string,
    payload: Partial<Pick<CalendarSubtask, 'title' | 'is_done' | 'position'>>
  ): Promise<CalendarSubtask> {
    const response = await api.put<{ subtask: CalendarSubtask }>(
      `/calendar/events/${eventId}/subtasks/${subtaskId}`,
      payload
    );
    if (response.error) throw new Error(response.error);
    if (!response.data?.subtask) throw new Error('Subtask response missing');
    return response.data.subtask;
  },

  async deleteSubtask(eventId: string, subtaskId: string): Promise<void> {
    const response = await api.delete(`/calendar/events/${eventId}/subtasks/${subtaskId}`);
    if (response.error) throw new Error(response.error);
  },

  async reorderSubtasks(eventId: string, subtaskIds: string[]): Promise<CalendarSubtask[]> {
    const response = await api.post<{ subtasks: CalendarSubtask[] }>(`/calendar/events/${eventId}/subtasks/reorder`, {
      subtask_ids: subtaskIds,
    });
    if (response.error) throw new Error(response.error);
    return response.data?.subtasks || [];
  },
};

/**
 * Format a UTC ISO (or datetime) string for use in datetime-local inputs.
 * If timeZone is set, formats in that IANA zone; otherwise uses device local time.
 */
export function toDatetimeLocalValue(isoOrDatetime: string, timeZone?: string | null): string {
  try {
    const date = parseISO(isoOrDatetime);
    if (timeZone && timeZone.trim()) {
      return formatInTimeZone(date, timeZone, "yyyy-MM-dd'T'HH:mm");
    }
    return format(date, "yyyy-MM-dd'T'HH:mm");
  } catch {
    return '';
  }
}

/**
 * Convert a datetime-local value to UTC ISO string.
 * If timeZone is set, interprets localValue as being in that IANA zone; otherwise device local.
 */
export function localDatetimeToIso(localValue: string, timeZone?: string | null): string {
  if (timeZone && timeZone.trim()) {
    return fromZonedTime(localValue, timeZone).toISOString();
  }
  return new Date(localValue).toISOString();
}

/** Options for formatEventTime (e.g. locale). */
export type FormatEventTimeOptions = { locale?: Locale };

/**
 * Format a UTC ISO string for display. Uses timeZone if set, otherwise device local.
 */
export function formatEventTime(
  iso: string,
  formatStr: string,
  timeZone?: string | null,
  options?: FormatEventTimeOptions
): string {
  try {
    const date = parseISO(iso);
    if (timeZone && timeZone.trim()) {
      return formatInTimeZone(date, timeZone, formatStr, options);
    }
    return format(date, formatStr, options);
  } catch {
    return '';
  }
}
