import type { ServerResponse } from 'node:http';
import type { RouteRequest } from '../types';
import type {
  AcceptOfferResponse, AdminHandOverResponse, ArchiveCalendarResponse, HandOverResponse, WithdrawOfferResponse,
} from '../contracts/calendar-ownership';
import { defineRoutes } from '../http/route';
import { confirmPasswordHash } from '../security/reauthentication';
import { getAuthTokenFromRequest } from '../auth';
import { asCaller } from '../services/caller-proof';
import { acceptOffer, adminHandOver, archiveCalendar, offerCalendar, withdrawOffer } from '../services/calendar-ownership';

// A calendar's change of owner (services/calendar-ownership.ts). The service
// checks the restore locks of the old and the new owner inside the
// transaction, so no route names a section of the caller's.
type Request = RouteRequest & { url: string; params: Record<string, string> };

const route = { auth: 'user' as const, module: 'calendar', restoreSection: null };

// The administrator's password, asked again as on the other admin paths; the change re-checks it in its transaction.
const admin = (change: (req: Request, adminId: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>) => ({
  auth: 'admin' as const, permission: 'calendars.manage' as const, module: null, restoreSection: null, body: { limit: 4096 },
  handler: async (req: Request, adminId: string, body: Record<string, unknown> | null, res: ServerResponse) => {
    const confirmed = await confirmPasswordHash(adminId, body?.current_password, res);
    if ('refused' in confirmed) return confirmed.refused;
    return asCaller({ userId: adminId, token: getAuthTokenFromRequest(req), permission: 'calendars.manage', passwordHash: confirmed.passwordHash },
      () => change(req, adminId, body ?? {}));
  },
});

export = defineRoutes({
  'POST /api/calendar/calendars/:id/hand-over': { ...route, body: { limit: 1024 }, handler: async (req: Request, userId: string, body: unknown) => {
    return { offer: await offerCalendar(userId, req.params.id, body, req) } satisfies HandOverResponse;
  } },
  'POST /api/calendar/calendars/:id/hand-over/accept': { ...route, handler: async (req: Request, userId: string) => {
    return { ...await acceptOffer(userId, req.params.id) } satisfies AcceptOfferResponse;
  } },
  'DELETE /api/calendar/calendars/:id/hand-over': { ...route, handler: async (req: Request, userId: string) => {
    return { ...await withdrawOffer(userId, req.params.id) } satisfies WithdrawOfferResponse;
  } },

  'POST /api/admin/calendars/:id/hand-over': admin(async (req, adminId, body) => {
    return { calendar: await adminHandOver(adminId, req.params.id, body, req) } satisfies AdminHandOverResponse;
  }),
  'PUT /api/admin/calendars/:id/archive': admin(async (req, adminId, body) => {
    return { calendar: await archiveCalendar(adminId, req.params.id, body, req) } satisfies ArchiveCalendarResponse;
  }),
});
