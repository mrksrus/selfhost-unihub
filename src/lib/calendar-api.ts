import { format, parseISO, type Locale } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { QueryClient } from '@tanstack/react-query';
import { api, type ApiResponse } from '@/lib/api';
import type { CalendarChoiceFields, CalendarWriteBlock, TaskMoveRequest, TaskMoveResponse, TaskPositionRequest, TaskPositionResponse, TaskRankFields } from '../../api/src/contracts/tasks';

export type { CalendarWriteBlock, TaskPositionRequest, TaskPositionResponse } from '../../api/src/contracts/tasks';

/** The answer of a move (contracts/tasks.ts TaskMoveResponse) with the event normalized for the browser. */
export interface TaskMove { event: CalendarEvent | null; pending?: TaskMoveResponse['pending']; sourceKept?: boolean }

/** A write refused because the item is still being moved to another calendar (409 CALENDAR_MOVE_PENDING). */
export const isMovePending = (error: unknown) => error instanceof CalendarRequestError && error.code === 'CALENDAR_MOVE_PENDING';

/** What a refused write tells the person; `reload` when the lists must be fetched again first. */
export interface WriteRefusal { title: string; description: string; reload?: boolean }

/**
 * A write the server refused for a reason the person can act on, by its
 * error code (api/src/services/calendar-move.ts, task-order.ts), as a plain
 * notice rather than a failure: the row and the cache stay as they are.
 * Null for anything else.
 */
export function writeRefusal(error: unknown): WriteRefusal | null {
  if (!(error instanceof CalendarRequestError)) return null;
  switch (error.code) {
    case 'CALENDAR_MOVE_PENDING': return MOVE_PENDING_NOTICE;
    // A shared calendar entry (several components in one object) or a repeating event: the server says which.
    case 'CALENDAR_MOVE_UNSUPPORTED': return { title: 'This item cannot be moved on its own', description: error.message };
    case 'CALENDAR_RECURRING_MOVE': return { title: 'Repeating events stay in their calendar', description: error.message };
    // The server copy changed, or the server reports no versions: the lists are fetched again before another try.
    case 'CALDAV_CONFLICT': return { title: 'Changed on the calendar server', description: error.message, reload: true };
    case 'ORDER_STALE': return { title: 'The list changed in the meantime', description: 'It has been reloaded. Try again.', reload: true };
    default: return null;
  }
}
/** What to say then, instead of a failure: the row and the cache stay as they are. */
export const MOVE_PENDING_NOTICE = { title: 'Still being moved to another list', description: 'UniHub finishes the move when the calendar server answers. Try again in a moment.' } as const;

export type TodoStatus = 'done' | 'changed' | 'time_moved' | 'cancelled' | null;

/** A refused request with the server's error code, so a caller can tell a stale list (ORDER_STALE) from a failure. */
export class CalendarRequestError extends Error {
  code: string | null;
  status: number | null;
  constructor(response: ApiResponse<unknown>, fallback: string) {
    super(response.error || fallback);
    this.name = 'CalendarRequestError';
    this.code = typeof response.code === 'string' ? response.code : null;
    this.status = typeof response.status === 'number' ? response.status : null;
  }
}
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

/**
 * A calendar (a "list" in ToDo). The choice fields (where new items go and
 * what a calendar can take) come from the server (contracts/tasks.ts); an
 * answer from an older server lacks them and gets the fallback in
 * `normalizeCalendar`.
 */
export interface CalendarCalendar extends CalendarChoiceFields {
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

/** The calendar as the server lists it; the choice fields may be missing from an older server. */
type CalendarCalendarRow = Omit<CalendarCalendar, keyof CalendarChoiceFields> & Partial<CalendarChoiceFields>;

/**
 * Fills the choice fields an older server leaves out, from the rules it
 * applies anyway: a subscription or a read-only calendar takes nothing new,
 * and only UniHub's own lists hold tasks without a date. Nothing is marked as
 * a default then; the chooser falls back to the first list that qualifies.
 */
export function normalizeCalendar(calendar: CalendarCalendarRow): CalendarCalendar {
  const provider = calendar.account_provider ?? 'local';
  const write_block: CalendarWriteBlock | null = calendar.write_block !== undefined ? calendar.write_block
    : provider === 'ics' || calendar.read_only ? 'read_only' : null;
  return {
    ...calendar,
    write_block,
    takes_undated_tasks: calendar.takes_undated_tasks ?? (provider === 'local' && !write_block),
    default_for_tasks: calendar.default_for_tasks ?? false,
    default_for_events: calendar.default_for_events ?? false,
  };
}

export interface CalendarEvent extends Partial<TaskRankFields> {
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
  /** The email this task or event was made from, if any. */
  source_email?: import('@/lib/email-tasks').SourceEmail | null;
}

/** What creates an event or task; `source_email_id` links it to the email it came from. */
export type NewCalendarEvent = Partial<CalendarEvent> & { title: string; source_email_id?: string };

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

/**
 * Refreshes everything that shows events, tasks or calendars. Every change to
 * an event or task goes through this, from any feature (Calendar, ToDo, and
 * later mail turned into a task).
 */
export function invalidateCalendarQueries(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: calendarQueryKeys.all }),
    client.invalidateQueries({ queryKey: calendarQueryKeys.accounts }),
    client.invalidateQueries({ queryKey: calendarQueryKeys.calendars }),
    client.invalidateQueries({ queryKey: calendarQueryKeys.upcomingEvents }),
    client.invalidateQueries({ queryKey: calendarQueryKeys.stats }),
  ]);
}

