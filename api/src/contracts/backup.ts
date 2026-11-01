// Request and response shapes of the backup routes from 0.28 (F11). The
// frontend imports these as types only; the rules are in services/export-jobs.ts,
// services/backup-import.ts and the recovery catalog (services/backup-catalog.ts,
// services/data-inventory.ts), and docs/BACKUP_RESTORE.md describes them.

/** The sections a person can choose. The request parser still accepts "accounts" from older clients. */
export type BackupSectionId = 'settings' | 'contacts' | 'calendar' | 'mail' | 'recordings';

/**
 * The data classes of F2. A user backup holds UniHub's own data (local, the
 * local overlay on synced items, configuration) and Download-mode mail by
 * policy; mirrored provider data downloads again after the accounts reconnect.
 */
export type BackupDataClass = 'local' | 'local-by-policy' | 'mirror' | 'org' | 'config' | 'installation' | 'ciphertext';

/** Something a backup does not hold, with the reason in plain words. */
export interface BackupLeftOut {
  section: BackupSectionId;
  /** For example "Sync-mode mail" or "CalDAV events". */
  what: string;
  /** For example "It downloads again from the provider after the account reconnects." */
  reason: string;
  /** How many items, where the archive or the restore counted them. */
  count?: number;
}

/** What a backup holds by class, written into its manifest and shown before and after a restore. */
export interface BackupContents {
  included: BackupDataClass[];
  left_out: BackupLeftOut[];
  /** Plain notes, for example on mail that downloads again. */
  notes: string[];
}

/**
 * Whether the backup holds Download-mode mail. A policy (backup.download_mail)
 * or an account that deletes mail at the provider can force it on; the
 * control is then checked and greyed out with the reason.
 */
export interface DownloadMailChoice {
  value: boolean;
  forced: boolean;
  reason: string | null;
  /** The Download-mode accounts whose mail is always included (provider deletion on). */
  forced_account_ids: string[];
}

/** POST /api/backup/jobs */
export interface BackupCreateRequest {
  /** 'full' or the chosen sections. */
  sections?: 'full' | BackupSectionId[];
  /** "Include downloaded mail"; a forced choice wins. */
  include_download_mail?: boolean;
  /** Ignored from 0.28: every new backup is encrypted. Older clients still send it. */
  encrypt?: boolean;
}

/** POST /api/mail/accounts/:id/backup-export: one mail account's backup, always encrypted. */
export interface MailAccountBackupRequest {
  /** Ignored from 0.28, as above. */
  encrypt?: boolean;
}

export type BackupJobStatus = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'ready' | 'failed';

/** A user backup as the API lists it (GET /api/backup/jobs, /jobs/:id). */
export interface BackupJob {
  id: string;
  scope: 'full' | 'partial';
  status: BackupJobStatus;
  phase: string;
  progress: number;
  cancel_requested: boolean;
  requested_sections: string[];
  file_size: number | null;
  file_sha256: string | null;
  content_type: string | null;
  /** False only for an archive made before 0.28 ("Not encrypted, made before 0.28"). */
  encryption_enabled: boolean;
  backup_uuid: string | null;
  recovery_password_available: boolean;
  recovery_password_revealed: boolean;
  server_unlock_available: boolean;
  /** When the server removes it (backup.server_retention_days); null keeps it until deleted. */
  keep_until: string | null;
  /** What it holds; null for a backup made before 0.28. */
  contents: BackupContents | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  downloaded_at: string | null;
}

export interface BackupJobResponse { job: BackupJob }
export interface BackupJobsResponse { jobs: BackupJob[] }

/** GET /api/backup/capabilities */
export interface BackupCapabilities {
  enabled: boolean;
  /** The data schema new archives are written in. */
  version: number;
  sections: { id: string; label: string }[];
  export_sections?: { id: string; label: string }[];
  exclusions: string[];
  /** The "Include downloaded mail" control as it applies to this person. */
  download_mail: DownloadMailChoice;
}

/** A validation or restore result; contents and notes come from the archive's manifest, or from the class filter for older archives. */
export interface BackupImportResult {
  dry_run: boolean;
  valid: boolean;
  errors: string[];
  warnings: string[];
  counts: Record<string, number>;
  conflicts?: Record<string, number>;
  import_sections?: string[];
  account_only_sections?: string[];
  restored_files?: number;
  /** What the archive holds and what it left out, with counts. */
  contents?: BackupContents;
  /** For example how many synced tasks' ToDo states wait for the next sync, or could not be matched. */
  notes?: string[];
  options?: {
    conflict_mode?: string;
    calendar_mode?: string;
    credentials_mode?: string;
  };
}
