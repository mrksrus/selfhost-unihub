import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Play } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { can } from '@/lib/permissions';
import { useToast } from '@/hooks/use-toast';
import { useSecretMutation } from '@/hooks/use-secret-mutation';
import {
  INSTANCE_BACKUP_KEEP_MAX, INSTANCE_BACKUP_KEEP_MIN, instanceBackupQueryKey, instanceBackupQueryOptions, localTimeOf, runInstanceBackup, saveInstanceBackupSchedule,
  type InstanceBackupRun, type InstanceBackupSchedule,
} from '@/lib/instance-backup-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { PasswordConfirmDialog } from '@/components/admin/PasswordConfirmDialog';

// Server settings → Instance backup (D4): the whole installation, encrypted
// with its own key, to a mount the environment names. Destination and key
// are read-only status from the environment (F10: a compromised admin
// session cannot redirect backups); the schedule (time in UTC, how many to
// keep; defaults 03:30 and 14) is set here with the administrator's
// password. Restore is a command in the image, never a web action.

const formatBytes = (bytes: number) => bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const formatWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const RUN_STATUS: Record<InstanceBackupRun['status'], string> = { running: 'Running', succeeded: 'Succeeded', failed: 'Failed' };
const MISSING: Record<'destination' | 'key', string> = { destination: 'INSTANCE_BACKUP_DIR', key: 'INSTANCE_BACKUP_KEY or INSTANCE_BACKUP_KEY_FILE' };
const KEEP_MIN = INSTANCE_BACKUP_KEEP_MIN;
const KEEP_MAX = INSTANCE_BACKUP_KEEP_MAX;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function runLine(run: InstanceBackupRun) {
  return [RUN_STATUS[run.status], formatWhen(run.finished_at ?? run.started_at), run.size_bytes ? formatBytes(run.size_bytes) : null,
    run.trigger === 'manual' ? `started by ${run.actor_email ?? 'an administrator'}` : 'scheduled'].filter(Boolean).join(' · ');
}

/** The fields of the schedule dialog, checked before the password is asked for. */
function ScheduleFields({ value, onChange, timeZone }: { value: InstanceBackupSchedule; onChange: (next: InstanceBackupSchedule) => void; timeZone?: string | null }) {
  const id = useId();
  const local = localTimeOf(value.time_utc, timeZone);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-time`}>Time (UTC)</Label>
        <Input id={`${id}-time`} type="time" required step={60} value={value.time_utc} onChange={event => onChange({ ...value, time_utc: event.target.value })} />
        <p className="text-xs text-muted-foreground">{local ? `${local} for you.` : 'Hours and minutes, UTC.'}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-keep`}>Backups kept</Label>
        <Input id={`${id}-keep`} type="number" required min={KEEP_MIN} max={KEEP_MAX} inputMode="numeric" value={value.keep} onChange={event => onChange({ ...value, keep: Number(event.target.value) })} />
        <p className="text-xs text-muted-foreground">The oldest beyond this number is removed after a verified success.</p>
      </div>
    </div>
  );
}

