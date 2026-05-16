const fs = require('fs');
const path = require('path');
const { db } = require('../state');
const { importBackupForUser, importBackupZipBufferForUser } = require('../services/backup');
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
      console.error('List backup jobs error:', error);
      return { error: 'Failed to list backup jobs', status: 500 };
    }
  },

  'POST /api/backup/jobs': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return { job: await startDataExportJob(userId, body || {}) };
    } catch (error) {
      console.error('Start backup job error:', error);
      return { error: error.message || 'Failed to start backup job', status: 500 };
    }
  },

  'GET /api/backup/jobs/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const jobId = getBackupJobId(req);
      if (!jobId) return { error: 'Invalid backup job id', status: 400 };
      const job = await getDataExportJob(userId, jobId);
      if (!job) return { error: 'Backup job not found', status: 404 };
      return { job: serializeJob(job) };
    } catch (error) {
      console.error('Get backup job error:', error);
      return { error: 'Failed to load backup job', status: 500 };
    }
  },

  'GET /api/backup/jobs/:id/download': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const jobId = getBackupJobId(req);
      if (!jobId) return { error: 'Invalid backup job id', status: 400 };
      const job = await getDataExportJob(userId, jobId);
      if (!job) return { error: 'Backup job not found', status: 404 };
      if (job.status !== 'ready' || !job.file_path) return { error: 'Backup is not ready', status: 409 };
      if (!isBackupPathUnderRoot(job.file_path)) return { error: 'Invalid backup path', status: 500 };
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
        __filename: `unihub-backup-${new Date().toISOString().slice(0, 10)}-${jobId}.zip`,
      };
    } catch (error) {
      console.error('Download backup job error:', error);
      return { error: 'Failed to download backup', status: 500 };
    }
  },

  'DELETE /api/backup/jobs/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const jobId = getBackupJobId(req);
      if (!jobId) return { error: 'Invalid backup job id', status: 400 };
      return await deleteDataExportJob(userId, jobId);
    } catch (error) {
      console.error('Delete backup job error:', error);
      return { error: 'Failed to delete backup job', status: 500 };
    }
  },

  'GET /api/backup/export': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return { error: 'JSON backup export has been replaced by ZIP backup jobs.', status: 410 };
    } catch (error) {
      console.error('Deprecated JSON backup endpoint error:', error);
      return { error: error.message || 'ZIP backup jobs are required for backup download', status: 500 };
    }
  },

  'POST /api/backup/import': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const mode = url.searchParams.get('mode') === 'apply' || body?.mode === 'apply' ? 'apply' : 'dry-run';
      const sections = url.searchParams.get('sections') || body?.sections || 'full';
      const options = {
        mode,
        sections,
        conflict_mode: url.searchParams.get('conflict_mode') || body?.conflict_mode || body?.conflictMode || 'keep_existing',
        calendar_mode: url.searchParams.get('calendar_mode') || body?.calendar_mode || body?.calendarMode || 'merge_same_name',
        credentials_mode: url.searchParams.get('credentials_mode') || body?.credentials_mode || body?.credentialsMode || 'keep_existing',
      };
      const result = Buffer.isBuffer(body)
        ? await importBackupZipBufferForUser(userId, body, options)
        : await importBackupForUser(userId, body?.backup || body, options);
      return { import: result };
    } catch (error) {
      console.error('Backup import error:', error);
      return { error: error.message || 'Failed to import backup', status: 500 };
    }
  },
};
