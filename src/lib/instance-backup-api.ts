import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ApiError, unwrap } from '@/lib/api-error';
import type { InstanceBackupRunResponse, InstanceBackupSettingsRequest, InstanceBackupStatus } from '../../api/src/contracts/instance-backup';

export type { InstanceBackupRun, InstanceBackupStatus } from '../../api/src/contracts/instance-backup';

// The built-in instance backup (D4), administrators only. Destination and
// key come from the environment and are shown read-only; the schedule (time
// and how many to keep, D35) is set on the page with the administrator's
// password. Restore is a command in the image, never a web action.

export const instanceBackupQueryKey = ['admin', 'instance-backup'] as const;

export async function fetchInstanceBackup(signal?: AbortSignal): Promise<InstanceBackupStatus> {
  const status = unwrap(await api.get<InstanceBackupStatus>('/admin/instance-backup', { signal }));
  if (!status) throw new Error('The server did not answer with the instance backup status.');
  return status;
}

export const instanceBackupQueryOptions = queryOptions({
  queryKey: instanceBackupQueryKey,
  queryFn: ({ signal }) => fetchInstanceBackup(signal),
});

/** The schedule an administrator sets (D35): "HH:MM" UTC and how many backups to keep (1 to 1000). */
export interface InstanceBackupSchedule { time_utc: string; keep: number }
export const INSTANCE_BACKUP_KEEP_MIN = 1;
export const INSTANCE_BACKUP_KEEP_MAX = 1000;

/**
 * Saves the schedule with the administrator's password (PUT
 * /api/admin/instance-backup/settings, InstanceBackupSettingsRequest); the
 * answer is the status as now set. The worker picks the change up within a
 * minute; a lower count removes the oldest backups at the next verified
 * success, never at once.
 */
export async function saveInstanceBackupSchedule(schedule: InstanceBackupSchedule, currentPassword: string): Promise<InstanceBackupStatus> {
  const status = unwrap(await api.put<InstanceBackupStatus>('/admin/instance-backup/settings', { ...schedule, current_password: currentPassword } satisfies InstanceBackupSettingsRequest));
  if (!status) throw new Error('The server did not answer with the instance backup status.');
  return status;
}

/** Why the server refused to start a run, in the page's words. */
const REFUSED: Record<string, string> = {
  INSTANCE_BACKUP_OFF: 'The instance backup is off: set the destination and the key in the server\'s environment, then restart.',
  INSTANCE_BACKUP_RUNNING: 'A backup is already running; it shows on the page when it finishes.',
  INSTANCE_BACKUP_NOT_READY: 'The server is not ready for background work yet. Try again in a moment.',
};

/** Starts a run now; the answer is the running run (202). */
export async function runInstanceBackup() {
  try {
    const answer = unwrap(await api.post<InstanceBackupRunResponse>('/admin/instance-backup/run'));
    if (!answer?.run) throw new Error('The server did not answer with the started run.');
    return answer.run;
  } catch (error) {
    if (error instanceof ApiError && error.code && REFUSED[error.code]) throw new Error(REFUSED[error.code]);
    throw error;
  }
}

/**
 * The UTC time of day as the administrator's clock shows it, with the zone's
 * name: "05:30 CEST". Today's date decides the offset; the profile's time
 * zone wins over the browser's. Null when the time is not "HH:MM".
 */
export function localTimeOf(timeUtc: string, timeZone?: string | null, today = new Date()): string | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeUtc)) return null;
  const [hours, minutes] = timeUtc.split(':').map(Number);
  const at = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hours, minutes));
  try {
    return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short', ...(timeZone ? { timeZone } : {}) });
  } catch {
    return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  }
}
