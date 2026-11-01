import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Play } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { useToast } from '@/hooks/use-toast';
import { instanceBackupQueryKey, instanceBackupQueryOptions, runInstanceBackup, type InstanceBackupRun } from '@/lib/instance-backup-api';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';

// Server settings → Instance backup (D4): the whole installation, encrypted
// with its own key, to a mount the environment names. The page shows the
// configuration read-only and starts a run; restore is a command in the
// image. Defaults (time, keep) are D35, shown as the server reports them.

const formatBytes = (bytes: number) => bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const formatWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const RUN_STATUS: Record<InstanceBackupRun['status'], string> = { running: 'Running', succeeded: 'Succeeded', failed: 'Failed' };
const MISSING: Record<'destination' | 'key', string> = { destination: 'INSTANCE_BACKUP_DIR', key: 'INSTANCE_BACKUP_KEY or INSTANCE_BACKUP_KEY_FILE' };

function runLine(run: InstanceBackupRun) {
  return [RUN_STATUS[run.status], formatWhen(run.finished_at ?? run.started_at), run.size_bytes ? formatBytes(run.size_bytes) : null,
    run.trigger === 'manual' ? `started by ${run.actor_email ?? 'an administrator'}` : 'scheduled'].filter(Boolean).join(' · ');
}

const AdminInstanceBackup = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const query = useQuery({ ...instanceBackupQueryOptions, enabled: user?.role === 'admin', refetchInterval: data => data.state.data?.running ? 3000 : false });
  const run = useMutation({
    mutationFn: runInstanceBackup,
    onSuccess: () => { void client.invalidateQueries({ queryKey: instanceBackupQueryKey }); toast({ title: 'Backup started', description: 'It runs in the background and shows below when it finishes.' }); },
    onError: (error: Error) => toast({ title: 'Could not start the backup', description: error.message, variant: 'destructive' }),
  });
  const status = query.data;

  const body = user?.role !== 'admin' ? <p className="text-sm text-muted-foreground">Only admins can see this page.</p>
    : query.isLoading ? <LoadingState label="Loading the instance backup…" />
    : query.error || !status ? <ErrorState title="Could not load the instance backup" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
    : (
      <>
        <p className="mb-8 max-w-prose text-sm text-muted-foreground">
          A backup of the whole installation: the database and every file, encrypted with the instance key. Keep the key, ENCRYPTION_KEY and BACKUP_MASTER_KEY in a password manager; without them a backup cannot be read.
        </p>
        <SettingsSection title="Status">
          <SettingsRow label={status.enabled ? 'On' : 'Off'} description={status.enabled
            ? `Runs daily at ${status.time_utc} UTC${status.next_run_at ? `; next ${formatWhen(status.next_run_at)}` : ''}.`
            : `Set ${status.missing.map(part => MISSING[part]).join(' and ')} in the server's environment, then restart. The server runs normally without a backup.`}>
            <Button onClick={() => run.mutate()} disabled={!status.enabled || status.running || run.isPending}>
              {status.running || run.isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" />}
              {status.running ? 'Backing up…' : 'Back up now'}
            </Button>
          </SettingsRow>
          <SettingsRow label="Last run" description={status.last_run ? runLine(status.last_run) : 'No run yet.'}>
            {status.last_run?.error && <span className="text-sm text-destructive">{status.last_run.error}</span>}
          </SettingsRow>
          {status.last_success && status.last_success.id !== status.last_run?.id && (
            <SettingsRow label="Last success" description={runLine(status.last_success)} />
          )}
          <SettingsRow label="Kept at the destination" description={status.enabled ? `${status.kept.count} ${status.kept.count === 1 ? 'backup' : 'backups'}, ${formatBytes(status.kept.bytes)}; the oldest beyond ${status.keep} is removed after a verified success.` : 'Nothing while the backup is off.'} />
        </SettingsSection>
        <SettingsSection title="Configuration" description="Read from the environment when the server starts; it cannot be changed here.">
          <SettingsRow label="Destination" description="INSTANCE_BACKUP_DIR, a mount outside the uploads folder."><span className="break-all font-mono text-sm">{status.destination ?? 'Not set'}</span></SettingsRow>
          <SettingsRow label="Key" description="INSTANCE_BACKUP_KEY or INSTANCE_BACKUP_KEY_FILE; its fingerprint marks every file."><span className="font-mono text-sm">{status.key_fingerprint ?? 'Not set'}</span></SettingsRow>
          <SettingsRow label="Time" description="INSTANCE_BACKUP_TIME, UTC."><span className="font-mono text-sm tabular-nums">{status.time_utc}</span></SettingsRow>
          <SettingsRow label="Backups kept" description="INSTANCE_BACKUP_KEEP."><span className="font-mono text-sm tabular-nums">{status.keep}</span></SettingsRow>
        </SettingsSection>
        <SettingsSection title="Runs">
          {status.runs.length === 0 ? <SettingsBlock><p className="text-sm text-muted-foreground">No runs yet.</p></SettingsBlock>
            : status.runs.map(entry => (
              <SettingsRow key={entry.id} label={entry.file_name ?? (entry.status === 'running' ? 'Backing up…' : 'No file written')} description={runLine(entry)}>
                {entry.error && <span className="text-sm text-destructive">{entry.error}</span>}
              </SettingsRow>
            ))}
        </SettingsSection>
        <SettingsSection title="Restore" description="Never from the web. On an empty installation, run in the image:">
          <SettingsBlock>
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs"><code>node /app/api/dist/scripts/instance-restore.js --file &lt;backup.uhib&gt; --key-file &lt;instance key&gt;</code></pre>
          </SettingsBlock>
        </SettingsSection>
      </>
    );

  return (
    <PageShell panel={<SettingsPanel active="admin-instance-backup" />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope="Instance backup" />
      <PageBody width="reading">{body}</PageBody>
    </PageShell>
  );
};

export default AdminInstanceBackup;
