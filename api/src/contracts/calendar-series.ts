// Request and response shapes of repeating events in UniHub's own calendars
// (F11). A series keeps its rule and its creator's time zone, so 09:00
// stays 09:00 across a daylight-saving change there; each date is an event
// of its own with its own ToDo state, checklist, attendees, order and
// reminders, kept when the series changes. Dates are kept from a year back
// to two years ahead and extended daily. Synced repeating events keep their
// provider's rules; this is the shape for local calendars. The frontend
// imports these as types only.
//
// Errors, besides those of the event routes: 400 RRULE_UNSUPPORTED for a
// rule outside RepeatRule; 400 TIME_ZONE_INVALID; 400 SERIES_SCOPE_INVALID
// for a scope other than occurrence or series; 409 SERIES_MOVE_REFUSED for
// a series moved to a calendar of another owner or a synced one.

/** The rules UniHub's own calendars offer (RFC 5545 RRULE parts). */
export type RepeatFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface RepeatRule {
  freq: RepeatFrequency;
  /** 1 to 99; 1 when left out. */
  interval?: number;
  /**
   * WEEKLY: any weekdays (MO TU WE TH FR SA SU). MONTHLY: one ordinal
   * weekday such as 2TU or -1FR. Not with by_month_day.
   */
  by_day?: string[];
  /** MONTHLY: one day of the month, 1 to 31; months without it are skipped. */
  by_month_day?: number;
  /** 1 to 999 dates; not with until. */
  count?: number;
  /** The last date (YYYY-MM-DD, in the series' time zone); not with count. */
  until?: string;
}

/** For a change of a repeating local event: this date only, or every date. */
export type SeriesScope = 'occurrence' | 'series';

/**
 * POST /api/calendar/events (edit on the calendar) and PUT
 * /api/calendar/events/:id of a local event take these besides the event's
 * fields. `repeat` makes a single event the first date of a new series, or
 * (null) turns a series back into the edited date as a single event and
 * deletes the series to the bin; `time_zone` is the creator's IANA zone,
 * the person's own when left out. PUT and DELETE of a date of a local
 * series take `scope` (body or ?scope=, as for synced series): occurrence
 * changes or deletes one date (a deleted date goes to the bin and comes
 * back as a single event), series every date in the window, keeping each
 * date's id and state; a date that leaves a changed rule and holds a ToDo
 * state, points or attendees goes to the bin, the others are removed.
 */
export interface RepeatInput {
  repeat?: RepeatRule | null;
  time_zone?: string;
  scope?: SeriesScope;
}

/**
 * On every event (contracts/calendar-shares.ts SharedEventFields carries
 * series_key): `recurrence` is the rule's RRULE text on every date of a
 * series. GET /api/calendar/events/:id of a date of a local series also
 * answers its rule and time zone for the event dialog.
 */
export interface SeriesDetail {
  repeat: RepeatRule | null;
  time_zone: string | null;
}
