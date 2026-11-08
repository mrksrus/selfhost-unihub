import type { RowDataPacket } from 'mysql2/promise';
import type { ServerResponse } from 'node:http';
import type { RouteRequest, RouteResponse, ApiError } from '../types';
import type { BackupCapabilities, BackupCreateRequest } from '../contracts/backup';
import path from 'path';
import { db } from '../state';
import { BACKUP_UPLOAD_MAX_SIZE } from '../config';
import { defineRoutes } from '../http/route';
import { clientError } from '../http/errors';
import type { PolicyDeclaration, RouteTable } from '../http/route';
import {
  startDataExportJob,
  listDataExportJobs,
  getDataExportJob,
  deleteDataExportJob,
  cancelDataExportJob,
  backupArchiveFile,
  markBackupDownloaded,
  serializeJob,
} from '../services/export-jobs';
import {
  createUploadedRestoreJob,
  createRestoreFromExport,
  unlockRestoreJob,
  startRestoreJob,
  cancelRestoreJob,
  deleteRestoreJob,
  listRestoreJobs,
  getRestoreJob,
  serializeRestoreJob,
} from '../services/backup-restore-jobs';
import { revealProtectedRecoveryPassword } from '../services/backup-container';
import { BACKUP_DISABLED_MESSAGE, DISABLED_BACKUP_ROUTES } from '../services/backup-availability';
import { downloadMailChoice } from '../services/backup-classes';
import { assertBackupDeletable } from '../services/backup-policy';
import { SECTION_POLICIES, ACCOUNT_SECTION } from '../services/backup-catalog';
import { BACKUP_VERSION } from '../services/backup-format';

// Backup and restore of the signed-in person's data (docs/BACKUP_RESTORE.md).
// The routes are core routes: the backup spans the modules, and a restore
// locks the sections it writes (services/restore-locks.ts), so they declare
// no restore section of their own.
type Request = RouteRequest & { url: string; params: Record<string, string> };
interface Input extends BackupCreateRequest {
  filePath?: string;
  password?: string;
  scope?: string;
  conflict_mode?: string;
  conflictMode?: string;
  calendar_mode?: string;
  calendarMode?: string;
  credentials_mode?: string;
  credentialsMode?: string;
}

const BACKUP_UPLOAD_ROOT = path.resolve('/app/uploads/backups/imports');
const SECTION_LABELS: Readonly<Record<string, string>> = { settings: 'Settings', contacts: 'Contacts', calendar: 'Calendar/ToDo', mail: 'Mail', recordings: 'Recordings' };

function getRestoreOptions(req: Request, body: Input = {}) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return {
    sections: url.searchParams.get('sections') || body.sections || 'full',
    conflict_mode: url.searchParams.get('conflict_mode') || body.conflict_mode || body.conflictMode || 'keep_existing',
    calendar_mode: url.searchParams.get('calendar_mode') || body.calendar_mode || body.calendarMode || 'merge_same_name',
    credentials_mode: url.searchParams.get('credentials_mode') || body.credentials_mode || body.credentialsMode || 'keep_existing',
  };
}

