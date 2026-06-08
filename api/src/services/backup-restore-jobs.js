const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('../state');
const {
  backupFromZipFile,
  importBackupForUser,
  normalizeBackupImportSections,
  sha256File,
} = require('./backup');
const {
  decryptBackupFile,
  decryptPortableCredentialBundle,
  readContainerHeader,
  unlockContainerWithPassword,
  unwrapDataKeyFromServer,
  wrapDataKeyForServer,
} = require('./backup-container');
const { pruneArchiveKeyIfUnreferenced } = require('./backup-archive-keys');
const {
  isAnyMailAccountSyncRunning,
  isAnyMailServerDeleteRunning,
} = require('./mail');
const RESTORE_ROOT = '/app/uploads/backups/restores';
const ATTACHMENTS_ROOT = '/app/uploads/attachments';
const MAIL_RAW_STORAGE_ROOT = '/app/uploads/mail-raw';
const RECORDINGS_ROOT = '/app/uploads/recordings';
const UPLOAD_RETENTION_DAYS = 7;
const ACTIVE_RESTORE_STATUSES = new Set(['queued', 'running', 'cancelling']);
const BUSY_RESTORE_STATUSES = new Set(['uploaded', 'validating', 'queued', 'running', 'cancelling']);
let restoreWorkerRunning = false;
let restoreWorkerScheduled = false;

class RestoreJobCancelledError extends Error {
  constructor() {
    super('Restore cancelled');
    this.name = 'RestoreJobCancelledError';
  }
}

function parseJsonValue(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
  } catch {
    return fallback;
  }
}

function serializeRestoreJob(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    source_type: row.source_type,
    source_export_job_id: row.source_export_job_id || null,
    status: row.status,
    operation: row.operation,
    phase: row.phase,
    progress: Number(row.progress) || 0,
    cancel_requested: Boolean(row.cancel_requested),
    requested_sections: normalizeBackupImportSections(parseJsonValue(row.requested_sections, 'full')),
    conflict_mode: row.conflict_mode,
    calendar_mode: row.calendar_mode,
    credentials_mode: row.credentials_mode,
    archive_available: Boolean(row.archive_path),
    archive_size: row.archive_size === null || row.archive_size === undefined ? null : Number(row.archive_size),
    archive_sha256: row.archive_sha256 || null,
    backup_uuid: row.backup_uuid || null,
    is_encrypted: Boolean(row.is_encrypted),
    validation_result: parseJsonValue(row.validation_result, null),
    result_counts: parseJsonValue(row.result_counts, null),
    error: row.error || null,
    attempt_count: Number(row.attempt_count) || 0,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    started_at: row.started_at instanceof Date ? row.started_at.toISOString() : (row.started_at || null),
    completed_at: row.completed_at instanceof Date ? row.completed_at.toISOString() : (row.completed_at || null),
    expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : (row.expires_at || null),
  };
}

async function updateRestoreJob(jobId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.execute(
    `UPDATE backup_restore_jobs
     SET ${keys.map(key => `${key} = ?`).join(', ')}
     WHERE id = ?`,
    [...keys.map(key => fields[key]), jobId]
  );
}

async function getRestoreJob(userId, jobId) {
  const [rows] = await db.execute(
    'SELECT * FROM backup_restore_jobs WHERE id = ? AND user_id = ? LIMIT 1',
    [jobId, userId]
  );
  return rows[0] || null;
}

async function listRestoreJobs(userId) {
  const [rows] = await db.execute(
    'SELECT * FROM backup_restore_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
    [userId]
  );
  return (rows || []).map(serializeRestoreJob);
}

function getJobWorkDir(jobId) {
  return path.join(RESTORE_ROOT, 'work', String(jobId));
}

function getRestoreDataDirs(userId, jobId) {
  return [ATTACHMENTS_ROOT, MAIL_RAW_STORAGE_ROOT, RECORDINGS_ROOT].map(root => (
    path.join(root, String(userId), 'restores', String(jobId))
  ));
}

async function cleanupJobWork(job) {
  await fs.promises.rm(getJobWorkDir(job.id), { recursive: true, force: true }).catch(() => {});
}

async function cleanupRestoredFiles(job) {
  await Promise.all(getRestoreDataDirs(job.user_id, job.id).map(dir => (
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
  )));
}

