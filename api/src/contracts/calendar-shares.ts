// Request and response shapes of shared, group and organisation calendars
// (F4, F11). A person shares their own UniHub calendars (task lists are
// calendars) with people and groups at five levels; calendars synced from a
// provider are never shared through UniHub. A calendar no person owns is an
// organisation calendar, or a group calendar when it names a group:
// administrators (calendars.manage) create both, a group's manager creates
// that group's, every member of the group contributes by default and the
// group's managers manage it. Reach for shares is as for shared books
// (contracts/address-books.ts): an administrator shares with anyone, a group
// or Everyone, anyone else with their own groups and the active people in
// them. Administrators see other people's calendars only by name and counts
// (Server › Calendars). The frontend imports these as types only.
//
// Errors, besides those of every route: 404 CALENDAR_NOT_FOUND for a
// calendar the caller cannot see (or a deleted one); 403 CALENDAR_FORBIDDEN
// for one they see but may not change in that way (an archived calendar is
// read-only for everyone); 400 CALENDAR_NOT_SHAREABLE for a calendar synced
// from a provider; 403 SHARE_OUT_OF_REACH for a share beyond the caller's
// reach; 400 SHARE_INVALID, SHARE_IS_OWNER, CALENDAR_NAME_INVALID,
// CALENDAR_COLOR_INVALID, CALENDAR_HAS_OWNER (a person's calendar where only
// a group or organisation calendar is meant); 404 GROUP_NOT_FOUND.
import type { Principal } from './organisation';
import type { ShareCandidatesResponse } from './address-books';

/**
 * What a person may do with a calendar; a higher one includes the lower.
 * freebusy: times only, as "Busy", no tasks; read: everything, own
 * reminders and notifications; contribute: read, and checklist points of
 * their own (add, change, tick, remove); edit: events, tasks, every point,
 * the calendar's bin; manage: edit, shares within their reach, name and
 * default colour. The owner manages their calendar; deleting it and handing
 * it over are the owner's alone.
 */
export type CalendarPermission = 'freebusy' | 'read' | 'contribute' | 'edit' | 'manage';

/** user: a person's; group: a group's (group_id); organisation: nobody's. */
export type CalendarOwnerKind = 'user' | 'group' | 'organisation';

export interface PersonRef { id: string; full_name: string | null; email: string }

/** A person's own view of a calendar. Without a stored one: visible, the calendar's colour, no change notifications. */
export interface CalendarView {
  is_visible: boolean;
  color: string;
  /** Notifications for other people's changes (off by default; own calendars too). */
  notify_changes: boolean;
}

/** The one pending ownership offer of a calendar, shown to its owner, the recipient and whoever made it. */
export interface CalendarOffer {
  to: PersonRef;
  by: PersonRef | null;
}

/**
 * What GET /api/calendar/calendars adds to each calendar. The list holds the
 * caller's own calendars, then those others share with them (directly,
 * through a group or Everyone) and the group calendars of groups they
 * manage, each at the most any grant gives; a calendar offered to the
 * caller that no share reaches is listed at freebusy for its offer alone,
 * and nothing else of it answers them until they accept. A reached calendar's
 * is_visible and color are the caller's view; its write_block is read_only
 * below edit.
 */
export interface CalendarAccessFields {
  permission: CalendarPermission;
  owner_kind: CalendarOwnerKind;
  /** The owner of another person's calendar; null for the caller's own and for a calendar no person owns. */
  owner: PersonRef | null;
  group: { id: string; name: string } | null;
  /** Archived by an administrator: read-only for everyone, the owner too. */
  archived: boolean;
  view: CalendarView;
  offer: CalendarOffer | null;
}

// --- Events ---------------------------------------------------------------------

/**
 * GET /api/calendar/events and GET /api/calendar/events/:id include the
 * events of the reached calendars the caller has on (view is_visible, with
 * visible_only=true). At freebusy an event keeps only its id, calendar,
 * start, end and all-day: the title reads "Busy", every other field is
 * empty, and tasks without a date are left out. Each event carries:
 */
export interface SharedEventFields {
  /** The series a date belongs to: a local series' id, a synced object's UID; null for a single event. */
  series_key: string | null;
}