function isTemporaryBackupUpload(req: Request, body: Input) {
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

const failed = (error: unknown, fallback: string, logLabel: string): RouteResponse => {
  console.error(`${logLabel}:`, error);
  const thrown = error as ApiError;
  return { error: thrown.status ? thrown.message : fallback, status: thrown.code === 'BACKUP_SECTION_UNSUPPORTED' ? 400 : thrown.status && thrown.status < 500 ? thrown.status : 500 };
};

type Handler = (req: Request, userId: string, body: Input, res: ServerResponse) => Promise<RouteResponse | undefined>;
// F13: creating and restoring a backup can be forbidden by a policy, and so can deleting one.
type Extra = { body?: { limit?: number; kind?: 'json' | 'backup-upload' | 'none' }; requires?: readonly PolicyDeclaration[]; destructive?: readonly PolicyDeclaration[] };
const user = (handler: Handler, extra: Extra = {}) => ({ auth: 'user' as const, module: null, ...extra, handler });
// Backup routes run the restore themselves, so a running restore does not gate them.
const write = (handler: Handler, extra: Extra = {}) => ({ ...user(handler, extra), restoreSection: null });

const routes: RouteTable = defineRoutes({
  'GET /api/backup/capabilities': user(async (_req, userId) => {
    const sections = Object.keys(SECTION_POLICIES).map(id => ({ id, label: SECTION_LABELS[id] || id }));
    const capabilities: BackupCapabilities = {
      enabled: DISABLED_BACKUP_ROUTES.size === 0, version: BACKUP_VERSION, sections,
      // Backup creation also offers the connection settings of mail and
      // calendar accounts without their content.
      export_sections: [...sections, { id: ACCOUNT_SECTION, label: 'Account settings' }],
      exclusions: ['Other users, login sessions and server configuration', 'Sync-mode mail and CalDAV events, which download again from the provider'],
      download_mail: await downloadMailChoice(userId),
    };
    return { ...capabilities };
  }),

  'GET /api/backup/jobs': user(async (_req, userId) => {
    try { return { jobs: await listDataExportJobs(userId) }; } catch (error) { return failed(error, 'Failed to list backup jobs', 'List backup jobs error'); }
  }),

  // Every new backup is encrypted; an older client's encrypt: false is ignored.
  'POST /api/backup/jobs': write(async (_req, userId, body) => {
    try {
      const job = await startDataExportJob(userId, { sections: body?.sections, scope: body?.scope, includeDownloadMail: body?.include_download_mail !== false });
      return { job, status: 202 };
    } catch (error) { return failed(error, 'Failed to start backup job', 'Start backup job error'); }
  }, { requires: ['backup.create'] }),

  'GET /api/backup/jobs/:id': user(async (req, userId) => {
    try {
      const job = await getDataExportJob(userId, req.params.id);
      if (!job) return { error: 'Backup job not found', status: 404 };
      return { job: serializeJob(job) };
    } catch (error) { return failed(error, 'Failed to load backup job', 'Get backup job error'); }
  }),

  // The browser's download, with the session cookie. Whatever downloads
  // outside the page (the Android app) uses a backup-archive ticket instead
  // (services/file-tickets.ts).
  'GET /api/backup/jobs/:id/download': user(async (req, userId) => {
    try {
      const file = await backupArchiveFile(userId, req.params.id);
      await markBackupDownloaded(userId, req.params.id);
      return { __streamPath: file.path, __contentType: file.contentType, __contentLength: file.size, __filename: file.filename };
    } catch (error) {
      if ((error as ApiError).status) return clientError(error, 'Failed to download backup');
      return failed(error, 'Failed to download backup', 'Download backup job error');
    }
  }),

  'POST /api/backup/jobs/:id/recovery-password/reveal': write(async (req, userId) => {
    const jobId = req.params.id;
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>(
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
      const password = revealProtectedRecoveryPassword(row.recovery_password_ciphertext, row.backup_uuid);
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
  }),

  'POST /api/backup/jobs/:id/restore': write(async (req, userId, body) => {
    try {
      const result = await createRestoreFromExport(userId, req.params.id, getRestoreOptions(req, body || {}));
      return result.error ? result : { ...result, status: 202 };
    } catch (error) { return failed(error, 'Failed to create restore job', 'Create restore from backup error'); }
  }, { requires: ['backup.restore'] }),

  'POST /api/backup/jobs/:id/cancel': write(async (req, userId) => {
    try {
      const result = await cancelDataExportJob(userId, req.params.id);
      return result.error ? result : { ...result, status: 202 };
    } catch (error) { return failed(error, 'Failed to cancel backup job', 'Cancel backup job error'); }
  }),

  // backup.server_retention_days is a minimum age before deleting (D36).
  'DELETE /api/backup/jobs/:id': write(async (req, userId) => {
    try {
      await assertBackupDeletable(userId, req.params.id);
      return await deleteDataExportJob(userId, req.params.id, { authorize: cx => assertBackupDeletable(userId, req.params.id, {}, cx, { lock: true }) });
    } catch (error) {
      if ((error as ApiError).code === 'POLICY_FORBIDS') return clientError(error, 'Failed to delete backup job');
      return failed(error, 'Failed to delete backup job', 'Delete backup job error');
    }
  }, { destructive: ['backup.delete'] }),

  'GET /api/backup/restore-jobs': user(async (_req, userId) => {
    try { return { jobs: await listRestoreJobs(userId) }; } catch (error) { return failed(error, 'Failed to list restore jobs', 'List restore jobs error'); }
  }),

  'GET /api/backup/restore-jobs/:id': user(async (req, userId) => {
    try {
      const job = await getRestoreJob(userId, req.params.id);
      if (!job) return { error: 'Restore job not found', status: 404 };
      return { job: serializeRestoreJob(job) };
    } catch (error) { return failed(error, 'Failed to load restore job', 'Get restore job error'); }
  }),

  'POST /api/backup/restore-jobs/:id/unlock': write(async (req, userId, body) => {
    try {
      const result = await unlockRestoreJob(userId, req.params.id, body?.password);
      return result.error ? result : { ...result, status: 202 };
    } catch (error) {
      return { error: (error as ApiError).message || 'Unable to unlock backup. The password is incorrect or the backup is damaged.', status: 400 };
    }
  }),

  'POST /api/backup/restore-jobs/:id/start': write(async (req, userId) => {
    try {
      const result = await startRestoreJob(userId, req.params.id);
      return result.error ? result : { ...result, status: 202 };
    } catch (error) { return failed(error, 'Failed to start restore job', 'Start restore job error'); }
  }, { requires: ['backup.restore'] }),

  'POST /api/backup/restore-jobs/:id/cancel': write(async (req, userId) => {
    try {
      const result = await cancelRestoreJob(userId, req.params.id);
      return result.error ? result : { ...result, status: 202 };
    } catch (error) { return failed(error, 'Failed to cancel restore job', 'Cancel restore job error'); }
  }),

  'DELETE /api/backup/restore-jobs/:id': write(async (req, userId) => {
    try { return await deleteRestoreJob(userId, req.params.id); } catch (error) { return failed(error, 'Failed to delete restore job', 'Delete restore job error'); }
  }, { destructive: ['backup.delete'] }),

  // The JSON export of releases before 0.9: gone, said plainly.
  'GET /api/backup/export': { auth: 'public', module: null, body: { kind: 'none' }, handler: async () => ({
    error: 'JSON backup export has been replaced by backup jobs.',
    status: 410,
  }) },

  // The boundary spools the archive to BACKUP_UPLOAD_ROOT and passes its path.
  'POST /api/backup/import': write(async (req, userId, body) => {
    try {
      if (!isTemporaryBackupUpload(req, body)) {
        return { error: 'Upload a .zip or .unihub-backup file', status: 400 };
      }
      const job = await createUploadedRestoreJob(userId, body.filePath!, getRestoreOptions(req, {}));
      return { job, status: 202 };
    } catch (error) { return failed(error, 'Failed to retain backup upload', 'Backup upload error'); }
  }, { body: { limit: BACKUP_UPLOAD_MAX_SIZE, kind: 'backup-upload' }, requires: ['backup.restore'] }),
});

// The emergency switch (services/backup-availability.ts), also for callers
// that dispatch a handler directly.
for (const key of DISABLED_BACKUP_ROUTES) {
  const spec = routes[key];
  if (spec) routes[key] = Object.freeze({ ...spec, handler: async () => ({ error: BACKUP_DISABLED_MESSAGE, status: 503 }) });
}

export = routes;
