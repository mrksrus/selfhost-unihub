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
