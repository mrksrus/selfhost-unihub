import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import { createFileTicket } from '@/lib/file-tickets-api';
export { getBackupDownloadAction, type BackupDownloadAction } from '@/lib/backup';
import type {
  BackupCapabilities, BackupCreateRequest, BackupImportResult, BackupJob, BackupJobResponse, BackupJobsResponse, BackupSectionId,
} from '../../api/src/contracts/backup';

export type {
  BackupCapabilities, BackupContents, BackupDataClass, BackupImportResult, BackupJob, BackupJobStatus, BackupLeftOut, BackupSectionId, DownloadMailChoice,
} from '../../api/src/contracts/backup';

// The person's backups and restores (Settings → Backup and restore). Every
// backup made from 0.28 is encrypted; the recovery password is shown once
// before the first download, and the archive leaves the server through a
// download ticket (F9), never with the session cookie.

export type RestoreJob = {
  id: string;
  source_type: 'upload' | 'generated';
  source_export_job_id: string | null;
  status: 'uploaded' | 'awaiting_password' | 'validating' | 'validated' | 'queued' | 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'expired';
  operation: 'validate' | 'restore';
  phase: string;
  progress: number;
  cancel_requested: boolean;
  requested_sections: string[];
  conflict_mode: string;
  calendar_mode: string;
  credentials_mode: string;
  archive_available: boolean;
  archive_size: number | null;
  archive_sha256: string | null;
  backup_uuid: string | null;
  is_encrypted: boolean;
  validation_result: BackupImportResult | null;
  result_counts: BackupImportResult | null;
  error: string | null;
  attempt_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
};

export type BackupSection = { id: string; label: string };
export type ConflictMode = 'keep_existing' | 'replace' | 'keep_both';
export type CalendarMode = 'merge_same_name' | 'copy';
export type CredentialsMode = 'keep_existing' | 'restore';
export interface RestoreOptions { conflict_mode: ConflictMode; calendar_mode: CalendarMode; credentials_mode: CredentialsMode }

export const BACKUP_ACTIVE: readonly BackupJob['status'][] = ['queued', 'running', 'cancelling'];
export const RESTORE_ACTIVE: readonly RestoreJob['status'][] = ['uploaded', 'validating', 'queued', 'running', 'cancelling'];

// The 0.27 keys stay: use-mail-account-backup.ts lists an account's export under them too.
export const backupQueryKeys = {
  capabilities: ['backup-capabilities'] as const,
  jobs: ['backup-jobs'] as const,
  restoreJobs: ['backup-restore-jobs'] as const,
};

const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`The server did not answer with the ${what}.`);
  return value;
};
const job = (path: string) => `/backup/jobs/${encodeURIComponent(path)}`;
const restoreJob = (path: string) => `/backup/restore-jobs/${encodeURIComponent(path)}`;

export const backupApi = {
  capabilities: async (signal?: AbortSignal) => required(unwrap(await api.get<BackupCapabilities>('/backup/capabilities', { signal })), 'backup capabilities'),
  jobs: async (signal?: AbortSignal) => required(unwrap(await api.get<BackupJobsResponse>('/backup/jobs', { signal })), 'backups').jobs ?? [],
  restoreJobs: async (signal?: AbortSignal) => required(unwrap(await api.get<{ jobs: RestoreJob[] }>('/backup/restore-jobs', { signal })), 'restore jobs').jobs ?? [],
  /** Starts a backup; the answer is the queued job. Every backup is encrypted (0.28). */
  create: async (request: Pick<BackupCreateRequest, 'sections' | 'include_download_mail'>) =>
    required(unwrap(await api.post<BackupJobResponse>('/backup/jobs', request satisfies BackupCreateRequest)), 'backup').job,
  cancel: async (id: string) => { unwrap(await api.post(`${job(id)}/cancel`)); },
  delete: async (id: string) => { unwrap(await api.delete(job(id))); },
  revealRecoveryPassword: async (id: string) =>
    required(unwrap(await api.post<{ recovery_password: string }>(`${job(id)}/recovery-password/reveal`)), 'recovery password').recovery_password,
  /** Validates a backup kept on the server for a restore; the answer is the restore job to follow. */
  restoreStored: async (id: string, sections: string[] | 'full', options: RestoreOptions) =>
    required(unwrap(await api.post<{ job: RestoreJob }>(`${job(id)}/restore`, { sections, ...options })), 'restore job').job,
  /** Uploads an archive once; validation runs in the background. */
  upload: async (file: File, sections: BackupSectionId[] | 'full', options: RestoreOptions) => {
    const params = new URLSearchParams({ sections: sections === 'full' ? 'full' : sections.join(','), ...options });
    const contentType = file.name.endsWith('.unihub-backup') ? 'application/vnd.unihub.backup' : 'application/zip';
    return required(unwrap(await api.uploadBlob<{ job: RestoreJob }>(`/backup/import?${params}`, file, contentType)), 'restore job').job;
  },
  unlock: async (id: string, password: string) => required(unwrap(await api.post<{ job: RestoreJob }>(`${restoreJob(id)}/unlock`, { password })), 'restore job').job,
  startRestore: async (id: string) => required(unwrap(await api.post<{ job: RestoreJob }>(`${restoreJob(id)}/start`)), 'restore job').job,
  cancelRestore: async (id: string) => { unwrap(await api.post(`${restoreJob(id)}/cancel`)); },
  deleteRestore: async (id: string) => { unwrap(await api.delete(restoreJob(id))); },
};

/** The file name a backup is saved under: the archive is always `.unihub-backup`; an unencrypted one from before 0.28 keeps `.zip`. */
export const backupFileName = (job: Pick<BackupJob, 'id' | 'encryption_enabled'>, prefix = 'unihub-backup') =>
  `${prefix}-${job.id}.${job.encryption_enabled ? 'unihub-backup' : 'zip'}`;

/**
 * Asks for the download ticket of a ready backup: the answer goes to
 * `downloadTicket` (src/lib/platform.ts), which hands the URL to the browser
 * or the app's download manager without the session cookie. The dispatch
 * stays with the caller so a ticket answered after the session ended
 * (useSessionMutation's guarded onSuccess) starts no download. Rejects when
 * no ticket could be made.
 */
export async function prepareBackupDownload(job: Pick<BackupJob, 'id' | 'encryption_enabled'>, prefix?: string): Promise<{ url: string; filename: string }> {
  const ticket = await createFileTicket({ kind: 'backup-archive', id: job.id });
  return { url: ticket.url, filename: ticket.filename || backupFileName(job, prefix) };
}
