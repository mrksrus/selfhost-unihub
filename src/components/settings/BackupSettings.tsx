import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, Loader2, LockKeyhole, MoreHorizontal, Play, RotateCcw, Square, Upload } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { useToast } from '@/hooks/use-toast';
import { usePolicy } from '@/hooks/use-policies';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useSessionScope } from '@/lib/session-scope';
import {
  BACKUP_ACTIVE, RESTORE_ACTIVE, backupApi, backupQueryKeys, getBackupDownloadAction, prepareBackupDownload,
  type BackupContents, type BackupDataClass, type BackupImportResult, type BackupJob, type BackupSectionId, type CalendarMode, type ConflictMode, type CredentialsMode, type RestoreJob, type RestoreOptions,
} from '@/lib/backup-api';
import { copyText, downloadTicket, saveFile } from '@/lib/platform';
import { jobPollInterval } from '@/lib/job-polling';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { PolicyMenuItem, PolicyNote } from '@/components/ui/policy-note';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { cn } from '@/lib/utils';

// Settings → Backup and restore (0.28). Every backup is encrypted; what it
// holds follows the data classes (F2): UniHub's own data and configuration,
// downloaded mail by choice or policy, never what a provider holds. The
// archive leaves the server through a download ticket (F9). A policy can
// forbid creating, restoring or deleting: the control greys out with the
// server's reason.

/** What each data class means to the person. */
const CLASS_WORDS: Record<BackupDataClass, string> = {
  local: 'your contacts, local calendars, tasks and recordings',
  'local-by-policy': 'downloaded mail',
  config: 'your settings and account sign-ins',
  mirror: 'mail and calendars a provider holds',
  org: 'shared data of the organisation',
  installation: 'server-only data',
  ciphertext: 'encrypted messages',
};

const SECTION_WORDS: Record<string, string> = {
  settings: 'your settings and profile',
  contacts: 'contacts',
  calendar: 'local calendars, events and tasks, and your ToDo state of synced tasks',
  mail: 'mail accounts with their sign-ins, folders, rules and templates',
  recordings: 'recordings',
  accounts: 'mail and calendar sign-ins',
};

const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const formatWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const formatDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
const joinWords = (words: string[]) => words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const NO_JOBS: BackupJob[] = [];
const NO_RESTORES: RestoreJob[] = [];

// A restore job is prepared with the three choices and runs with them: the
// screen shows the prepared job's choices, and Restore opens only while the
// choices on the screen are the job's.
const sameOptions = (a: RestoreOptions, b: RestoreOptions) => a.conflict_mode === b.conflict_mode && a.calendar_mode === b.calendar_mode && a.credentials_mode === b.credentials_mode;
const jobOptions = (job: RestoreJob): RestoreOptions => ({ conflict_mode: job.conflict_mode as ConflictMode, calendar_mode: job.calendar_mode as CalendarMode, credentials_mode: job.credentials_mode as CredentialsMode });

const BACKUP_STATUS: Record<BackupJob['status'], string> = { queued: 'Waiting', running: 'Creating', cancelling: 'Stopping', cancelled: 'Stopped', ready: 'Ready', failed: 'Failed' };
const RESTORE_STATUS: Record<RestoreJob['status'], string> = {
  uploaded: 'Uploaded', awaiting_password: 'Needs its recovery password', validating: 'Checking', validated: 'Checked, ready to restore', queued: 'Waiting',
  running: 'Restoring', cancelling: 'Stopping', cancelled: 'Stopped', completed: 'Restored', failed: 'Failed', expired: 'Expired',
};

/** What an archive holds and what it leaves out, from its manifest, with the server's notes. */
export function BackupContentsList({ contents, notes, className }: { contents: BackupContents | null | undefined; notes?: string[]; className?: string }) {
  if (!contents) return null;
  const included = contents.included.map(dataClass => CLASS_WORDS[dataClass] ?? dataClass);
  return (
    <div className={cn('space-y-1 text-sm', className)}>
      {included.length > 0 && <p><span className="text-muted-foreground">In the backup: </span>{capitalise(joinWords(included))}.</p>}
      {contents.left_out.length > 0 && (
        <p><span className="text-muted-foreground">Left out: </span>
          {contents.left_out.map((entry, index) => (
            <span key={`${entry.section}-${entry.what}`}>{index > 0 && '; '}{entry.what}{entry.count !== undefined && ` (${entry.count.toLocaleString()})`}<span className="text-muted-foreground">, {entry.reason.replace(/\.$/, '').replace(/^./, c => c.toLowerCase())}</span></span>
          ))}.
        </p>
      )}
      {[...contents.notes, ...(notes ?? [])].map(note => <p key={note} className="text-muted-foreground">{note}</p>)}
    </div>
  );
}

