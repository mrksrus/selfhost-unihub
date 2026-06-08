const fs = require('fs');
const path = require('path');
const { db } = require('../state');
const {
  startDataExportJob,
  listDataExportJobs,
  getDataExportJob,
  deleteDataExportJob,
  cancelDataExportJob,
  isBackupPathUnderRoot,
  serializeJob,
} = require('../services/export-jobs');
const {
  createUploadedRestoreJob,
  createRestoreFromExport,
  unlockRestoreJob,
  startRestoreJob,
  cancelRestoreJob,
  deleteRestoreJob,
  listRestoreJobs,
  getRestoreJob,
  serializeRestoreJob,
} = require('../services/backup-restore-jobs');
const { revealProtectedRecoveryPassword } = require('../services/backup-container');

const BACKUP_UPLOAD_ROOT = path.resolve('/app/uploads/backups/imports');

function getPathId(req, marker) {
  const parts = new URL(req.url, `http://${req.headers.host}`).pathname.split('/').filter(Boolean);
  const index = parts.indexOf(marker);
  return index === -1 ? null : parts[index + 1] || null;
}

function getRestoreOptions(req, body = {}) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return {
    sections: url.searchParams.get('sections') || body.sections || 'full',
    conflict_mode: url.searchParams.get('conflict_mode') || body.conflict_mode || body.conflictMode || 'keep_existing',
    calendar_mode: url.searchParams.get('calendar_mode') || body.calendar_mode || body.calendarMode || 'merge_same_name',
    credentials_mode: url.searchParams.get('credentials_mode') || body.credentials_mode || body.credentialsMode || 'keep_existing',
  };
}

