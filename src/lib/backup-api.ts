export type BackupJob = {
  id: string;
  scope: 'full' | 'partial';
  status: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'ready' | 'failed';
  phase: string;
  progress: number;
  cancel_requested: boolean;
  requested_sections: string[];
  file_size: number | null;
  file_sha256: string | null;
  content_type: string | null;
  encryption_enabled: boolean;
  backup_uuid: string | null;
  recovery_password_available: boolean;
  recovery_password_revealed: boolean;
  server_unlock_available: boolean;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  downloaded_at: string | null;
};

export type BackupImportResult = {
  dry_run: boolean;
  valid: boolean;
  errors: string[];
  warnings: string[];
  counts: Record<string, number>;
  conflicts?: Record<string, number>;
  import_sections?: string[];
  restored_files?: number;
  options?: {
    conflict_mode?: string;
    calendar_mode?: string;
    credentials_mode?: string;
  };
};

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


export type BackupCapabilities = { enabled: boolean; version: number; sections: { id: string; label: string }[]; exclusions: string[] };
