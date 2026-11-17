// Request and response shapes of a calendar's change of owner (F4, F11).
// The owner of a person's calendar offers it to one active person within
// their reach who has the Calendar module; the recipient accepts or
// declines, the offerer withdraws; an offer has no expiry. A manager of a
// group that holds a share of read or higher on a person's calendar offers
// it, or hands it over at once, to an active member of that group, never an
// administrator's calendar. Administrators (calendars.manage) hand over at
// once any calendar on Server › Calendars, to a person, to the organisation
// or into its owner's bin, and archive or unarchive it; an administrator's
// calendar only the installation owner. After a hand-over every event moves
// with the calendar, its shares stay, the new owner's own share goes and the
// old owner keeps an edit share and their reminders. Synced calendars have no
// owner change. The frontend imports these as types only.
//
// Errors, besides those of every route and contracts/calendar-shares.ts: 400
// OFFER_INVALID (no such person, inactive, without the Calendar module, the
// owner themselves); 403 SHARE_OUT_OF_REACH; 404 OFFER_NOT_FOUND (no pending
// offer the caller may act on); 409 OFFER_PENDING (another offer is
// pending); 400 ADMIN_PASSWORD_REQUIRED, 403 ADMIN_PASSWORD_INCORRECT on the
// administrator's routes.
import type { AdminReauthentication } from './admin-accounts';
import type { CalendarOffer, SharedCalendarSummary } from './calendar-shares';

/**
 * POST /api/calendar/calendars/:id/hand-over: the owner (or a group manager
 * as above) offers the calendar to `to`; a group manager with `now` hands it
 * over at once. Answers the pending offer, or null after a hand-over at once.
 */
export interface HandOverRequest { to: string; now?: boolean }
export interface HandOverResponse { offer: CalendarOffer | null }

/** POST /api/calendar/calendars/:id/hand-over/accept (the recipient): reach, activity and the module are checked again. */
export interface AcceptOfferResponse { calendar_id: string }

/** DELETE /api/calendar/calendars/:id/hand-over: the offerer withdraws, the recipient declines; nothing else changes. */
export interface WithdrawOfferResponse { withdrawn: true }

/**
 * POST /api/admin/calendars/:id/hand-over (calendars.manage): at once, to a
 * person's id, to 'organisation', or to 'bin' (the calendar with its events
 * into its owner's bin). Also what the Deactivate and Delete dialogs call
 * per calendar.
 */
export interface AdminHandOverRequest extends AdminReauthentication { to: string }
export interface AdminHandOverResponse { calendar: SharedCalendarSummary | null }

/** PUT /api/admin/calendars/:id/archive (calendars.manage): archived calendars are read-only for everyone. */
export interface ArchiveCalendarRequest extends AdminReauthentication { archived: boolean }
export type ArchiveCalendarResponse = { calendar: SharedCalendarSummary };

/**
 * A person's calendar shared with someone, by name and counts. GET
 * /api/admin/users/:id/accounts lists them as `shared_calendars` for the
 * choice per calendar before Deactivate (leave it, a colleague, the
 * organisation, the bin) or Delete (a colleague, the organisation, the bin).
 */
export interface SharedCalendarRef { id: string; name: string; share_count: number; event_count: number }

/**
 * Notification kind `calendar-ownership`, three messages: an offer (to the
 * recipient), "now belongs to <name>" (to the old owner, after an accept
 * and a hand-over at once) and an archive (to the owner). At the detail
 * `none`: "A calendar's owner changed" without names.
 */
export type CalendarOwnershipNotice = 'offered' | 'handed_over' | 'archived';