function SectionChips({ sections, value, onChange, disabled, allLabel }: {
  sections: { id: string; label: string }[]; value: 'full' | string[]; onChange: (next: 'full' | string[]) => void; disabled?: boolean; allLabel: string;
}) {
  const toggle = (id: string) => {
    const current = value === 'full' ? [] : value;
    const next = current.includes(id) ? current.filter(entry => entry !== id) : [...current, id];
    onChange(next.length === 0 ? 'full' : next);
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant={value === 'full' ? 'default' : 'outline'} aria-pressed={value === 'full'} disabled={disabled} onClick={() => onChange('full')}>{allLabel}</Button>
      {sections.map(section => {
        const on = value !== 'full' && value.includes(section.id);
        return <Button key={section.id} type="button" size="sm" variant={on ? 'default' : 'outline'} aria-pressed={on} disabled={disabled} onClick={() => toggle(section.id)}>{section.label}</Button>;
      })}
    </div>
  );
}

export default function BackupSettings({ active }: { active: boolean }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const scope = useSessionScope();
  const queryClient = useQueryClient();
  const createPolicy = usePolicy('backup.create');
  const restorePolicy = usePolicy('backup.restore');
  const deletePolicy = usePolicy('backup.delete');
  const retentionPolicy = usePolicy('backup.server_retention_days');
  const enabled = !!user && active;

  const capabilitiesQuery = useQuery({ queryKey: backupQueryKeys.capabilities, queryFn: ({ signal }) => backupApi.capabilities(signal), enabled });
  const jobsQuery = useQuery({
    queryKey: backupQueryKeys.jobs, queryFn: ({ signal }) => backupApi.jobs(signal), enabled,
    refetchInterval: query => jobPollInterval(query.state.data, active, 5000),
  });
  const restoreJobsQuery = useQuery({
    queryKey: backupQueryKeys.restoreJobs, queryFn: ({ signal }) => backupApi.restoreJobs(signal), enabled,
    refetchInterval: query => jobPollInterval(query.state.data, active, 3000),
  });
  const capabilities = capabilitiesQuery.data;
  const available = capabilities?.enabled === true;
  const jobs = jobsQuery.data ?? NO_JOBS;
  const restoreJobs = restoreJobsQuery.data ?? NO_RESTORES;
  const importSections = capabilities?.sections ?? [];
  const exportSections = (capabilities?.export_sections ?? importSections).filter(section => section.id !== 'accounts');
  const sectionLabels = new Map([...importSections, ...exportSections].map(({ id, label }) => [id, label]));
  const sectionLabel = (id: string) => sectionLabels.get(id) || id;
  const refreshJobs = () => { void queryClient.invalidateQueries({ queryKey: backupQueryKeys.jobs }); };
  const refreshRestores = () => { void queryClient.invalidateQueries({ queryKey: backupQueryKeys.restoreJobs }); };
  const failed = (title: string) => (error: Error) => toast({ title, description: error.message, variant: 'destructive' });

  // Creating.
  const [exportSelection, setExportSelection] = useState<'full' | string[]>('full');
  const downloadMail = capabilities?.download_mail;
  const [includeDownloadMail, setIncludeDownloadMail] = useState<boolean | null>(null);
  const downloadMailOn = downloadMail?.forced ? true : includeDownloadMail ?? downloadMail?.value ?? true;

  // Restoring.
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importSelection, setImportSelection] = useState<'full' | string[]>('full');
  const [options, setOptions] = useState<RestoreOptions>({ conflict_mode: 'keep_existing', calendar_mode: 'merge_same_name', credentials_mode: 'keep_existing' });
  // The choices at the moment a preparation answers; a job prepared with others is not taken up.
  const optionsNow = useRef(options);
  optionsNow.current = options;
  const [selectedRestoreJobId, setSelectedRestoreJobId] = useState<string | null>(null);
  const [restorePassword, setRestorePassword] = useState('');
  const [shownResult, setShownResult] = useState<BackupImportResult | null>(null);
  const completedRestores = useRef(new Set<string>());
  const selectedRestoreJob = restoreJobs.find(job => job.id === selectedRestoreJobId) ?? null;
  const preparedAsChosen = !!selectedRestoreJob && sameOptions(jobOptions(selectedRestoreJob), options);
  const resetReview = () => { setSelectedRestoreJobId(null); setShownResult(null); };
  const changeOption = <K extends keyof RestoreOptions>(key: K, value: RestoreOptions[K]) => { setOptions(current => ({ ...current, [key]: value })); resetReview(); };
  const selectRestoreJob = (job: RestoreJob) => { setSelectedRestoreJobId(job.id); setOptions(jobOptions(job)); setShownResult(job.validation_result || job.result_counts); };

  useEffect(() => {
    if (selectedRestoreJob?.validation_result) setShownResult(selectedRestoreJob.validation_result);
    const completed = restoreJobs.filter(job => job.status === 'completed' && !completedRestores.current.has(job.id));
    if (completed.length) {
      completed.forEach(job => completedRestores.current.add(job.id));
      // Restored data shows everywhere else; the backup lists keep polling on their own.
      void queryClient.invalidateQueries({ predicate: query => !['backup-jobs', 'backup-restore-jobs'].includes(String(query.queryKey[0])) });
    }
  }, [selectedRestoreJob, restoreJobs, queryClient]);

  // Recovery password, shown once before the first download. The server
  // reveals it once: the dialog cannot be dismissed while the reveal runs, and
  // an answer is shown only for the backup it was asked for.
  const [recoveryJob, setRecoveryJob] = useState<BackupJob | null>(null);
  const recoveryJobNow = useRef<BackupJob | null>(null);
  const [recoveryPassword, setRecoveryPassword] = useState<string | null>(null);
  const [recoverySaved, setRecoverySaved] = useState(false);
  const openRecovery = (job: BackupJob) => { recoveryJobNow.current = job; setRecoveryJob(job); setRecoveryPassword(null); setRecoverySaved(false); };
  const closeRecovery = () => { recoveryJobNow.current = null; setRecoveryJob(null); setRecoveryPassword(null); setRecoverySaved(false); };

  const create = useSessionMutation({
    mutationFn: () => backupApi.create({ sections: exportSelection === 'full' ? 'full' : exportSelection as BackupSectionId[], include_download_mail: downloadMailOn }),
    onSuccess: () => { refreshJobs(); toast({ title: 'Backup started', description: 'It shows below while it is created.' }); },
    onError: failed('Could not start the backup'),
  });
  const cancel = useSessionMutation({ mutationFn: (job: BackupJob) => backupApi.cancel(job.id), onSuccess: refreshJobs, onError: failed('Could not stop the backup') });
  const remove = useSessionMutation({ mutationFn: (job: BackupJob) => backupApi.delete(job.id), onSuccess: () => { refreshJobs(); toast({ title: 'Backup deleted' }); }, onError: failed('Could not delete the backup') });
  // The ticket is fetched in the request and handed to the browser or the app
  // only in the session-guarded callback: a late answer starts no download.
  const download = useSessionMutation({ mutationFn: (job: BackupJob) => prepareBackupDownload(job), onSuccess: ticket => downloadTicket(ticket), onError: failed('Could not download the backup') });
  const reveal = useSessionMutation({
    mutationFn: (job: BackupJob) => backupApi.revealRecoveryPassword(job.id),
    onSuccess: (password, job) => { refreshJobs(); if (recoveryJobNow.current?.id === job.id) setRecoveryPassword(password); },
    onError: failed('Could not show the recovery password'),
  });
  const prepared = (job: RestoreJob, chosen: RestoreOptions) => {
    refreshRestores();
    // The choices changed while the server prepared: the job stays in the list below, unselected.
    if (!sameOptions(chosen, optionsNow.current)) return false;
    setSelectedRestoreJobId(job.id); setShownResult(null);
    return true;
  };
  const restoreStored = useSessionMutation({
    mutationFn: ({ job, options: chosen }: { job: BackupJob; options: RestoreOptions }) => backupApi.restoreStored(job.id, job.requested_sections.length ? job.requested_sections : 'full', chosen),
    onSuccess: (job, { options: chosen }) => { if (prepared(job, chosen)) toast({ title: 'Checking the backup', description: 'Restore becomes available once the check passes.' }); },
    onError: failed('Could not prepare the restore'),
  });
  const upload = useSessionMutation({
    mutationFn: ({ file, options: chosen }: { file: File; options: RestoreOptions }) => backupApi.upload(file, importSelection === 'full' ? 'full' : importSelection as BackupSectionId[], chosen),
    onSuccess: (job, { options: chosen }) => {
      if (!prepared(job, chosen)) return;
      setRestorePassword('');
      toast(job.status === 'awaiting_password'
        ? { title: 'Recovery password needed', description: 'Enter the recovery password of this backup to check it.' }
        : { title: 'Backup uploaded', description: 'It is checked in the background.' });
    },
    onError: failed('Could not upload the backup'),
  });
  const unlock = useSessionMutation({
    mutationFn: (job: RestoreJob) => backupApi.unlock(job.id, restorePassword),
    onSuccess: () => { setRestorePassword(''); refreshRestores(); toast({ title: 'Backup unlocked', description: 'It is checked in the background.' }); },
    onError: failed('Could not unlock the backup'),
  });
  const startRestore = useSessionMutation({
    mutationFn: (job: RestoreJob) => backupApi.startRestore(job.id),
    onSuccess: () => { refreshRestores(); toast({ title: 'Restore started', description: 'It runs in the background; you may leave this page.' }); },
    onError: failed('Could not start the restore'),
  });
  const cancelRestore = useSessionMutation({ mutationFn: (job: RestoreJob) => backupApi.cancelRestore(job.id), onSuccess: refreshRestores, onError: failed('Could not stop the restore') });
  const removeRestore = useSessionMutation({
    mutationFn: (job: RestoreJob) => backupApi.deleteRestore(job.id),
    onSuccess: (_result, job) => { if (selectedRestoreJobId === job.id) resetReview(); refreshRestores(); },
    onError: failed('Could not delete the restore job'),
  });

  const openDownload = (job: BackupJob) => {
    const action = getBackupDownloadAction(job);
    if (action === 'reveal_password') { openRecovery(job); return; }
    if (action === 'missing_password_metadata') {
      toast({ title: 'Recovery password unavailable', description: 'This backup is missing its recovery-password record. Create a new backup.', variant: 'destructive' });
      return;
    }
    download.mutate(job);
  };
  const saveRecoveryFile = () => {
    if (!recoveryJob || !recoveryPassword) return;
    const blob = new Blob([`UniHub backup: ${recoveryJob.id}\nRecovery password: ${recoveryPassword}\n`], { type: 'text/plain;charset=utf-8' });
    saveFile(blob, `unihub-backup-${recoveryJob.id}-recovery-password.txt`).then(() => { if (!scope.ended) setRecoverySaved(true); })
      .catch(() => toast({ title: 'Could not save the file', variant: 'destructive' }));
  };
  // While the reveal runs, or until the shown password is saved, the dialog stays.
  const recoveryStays = reveal.isPending || (!!recoveryPassword && !recoverySaved);

  // What the chosen backup will hold, for the ledger under the choice.
  const chosen = exportSelection === 'full' ? exportSections.map(section => section.id) : exportSelection;
  const holds = chosen.map(id => SECTION_WORDS[id] ?? sectionLabel(id).toLowerCase());
  const leftOut = [
    chosen.includes('mail') ? (downloadMailOn ? 'mail of Sync-mode accounts' : 'downloaded mail and mail of Sync-mode accounts') : null,
    chosen.includes('calendar') ? 'events and tasks of calendar servers' : null,
    ...(capabilities?.exclusions ?? []).map(entry => entry.replace(/\.$/, '').replace(/^./, c => c.toLowerCase())),
  ].filter((entry): entry is string => !!entry);
  const retentionText = retentionPolicy.value ? `The server keeps each backup ${retentionPolicy.value} days, then removes it.` : 'The server keeps them until you delete them.';
  const busy = create.isPending || upload.isPending || unlock.isPending;
  // The restore choices are fixed while the server prepares a job with them.
  const preparing = upload.isPending || restoreStored.isPending;

  return (<>
    <div className="mb-8 space-y-3">
      <p className="max-w-prose text-sm text-muted-foreground">
        Every backup is encrypted. Keep the downloaded file and its recovery password away from this server; together they open the backup on any UniHub.
        Mail and calendars a provider holds are not in it: they download again after the accounts reconnect.
      </p>
      <p role="note" aria-label="Backup and restore are experimental" className="max-w-prose text-sm text-muted-foreground">
        <span className="font-medium text-warning">Experimental. </span>Do not rely on a backup as the only copy of important data; a server recovery also needs the database, uploads and configuration.
      </p>
      {capabilitiesQuery.error && <ErrorState title="Could not check backup availability" error={capabilitiesQuery.error} onRetry={() => void capabilitiesQuery.refetch()} retrying={capabilitiesQuery.isFetching} />}
      {capabilitiesQuery.isLoading && <p role="status" className="text-sm text-muted-foreground">Checking backup availability…</p>}
      {capabilities && !available && <p role="status" className="text-sm text-warning">Creating and restoring backups is unavailable on this server. Finished backups can still be downloaded.</p>}
    </div>

    <SettingsSection title="Create a backup">
      <SettingsRow stack label="What to back up" description="A full backup also holds the data of hidden and disabled pages.">
        <SectionChips sections={exportSections} value={exportSelection} onChange={setExportSelection} disabled={!available || busy} allLabel="Everything" />
      </SettingsRow>
      <SettingsRow label="Include downloaded mail" htmlFor="backup-download-mail" lock={downloadMail?.forced ? downloadMail.reason ?? 'Always included.' : undefined}
        description={<>
          The mail of Download-mode accounts, which may exist nowhere else.
          {downloadMail && downloadMail.forced_account_ids.length > 0 && !downloadMail.forced && ` Always included for ${downloadMail.forced_account_ids.length === 1 ? 'the account that deletes' : `${downloadMail.forced_account_ids.length} accounts that delete`} mail at the provider.`}
        </>}>
        <Switch id="backup-download-mail" checked={downloadMailOn} disabled={!available || busy || !!downloadMail?.forced || !chosen.includes('mail')}
          onCheckedChange={setIncludeDownloadMail} />
      </SettingsRow>
      <SettingsRow stack label="What it holds">
        <div className="grid w-full gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <p className="text-muted-foreground">In the backup</p>
            <ul className="mt-1 space-y-0.5">{holds.map(entry => <li key={entry}>{capitalise(entry)}</li>)}</ul>
          </div>
          <div>
            <p className="text-muted-foreground">Left out</p>
            {leftOut.length === 0 ? <p className="mt-1">Nothing.</p> : <ul className="mt-1 space-y-0.5">{leftOut.map(entry => <li key={entry}>{capitalise(entry)}</li>)}</ul>}
            {(chosen.includes('mail') || chosen.includes('calendar')) && <p className="mt-1 text-xs text-muted-foreground">What a provider holds downloads again after the account reconnects.</p>}
          </div>
        </div>
      </SettingsRow>
      <SettingsBlock className="flex flex-col items-start gap-1 sm:items-end">
        <Button onClick={() => create.mutate()} disabled={!available || busy || !!createPolicy.lock}>
          {create.isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <LockKeyhole aria-hidden="true" />}Create backup
        </Button>
        {createPolicy.lock && <PolicyNote reason={createPolicy.lock} />}
      </SettingsBlock>
    </SettingsSection>

    <SettingsSection title="Backups on this server" description={`${retentionText} Creating a backup does not download it to this device.`}>
      {jobsQuery.isLoading ? <SettingsBlock><LoadingState compact label="Loading backups…" /></SettingsBlock>
        : jobsQuery.error && jobs.length === 0 ? <SettingsBlock><ErrorState title="Could not load backups" error={jobsQuery.error} onRetry={() => void jobsQuery.refetch()} retrying={jobsQuery.isFetching} /></SettingsBlock>
        : jobs.length === 0 ? <SettingsBlock><p className="text-sm text-muted-foreground">No backups yet. Create one above.</p></SettingsBlock>
        : jobs.map(job => {
          const running = BACKUP_ACTIVE.includes(job.status);
          const title = job.scope === 'full' ? 'Full backup' : `${job.requested_sections.map(sectionLabel).join(', ')} backup`;
          const meta = [
            job.status === 'running' ? `Creating ${job.progress}%` : BACKUP_STATUS[job.status],
            formatWhen(job.completed_at || job.started_at || job.created_at),
            job.file_size ? formatBytes(job.file_size) : null,
            job.keep_until ? `kept until ${formatDay(job.keep_until)}` : null,
          ].filter(Boolean).join(' · ');
          const age = !job.encryption_enabled ? 'Not encrypted, made before 0.28.' : job.contents === null && job.status === 'ready' ? 'Made before 0.28; what it holds is read when it is restored.' : null;
          return (
            <div key={job.id} className="space-y-2 py-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    {job.encryption_enabled && <LockKeyhole aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <span className="truncate">{title}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">{meta}</p>
                  {age && <p className="text-xs text-muted-foreground">{age}</p>}
                  {job.contents && job.contents.left_out.length > 0 && (
                    <p className="text-xs text-muted-foreground">Left out: {job.contents.left_out.map(entry => `${entry.what}${entry.count !== undefined ? ` (${entry.count.toLocaleString()})` : ''}`).join(', ')}.</p>
                  )}
                  {job.error && <p className="text-xs text-destructive">{job.error}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1 touch:gap-3">
                  {job.status === 'ready' && <>
                    <Button variant="outline" size="sm" onClick={() => openDownload(job)} disabled={download.isPending} aria-label={`Download ${title}`}><Download aria-hidden="true" />Download</Button>
                    <Button variant="outline" size="sm" className="hidden sm:inline-flex" onClick={() => restoreStored.mutate({ job, options })} aria-label={`Restore ${title}`}
                      disabled={!available || busy || preparing || !!restorePolicy.lock} title={restorePolicy.lock}><RotateCcw aria-hidden="true" />Restore</Button>
                  </>}
                  {running && <Button variant="outline" size="sm" onClick={() => cancel.mutate(job)} disabled={job.status === 'cancelling'}><Square aria-hidden="true" />Stop</Button>}
                  {!running && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`More actions for ${title}`}><MoreHorizontal aria-hidden="true" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {job.status === 'ready' && <PolicyMenuItem className="sm:hidden" lock={restorePolicy.lock} disabled={!available || busy || preparing} onClick={() => restoreStored.mutate({ job, options })}>Restore</PolicyMenuItem>}
                        <PolicyMenuItem lock={deletePolicy.lock} className="text-destructive focus:text-destructive" onClick={() => remove.mutate(job)}>Delete</PolicyMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
              {running && <Progress value={job.progress} aria-label={`${title} progress`} />}
            </div>
          );
        })}
    </SettingsSection>

    <SettingsSection title="Restore" description="Upload a backup, or choose one above, and review what it holds before anything is restored.">
      {restorePolicy.lock && <SettingsBlock><PolicyNote reason={restorePolicy.lock} className="mt-0" /></SettingsBlock>}
      <SettingsRow label="Backup file" htmlFor="backup-import-file" description="A .unihub-backup file, or a .zip backup made before 0.28.">
        <Input id="backup-import-file" type="file" className="w-full sm:w-72" accept="application/zip,application/vnd.unihub.backup,.zip,.unihub-backup"
          disabled={!available || busy || !!restorePolicy.lock}
          onChange={event => { setImportFile(event.target.files?.[0] || null); resetReview(); setRestorePassword(''); }} />
      </SettingsRow>
      <SettingsRow stack label="What to restore" description="Chosen sections restore only that data from the same backup.">
        <SectionChips sections={importSections} value={importSelection} onChange={next => { setImportSelection(next); resetReview(); }} disabled={!available || busy || preparing || !!restorePolicy.lock} allLabel="Everything" />
      </SettingsRow>
      <SettingsRow stack label="When something already exists">
        <div className="grid w-full gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="restore-conflicts">Matching items</Label>
            <Select value={options.conflict_mode} onValueChange={value => changeOption('conflict_mode', value as ConflictMode)} disabled={preparing || !!restorePolicy.lock}>
              <SelectTrigger id="restore-conflicts"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="keep_existing">Keep what is here</SelectItem>
                <SelectItem value="replace">Replace with the backup</SelectItem>
                <SelectItem value="keep_both">Keep both</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="restore-calendars">Local calendars</Label>
            <Select value={options.calendar_mode} onValueChange={value => changeOption('calendar_mode', value as CalendarMode)} disabled={preparing || !!restorePolicy.lock}>
              <SelectTrigger id="restore-calendars"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="merge_same_name">Merge by name</SelectItem>
                <SelectItem value="copy">Restore as copies</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="restore-credentials">Account sign-ins</Label>
            <Select value={options.credentials_mode} onValueChange={value => changeOption('credentials_mode', value as CredentialsMode)} disabled={preparing || !!restorePolicy.lock}>
              <SelectTrigger id="restore-credentials"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="keep_existing">Keep the current ones</SelectItem>
                <SelectItem value="restore">Use the backup's</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </SettingsRow>
      <SettingsBlock className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => importFile && upload.mutate({ file: importFile, options })} disabled={!available || busy || preparing || !importFile || !!restorePolicy.lock}>
            {upload.isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Upload aria-hidden="true" />}Upload and check
          </Button>
          <Button onClick={() => selectedRestoreJob && preparedAsChosen && startRestore.mutate(selectedRestoreJob)}
            disabled={!available || busy || startRestore.isPending || selectedRestoreJob?.status !== 'validated' || !preparedAsChosen || !!restorePolicy.lock}>
            <Play aria-hidden="true" />Restore
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Restore opens once the check has passed. You may leave this page while a check or a restore runs.</p>

        {selectedRestoreJob?.status === 'awaiting_password' && (
          <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (restorePassword) unlock.mutate(selectedRestoreJob); }}>
            <Label htmlFor="restore-password">Recovery password of this backup</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="restore-password" type="password" value={restorePassword} onChange={event => setRestorePassword(event.target.value)} autoComplete="off" />
              <Button type="submit" disabled={!restorePassword || unlock.isPending}>{unlock.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}Unlock</Button>
            </div>
            <p className="text-xs text-muted-foreground">The password is used once and not stored.</p>
          </form>
        )}

        {selectedRestoreJob && RESTORE_ACTIVE.includes(selectedRestoreJob.status) && (
          <div className="space-y-2" role="status">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium">{RESTORE_STATUS[selectedRestoreJob.status]}{selectedRestoreJob.phase ? `: ${selectedRestoreJob.phase.replace(/_/g, ' ')}` : ''}</span>
              <span className="text-muted-foreground">{selectedRestoreJob.progress}%</span>
            </div>
            <Progress value={selectedRestoreJob.progress} />
          </div>
        )}

        {shownResult && (
          <div className="space-y-2 border-l-2 border-border pl-4 text-sm" aria-label="Backup review">
            <p className="font-medium">
              {shownResult.valid ? 'The backup checks out' : 'The backup cannot be restored'}
              <span className="font-normal text-muted-foreground"> · {shownResult.dry_run ? 'review only, nothing restored yet' : 'restored'}</span>
            </p>
            {shownResult.import_sections?.length ? <p className="text-muted-foreground">Sections: {shownResult.import_sections.map(sectionLabel).join(', ')}.</p> : null}
            <BackupContentsList contents={shownResult.contents} notes={shownResult.notes} />
            {shownResult.account_only_sections?.length ? (
              <p className="text-muted-foreground">Sign-ins only for {shownResult.account_only_sections.map(sectionLabel).join(' and ')}: the accounts sign in again and download from the provider.</p>
            ) : null}
            {Object.keys(shownResult.counts || {}).length > 0 && (
              <p className="text-muted-foreground">In the archive: {Object.entries(shownResult.counts).map(([key, value]) => `${key} ${value.toLocaleString()}`).join(', ')}. Items already here are kept, replaced or copied as chosen above.</p>
            )}
            {Object.keys(shownResult.conflicts || {}).length > 0 && (
              <p className="text-muted-foreground">Already here: {Object.entries(shownResult.conflicts || {}).map(([key, value]) => `${key} ${value.toLocaleString()}`).join(', ')}.</p>
            )}
            {shownResult.restored_files !== undefined && <p className="text-muted-foreground">Files restored: {shownResult.restored_files.toLocaleString()}.</p>}
            {shownResult.warnings?.length > 0 && <ul aria-label="Recovery warnings" className="list-disc pl-5 text-warning">{shownResult.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
            {shownResult.errors?.length > 0 && <p className="text-destructive">{shownResult.errors.join(' ')}</p>}
          </div>
        )}
      </SettingsBlock>
    </SettingsSection>

    <SettingsSection title="Restore jobs" description="Uploaded backups are removed after a successful restore, or seven days after their check.">
      {restoreJobsQuery.isLoading ? <SettingsBlock><LoadingState compact label="Loading restore jobs…" /></SettingsBlock>
        : restoreJobsQuery.error && restoreJobs.length === 0 ? <SettingsBlock><ErrorState title="Could not load restore jobs" error={restoreJobsQuery.error} onRetry={() => void restoreJobsQuery.refetch()} retrying={restoreJobsQuery.isFetching} /></SettingsBlock>
        : restoreJobs.length === 0 ? <SettingsBlock><p className="text-sm text-muted-foreground">No restores yet.</p></SettingsBlock>
        : restoreJobs.map(job => {
          const running = RESTORE_ACTIVE.includes(job.status);
          const title = `${job.source_type === 'generated' ? 'From a backup on this server' : 'From an uploaded backup'}${job.is_encrypted ? '' : ' (not encrypted)'}`;
          const meta = [RESTORE_STATUS[job.status], formatWhen(job.completed_at || job.started_at || job.created_at), job.archive_size ? formatBytes(job.archive_size) : null].filter(Boolean).join(' · ');
          return (
            <div key={job.id} className={cn('space-y-2 py-4', selectedRestoreJobId === job.id && '-mx-3 rounded-md bg-muted/40 px-3')}>
              <div className="flex items-start gap-3">
                <button type="button" className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-pressed={selectedRestoreJobId === job.id} onClick={() => selectRestoreJob(job)}>
                  <p className="text-sm font-medium">{title}</p>
                  <p className="text-xs text-muted-foreground">{meta}</p>
                  {job.error && <p className="text-xs text-destructive">{job.error}</p>}
                </button>
                <div className="flex shrink-0 items-center gap-1 touch:gap-3">
                  {job.status === 'validated' && <Button size="sm" onClick={() => startRestore.mutate(job)} disabled={!available || startRestore.isPending || !!restorePolicy.lock} title={restorePolicy.lock}><Play aria-hidden="true" />Restore</Button>}
                  {['failed', 'cancelled'].includes(job.status) && job.archive_available && <Button variant="outline" size="sm" onClick={() => startRestore.mutate(job)} disabled={!available || !!restorePolicy.lock}><RotateCcw aria-hidden="true" />Try again</Button>}
                  {running && <Button variant="outline" size="sm" onClick={() => cancelRestore.mutate(job)} disabled={job.status === 'cancelling'}><Square aria-hidden="true" />Stop</Button>}
                  {!running && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`More actions for the restore ${meta}`}><MoreHorizontal aria-hidden="true" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <PolicyMenuItem className="text-destructive focus:text-destructive" onClick={() => removeRestore.mutate(job)}>Delete</PolicyMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
              {running && <Progress value={job.progress} />}
            </div>
          );
        })}
    </SettingsSection>

    <Dialog open={!!recoveryJob} onOpenChange={open => { if (!open && !recoveryStays) closeRecovery(); }}>
      <DialogContent onEscapeKeyDown={event => { if (recoveryStays) event.preventDefault(); }}
        onPointerDownOutside={event => { if (recoveryStays) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>Recovery password</DialogTitle>
          <DialogDescription>
            This backup opens on any UniHub only with its recovery password. It is shown once; save it somewhere safe before downloading.
          </DialogDescription>
        </DialogHeader>
        {recoveryPassword ? (
          <div className="space-y-3">
            <p className="select-all break-all rounded-md border border-border bg-muted/40 p-3 font-mono text-sm" aria-label="Recovery password">{recoveryPassword}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void copyText(recoveryPassword).then(copied => { if (!scope.ended) { setRecoverySaved(copied); toast({ title: copied ? 'Copied' : 'Could not copy', variant: copied ? undefined : 'destructive' }); } })}>
                <Copy aria-hidden="true" />Copy
              </Button>
              <Button variant="outline" size="sm" onClick={saveRecoveryFile}><Download aria-hidden="true" />Save as file</Button>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-accent" checked={recoverySaved} onChange={event => setRecoverySaved(event.target.checked)} />
              <span>I have saved the recovery password.</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={closeRecovery} disabled={!recoverySaved}>Close</Button>
              <Button disabled={!recoverySaved || download.isPending} onClick={() => { if (recoveryJob) download.mutate(recoveryJob); closeRecovery(); }}>
                <Download aria-hidden="true" />Download backup
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={closeRecovery} disabled={reveal.isPending}>Cancel</Button>
            <Button onClick={() => recoveryJob && reveal.mutate(recoveryJob)} disabled={reveal.isPending}>
              {reveal.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}Show the password
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  </>);
}
