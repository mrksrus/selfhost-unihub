import type { RouteRequest, ApiError } from '../types';
import type { FileTicketResponse } from '../contracts/files';
import { clientError } from '../http/errors';
import { log } from '../log';
import { defineRoutes } from '../http/route';
import { getAuthTokenFromRequest } from '../auth';
import { createFileTicket, redeemFileTicket } from '../services/file-tickets';

// Download tickets (F9, services/file-tickets.ts). The page asks for a ticket
// with its session; whatever fetches the file (the Android app) uses the URL
// without one. The kind decides the module and restore section, so the
// routes are core routes and the service checks both.
type Request = RouteRequest & { params: Record<string, string> };

function failed(error: unknown, fallback: string) {
  if (!(error as ApiError).status) log.error('files', fallback, error);
  return clientError(error, fallback);
}

export = defineRoutes({
  // Writes only the ticket, which no restore carries.
  'POST /api/files/tickets': { auth: 'user', module: null, restoreSection: null, body: { limit: 1024 },
    handler: async (req: Request, userId: string, body: unknown) => {
      try {
        const ticket: FileTicketResponse = await createFileTicket(userId, getAuthTokenFromRequest(req), body);
        return { ...ticket };
      } catch (error) { return failed(error, 'Failed to prepare the download'); }
    } },

  // Public: the ticket is the credential. Always a download (never shown as a
  // page of this origin), without ranges (single use), not cached.
  'GET /api/files/tickets/:token': { auth: 'public', module: null, body: { kind: 'none' },
    handler: async (req: Request) => {
      try {
        const file = await redeemFileTicket(req.params.token);
        return {
          __streamPath: file.path,
          __contentLength: file.size,
          __contentType: file.contentType,
          __filename: file.filename,
          __disposition: 'attachment',
          __ranges: false,
          __headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer' },
        };
      } catch (error) { return failed(error, 'Failed to send the file'); }
    } },
});
