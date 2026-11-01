import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ApiError, unwrap } from '@/lib/api-error';
import type { InstanceBackupRunResponse, InstanceBackupStatus } from '../../api/src/contracts/instance-backup';

export type { InstanceBackupRun, InstanceBackupStatus } from '../../api/src/contracts/instance-backup';

// The built-in instance backup (D4), administrators only. Its configuration
// comes from the environment and is shown read-only; the page can only start
// a run. Restore is a command in the image, never a web action.

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