/** Choices for event and task reminders, in minutes before the start. */
export const REMINDER_OPTIONS = [
  { value: 0, label: 'At event time' },
  { value: 5, label: '5 minutes before' },
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
  { value: 120, label: '2 hours before' },
  { value: 1440, label: '1 day before' },
] as const;

/** Colors offered for events and tasks without their own calendar color. */
export const EVENT_COLOR_OPTIONS = [
  { value: '#22c55e', label: 'Green' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#8b5cf6', label: 'Purple' },
  { value: '#f59e0b', label: 'Orange' },
  { value: '#ef4444', label: 'Red' },
  { value: '#06b6d4', label: 'Cyan' },
] as const;

export const calendarApi = {
  async fetchEvent(id: string, signal?: AbortSignal): Promise<CalendarEvent> {
    const response = await api.get<{ event: CalendarEvent }>(`/calendar/events/${encodeURIComponent(id)}`, { signal });
    if (response.error) throw new Error(response.error);
    if (!response.data?.event || response.data.event.id !== id) throw new Error('Event not found');
    return normalizeEvent(response.data.event);
  },

  async fetchEvents(filters: CalendarEventFilters = {}, signal?: AbortSignal): Promise<CalendarEvent[]> {
    const query = buildEventsQuery(filters);
    const endpoint = query ? `/calendar/events?${query}` : '/calendar/events';
    const response = await api.get<{ events: CalendarEvent[] }>(endpoint, { signal });
    if (response.error) throw new Error(response.error);
    return (response.data?.events || []).map(normalizeEvent);
  },

  async createEvent(payload: NewCalendarEvent): Promise<CalendarEvent> {
    const response = await api.post<{ event: CalendarEvent }>('/calendar/events', payload);
    if (response.error) throw new Error(response.error);
    const event = response.data?.event;
    if (!event) throw new Error('Event response missing');
    return normalizeEvent(event);
  },

  async fetchAccounts(signal?: AbortSignal): Promise<CalendarAccount[]> {
    const response = await api.get<{ accounts: CalendarAccount[] }>('/calendar/accounts', { signal });
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

  async fetchCalendars(signal?: AbortSignal): Promise<CalendarCalendar[]> {
    const response = await api.get<{ calendars: CalendarCalendarRow[] }>('/calendar/calendars', { signal });
    if (response.error) throw new Error(response.error);
    return (response.data?.calendars || []).map(normalizeCalendar);
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
    const response = await api.post<{ calendar: CalendarCalendarRow }>('/calendar/calendars', payload);
    if (response.error) throw new Error(response.error);
    if (!response.data?.calendar) throw new Error('Calendar response missing');
    return normalizeCalendar(response.data.calendar);
  },

  async updateCalendar(
    id: string,
    payload: Partial<Pick<CalendarCalendar, 'name' | 'color' | 'is_visible' | 'auto_todo_enabled' | 'read_only' | 'is_primary'>>
  ): Promise<CalendarCalendar> {
    const response = await api.put<{ calendar: CalendarCalendarRow }>(`/calendar/calendars/${id}`, payload);
    if (response.error) throw new Error(response.error);
    if (!response.data?.calendar) throw new Error('Calendar response missing');
    return normalizeCalendar(response.data.calendar);
  },

  /**
   * Places a task between the two it is shown next to (`after` above, `before`
   * below; null at a section's end). The answer holds the rank the server
   * stored for it, and for any tasks it had to spread apart. A neighbour that
   * is gone or no longer adjacent is refused with ORDER_STALE: reload the list
   * instead of guessing (contracts/tasks.ts).
   */
  async setTaskPosition(id: string, position: TaskPositionRequest): Promise<TaskPositionResponse> {
    const response = await api.put<TaskPositionResponse>(`/calendar/events/${encodeURIComponent(id)}/position`, position);
    if (response.error || !response.data?.ranks) throw new CalendarRequestError(response, 'Could not reorder the task');
    return { ranks: response.data.ranks };
  },

  /**
   * Moves a task (or event) to another list or calendar. `pending` means a
   * calendar server has not confirmed yet and UniHub finishes the move in the
   * background: 'creating', the task shows in its new list once it has;
   * 'removing', it is there already and only the old copy waits. `sourceKept`:
   * the old copy was changed elsewhere and stays in its old calendar too.
   */
  async moveTask(id: string, calendarId: string): Promise<TaskMove> {
    const body: TaskMoveRequest = { calendar_id: calendarId };
    const response = await api.post<TaskMoveResponse>(`/calendar/events/${encodeURIComponent(id)}/move`, body);
    if (response.error) throw new CalendarRequestError(response, 'Could not move the task');
    const event = response.data?.event ?? null;
    const pending = response.data?.pending;
    if (!event && !pending) throw new Error('Event response missing');
    return { event: event ? normalizeEvent(event) : null, ...(pending ? { pending } : {}), ...(response.data?.source_kept ? { sourceKept: true } : {}) };
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
  async updateEvent(id: string, payload: Partial<CalendarEvent> & { source_email_id?: string | null }, scope?: RecurrenceScope): Promise<{ event: CalendarEvent | null; replaced: boolean } & Pick<TaskMove, 'pending' | 'sourceKept'>> {
    const response = await api.put<{ event: CalendarEvent | null; replaced?: boolean; pending?: TaskMoveResponse['pending']; source_kept?: boolean }>(`/calendar/events/${id}`, scope ? { ...payload, scope } : payload);
    if (response.error) throw new CalendarRequestError(response, 'Could not update the event');
    const event = response.data?.event ?? null;
    if (!event && !response.data?.replaced) throw new Error('Event response missing');
    // A changed calendar is a move; a calendar server that has not confirmed answers 202 with `pending`.
    return { event: event ? normalizeEvent(event) : null, replaced: response.data?.replaced === true,
      ...(response.data?.pending ? { pending: response.data.pending } : {}), ...(response.data?.source_kept ? { sourceKept: true } : {}) };
  },

  async updateTodoStatus(
    id: string,
    payload: { todo_status: TodoStatus; start_time?: string; end_time?: string }
  ): Promise<CalendarEvent> {
    const response = await api.put<{ event: CalendarEvent }>(`/calendar/events/${id}/todo-status`, payload);
    if (response.error) throw new CalendarRequestError(response, 'Could not update the task');
    const event = response.data?.event;
    if (!event) throw new Error('Event response missing');
    return normalizeEvent(event);
  },

  async deleteEvent(id: string, scope?: RecurrenceScope): Promise<void> {
    const response = await api.delete(`/calendar/events/${id}${scope ? `?scope=${scope}` : ''}`);
    if (response.error) throw new CalendarRequestError(response, 'Could not delete the event');
  },

  async createSubtask(eventId: string, payload: { title: string; position?: number; is_done?: boolean }): Promise<CalendarSubtask> {
    const response = await api.post<{ subtask: CalendarSubtask }>(`/calendar/events/${eventId}/subtasks`, payload);
    if (response.error) throw new CalendarRequestError(response, 'Could not add the subtask');
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
    if (response.error) throw new CalendarRequestError(response, 'Could not update the subtask');
    if (!response.data?.subtask) throw new Error('Subtask response missing');
    return response.data.subtask;
  },

  async deleteSubtask(eventId: string, subtaskId: string): Promise<void> {
    const response = await api.delete(`/calendar/events/${eventId}/subtasks/${subtaskId}`);
    if (response.error) throw new CalendarRequestError(response, 'Could not delete the subtask');
  },

  async reorderSubtasks(eventId: string, subtaskIds: string[]): Promise<CalendarSubtask[]> {
    const response = await api.post<{ subtasks: CalendarSubtask[] }>(`/calendar/events/${eventId}/subtasks/reorder`, {
      subtask_ids: subtaskIds,
    });
    if (response.error) throw new CalendarRequestError(response, 'Could not reorder the subtasks');
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
