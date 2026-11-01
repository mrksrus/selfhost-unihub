import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
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

export async function runInstanceBackup() {
  const answer = unwrap(await api.post<InstanceBackupRunResponse>('/admin/instance-backup/run'));
  if (!answer?.run) throw new Error('The server did not answer with the started run.');
  return answer.run;
}
