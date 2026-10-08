import type { IncomingMessage } from 'node:http';
import type { ApiError } from '../types';
import imported1 = require('../services/offline');
const { createOfflineSnapshot } = imported1;
export = {
  'GET /api/offline/snapshot': async (_req: IncomingMessage, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try { return { snapshot: await createOfflineSnapshot(userId) }; }
    catch (error) {
      console.error('[OFFLINE] Snapshot failed:', (error as ApiError).message);
      return { error: (error as ApiError).status === 413 ? (error as ApiError).message : 'Could not prepare offline data. Your previous snapshot was kept.', status: (error as ApiError).status === 413 ? 413 : 500 };
    }
  },
};