async function checkRestoreCancelled(jobId) {
  const [rows] = await db.execute(
    'SELECT cancel_requested, status FROM backup_restore_jobs WHERE id = ? LIMIT 1',
    [jobId]
  );
  if (!rows.length || rows[0].cancel_requested || rows[0].status === 'cancelling') {
    throw new RestoreJobCancelledError();
  }
}

async function getServerDataKey(job) {
  if (!job.is_encrypted) return null;
  const [rows] = await db.execute(
    `SELECT server_wrapped_key
     FROM backup_archive_keys
     WHERE backup_uuid = ? AND user_id = ?
     LIMIT 1`,
    [job.backup_uuid, job.user_id]
  );
  if (!rows.length) return null;
  try {
    return unwrapDataKeyFromServer(rows[0].server_wrapped_key, job.backup_uuid);
  } catch {
    return null;
  }
}

async function prepareZipForJob(job, dataKey) {
  if (!job.is_encrypted) return { zipPath: job.archive_path, temporary: false };
  const workDir = getJobWorkDir(job.id);
  const zipPath = path.join(workDir, 'archive.zip');
  await fs.promises.rm(workDir, { recursive: true, force: true });
  await fs.promises.mkdir(workDir, { recursive: true });
  await updateRestoreJob(job.id, { phase: 'decrypting', progress: 5 });
  await decryptBackupFile(job.archive_path, zipPath, dataKey, {
    checkCancelled: () => checkRestoreCancelled(job.id),
    onProgress: async (processed, total) => {
      await updateRestoreJob(job.id, {
        progress: 5 + Math.round((processed / Math.max(total, 1)) * 30),
      });
    },
  });
  return { zipPath, temporary: true };
}

async function loadBackupForJob(job, dataKey) {
  const prepared = await prepareZipForJob(job, dataKey);
  try {
    const parsed = await backupFromZipFile(prepared.zipPath);
    if (parsed.backup.portable_credentials) {
      if (!dataKey) throw new Error('Protected portable credentials require an encrypted backup key.');
      decryptPortableCredentialBundle(parsed.backup.portable_credentials, dataKey);
    }
    return { ...parsed, prepared };
  } catch (error) {
    if (prepared.temporary) await cleanupJobWork(job);
    throw error;
  }
}

async function validateRestoreJob(job) {
  await updateRestoreJob(job.id, {
    status: 'validating',
    phase: 'hashing',
    progress: 1,
    error: null,
    started_at: job.started_at || new Date(),
  });
  await checkRestoreCancelled(job.id);
  const archiveHash = await sha256File(job.archive_path, () => checkRestoreCancelled(job.id));
  await updateRestoreJob(job.id, { archive_sha256: archiveHash, progress: 4 });
  const dataKey = await getServerDataKey(job);
  if (job.is_encrypted && !dataKey) {
    await updateRestoreJob(job.id, {
      status: 'awaiting_password',
      phase: 'awaiting_password',
      progress: 0,
    });
    return;
  }

  const parsed = await loadBackupForJob(job, dataKey);
  try {
    await updateRestoreJob(job.id, { phase: 'validating', progress: 40 });
    const validation = await importBackupForUser(job.user_id, parsed.backup, {
      mode: 'dry-run',
      sections: parseJsonValue(job.requested_sections, 'full'),
      conflict_mode: job.conflict_mode,
      calendar_mode: job.calendar_mode,
      credentials_mode: job.credentials_mode,
      fileSourcesByPath: parsed.fileSourcesByPath,
      portableCredentialKey: dataKey,
    });
    if (!validation.valid || validation.errors?.length) {
      await updateRestoreJob(job.id, {
        status: 'failed',
        phase: 'validation_failed',
        progress: 100,
        validation_result: JSON.stringify(validation),
        error: validation.errors?.[0] || 'Backup validation failed',
        completed_at: new Date(),
      });
      await discardInvalidUpload(job);
      return;
    }
    await updateRestoreJob(job.id, {
      status: 'validated',
      phase: 'validated',
      progress: 100,
      validation_result: JSON.stringify(validation),
      error: null,
      completed_at: new Date(),
    });
  } finally {
    if (parsed.prepared.temporary) await cleanupJobWork(job);
  }
}