const AdminInstanceBackup = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const query = useQuery({ ...instanceBackupQueryOptions, enabled: can(user, 'server.settings'), refetchInterval: data => data.state.data?.running ? 3000 : false });
  const run = useMutation({
    mutationFn: runInstanceBackup,
    onSuccess: () => { void client.invalidateQueries({ queryKey: instanceBackupQueryKey }); toast({ title: 'Backup started', description: 'It runs in the background and shows below when it finishes.' }); },
    onError: (error: Error) => toast({ title: 'Could not start the backup', description: error.message, variant: 'destructive' }),
  });
  const status = query.data;

  // The schedule dialog: the fields start from what the server reports at the
  // moment it opens, and stay the administrator's own until Save or Cancel.
  // The status keeps polling while a backup runs; a changed answer must not
  // replace what they are typing.
  const [editing, setEditing] = useState(false);
  const [schedule, setSchedule] = useState<InstanceBackupSchedule>({ time_utc: '03:30', keep: 14 });
  const openEditor = () => { if (status) setSchedule({ time_utc: status.time_utc, keep: status.keep }); setEditing(true); };
  const scheduleValid = TIME.test(schedule.time_utc) && Number.isInteger(schedule.keep) && schedule.keep >= KEEP_MIN && schedule.keep <= KEEP_MAX;
  const saveSchedule = useSecretMutation({
    mutationFn: (currentPassword: string) => saveInstanceBackupSchedule(schedule, currentPassword),
    onSuccess: answer => {
      client.setQueryData(instanceBackupQueryKey, answer);
      setEditing(false);
      toast({ title: 'Schedule saved', description: `Daily at ${answer.time_utc} UTC, keeping ${answer.keep}.` });
    },
    onError: (error: Error) => toast({ title: 'Could not save the schedule', description: error.message, variant: 'destructive' }),
  });
  const local = status ? localTimeOf(status.time_utc, user?.timezone) : null;

  const body = !can(user, 'server.settings') ? <p className="text-sm text-muted-foreground">Only admins can see this page.</p>
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
        <SettingsSection title="Schedule"
          description={`Daily, at a time of your choosing. Saving asks for your password.${status.schedule_source === 'environment' ? ` Until you set one, the server's environment or its defaults (${status.schedule_defaults?.time_utc ?? '03:30'} UTC, keep ${status.schedule_defaults?.keep ?? 14}) hold.` : ''}`}
          action={<Button size="sm" variant="outline" onClick={openEditor}>Change schedule…</Button>}>
          <SettingsRow label="Time" description={local ? `${local} for you. The run starts at this UTC time every day.` : 'The run starts at this UTC time every day.'}>
            <span className="font-mono text-sm tabular-nums">{status.time_utc} UTC</span>
          </SettingsRow>
          <SettingsRow label="Backups kept" description="The oldest beyond this number is removed after a verified success.">
            <span className="font-mono text-sm tabular-nums">{status.keep}</span>
          </SettingsRow>
        </SettingsSection>
        <SettingsSection title="Destination and key" description="Read from the server's environment when it starts; they cannot be changed here, so a signed-in administrator cannot redirect backups.">
          <SettingsRow label="Destination" description={status.destination ? 'INSTANCE_BACKUP_DIR, a mount outside the uploads folder.' : 'Not configured: set INSTANCE_BACKUP_DIR to a mount outside the uploads folder, then restart.'}>
            <span className="break-all font-mono text-sm">{status.destination ?? 'Not configured'}</span>
          </SettingsRow>
          <SettingsRow label="Key" description={status.key_fingerprint ? 'INSTANCE_BACKUP_KEY or INSTANCE_BACKUP_KEY_FILE; its fingerprint marks every file.' : 'Not configured: set INSTANCE_BACKUP_KEY or INSTANCE_BACKUP_KEY_FILE (at least 32 random bytes), then restart.'}>
            <span className="font-mono text-sm">{status.key_fingerprint ?? 'Not configured'}</span>
          </SettingsRow>
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
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs"><code>{status.restore_command}</code></pre>
          </SettingsBlock>
        </SettingsSection>
      </>
    );

  return (
    <PageShell panel={<SettingsPanel active="admin-instance-backup" />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope="Instance backup" />
      <PageBody width="reading">{body}</PageBody>
      <PasswordConfirmDialog open={editing} onClose={() => { if (!saveSchedule.isPending) setEditing(false); }} title="Change the schedule?"
        description="The daily run and how many backups the destination keeps. Nothing already written is deleted by a change; the oldest beyond the number goes after the next verified success."
        actionLabel="Save schedule" pending={saveSchedule.isPending} confirmDisabled={!scheduleValid} onConfirm={password => saveSchedule.mutate(password)}>
        <ScheduleFields value={schedule} onChange={setSchedule} timeZone={user?.timezone} />
        {!scheduleValid && <p role="alert" className="text-sm text-destructive">Choose a time as hours and minutes and a number of backups between {KEEP_MIN} and {KEEP_MAX}.</p>}
      </PasswordConfirmDialog>
    </PageShell>
  );
};

export default AdminInstanceBackup;
