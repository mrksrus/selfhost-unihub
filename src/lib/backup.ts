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
 * How to open a backup outside UniHub (D37, P-35; docs/BACKUP_RESTORE.md
 * "Opening a backup outside UniHub"): the short sentence under the recovery
 * password and under a downloaded backup, and the steps behind "How to open
 * it". Windows Explorer and the macOS Archive Utility cannot open AES ZIP
 * files, so the tools are named.
 */
export const OPEN_OUTSIDE_UNIHUB = 'This backup is a password-protected ZIP file. Open it with 7-Zip, Keka or WinRAR and the recovery password. Inside are your mail as .eml files, contacts as a .vcf file, calendars as .ics files and your recordings, ready for programs such as Thunderbird. To restore into UniHub, upload the file unchanged.';
export const OPEN_OUTSIDE_STEPS: readonly string[] = [
  'Open the downloaded .zip with 7-Zip (Windows, Linux), Keka (macOS), Ark (KDE) or WinRAR and enter the recovery password. The ZIP support built into Windows Explorer and the macOS Archive Utility cannot open it; they show only README.txt.',
  'Inside is unihub-backup.zip, an ordinary ZIP archive: open or extract it as usual.',
  'Mail/ holds one .eml file per message, by account and folder. In Thunderbird, install the ImportExportTools NG add-on and import a folder of messages, or drag the .eml files onto a folder.',
  'Contacts/Contacts.vcf and the Calendars/ .ics files import through File › Import in Thunderbird and in most calendar and contacts programs. Recordings/ holds the original audio files.',
  'To restore into UniHub, upload the downloaded file unchanged, not unihub-backup.zip or the extracted files.',
];

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
