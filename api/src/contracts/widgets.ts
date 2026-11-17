// The Android home-screen widgets' one answer (F11). Read by app versions
// that see the `calendar-widgets` feature in GET /api/version; the page
// never calls it. Content follows the person's notification detail
// (reminder_notification_detail, with the administrator's floor), not the
// app lock: at `none` titles read "Event" (or "Busy") and tasks are counted
// without titles. Free/busy calendars show "Busy". Errors as for any
// Calendar route: MODULE_DISABLED, TWO_FACTOR_REQUIRED, APP_LOCK_REQUIRED
// and 401 empty the widget.

/** One event or date of the next 14 days in the calendars the person has on (own, shared, group, organisation). */
export interface WidgetAgendaItem {
  id: string;
  calendar_id: string;
  /** "Busy" at freebusy, "Event" at detail none. */
  title: string;
  start_time: string;
  end_time: string;
  all_day: boolean;
  color: string;
}

/** An open task of the lists the person has on, in their own order. */
export interface WidgetTask {
  id: string;
  calendar_id: string;
  /** null at detail none. */
  title: string | null;
  /** The due date in words for the person ("Today", "Tomorrow", "Mon 3 Feb"); null without one. */
  date_text: string | null;
  overdue: boolean;
  /** Edit on the list and detail full: the widget may tick it through PUT /api/calendar/events/:id/todo-status. */
  can_tick: boolean;
}

/** GET /api/widgets (Calendar module): at most 50 of each, a repeating task once with its next date. */
export interface WidgetsResponse {
  detail: 'full' | 'none';
  agenda: WidgetAgendaItem[];
  tasks: WidgetTask[];
  /** Open tasks beyond the ones listed. */
  more_tasks: number;
  /** The zone of every `date_text`: the person's, or the phone's when they set none. The app shows the agenda's times in it. */
  time_zone: string;
  generated_at: string;
}
