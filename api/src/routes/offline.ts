import type { ApiError, RouteRequest } from '../types';
import { createOfflineSnapshot } from '../services/offline';
import { defineRoutes } from '../http/route';

export = defineRoutes({
  'GET /api/offline/snapshot': { auth: 'user', module: null, handler: async (_req: RouteRequest, userId: string) => {
    try { return { snapshot: await createOfflineSnapshot(userId) }; }
    catch (error) {
      console.error('[OFFLINE] Snapshot failed:', (error as ApiError).message);
      return { error: (error as ApiError).status === 413 ? (error as ApiError).message : 'Could not prepare offline data. Your previous snapshot was kept.', status: (error as ApiError).status === 413 ? 413 : 500 };
    }
  } },
});
