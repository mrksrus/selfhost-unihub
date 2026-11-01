// Request and response shapes of the instance backup's admin routes (D4,
// F11). The frontend imports these as types only; the rules are in
// services/instance-backup.ts. The configuration comes from the environment
// only (INSTANCE_BACKUP_DIR, INSTANCE_BACKUP_KEY or _FILE, _TIME, _KEEP) and
// is shown read-only: a compromised admin session cannot redirect backups.

export type InstanceBackupRunStatus = 'running' | 'succeeded' | 'failed';
export type InstanceBackupTrigger = 'schedule' | 'manual';

/** One run, as the instance_backups table records it. */
export interface InstanceBackupRun {
  id: string;
  trigger: InstanceBackupTrigger;
  /** The administrator who pressed "Back up now"; null for the schedule. */
  actor_email: string | null;
  status: InstanceBackupRunStatus;
  file_name: string | null;
  size_bytes: number | null;
  app_version: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** GET /api/admin/instance-backup (permission server.settings). */
export interface InstanceBackupStatus {
  /** False without a destination or a key: the page says which is missing. */
  enabled: boolean;
  /** What the environment lacks when disabled. */
  missing: ('destination' | 'key')[];
  /** The mount, as configured; null when off. */
  destination: string | null;
  /** The key's fingerprint (its version in every file); null when off. */
  key_fingerprint: string | null;
  /** "HH:MM" UTC. */
  time_utc: string;
  keep: number;
  next_run_at: string | null;
  /** The latest run of any status; null before the first. */
  last_run: InstanceBackupRun | null;
  /** The latest successful run. */
  last_success: InstanceBackupRun | null;
  /** Files kept at the destination. */
  kept: { count: number; bytes: number };
  /** A run is in progress. */
  running: boolean;
  runs: InstanceBackupRun[];
}

/** POST /api/admin/instance-backup/run: starts a run now; 409 while one runs. */
export interface InstanceBackupRunResponse { run: InstanceBackupRun }
