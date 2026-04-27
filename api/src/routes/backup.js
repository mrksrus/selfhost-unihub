const { buildBackupForUser, importBackupForUser } = require('../services/backup');

module.exports = {
  'GET /api/backup/export': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const backup = await buildBackupForUser(userId);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      return {
        __raw: JSON.stringify(backup, null, 2),
        __contentType: 'application/json; charset=utf-8',
        __filename: `unihub-backup-${timestamp}.json`,
      };
    } catch (error) {
      console.error('Backup export error:', error);
      return { error: error.message || 'Failed to export backup', status: 500 };
    }
  },

  'POST /api/backup/import': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const mode = body?.mode === 'apply' ? 'apply' : 'dry-run';
      const backup = body?.backup || body;
      const result = await importBackupForUser(userId, backup, { mode });
      return { import: result };
    } catch (error) {
      console.error('Backup import error:', error);
      return { error: error.message || 'Failed to import backup', status: 500 };
    }
  },
};
