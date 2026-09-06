const { createOfflineSnapshot } = require('../services/offline');
module.exports = {
  'GET /api/offline/snapshot': async (_req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try { return { snapshot: await createOfflineSnapshot(userId) }; }
    catch (error) {
      console.error('[OFFLINE] Snapshot failed:', error.message);
      return { error: error.status === 413 ? error.message : 'Could not prepare offline data. Your previous snapshot was kept.', status: error.status === 413 ? 413 : 500 };
    }
  },
};
