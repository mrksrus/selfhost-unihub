import { format, parseISO, type Locale } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { api } from '@/lib/api';

export type TodoStatus = 'done' | 'changed' | 'time_moved' | 'cancelled' | null;
export type CalendarRsvpStatus = 'needsAction' | 'accepted' | 'tentative' | 'declined';
export type CalendarProvider = 'local' | 'caldav' | 'ics';
export type CalendarSyncStatus = 'pending' | 'syncing' | 'ok' | 'error' | 'paused' | null;
/** How an edit or delete of one occurrence of a synced series applies. */
export type RecurrenceScope = 'occurrence' | 'series';

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
  username?: string | null;
  discovery_url?: string | null;
  base_url?: string | null;
  token_expires_at: null;
  provider_config: {
    server?: { url: string; source: 'manual' | 'provider' | 'dns' | 'well-known' | 'subscription'; label: string };
    hint?: string | null;
    timeZone?: string | null;
  };
  capabilities: Record<string, unknown>;
  is_active: boolean;
  sync_status?: CalendarSyncStatus;
  sync_error?: string | null;
  last_synced_at: string | null;
  next_sync_at?: string | null;
  mail_account_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** Calendar of a mail account, as shown on the mail account's edit page. */
export interface MailCalendarLink {
  enabled: boolean;
  account: CalendarAccount | null;
  calendars: Pick<CalendarCalendar, 'id' | 'name' | 'color' | 'read_only' | 'is_visible'>[];
  event_count: number;
  provider: { id: string; label: string; supported: boolean; hint: string | null } | null;
}

export const isRemoteCalendarAccount = (account?: Pick<CalendarAccount, 'provider'> | null) => (
  account?.provider === 'caldav' || account?.provider === 'ics'
);

/** The browser's zone, used for floating and all-day times of synced events. */
export const browserTimeZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
};

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
  user_id: string;
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
  async fetchEvent(id: string, signal?: AbortSignal): Promise<CalendarEvent> {
    const response = await api.get<{ event: CalendarEvent }>(`/calendar/events/${encodeURIComponent(id)}`, { signal });
    if (response.error) throw new Error(response.error);
    if (!response.data?.event || response.data.event.id !== id) throw new Error('Event not found');
    return normalizeEvent(response.data.event);
  },

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
    username?: string | null;
    password?: string;
    /** CalDAV server address (optional) or iCalendar subscription address. */
    url?: string | null;
    time_zone?: string;
    is_active?: boolean;
    default_calendar_name?: string;
    default_calendar_color?: string;
  }): Promise<{ account: CalendarAccount; calendars?: CalendarCalendar[]; server?: { url: string; label: string }; hint?: string | null }> {
    const response = await api.post<{ account: CalendarAccount; calendars?: CalendarCalendar[]; server?: { url: string; label: string }; hint?: string | null }>('/calendar/accounts', payload);
    if (response.error) throw new Error(response.error);
    if (!response.data?.account) throw new Error('Calendar account response missing');
    return response.data;
  },

  async syncAccount(id: string): Promise<CalendarAccount | null> {
    const response = await api.post<{ account: CalendarAccount | null }>(`/calendar/accounts/${encodeURIComponent(id)}/sync`, {});
    if (response.error) throw new Error(response.error);
    return response.data?.account ?? null;
  },

  async fetchMailCalendar(mailAccountId: string, signal?: AbortSignal): Promise<MailCalendarLink> {
    const response = await api.get<{ calendar: MailCalendarLink }>(`/mail/accounts/${encodeURIComponent(mailAccountId)}/calendar`, { signal });
    if (response.error) throw new Error(response.error);
    if (!response.data?.calendar) throw new Error('Calendar settings response missing');
    return response.data.calendar;
  },

  /** caldav_url: omitted keeps the current address, '' finds it automatically. */
  async setMailCalendar(mailAccountId: string, payload: { enabled: boolean; caldav_url?: string; time_zone?: string }): Promise<MailCalendarLink> {
    const response = await api.put<{ calendar: MailCalendarLink }>(`/mail/accounts/${encodeURIComponent(mailAccountId)}/calendar`, payload);
    if (response.error) throw new Error(response.error);
    if (!response.data?.calendar) throw new Error('Calendar settings response missing');
    return response.data.calendar;
  },

  async updateAccount(id: string, payload: Partial<{
    account_email: string | null;
    display_name: string | null;
    is_active: boolean;
    password: string;
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

  /**
   * A synced recurring event changed for the whole series comes back as
   * `replaced`: its occurrences were rebuilt and the edited id is gone.
   */
  async updateEvent(id: string, payload: Partial<CalendarEvent>, scope?: RecurrenceScope): Promise<{ event: CalendarEvent | null; replaced: boolean }> {
    const response = await api.put<{ event: CalendarEvent | null; replaced?: boolean }>(`/calendar/events/${id}`, scope ? { ...payload, scope } : payload);
    if (response.error) throw new Error(response.error);
    const event = response.data?.event ?? null;
    if (!event && !response.data?.replaced) throw new Error('Event response missing');
    return { event: event ? normalizeEvent(event) : null, replaced: response.data?.replaced === true };
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

  async deleteEvent(id: string, scope?: RecurrenceScope): Promise<void> {
    const response = await api.delete(`/calendar/events/${id}${scope ? `?scope=${scope}` : ''}`);
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