function isTemporaryBackupUpload(req, body) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (
    !body?.filePath
    || (!contentType.includes('application/zip')
      && !contentType.includes('application/octet-stream')
      && !contentType.includes('application/vnd.unihub.backup'))
  ) {
    return false;
  }
  const filePath = path.resolve(body.filePath);
  return filePath.startsWith(`${BACKUP_UPLOAD_ROOT}${path.sep}`);
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
      return {
        job: await startDataExportJob(userId, {
          ...(body || {}),
          encrypt: body?.encrypt !== false,
        }),
        status: 202,
      };
    } catch (error) {
      console.error('Start backup job error:', error);
      return { error: error.message || 'Failed to start backup job', status: 500 };
    }
  },

  'GET /api/backup/jobs/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const jobId = getPathId(req, 'jobs');
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
      const jobId = getPathId(req, 'jobs');
      if (!jobId) return { error: 'Invalid backup job id', status: 400 };
      const job = await getDataExportJob(userId, jobId);
      if (!job) return { error: 'Backup job not found', status: 404 };
      if (job.status !== 'ready' || !job.file_path) return { error: 'Backup is not ready', status: 409 };
      if (job.encryption_enabled) {
        if (job.recovery_password_available) {
          return { error: 'Reveal and save the recovery password before the first download', status: 409 };
        }
        if (!job.recovery_password_revealed) {
          return {
            error: 'Recovery password metadata is missing. Create a new encrypted backup before downloading.',
            status: 409,
          };
        }
      }
      if (!isBackupPathUnderRoot(job.file_path)) return { error: 'Invalid backup path', status: 500 };
      const filePath = path.resolve(job.file_path);
      const stat = await fs.promises.stat(filePath);
      await db.execute(
        'UPDATE data_export_jobs SET downloaded_at = UTC_TIMESTAMP() WHERE id = ? AND user_id = ?',
        [jobId, userId]
      );
      const extension = job.encryption_enabled ? 'unihub-backup' : 'zip';
      return {
        __streamPath: filePath,
        __contentType: job.content_type || (job.encryption_enabled ? 'application/vnd.unihub.backup' : 'application/zip'),
        __contentLength: stat.size,
        __filename: `unihub-backup-${new Date().toISOString().slice(0, 10)}-${jobId}.${extension}`,
      };
    } catch (error) {
      console.error('Download backup job error:', error);
      return { error: 'Failed to download backup', status: 500 };
    }
  },

  'POST /api/backup/jobs/:id/recovery-password/reveal': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const jobId = getPathId(req, 'jobs');
    if (!jobId) return { error: 'Invalid backup job id', status: 400 };
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT jobs.backup_uuid, jobs.status,
                archive_keys.recovery_password_ciphertext,
                archive_keys.recovery_password_revealed_at,
                archive_keys.server_wrapped_key
         FROM data_export_jobs jobs
         LEFT JOIN backup_archive_keys archive_keys ON archive_keys.export_job_id = jobs.id
         WHERE jobs.id = ? AND jobs.user_id = ?
         FOR UPDATE`,
        [jobId, userId]
      );
      const row = rows[0];
      if (!row) {
        await connection.rollback();
        return { error: 'Backup or recovery password not found', status: 404 };
      }
      if (row.status !== 'ready') {
        await connection.rollback();
        return { error: 'Backup is not ready', status: 409 };
      }
      if (!row.recovery_password_ciphertext) {
        await connection.rollback();
        return row.recovery_password_revealed_at
          ? { error: 'Recovery password has already been revealed', status: 410 }
          : { error: 'Recovery password metadata is missing. Create a new encrypted backup.', status: 409 };
      }
      const password = revealProtectedRecoveryPassword(
        row.recovery_password_ciphertext,
        row.backup_uuid
      );
      await connection.execute(
        `UPDATE backup_archive_keys
         SET recovery_password_ciphertext = NULL,
             recovery_password_revealed_at = UTC_TIMESTAMP()
         WHERE backup_uuid = ? AND user_id = ?`,
        [row.backup_uuid, userId]
      );
      await connection.commit();
      return { recovery_password: password };
    } catch (error) {
      await connection.rollback().catch(() => {});
      console.error('Reveal backup recovery password error:', error);
      return { error: 'Failed to reveal recovery password', status: 500 };
    } finally {
      connection.release();
    }
  },

  'POST /api/backup/jobs/:id/restore': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const jobId = getPathId(req, 'jobs');
      const result = await createRestoreFromExport(userId, jobId, getRestoreOptions(req, body || {}));
      return result.error ? result : { ...result, status: 202 };
    } catch (error) {
      console.error('Create restore from backup error:', error);
      return { error: error.message || 'Failed to create restore job', status: 500 };
    }
  },

  'POST /api/backup/jobs/:id/cancel': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const result = await cancelDataExportJob(userId, getPathId(req, 'jobs'));
      return result.error ? result : { ...result, status: 202 };
    } catch (error) {
      console.error('Cancel backup job error:', error);
      return { error: 'Failed to cancel backup job', status: 500 };
    }
  },

  'DELETE /api/backup/jobs/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return await deleteDataExportJob(userId, getPathId(req, 'jobs'));
    } catch (error) {
      console.error('Delete backup job error:', error);
      return { error: 'Failed to delete backup job', status: 500 };
    }
  },

  'GET /api/backup/restore-jobs': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return { jobs: await listRestoreJobs(userId) };
    } catch (error) {
      console.error('List restore jobs error:', error);
      return { error: 'Failed to list restore jobs', status: 500 };
    }
  },

  'GET /api/backup/restore-jobs/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const job = await getRestoreJob(userId, getPathId(req, 'restore-jobs'));
      if (!job) return { error: 'Restore job not found', status: 404 };
      return { job: serializeRestoreJob(job) };
    } catch (error) {
      console.error('Get restore job error:', error);
      return { error: 'Failed to load restore job', status: 500 };
    }
  },

  'POST /api/backup/restore-jobs/:id/unlock': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const result = await unlockRestoreJob(
        userId,
        getPathId(req, 'restore-jobs'),
        body?.password
      );
      return result.error ? result : { ...result, status: 202 };
    } catch (error) {
      return {
        error: error.message || 'Unable to unlock backup. The password is incorrect or the backup is damaged.',
        status: 400,
      };
    }
  },

  'POST /api/backup/restore-jobs/:id/start': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const result = await startRestoreJob(userId, getPathId(req, 'restore-jobs'));
      return result.error ? result : { ...result, status: 202 };
    } catch (error) {
      console.error('Start restore job error:', error);
      return { error: 'Failed to start restore job', status: 500 };
    }
  },

  'POST /api/backup/restore-jobs/:id/cancel': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const result = await cancelRestoreJob(userId, getPathId(req, 'restore-jobs'));
      return result.error ? result : { ...result, status: 202 };
    } catch (error) {
      console.error('Cancel restore job error:', error);
      return { error: 'Failed to cancel restore job', status: 500 };
    }
  },

  'DELETE /api/backup/restore-jobs/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return await deleteRestoreJob(userId, getPathId(req, 'restore-jobs'));
    } catch (error) {
      console.error('Delete restore job error:', error);
      return { error: 'Failed to delete restore job', status: 500 };
    }
  },

  'GET /api/backup/export': async () => ({
    error: 'JSON backup export has been replaced by backup jobs.',
    status: 410,
  }),

  'POST /api/backup/import': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      if (!isTemporaryBackupUpload(req, body)) {
        return { error: 'Upload a .zip or .unihub-backup file', status: 400 };
      }
      const job = await createUploadedRestoreJob(
        userId,
        body.filePath,
        getRestoreOptions(req, {})
      );
      return { job, status: 202 };
    } catch (error) {
      console.error('Backup upload error:', error);
      return { error: error.message || 'Failed to retain backup upload', status: 500 };
    }
  },
};
