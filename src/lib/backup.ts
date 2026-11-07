import type { BackupJob } from '../../api/src/contracts/backup';

type DownloadableBackupState = {
  encryption_enabled: boolean;
  recovery_password_available: boolean;
  recovery_password_revealed: boolean;
};

export type BackupDownloadAction = 'download' | 'reveal_password' | 'missing_password_metadata';

export function getBackupDownloadAction(job: DownloadableBackupState): BackupDownloadAction {
  if (!job.encryption_enabled) return 'download';
  if (job.recovery_password_available) return 'reveal_password';
  return job.recovery_password_revealed ? 'download' : 'missing_password_metadata';
}

/**
 * How to open a backup outside UniHub (D37, P-35): with 7-Zip and the
 * recovery password, then mail into Thunderbird, contacts and calendars
 * through import. The integrator supplies the final words together with the
 * archive format; until then nothing is shown in its two places (under the
 * recovery password, under a downloaded backup).
 */
export const OPEN_OUTSIDE_UNIHUB: string | null = null;

/**
 * When a backup may be deleted under the administrator's minimum (D36): the
 * server's date, else the backup's completion plus the minimum; null when
 * nothing holds it.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
export function deletableFrom(job: Pick<BackupJob, 'keep_until' | 'completed_at' | 'created_at'>, minimumDays: number | null): string | null {
  if (job.keep_until) return job.keep_until;
  if (!minimumDays) return null;
  return new Date(Date.parse(job.completed_at || job.created_at) + minimumDays * DAY_MS).toISOString();
}