async function restoreValidatedJob(job) {
  await cleanupRestoredFiles(job);
  await updateRestoreJob(job.id, {
    status: 'running',
    phase: 'preparing',
    progress: 1,
    error: null,
    started_at: new Date(),
    completed_at: null,
    attempt_count: Number(job.attempt_count || 0) + 1,
  });
  await checkRestoreCancelled(job.id);
  const restoreSections = new Set(normalizeBackupImportSections(parseJsonValue(job.requested_sections, 'full')));
  if (restoreSections.has('mail')) {
    while (isAnyMailAccountSyncRunning() || isAnyMailServerDeleteRunning()) {
      await updateRestoreJob(job.id, { phase: 'waiting_for_mail', progress: 1 });
      await new Promise(resolve => setTimeout(resolve, 1000));
      await checkRestoreCancelled(job.id);
    }
  }
  const dataKey = await getServerDataKey(job);
  if (job.is_encrypted && !dataKey) {
    throw new Error('The encrypted backup key is no longer available. Upload the backup and enter its recovery password again.');
  }
  const parsed = await loadBackupForJob(job, dataKey);
  try {
    await updateRestoreJob(job.id, { phase: 'restoring', progress: 40 });
    const result = await importBackupForUser(job.user_id, parsed.backup, {
      mode: 'apply',
      sections: parseJsonValue(job.requested_sections, 'full'),
      conflict_mode: job.conflict_mode,
      calendar_mode: job.calendar_mode,
      credentials_mode: job.credentials_mode,
      fileSourcesByPath: parsed.fileSourcesByPath,
      portableCredentialKey: dataKey,
      restoreJobId: job.id,
      checkCancelled: () => checkRestoreCancelled(job.id),
      onProgress: async (phase, progress) => {
        await updateRestoreJob(job.id, { phase, progress });
      },
      beforeCommit: async (connection, restoreResult) => {
        await connection.execute(
          `UPDATE backup_restore_jobs
           SET status = 'completed',
               phase = 'completed',
               progress = 100,
               result_counts = ?,
               error = NULL,
               completed_at = UTC_TIMESTAMP()
           WHERE id = ?`,
          [JSON.stringify(restoreResult), job.id]
        );
      },
    });
    await cleanupSuccessfulUpload(job).catch(error => {
      console.warn('[BACKUP RESTORE] Restore completed but upload cleanup failed:', error.message);
    });
    return result;
  } finally {
    if (parsed.prepared.temporary) await cleanupJobWork(job);
  }
}

async function cleanupSuccessfulUpload(job) {
  if (job.source_type !== 'upload') return;
  if (job.archive_path) {
    await fs.promises.rm(job.archive_path, { force: true }).catch(() => {});
  }
  await updateRestoreJob(job.id, { archive_path: null, expires_at: null });
  await pruneArchiveKeyIfUnreferenced(job.user_id, job.backup_uuid);
}

async function discardInvalidUpload(job) {
  if (job.source_type !== 'upload') return;
  if (job.archive_path) {
    await fs.promises.rm(job.archive_path, { force: true }).catch(() => {});
  }
  await updateRestoreJob(job.id, { archive_path: null, expires_at: null });
  await pruneArchiveKeyIfUnreferenced(job.user_id, job.backup_uuid);
}

async function runRestoreJob(jobId) {
  const [rows] = await db.execute('SELECT * FROM backup_restore_jobs WHERE id = ? LIMIT 1', [jobId]);
  const job = rows[0];
  if (!job || !['uploaded', 'queued'].includes(job.status)) return;
  try {
    if (job.operation === 'restore') await restoreValidatedJob(job);
    else await validateRestoreJob(job);
  } catch (error) {
    await cleanupJobWork(job);
    await cleanupRestoredFiles(job);
    if (error instanceof RestoreJobCancelledError) {
      await updateRestoreJob(job.id, {
        status: 'cancelled',
        phase: 'cancelled',
        progress: 100,
        error: null,
        completed_at: new Date(),
      });
      return;
    }
    if (
      job.operation === 'validate'
      && /(backup|zip|checksum|encrypted|credential bundle|archive)/i.test(error.message || '')
    ) {
      await discardInvalidUpload(job).catch(() => {});
    }
    console.error('[BACKUP RESTORE] Job failed:', error);
    await updateRestoreJob(job.id, {
      status: 'failed',
      phase: 'failed',
      progress: 100,
      error: error.message || 'Backup restore failed',
      completed_at: new Date(),
    });
  }
}

