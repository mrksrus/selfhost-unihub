const fs = require('fs');
const path = require('path');
const { db } = require('../state');
const { buildBackupForUser, importBackupForUser } = require('../services/backup');
const {
  startDataExportJob,
  listDataExportJobs,
  getDataExportJob,
  deleteDataExportJob,
  isBackupPathUnderRoot,
  serializeJob,
} = require('../services/export-jobs');

function getBackupJobId(req) {
  const parts = new URL(req.url, `http://${req.headers.host}`).pathname.split('/').filter(Boolean);
  const index = parts.indexOf('jobs');
  return index === -1 ? null : parts[index + 1] || null;
}

module.exports = {
  'GET /api/backup/jobs': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return { jobs: await listDataExportJobs(userId) };
    } catch (error) {
      console.error('List export jobs error:', error);
      return { error: 'Failed to list export jobs', status: 500 };
    }
  },

  'POST /api/backup/jobs': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return { job: await startDataExportJob(userId, body || {}) };
    } catch (error) {
      console.error('Start export job error:', error);
      return { error: error.message || 'Failed to start export job', status: 500 };
    }
  },

  'GET /api/backup/jobs/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const jobId = getBackupJobId(req);
      if (!jobId) return { error: 'Invalid export job id', status: 400 };
      const job = await getDataExportJob(userId, jobId);
      if (!job) return { error: 'Export job not found', status: 404 };
      return { job: serializeJob(job) };
    } catch (error) {
      console.error('Get export job error:', error);
      return { error: 'Failed to load export job', status: 500 };
    }
  },

  'GET /api/backup/jobs/:id/download': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const jobId = getBackupJobId(req);
      if (!jobId) return { error: 'Invalid export job id', status: 400 };
      const job = await getDataExportJob(userId, jobId);
      if (!job) return { error: 'Export job not found', status: 404 };
      if (job.status !== 'ready' || !job.file_path) return { error: 'Export is not ready', status: 409 };
      if (!isBackupPathUnderRoot(job.file_path)) return { error: 'Invalid export path', status: 500 };
      const filePath = path.resolve(job.file_path);
      const stat = await fs.promises.stat(filePath);
      await db.execute(
        'UPDATE data_export_jobs SET downloaded_at = UTC_TIMESTAMP() WHERE id = ? AND user_id = ?',
        [jobId, userId]
      );
      return {
        __streamPath: filePath,
        __contentType: 'application/zip',
        __contentLength: stat.size,
        __filename: `unihub-export-${new Date().toISOString().slice(0, 10)}-${jobId}.zip`,
      };
    } catch (error) {
      console.error('Download export job error:', error);
      return { error: 'Failed to download export', status: 500 };
    }
  },

  'DELETE /api/backup/jobs/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const jobId = getBackupJobId(req);
      if (!jobId) return { error: 'Invalid export job id', status: 400 };
      return await deleteDataExportJob(userId, jobId);
    } catch (error) {
      console.error('Delete export job error:', error);
      return { error: 'Failed to delete export job', status: 500 };
    }
  },

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