/**
 * Writes keep the event routes' URLs for every calendar the caller
 * reaches. Creating an event or task, changing, ticking, reordering or
 * deleting one (one date or all) needs edit; adding a checklist point needs
 * contribute, and changing, ticking or removing a point needs edit or
 * contribute and the point being the caller's own. An event moves only
 * between calendars of the same owner (409 CALENDAR_MOVE_SHARED otherwise).
 * A write to another person's calendar waits for that person's calendar
 * restore, as their own writes do. Each person sets their own reminders on
 * an event of a calendar they do not own; the event's reminders are the
 * owner's. Notification kind `calendar-change` (off until the person
 * switches notify_changes on): another person created, changed, ticked,
 * added a point to or deleted an event, at most one per event and person in
 * ten minutes, "<name> changed <title>" or, at the detail none, "A shared
 * calendar changed".
 */

/** A checklist point carries who added it (contribute: the points one added are one's own). */
export interface SubtaskAuthorFields {
  created_by: string | null;
  created_by_name: string | null;
}

// --- Shares ---------------------------------------------------------------------

export interface CalendarShare {
  principal: Principal;
  /** The person's or group's name; "Everyone" for everyone. */
  name: string;
  /** A person's address; null for a group or everyone. */
  email: string | null;
  permission: CalendarPermission;
}

/** GET /api/calendar/calendars/:id/shares (manage). */
export interface CalendarSharesResponse { shares: CalendarShare[] }

/**
 * PUT /api/calendar/calendars/:id/shares (manage): gives, changes or (null)
 * removes one principal's share. Giving or raising one is checked against
 * the caller's reach; lowering or removing one is not. The owner holds no
 * share (SHARE_IS_OWNER). Answers the shares.
 */
export interface SetCalendarShareRequest { principal: Principal; permission: CalendarPermission | null }

/** GET /api/calendar/calendars/:id/share-candidates?q= (manage): within the caller's reach, at most 20 people and 20 groups. */
export type CalendarShareCandidatesResponse = ShareCandidatesResponse;

/** PUT /api/calendar/calendars/:id/view (any level): the caller's own view; null colour returns to the calendar's. */
export interface CalendarViewRequest { is_visible?: boolean; color?: string | null; notify_changes?: boolean }
export interface CalendarViewResponse { view: CalendarView }

// --- Group and organisation calendars ---------------------------------------------

/** A calendar as administrators and group managers see it: by name and counts, never its content. */
export interface SharedCalendarSummary {
  id: string;
  name: string;
  color: string;
  owner_kind: CalendarOwnerKind;
  owner: PersonRef | null;
  group: { id: string; name: string } | null;
  share_count: number;
  event_count: number;
  archived_at: string | null;
  /** A group or organisation calendar hidden by Delete, until an administrator restores it or the purge. */
  deleted_at: string | null;
  created_at: string;
}

/**
 * POST /api/calendar/shared-calendars: an organisation calendar
 * (calendars.manage), or with group_id a group calendar (calendars.manage
 * or a manager of that group), which starts with a contribute share to the
 * group.
 */
export interface SharedCalendarInput { name: string; color?: string; group_id?: string | null }

/** PUT /api/calendar/shared-calendars/:id (manage): the name and default colour of a UniHub calendar. */
export interface SharedCalendarUpdate { name?: string; color?: string }

/** The answer of create, update and restore. */
export interface SharedCalendarResponse { calendar: SharedCalendarSummary }

/** DELETE /api/calendar/shared-calendars/:id (a manager of its group, or calendars.manage): hidden at once; an administrator restores it; purged with its events after the bin's time. */
export interface DeleteSharedCalendarResponse { deleted: true }

/**
 * GET /api/admin/calendars (calendars.manage): Server › Calendars, every
 * organisation and group calendar (deleted ones included) and every
 * person's calendar shared with someone, by name and counts.
 */
export interface AdminCalendarsResponse { calendars: SharedCalendarSummary[] }

/** POST /api/admin/calendars/:id/restore (calendars.manage): a deleted group or organisation calendar back with its events and shares. */
export type RestoreSharedCalendarResponse = SharedCalendarResponse;