async function pumpRestoreJobs() {
  if (restoreWorkerRunning) return;
  restoreWorkerRunning = true;
  try {
    while (true) {
      const [rows] = await db.execute(
        `SELECT id FROM backup_restore_jobs
         WHERE status IN ('uploaded', 'queued')
         ORDER BY created_at ASC
         LIMIT 1`
      );
      if (!rows.length) break;
      await runRestoreJob(rows[0].id);
    }
  } finally {
    restoreWorkerRunning = false;
  }
}

function scheduleRestoreWorker() {
  if (restoreWorkerScheduled) return;
  restoreWorkerScheduled = true;
  setTimeout(() => {
    restoreWorkerScheduled = false;
    pumpRestoreJobs().catch(error => console.error('[BACKUP RESTORE] Worker crashed:', error));
  }, 20);
}

function normalizeRestoreOptions(options = {}) {
  return {
    sections: normalizeBackupImportSections(options.sections || 'full'),
    conflictMode: ['keep_existing', 'replace', 'keep_both'].includes(options.conflict_mode)
      ? options.conflict_mode
      : 'keep_existing',
    calendarMode: ['merge_same_name', 'copy'].includes(options.calendar_mode)
      ? options.calendar_mode
      : 'merge_same_name',
    credentialsMode: ['keep_existing', 'restore'].includes(options.credentials_mode)
      ? options.credentials_mode
      : 'keep_existing',
  };
}

