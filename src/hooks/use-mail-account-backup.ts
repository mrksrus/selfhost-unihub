import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BackupJob } from '@/lib/backup-api';
import { getBackupDownloadAction } from '@/lib/backup';
import { jobPollInterval } from '@/lib/job-polling';

// The started job id lives in the query cache so the sync panel, the confirm
// dialog and the account dialog all show the same export for an account.
const jobIdKey = (accountId: string) => ['mail-account-backup', accountId] as const;

/** Account mail export ("Download a backup first") with the Settings › Backup job polling and download. */
export function useMailAccountBackup(accountId: string) {
  const client = useQueryClient();
  const jobId = useQuery<string | null>({ queryKey: jobIdKey(accountId), queryFn: skipToken }).data ?? null;
  const job = useQuery({
    queryKey: ['backup-jobs', 'mail-account', jobId],
    queryFn: jobId ? async ({ signal }) => {
      const response = await api.get<{ job: BackupJob }>(`/backup/jobs/${encodeURIComponent(jobId)}`, { signal });
      if (response.error || !response.data?.job) throw new Error(response.error || 'Backup status is unavailable.');
      return response.data.job;
    } : skipToken,
    refetchInterval: query => jobPollInterval(query.state.data ? [query.state.data] : undefined, true, 2000),
    retry: 1,
  });
  const start = useMutation({
    mutationFn: async () => {
      const response = await api.post<{ job: BackupJob }>(`/mail/accounts/${encodeURIComponent(accountId)}/backup-export`);
      if (response.error || !response.data?.job) throw new Error(response.error || 'The backup could not be started.');
      return response.data.job;
    },
    retry: false,
    onSuccess: started => {
      client.setQueryData(['backup-jobs', 'mail-account', started.id], started);
      client.setQueryData(jobIdKey(accountId), started.id);
      // Settings › Backup lists the same job.
      void client.invalidateQueries({ queryKey: ['backup-jobs'], exact: true });
    },
  });
  const current = jobId ? job.data ?? null : null;
  const download = () => {
    if (!current) return;
    const link = document.createElement('a');
    link.href = api.getDownloadUrl(`/backup/jobs/${encodeURIComponent(current.id)}/download`);
    link.download = `unihub-mail-backup-${current.id}.${current.encryption_enabled ? 'unihub-backup' : 'zip'}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  return {
    job: current,
    start: () => start.mutate(),
    starting: start.isPending,
    error: start.error?.message ?? (jobId && job.isError ? job.error.message : null),
    /** Encrypted exports need their recovery password saved in Settings › Backup before download. */
    directDownload: current ? getBackupDownloadAction(current) === 'download' : false,
    download,
  };
}
