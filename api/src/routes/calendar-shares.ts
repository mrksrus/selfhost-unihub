import type { RouteRequest } from '../types';
import type {
  AdminCalendarsResponse, CalendarShareCandidatesResponse, CalendarSharesResponse, CalendarViewResponse, DeleteSharedCalendarResponse,
  RestoreSharedCalendarResponse, SharedCalendarResponse,
} from '../contracts/calendar-shares';
import { defineRoutes } from '../http/route';
import {
  adminCalendars, calendarShareCandidates, calendarShares, createSharedCalendar, deleteSharedCalendar, restoreSharedCalendar, setCalendarShare,
  setCalendarView, updateSharedCalendar,
} from '../services/calendar-shares';

// Shared, group and organisation calendars (F4): shares, a person's view,
// and the calendars no person owns. Every route asks the access service
// (services/calendar-shares.ts) before anything happens and again inside
// the write's transaction. Grants, views and calendars no person owns are in
// no personal backup, so no route names a restore section.
type Request = RouteRequest & { url: string; params: Record<string, string> };

const route = { auth: 'user' as const, module: 'calendar', restoreSection: null };
const admin = { auth: 'admin' as const, permission: 'calendars.manage' as const, module: null, restoreSection: null };

export = defineRoutes({
  'GET /api/calendar/calendars/:id/shares': { ...route, handler: async (req: Request, userId: string) => {
    return { shares: await calendarShares(userId, req.params.id) } satisfies CalendarSharesResponse;
  } },
  'PUT /api/calendar/calendars/:id/shares': { ...route, body: { limit: 1024 }, handler: async (req: Request, userId: string, body: unknown) => {
    return { shares: await setCalendarShare(userId, req.params.id, body) } satisfies CalendarSharesResponse;
  } },
  'GET /api/calendar/calendars/:id/share-candidates': { ...route, handler: async (req: Request, userId: string) => {
    const query = new URL(req.url, 'http://unihub.invalid').searchParams.get('q') ?? '';
    return { ...await calendarShareCandidates(userId, req.params.id, query) } satisfies CalendarShareCandidatesResponse;
  } },
  'PUT /api/calendar/calendars/:id/view': { ...route, body: { limit: 1024 }, handler: async (req: Request, userId: string, body: unknown) => {
    return { view: await setCalendarView(userId, req.params.id, body) } satisfies CalendarViewResponse;
  } },

  'POST /api/calendar/shared-calendars': { ...route, body: { limit: 4096 }, handler: async (_req: Request, userId: string, body: unknown) => {
    return { calendar: await createSharedCalendar(userId, body) } satisfies SharedCalendarResponse;
  } },
  'PUT /api/calendar/shared-calendars/:id': { ...route, body: { limit: 4096 }, handler: async (req: Request, userId: string, body: unknown) => {
    return { calendar: await updateSharedCalendar(userId, req.params.id, body) } satisfies SharedCalendarResponse;
  } },
  // Hidden at once, deleted nothing for good: an administrator restores it.
  'DELETE /api/calendar/shared-calendars/:id': { ...route, handler: async (req: Request, userId: string) => {
    return { ...await deleteSharedCalendar(userId, req.params.id) } satisfies DeleteSharedCalendarResponse;
  } },

  // Server › Calendars: by name and counts, never content.
  'GET /api/admin/calendars': { ...admin, handler: async () => {
    return { calendars: await adminCalendars() } satisfies AdminCalendarsResponse;
  } },
  'POST /api/admin/calendars/:id/restore': { ...admin, handler: async (req: Request) => {
    return { calendar: await restoreSharedCalendar(req.params.id) } satisfies RestoreSharedCalendarResponse;
  } },
});