async function createUploadedRestoreJob(userId, sourcePath, options = {}) {
  const jobId = crypto.randomUUID();
  const normalized = normalizeRestoreOptions(options);
  const parsedHeader = await readContainerHeader(sourcePath);
  const encrypted = Boolean(parsedHeader);
  const backupUuid = parsedHeader?.header?.backup_uuid || null;
  const targetDir = path.join(RESTORE_ROOT, String(userId));
  await fs.promises.mkdir(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, `${jobId}.${encrypted ? 'unihub-backup' : 'zip'}`);
  await fs.promises.rename(sourcePath, targetPath);
  const stat = await fs.promises.stat(targetPath);
  let status = 'uploaded';
  if (encrypted) {
    const [keys] = await db.execute(
      'SELECT backup_uuid FROM backup_archive_keys WHERE backup_uuid = ? AND user_id = ? LIMIT 1',
      [backupUuid, userId]
    );
    if (!keys.length) status = 'awaiting_password';
  }

  try {
    await db.execute(
      `INSERT INTO backup_restore_jobs
         (id, user_id, source_type, status, operation, phase, progress, requested_sections,
          conflict_mode, calendar_mode, credentials_mode, archive_path, archive_size,
          backup_uuid, is_encrypted, expires_at)
       VALUES (?, ?, 'upload', ?, 'validate', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        userId,
        status,
        status,
        JSON.stringify(normalized.sections),
        normalized.conflictMode,
        normalized.calendarMode,
        normalized.credentialsMode,
        targetPath,
        stat.size,
        backupUuid,
        encrypted ? 1 : 0,
        new Date(Date.now() + (UPLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000)),
      ]
    );
  } catch (error) {
    await fs.promises.rm(targetPath, { force: true }).catch(() => {});
    throw error;
  }
  if (status === 'uploaded') scheduleRestoreWorker();
  return serializeRestoreJob(await getRestoreJob(userId, jobId));
}

async function createRestoreFromExport(userId, exportJobId, options = {}) {
  const [exports] = await db.execute(
    'SELECT * FROM data_export_jobs WHERE id = ? AND user_id = ? LIMIT 1',
    [exportJobId, userId]
  );
  const exportJob = exports[0];
  if (!exportJob) return { error: 'Backup not found', status: 404 };
  if (exportJob.status !== 'ready' || !exportJob.file_path) {
    return { error: 'Backup is not ready', status: 409 };
  }
  const normalized = normalizeRestoreOptions({
    ...options,
    sections: options.sections || parseJsonValue(exportJob.requested_sections, 'full'),
  });
  const [active] = await db.execute(
    `SELECT id FROM backup_restore_jobs
     WHERE user_id = ? AND status IN ('queued', 'running', 'cancelling')
     LIMIT 1`,
    [userId]
  );
  if (active.length) return { error: 'Another restore is already running', status: 409 };
  const jobId = crypto.randomUUID();
  await db.execute(
    `INSERT INTO backup_restore_jobs
       (id, user_id, source_type, source_export_job_id, status, operation, phase, progress,
        requested_sections, conflict_mode, calendar_mode, credentials_mode, archive_path,
        archive_size, archive_sha256, backup_uuid, is_encrypted)
     VALUES (?, ?, 'generated', ?, 'uploaded', 'validate', 'uploaded', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId,
      userId,
      exportJobId,
      JSON.stringify(normalized.sections),
      normalized.conflictMode,
      normalized.calendarMode,
      normalized.credentialsMode,
      exportJob.file_path,
      exportJob.file_size,
      exportJob.file_sha256,
      exportJob.backup_uuid,
      exportJob.encryption_enabled ? 1 : 0,
    ]
  );
  scheduleRestoreWorker();
  return { job: serializeRestoreJob(await getRestoreJob(userId, jobId)) };
}

async function unlockRestoreJob(userId, jobId, password) {
  const job = await getRestoreJob(userId, jobId);
  if (!job) return { error: 'Restore job not found', status: 404 };
  if (job.status !== 'awaiting_password' || !job.is_encrypted) {
    return { error: 'Restore job is not waiting for a password', status: 409 };
  }
  if (!password) return { error: 'Recovery password is required', status: 400 };
  const unlocked = await unlockContainerWithPassword(job.archive_path, password);
  if (unlocked.header.backup_uuid !== job.backup_uuid) {
    return { error: 'Unable to unlock backup. The password is incorrect or the backup is damaged.', status: 400 };
  }
  await db.execute(
    `INSERT INTO backup_archive_keys
       (backup_uuid, user_id, server_wrapped_key, expires_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       restore_job_id = NULL,
       server_wrapped_key = VALUES(server_wrapped_key),
       expires_at = CASE
         WHEN export_job_id IS NULL
           THEN GREATEST(COALESCE(expires_at, VALUES(expires_at)), VALUES(expires_at))
         ELSE expires_at
       END`,
    [
      job.backup_uuid,
      userId,
      wrapDataKeyForServer(unlocked.dataKey, job.backup_uuid),
      job.expires_at,
    ]
  );
  await updateRestoreJob(jobId, {
    status: 'uploaded',
    phase: 'uploaded',
    operation: 'validate',
    progress: 0,
    error: null,
  });
  scheduleRestoreWorker();
  return { job: serializeRestoreJob(await getRestoreJob(userId, jobId)) };
}

async function startRestoreJob(userId, jobId) {
  const job = await getRestoreJob(userId, jobId);
  if (!job) return { error: 'Restore job not found', status: 404 };
  if (!['validated', 'failed', 'cancelled'].includes(job.status)) {
    return { error: 'Restore job must be validated before it can start', status: 409 };
  }
  const validation = parseJsonValue(job.validation_result, null);
  const retryValidation = !validation?.valid || Boolean(validation.errors?.length);
  const [active] = await db.execute(
    `SELECT id FROM backup_restore_jobs
     WHERE user_id = ? AND id <> ? AND status IN ('queued', 'running', 'cancelling')
     LIMIT 1`,
    [userId, jobId]
  );
  if (active.length) return { error: 'Another restore is already running', status: 409 };
  if (!job.archive_path || !fs.existsSync(job.archive_path)) {
    return { error: 'The retained backup archive is no longer available', status: 410 };
  }
  await updateRestoreJob(jobId, {
    status: retryValidation ? 'uploaded' : 'queued',
    operation: retryValidation ? 'validate' : 'restore',
    phase: retryValidation ? 'uploaded' : 'queued',
    progress: 0,
    cancel_requested: 0,
    error: null,
    completed_at: null,
  });
  scheduleRestoreWorker();
  return { job: serializeRestoreJob(await getRestoreJob(userId, jobId)) };
}

async function cancelRestoreJob(userId, jobId) {
  const job = await getRestoreJob(userId, jobId);
  if (!job) return { error: 'Restore job not found', status: 404 };
  if (!BUSY_RESTORE_STATUSES.has(job.status)) {
    return { error: 'Restore job is not running', status: 409 };
  }
  if (job.phase === 'commit') {
    return { error: 'Restore is committing and can no longer be stopped', status: 409 };
  }
  if (['uploaded', 'queued'].includes(job.status)) {
    await updateRestoreJob(jobId, {
      status: 'cancelled',
      phase: 'cancelled',
      progress: 100,
      cancel_requested: 1,
      completed_at: new Date(),
    });
  } else {
    await updateRestoreJob(jobId, {
      status: 'cancelling',
      phase: 'cancelling',
      cancel_requested: 1,
    });
  }
  return { job: serializeRestoreJob(await getRestoreJob(userId, jobId)) };
}

async function deleteRestoreJob(userId, jobId) {
  const job = await getRestoreJob(userId, jobId);
  if (!job) return { error: 'Restore job not found', status: 404 };
  if (BUSY_RESTORE_STATUSES.has(job.status)) {
    return { error: 'Stop the restore before deleting it', status: 409 };
  }
  await cleanupJobWork(job);
  if (job.source_type === 'upload' && job.archive_path) {
    await fs.promises.rm(job.archive_path, { force: true }).catch(() => {});
  }
  await db.execute('DELETE FROM backup_restore_jobs WHERE id = ? AND user_id = ?', [jobId, userId]);
  await pruneArchiveKeyIfUnreferenced(userId, job.backup_uuid);
  return { deleted: true };
}

async function resumePendingRestoreJobs() {
  const [completedUploads] = await db.execute(
    `SELECT * FROM backup_restore_jobs
     WHERE source_type = 'upload' AND status = 'completed' AND archive_path IS NOT NULL`
  );
  for (const job of completedUploads || []) {
    await cleanupSuccessfulUpload(job).catch(error => {
      console.warn('[BACKUP RESTORE] Could not finish completed upload cleanup:', error.message);
    });
  }
  const [interrupted] = await db.execute(
    `SELECT * FROM backup_restore_jobs
     WHERE status IN ('validating', 'running', 'cancelling')`
  );
  for (const job of interrupted || []) {
    await cleanupJobWork(job);
    await cleanupRestoredFiles(job);
    await updateRestoreJob(job.id, job.cancel_requested
      ? {
          status: 'cancelled',
          phase: 'cancelled',
          progress: 100,
          completed_at: new Date(),
        }
      : {
          status: job.operation === 'restore' ? 'queued' : 'uploaded',
          phase: 'queued',
          progress: 0,
        });
  }
  scheduleRestoreWorker();
  return interrupted.length;
}

async function cleanupExpiredRestoreArchives() {
  const [rows] = await db.execute(
    `SELECT * FROM backup_restore_jobs
     WHERE source_type = 'upload'
       AND archive_path IS NOT NULL
       AND expires_at IS NOT NULL
       AND expires_at <= UTC_TIMESTAMP()
       AND status NOT IN ('validating', 'queued', 'running', 'cancelling')`
  );
  for (const job of rows || []) {
    await fs.promises.rm(job.archive_path, { force: true }).catch(() => {});
    await updateRestoreJob(job.id, {
      status: 'expired',
      phase: 'expired',
      archive_path: null,
    });
    await pruneArchiveKeyIfUnreferenced(job.user_id, job.backup_uuid);
  }
  return rows.length;
}

async function getActiveRestoreSections(userId) {
  const [rows] = await db.execute(
    `SELECT requested_sections
     FROM backup_restore_jobs
     WHERE user_id = ? AND status IN ('queued', 'running', 'cancelling')
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId]
  );
  return rows.length
    ? new Set(normalizeBackupImportSections(parseJsonValue(rows[0].requested_sections, 'full')))
    : new Set();
}

async function isSectionRestoreActive(userId, section) {
  const sections = await getActiveRestoreSections(userId);
  return sections.has(section);
}

module.exports = {
  RESTORE_ROOT,
  ACTIVE_RESTORE_STATUSES,
  serializeRestoreJob,
  createUploadedRestoreJob,
  createRestoreFromExport,
  unlockRestoreJob,
  startRestoreJob,
  cancelRestoreJob,
  deleteRestoreJob,
  listRestoreJobs,
  getRestoreJob,
  resumePendingRestoreJobs,
  cleanupExpiredRestoreArchives,
  getActiveRestoreSections,
  isSectionRestoreActive,
  scheduleRestoreWorker,
};
