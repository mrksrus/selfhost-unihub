import type { RouteRequest } from '../types';
import type { BinDeleteResponse, BinListResponse, BinRestoreResponse } from '../contracts/bin';
import { clientError } from '../http/errors';
import { defineRoutes } from '../http/route';
import { log } from '../log';
import { listBin, restoreFromBin, restoreBinItem, deleteBinItem, emptyBin } from '../services/bin';

// The bin (0.28, D13): listing, restoring, deleting for good and emptying.
// One route serves every module's items, so the bin service checks each
// item's module switch and the restore lock of its section; the routes are
// core routes (module and restoreSection null). Deleting for good and
// emptying remove data for good: they name bin.delete (F13).
type Request = RouteRequest & { url: string; params: Record<string, string> };

function failed(error: unknown, fallback: string) {
  const answer = clientError(error, fallback);
  if (answer.status >= 500) log.error('bin', fallback, error);
  return answer;
}

const binRoute = { auth: 'user' as const, module: null, restoreSection: null };

export = defineRoutes({
  'GET /api/bin': { auth: 'user', module: null, handler: async (req: Request, userId: string) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const answer: BinListResponse = await listBin(userId, url.searchParams.get('module'), url.searchParams.get('before'));
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to list the bin'); }
  } },

  // A list's whole group may be sent: up to 5000 ids (bin.ts parseIds).
  'POST /api/bin/restore': { ...binRoute, body: { limit: 262144 }, handler: async (_req: Request, userId: string, body: unknown) => {
    try {
      const answer: BinRestoreResponse = await restoreFromBin(userId, body);
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to restore from the bin'); }
  } },

  'POST /api/bin/:id/restore': { ...binRoute, handler: async (req: Request, userId: string, body: unknown) => {
    try {
      const answer: BinRestoreResponse = await restoreBinItem(userId, req.params.id, body);
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to restore from the bin'); }
  } },

  'DELETE /api/bin/:id': { ...binRoute, destructive: ['bin.delete'], handler: async (req: Request, userId: string) => {
    try {
      const answer: BinDeleteResponse = await deleteBinItem(userId, req.params.id);
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to delete from the bin'); }
  } },

  'POST /api/bin/empty': { ...binRoute, destructive: ['bin.delete'], handler: async (_req: Request, userId: string, body: unknown) => {
    try {
      const answer: BinDeleteResponse = await emptyBin(userId, body);
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to empty the bin'); }
  } },
});
