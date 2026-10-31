// Request and response shapes of the task and calendar routes that 0.27
// added or extended (F11). The frontend imports these as types only; the
// rules are in services/task-order.ts, services/calendar.ts and the move
// service, and docs/CALENDAR.md describes them.

/** A ToDo state; null is open. */
export type TodoStatus = 'done' | 'changed' | 'time_moved' | 'cancelled' | null;

/** The hand order of a task (services/task-order.ts). */
export interface TaskRankFields {
  /**
   * Where the task stands: its hand rank if it was ever placed by hand, else
   * a rank from its date (its creation time for a task without a date).
   * Ascending; equal ranks are ordered by sort_key. Compare only within one answer:
   * a rank says nothing on its own.
   */
  sort_rank: number;
  /**
   * The tiebreak for equal ranks: order by sort_rank, then sort_key (plain
   * string comparison, not locale-aware). Unlike the id it survives a sync
   * that rebuilds the row and a restore that renews ids, so ties keep their
   * order. Opaque: it may carry a suffix after `~` (a restored copy, or a
   * synced task's calendar), and two tasks never share one. Never derive it
   * on the client.
   */
  sort_key: string;
  /** The task was placed by hand; a date changed in UniHub clears it. */
  hand_ordered: boolean;
}

export interface CalendarSubtaskDto {
  id: string;
  event_id: string;
  user_id: string;
  title: string;
  is_done: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CalendarAttendeeDto {
  id: string;
  user_id: string;
  event_id: string;
  email: string;
  display_name: string | null;
  response_status: 'needsAction' | 'accepted' | 'tentative' | 'declined';
  is_organizer: boolean;
  optional_attendee: boolean;
  comment: string | null;
  created_at: string;
  updated_at: string;
}

/** The email a task was made from: what was kept of it, and whether it still exists. */
export interface SourceEmailDto {
  email_id: string;
  subject: string | null;
  from_name: string | null;
  from_address: string;
  received_at: string | null;
  attachments: string[];
  account: string | null;
  draft: boolean;
  to: string | null;
  available: boolean;
}

/**
 * An event or task as GET /api/calendar/events and the event routes answer.
 * Every event carries its rank; ToDo and Today order open tasks by it.
 */
export interface CalendarEventDto extends TaskRankFields {
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
  source_email_id: string | null;
  source_email: SourceEmailDto | null;
  subtasks: CalendarSubtaskDto[];
  attendees: CalendarAttendeeDto[];
}

/**
 * PUT /api/calendar/events/:id/position: place the task between two tasks
 * the person sees next to each other. `after` is the task just above (null
 * at the top of the section), `before` the task just below (null at the
 * bottom). At least one is given. A neighbour that is gone, done, not this
 * person's, or no longer in that order answers 409 ORDER_STALE: refetch and
 * let the person try again; do not guess.
 */
export interface TaskPositionRequest {
  before: string | null;
  after: string | null;
}

/**
 * The new rank of every task the placement changed: usually only the moved
 * one; several when tasks with equal ranks had to be spread apart.
 */
export interface TaskPositionResponse {
  ranks: Record<string, number>;
}

/** POST /api/calendar/events/:id/move: move a task (or event) to another calendar or list. */
export interface TaskMoveRequest {
  calendar_id: string;
}

/**
 * The moved task. `pending` says a calendar server has not confirmed the
 * move yet (status 202): UniHub finishes it in the background, and the task
 * shows in its new list once the server stored it ('creating') or still has
 * an old copy to remove ('removing').
 */
export interface TaskMoveResponse {
  event: CalendarEventDto | null;
  pending?: 'creating' | 'removing';
}

/**
 * Why a calendar takes no new events or tasks: 'read_only' (a subscription,
 * or a calendar the server marks read-only) or 'sync_paused' (its account's
 * sync is paused).
 */
export type CalendarWriteBlock = 'read_only' | 'sync_paused';

/**
 * Fields the server adds to each calendar of GET /api/calendar/calendars, so
 * no client re-implements the rules: where new items go and what a calendar
 * can take.
 */
export interface CalendarChoiceFields {
  /** New tasks go here: the default task list setting, or UniHub's fallback. */
  default_for_tasks: boolean;
  /** New events go here: the default calendar setting, or UniHub's fallback. */
  default_for_events: boolean;
  /** Why nothing new can be added here; null when it can. */
  write_block: CalendarWriteBlock | null;
  /** A task without a date can be saved here (only UniHub's own lists). */
  takes_undated_tasks: boolean;
}

export type CalendarProvider = 'local' | 'caldav' | 'ics';

/** A calendar (a "list" in ToDo) as GET /api/calendar/calendars answers. */
export interface CalendarDto extends CalendarChoiceFields {
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
  account_provider: CalendarProvider;
  account_display_name: string | null;
  account_email: string | null;
  created_at: string;
  updated_at: string;
}

/** GET /api/calendar/calendars */
export interface CalendarListResponse {
  calendars: CalendarDto[];
}
