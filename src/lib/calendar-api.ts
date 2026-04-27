import { format, parseISO, type Locale } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { api } from '@/lib/api';

export type TodoStatus = 'done' | 'changed' | 'time_moved' | 'cancelled' | null;
export type CalendarRsvpStatus = 'needsAction' | 'accepted' | 'tentative' | 'declined';
export type CalendarProvider = 'local';

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

export interface CalendarAttendee {
  id?: string;
  event_id?: string;
  user_id?: string;
  email: string;
  display_name?: string | null;
  response_status?: CalendarRsvpStatus;
  is_organizer?: boolean;
  optional_attendee?: boolean;
  comment?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface CalendarAccount {
  id: string;
  user_id: string;
  provider: CalendarProvider;
  account_email: string | null;
  display_name: string | null;
  token_expires_at: null;
  provider_config: Record<string, never>;
  capabilities: Record<string, unknown>;
  is_active: boolean;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarCalendar {
  id: string;
  user_id: string;
  account_id: string;
  name: string;
  external_id: string | null;
  color: string;
  is_visible: boolean;
  auto_todo_enabled: boolean;
  read_only: boolean;
  is_primary: boolean;
  sync_token: string | null;
  account_provider?: CalendarProvider;
  account_display_name?: string | null;
  account_email?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarEvent {
  id: string;
  calendar_id: string | null;
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
  attendees: CalendarAttendee[];
}

export interface CalendarEventFilters {
  includeTodos?: boolean;
  includeDone?: boolean;
  respectAutoTodo?: boolean;
  visibleOnly?: boolean;
  rangeStart?: string;
  rangeEnd?: string;
  calendarIds?: string[];
}

const normalizeEvent = (event: CalendarEvent): CalendarEvent => ({
  ...event,
  subtasks: Array.isArray(event.subtasks) ? event.subtasks : [],
  attendees: Array.isArray(event.attendees) ? event.attendees : [],
  reminders: Array.isArray(event.reminders) ? event.reminders : (event.reminders ?? null),
});

const buildEventsQuery = (filters: CalendarEventFilters = {}) => {
  const params = new URLSearchParams();
  if (filters.includeTodos) params.set('include_todos', 'true');
  if (filters.includeDone !== undefined) params.set('include_done', filters.includeDone ? 'true' : 'false');
  if (filters.respectAutoTodo) params.set('respect_auto_todo', 'true');
  if (filters.visibleOnly) params.set('visible_only', 'true');
  if (filters.rangeStart) params.set('range_start', filters.rangeStart);
  if (filters.rangeEnd) params.set('range_end', filters.rangeEnd);
  if (filters.calendarIds && filters.calendarIds.length > 0) {
    params.set('calendar_ids', filters.calendarIds.join(','));
  }
  return params.toString();
};

const stableFilterKey = (filters: CalendarEventFilters = {}) => (
  [
    `includeTodos=${filters.includeTodos ? '1' : '0'}`,
    `includeDone=${filters.includeDone === undefined ? 'x' : (filters.includeDone ? '1' : '0')}`,
    `respectAutoTodo=${filters.respectAutoTodo ? '1' : '0'}`,
    `visibleOnly=${filters.visibleOnly ? '1' : '0'}`,
    `rangeStart=${filters.rangeStart || ''}`,
    `rangeEnd=${filters.rangeEnd || ''}`,
    `calendarIds=${(filters.calendarIds || []).join('|')}`,
  ].join(';')
);

export const calendarQueryKeys = {
  all: ['calendar-events'] as const,
  list: (filters: CalendarEventFilters = {}) => ['calendar-events', stableFilterKey(filters)] as const,
  accounts: ['calendar-accounts'] as const,
  calendars: ['calendar-calendars'] as const,
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

  async fetchAccounts(): Promise<CalendarAccount[]> {
    const response = await api.get<{ accounts: CalendarAccount[] }>('/calendar/accounts');
    if (response.error) throw new Error(response.error);
    return response.data?.accounts || [];
  },

  async createAccount(payload: {
    provider: CalendarProvider;
    account_email?: string | null;
    display_name?: string | null;
    is_active?: boolean;
    default_calendar_name?: string;
    default_calendar_color?: string;
  }): Promise<{ account: CalendarAccount }> {
    const response = await api.post<{ account: CalendarAccount }>('/calendar/accounts', payload);
    if (response.error) throw new Error(response.error);
    if (!response.data?.account) throw new Error('Calendar account response missing');
    return response.data;
  },

  async updateAccount(id: string, payload: Partial<{
    account_email: string | null;
    display_name: string | null;
    is_active: boolean;
  }>): Promise<CalendarAccount> {
    const response = await api.put<{ account: CalendarAccount }>(`/calendar/accounts/${id}`, payload);
    if (response.error) throw new Error(response.error);
    if (!response.data?.account) throw new Error('Calendar account response missing');
    return response.data.account;
  },

  async deleteAccount(id: string): Promise<void> {
    const response = await api.delete(`/calendar/accounts/${id}`);
    if (response.error) throw new Error(response.error);
  },

  async fetchCalendars(): Promise<CalendarCalendar[]> {
    const response = await api.get<{ calendars: CalendarCalendar[] }>('/calendar/calendars');
    if (response.error) throw new Error(response.error);
    return response.data?.calendars || [];
  },

  async createCalendar(payload: {
    account_id: string;
    name: string;
    color?: string;
    external_id?: string | null;
    is_visible?: boolean;
    auto_todo_enabled?: boolean;
    read_only?: boolean;
    is_primary?: boolean;
  }): Promise<CalendarCalendar> {
    const response = await api.post<{ calendar: CalendarCalendar }>('/calendar/calendars', payload);
    if (response.error) throw new Error(response.error);
    if (!response.data?.calendar) throw new Error('Calendar response missing');
    return response.data.calendar;
  },

  async updateCalendar(
    id: string,
    payload: Partial<Pick<CalendarCalendar, 'name' | 'color' | 'is_visible' | 'auto_todo_enabled' | 'read_only' | 'is_primary'>>
  ): Promise<CalendarCalendar> {
    const response = await api.put<{ calendar: CalendarCalendar }>(`/calendar/calendars/${id}`, payload);
    if (response.error) throw new Error(response.error);
    if (!response.data?.calendar) throw new Error('Calendar response missing');
    return response.data.calendar;
  },

  async deleteCalendar(id: string): Promise<void> {
    const response = await api.delete(`/calendar/calendars/${id}`);
    if (response.error) throw new Error(response.error);
  },

  async updateRsvp(id: string, payload: { response_status: CalendarRsvpStatus; email?: string }): Promise<CalendarEvent> {
    const response = await api.put<{ event: CalendarEvent }>(`/calendar/events/${id}/rsvp`, payload);
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
