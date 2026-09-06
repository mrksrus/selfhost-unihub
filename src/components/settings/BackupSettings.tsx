import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import { getBackupDownloadAction } from '@/lib/backup';
import { jobPollInterval } from '@/lib/job-polling';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Download, Loader2, Database, Trash2, Upload, LockKeyhole, Square, RotateCcw, Copy, Play } from 'lucide-react';
import { motion } from 'framer-motion';

type BackupJob = {
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

type BackupImportResult = {
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

type RestoreJob = {
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

const IMPORT_SECTIONS = [
  { id: 'mail', label: 'Mail' },
  { id: 'calendar', label: 'Calendar/ToDo' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'recordings', label: 'Recordings' },
  { id: 'settings', label: 'Settings' },
] as const;

export default function BackupSettings({ active }: { active: boolean }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [backupCreating, setBackupCreating] = useState(false);
  const [backupImporting, setBackupImporting] = useState(false);
  const [backupEncryptionEnabled, setBackupEncryptionEnabled] = useState(true);
  const [backupImportFile, setBackupImportFile] = useState<File | null>(null);
  const [backupImportResult, setBackupImportResult] = useState<BackupImportResult | null>(null);
  const [selectedRestoreJobId, setSelectedRestoreJobId] = useState<string | null>(null);
  const [restorePassword, setRestorePassword] = useState('');
  const [recoveryDialogJob, setRecoveryDialogJob] = useState<BackupJob | null>(null);
  const [recoveryPassword, setRecoveryPassword] = useState<string | null>(null);
  const [recoveryPasswordSaved, setRecoveryPasswordSaved] = useState(false);
  const [recoveryPasswordLoading, setRecoveryPasswordLoading] = useState(false);
  const completedRestoreJobsRef = useRef(new Set<string>());
  const [backupImportSections, setBackupImportSections] = useState<string[] | 'full'>('full');
  const [backupConflictMode, setBackupConflictMode] = useState<'keep_existing' | 'replace' | 'keep_both'>('keep_existing');
  const [backupCalendarMode, setBackupCalendarMode] = useState<'merge_same_name' | 'copy'>('merge_same_name');
  const [backupCredentialsMode, setBackupCredentialsMode] = useState<'keep_existing' | 'restore'>('keep_existing');
  const { data: backupJobs = [], refetch: refetchBackupJobs } = useQuery({
    queryKey: ['backup-jobs'],
    queryFn: async ({ signal }) => {
      const response = await api.get<{ jobs: BackupJob[] }>('/backup/jobs', { signal });
      if (response.error) throw new Error(response.error);
      return response.data?.jobs || [];
    },
    refetchInterval: (query) => jobPollInterval(query.state.data, active, 5000),
    enabled: !!user && active,
  });

  const { data: restoreJobs = [], refetch: refetchRestoreJobs } = useQuery({
    queryKey: ['backup-restore-jobs'],
    queryFn: async ({ signal }) => {
      const response = await api.get<{ jobs: RestoreJob[] }>('/backup/restore-jobs', { signal });
      if (response.error) throw new Error(response.error);
      return response.data?.jobs || [];
    },
    refetchInterval: (query) => jobPollInterval(query.state.data, active, 3000),
    enabled: !!user && active,
  });

  const selectedRestoreJob = restoreJobs.find((job) => job.id === selectedRestoreJobId) || null;

  useEffect(() => {
    if (selectedRestoreJob?.validation_result) {
      setBackupImportResult(selectedRestoreJob.validation_result);
    }
    const completed = restoreJobs.filter((job) => job.status === 'completed' && !completedRestoreJobsRef.current.has(job.id));
    if (completed.length) {
      completed.forEach((job) => completedRestoreJobsRef.current.add(job.id));
      void queryClient.invalidateQueries({
        predicate: (query) => !['backup-jobs', 'backup-restore-jobs'].includes(String(query.queryKey[0])),
      });
    }
  }, [selectedRestoreJob, restoreJobs, queryClient]);

  const handleStartBackupJob = async (sections: string[] | 'full') => {
    setBackupCreating(true);
    try {
      const response = await api.post<{ job: BackupJob }>('/backup/jobs', {
        sections,
        encrypt: backupEncryptionEnabled,
      });
      if (response.error) {
        toast({ title: 'Failed to start backup', description: response.error, variant: 'destructive' });
        return;
      }
      await refetchBackupJobs();
      toast({ title: 'Backup job started' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Failed to start backup', description: message, variant: 'destructive' });
    } finally {
      setBackupCreating(false);
    }
  };

  const updateBackupImportSections = (sectionId: string | 'full') => {
    setBackupImportResult(null);
    setSelectedRestoreJobId(null);
    if (sectionId === 'full') {
      setBackupImportSections('full');
      return;
    }
    setBackupImportSections((current) => {
      const currentSections = current === 'full' ? [] : current;
      const next = currentSections.includes(sectionId)
        ? currentSections.filter((section) => section !== sectionId)
        : [...currentSections, sectionId];
      return next.length === 0 ? 'full' : next;
    });
  };

  const handleUploadBackup = async () => {
    if (!backupImportFile) {
      toast({ title: 'Select a backup file first', variant: 'destructive' });
      return;
    }
    setBackupImporting(true);
    try {
      const params = new URLSearchParams({
        sections: backupImportSections === 'full' ? 'full' : backupImportSections.join(','),
        conflict_mode: backupConflictMode,
        calendar_mode: backupCalendarMode,
        credentials_mode: backupCredentialsMode,
      });
      const response = await api.uploadBlob<{ job: RestoreJob }>(
        `/backup/import?${params.toString()}`,
        backupImportFile,
        backupImportFile.name.endsWith('.unihub-backup')
          ? 'application/vnd.unihub.backup'
          : 'application/zip'
      );
      if (response.error) {
        toast({ title: 'Backup import failed', description: response.error, variant: 'destructive' });
        return;
      }
      const job = response.data?.job;
      if (!job) throw new Error('The server did not return a restore job.');
      setSelectedRestoreJobId(job.id);
      setBackupImportResult(null);
      setRestorePassword('');
      await refetchRestoreJobs();
      toast({
        title: job.status === 'awaiting_password' ? 'Recovery password required' : 'Backup uploaded',
        description: job.status === 'awaiting_password'
          ? 'Enter the backup recovery password to continue validation.'
          : 'Validation is running in the background.',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Backup import failed', description: message, variant: 'destructive' });
    } finally {
      setBackupImporting(false);
    }
  };

  const handleUnlockRestoreJob = async (job: RestoreJob) => {
    if (!restorePassword) {
      toast({ title: 'Enter the recovery password', variant: 'destructive' });
      return;
    }
    setBackupImporting(true);
    try {
      const response = await api.post<{ job: RestoreJob }>(
        `/backup/restore-jobs/${encodeURIComponent(job.id)}/unlock`,
        { password: restorePassword }
      );
      if (response.error) {
        toast({ title: 'Unable to unlock backup', description: response.error, variant: 'destructive' });
        return;
      }
      setRestorePassword('');
      await refetchRestoreJobs();
      toast({ title: 'Backup unlocked', description: 'Validation is running in the background.' });
    } finally {
      setBackupImporting(false);
    }
  };

  const handleStartRestoreJob = async (job: RestoreJob) => {
    const response = await api.post<{ job: RestoreJob }>(
      `/backup/restore-jobs/${encodeURIComponent(job.id)}/start`
    );
    if (response.error) {
      toast({ title: 'Failed to start restore', description: response.error, variant: 'destructive' });
      return;
    }
    await refetchRestoreJobs();
    toast({
      title: 'Restore started',
      description: 'Restore is running in the background. You may close this page.',
    });
  };

  const handleRestoreStoredBackup = async (job: BackupJob) => {
    const response = await api.post<{ job: RestoreJob }>(
      `/backup/jobs/${encodeURIComponent(job.id)}/restore`,
      {
        sections: job.requested_sections,
        conflict_mode: backupConflictMode,
        calendar_mode: backupCalendarMode,
        credentials_mode: backupCredentialsMode,
      }
    );
    if (response.error) {
      toast({ title: 'Failed to prepare restore', description: response.error, variant: 'destructive' });
      return;
    }
    if (response.data?.job) setSelectedRestoreJobId(response.data.job.id);
    await refetchRestoreJobs();
    toast({ title: 'Backup validation started' });
  };

  const handleCancelBackupJob = async (job: BackupJob) => {
    const response = await api.post(`/backup/jobs/${encodeURIComponent(job.id)}/cancel`);
    if (response.error) {
      toast({ title: 'Failed to stop backup', description: response.error, variant: 'destructive' });
      return;
    }
    await refetchBackupJobs();
  };

  const handleCancelRestoreJob = async (job: RestoreJob) => {
    const response = await api.post(`/backup/restore-jobs/${encodeURIComponent(job.id)}/cancel`);
    if (response.error) {
      toast({ title: 'Failed to stop restore', description: response.error, variant: 'destructive' });
      return;
    }
    await refetchRestoreJobs();
  };

  const handleDeleteRestoreJob = async (job: RestoreJob) => {
    const response = await api.delete(`/backup/restore-jobs/${encodeURIComponent(job.id)}`);
    if (response.error) {
      toast({ title: 'Failed to delete restore job', description: response.error, variant: 'destructive' });
      return;
    }
    if (selectedRestoreJobId === job.id) {
      setSelectedRestoreJobId(null);
      setBackupImportResult(null);
    }
    await refetchRestoreJobs();
  };

  const startBackupDownload = (job: BackupJob) => {
    const link = document.createElement('a');
    link.href = api.getDownloadUrl(`/backup/jobs/${encodeURIComponent(job.id)}/download`);
    link.download = `unihub-backup-${job.id}.${job.encryption_enabled ? 'unihub-backup' : 'zip'}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handleBackupDownload = (job: BackupJob) => {
    const action = getBackupDownloadAction(job);
    if (action === 'reveal_password') {
      setRecoveryDialogJob(job);
      setRecoveryPassword(null);
      setRecoveryPasswordSaved(false);
      return;
    }
    if (action === 'missing_password_metadata') {
      toast({
        title: 'Recovery password unavailable',
        description: 'This encrypted backup is missing its recovery-password metadata. Create a new backup.',
        variant: 'destructive',
      });
      return;
    }
    startBackupDownload(job);
  };

  const handleRevealRecoveryPassword = async () => {
    if (!recoveryDialogJob) return;
    setRecoveryPasswordLoading(true);
    try {
      const response = await api.post<{ recovery_password: string }>(
        `/backup/jobs/${encodeURIComponent(recoveryDialogJob.id)}/recovery-password/reveal`
      );
      if (response.error || !response.data?.recovery_password) {
        toast({
          title: 'Failed to reveal recovery password',
          description: response.error,
          variant: 'destructive',
        });
        return;
      }
      setRecoveryPassword(response.data.recovery_password);
      await refetchBackupJobs();
    } finally {
      setRecoveryPasswordLoading(false);
    }
  };

  const downloadRecoveryPasswordFile = () => {
    if (!recoveryDialogJob || !recoveryPassword) return;
    const blob = new Blob(
      [`UniHub backup: ${recoveryDialogJob.id}\nRecovery password: ${recoveryPassword}\n`],
      { type: 'text/plain;charset=utf-8' }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `unihub-backup-${recoveryDialogJob.id}-recovery-password.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleDeleteBackupJob = async (job: BackupJob) => {
    try {
      const response = await api.delete(`/backup/jobs/${job.id}`);
      if (response.error) {
        toast({ title: 'Failed to delete backup', description: response.error, variant: 'destructive' });
        return;
      }
      await refetchBackupJobs();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Failed to delete backup', description: message, variant: 'destructive' });
    }
  };

  return (<>

        {/* Backup and import */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.33 }}
        >
          <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-accent/10">
                  <Database className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <CardTitle className="text-lg">Backup</CardTitle>
                  <CardDescription>Create restorable ZIP backups with app data, mail, attachments, and stored files.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                <div className="space-y-1">
                  <Label htmlFor="backupEncryption">Encrypt backups</Label>
                  <p className="text-xs text-muted-foreground">
                    Encrypted backups are portable to any UniHub server with their recovery password.
                  </p>
                </div>
                <Switch
                  id="backupEncryption"
                  checked={backupEncryptionEnabled}
                  onCheckedChange={setBackupEncryptionEnabled}
                />
              </div>

              <div className="flex flex-wrap gap-3">
                <Button variant="outline" onClick={() => handleStartBackupJob('full')} disabled={backupCreating}>
                  {backupCreating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                  Full backup
                </Button>
                {[
                  ['mail', 'Mail backup'],
                  ['calendar', 'Calendar backup'],
                  ['contacts', 'Contacts backup'],
                  ['recordings', 'Recordings backup'],
                  ['settings', 'Settings backup'],
                ].map(([section, label]) => (
                  <Button
                    key={section}
                    variant="outline"
                    onClick={() => handleStartBackupJob([section])}
                    disabled={backupCreating}
                  >
                    {label}
                  </Button>
                ))}
              </div>

              <div className="space-y-3">
                {backupJobs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No backup jobs yet.</p>
                ) : backupJobs.map((job) => (
                  <div key={job.id} className="rounded-md border border-border p-3 space-y-2">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="flex items-center gap-2 font-medium text-foreground">
                          {job.encryption_enabled && <LockKeyhole className="h-4 w-4" />}
                          {job.scope === 'full' ? 'Full backup' : `${job.requested_sections.join(', ')} backup`}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Started {new Date(job.started_at || job.created_at).toLocaleString()} • {job.phase || job.status}
                          {job.file_size ? ` • ${(job.file_size / 1024 / 1024).toFixed(1)} MB` : ''}
                        </p>
                        {job.completed_at && (
                          <p className="text-xs text-muted-foreground">
                            Finished {new Date(job.completed_at).toLocaleString()}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {job.status === 'ready' && (
                          <Button variant="outline" size="sm" onClick={() => handleBackupDownload(job)}>
                            <Download className="h-4 w-4 mr-2" />
                            Download
                          </Button>
                        )}
                        {job.status === 'ready' && (
                          <Button variant="outline" size="sm" onClick={() => handleRestoreStoredBackup(job)}>
                            <RotateCcw className="h-4 w-4 mr-2" />
                            Restore
                          </Button>
                        )}
                        {['queued', 'running', 'cancelling'].includes(job.status) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleCancelBackupJob(job)}
                            disabled={job.status === 'cancelling'}
                          >
                            <Square className="h-4 w-4 mr-2" />
                            Stop
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Delete backup"
                          onClick={() => handleDeleteBackupJob(job)}
                          disabled={['queued', 'running', 'cancelling'].includes(job.status)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    {['queued', 'running', 'cancelling'].includes(job.status) && <Progress value={job.progress} />}
                    {job.error && <p className="text-sm text-destructive">{job.error}</p>}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-accent/10">
                  <Upload className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <CardTitle className="text-lg">Import</CardTitle>
                  <CardDescription>Upload once, then validate and restore in the background.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="backupImportFile">Backup file</Label>
                <Input
                  id="backupImportFile"
                  type="file"
                  accept="application/zip,application/vnd.unihub.backup,.zip,.unihub-backup"
                  onChange={(event) => {
                    setBackupImportFile(event.target.files?.[0] || null);
                    setBackupImportResult(null);
                    setSelectedRestoreJobId(null);
                    setRestorePassword('');
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label>Import scope</Label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant={backupImportSections === 'full' ? 'default' : 'outline'}
                    onClick={() => updateBackupImportSections('full')}
                  >
                    Full import
                  </Button>
                  {IMPORT_SECTIONS.map((section) => (
                    <Button
                      key={section.id}
                      type="button"
                      variant={backupImportSections !== 'full' && backupImportSections.includes(section.id) ? 'default' : 'outline'}
                      onClick={() => updateBackupImportSections(section.id)}
                    >
                      {section.label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Full import restores every supported section. Category import restores only the selected data from the same ZIP backup.</p>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-2">
                  <Label>Conflicts</Label>
                  <Select value={backupConflictMode} onValueChange={(value) => {
                    setBackupConflictMode(value as typeof backupConflictMode);
                    setSelectedRestoreJobId(null);
                    setBackupImportResult(null);
                  }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="keep_existing">Keep existing</SelectItem>
                      <SelectItem value="replace">Replace matching</SelectItem>
                      <SelectItem value="keep_both">Keep both</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Local calendars</Label>
                  <Select value={backupCalendarMode} onValueChange={(value) => {
                    setBackupCalendarMode(value as typeof backupCalendarMode);
                    setSelectedRestoreJobId(null);
                    setBackupImportResult(null);
                  }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="merge_same_name">Merge same name</SelectItem>
                      <SelectItem value="copy">Create restored copies</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Account credentials</Label>
                  <Select value={backupCredentialsMode} onValueChange={(value) => {
                    setBackupCredentialsMode(value as typeof backupCredentialsMode);
                    setSelectedRestoreJobId(null);
                    setBackupImportResult(null);
                  }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="keep_existing">Keep current</SelectItem>
                      <SelectItem value="restore">Use backup</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={handleUploadBackup}
                  disabled={!backupImportFile || backupImporting}
                >
                  {backupImporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
                  Upload and validate
                </Button>
                <Button
                  onClick={() => selectedRestoreJob && handleStartRestoreJob(selectedRestoreJob)}
                  disabled={
                    !selectedRestoreJob ||
                    selectedRestoreJob.status !== 'validated' ||
                    !selectedRestoreJob.validation_result?.valid ||
                    Boolean(selectedRestoreJob.validation_result?.errors?.length)
                  }
                >
                  <Play className="h-4 w-4 mr-2" />
                  Restore
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Restore is enabled after background validation. You may close this page while validation or restore runs.
              </p>

              {selectedRestoreJob?.status === 'awaiting_password' && (
                <div className="space-y-3 rounded-md border border-destructive/40 p-3">
                  <div>
                    <p className="font-medium text-foreground">Encrypted backup</p>
                    <p className="text-sm text-muted-foreground">
                      Enter its recovery password. The password is used in memory and is not stored.
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      type="password"
                      value={restorePassword}
                      onChange={(event) => setRestorePassword(event.target.value)}
                      autoComplete="off"
                      placeholder="Recovery password"
                    />
                    <Button
                      onClick={() => handleUnlockRestoreJob(selectedRestoreJob)}
                      disabled={!restorePassword || backupImporting}
                    >
                      {backupImporting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Unlock
                    </Button>
                  </div>
                </div>
              )}

              {selectedRestoreJob && ['validating', 'queued', 'running', 'cancelling'].includes(selectedRestoreJob.status) && (
                <div className="space-y-2 rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium capitalize">{selectedRestoreJob.phase.replace(/_/g, ' ')}</span>
                    <span className="text-muted-foreground">{selectedRestoreJob.progress}%</span>
                  </div>
                  <Progress value={selectedRestoreJob.progress} />
                  {selectedRestoreJob.operation === 'restore' && (
                    <p className="text-xs text-muted-foreground">
                      Restore is running in the background. You may close this page.
                    </p>
                  )}
                </div>
              )}

              {backupImportResult && (
                <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">
                      {backupImportResult.valid ? 'Valid backup' : 'Invalid backup'}
                    </span>
                    <span className="text-muted-foreground">
                      {backupImportResult.dry_run ? 'Dry run' : 'Applied'}
                    </span>
                    {backupImportResult.import_sections?.length ? (
                      <span className="text-muted-foreground">
                        {backupImportResult.import_sections.join(', ')}
                      </span>
                    ) : null}
                  </div>
                  {Object.keys(backupImportResult.counts || {}).length > 0 && (
                    <p className="mt-2 text-muted-foreground">
                      {Object.entries(backupImportResult.counts).map(([key, value]) => `${key}: ${value}`).join(' • ')}
                    </p>
                  )}
                  {Object.keys(backupImportResult.conflicts || {}).length > 0 && (
                    <p className="mt-1 text-muted-foreground">
                      Conflicts: {Object.entries(backupImportResult.conflicts || {}).map(([key, value]) => `${key}: ${value}`).join(' • ')}
                    </p>
                  )}
                  {backupImportResult.restored_files !== undefined && (
                    <p className="mt-1 text-muted-foreground">Restored files: {backupImportResult.restored_files}</p>
                  )}
                  {backupImportResult.warnings?.length > 0 && (
                    <p className="mt-2 text-warning">{backupImportResult.warnings.join(' ')}</p>
                  )}
                  {backupImportResult.errors?.length > 0 && (
                    <p className="mt-2 text-destructive">{backupImportResult.errors.join(' ')}</p>
                  )}
                </div>
              )}

              <Separator />
              <div className="space-y-3">
                <div>
                  <p className="font-medium text-foreground">Restore jobs</p>
                  <p className="text-xs text-muted-foreground">
                    Uploaded archives expire after seven days. Completed server backups remain under Backup until deleted.
                  </p>
                </div>
                {restoreJobs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No restore jobs yet.</p>
                ) : restoreJobs.map((job) => (
                  <div key={job.id} className="space-y-2 rounded-md border border-border p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <button
                        type="button"
                        className="text-left"
                        onClick={() => {
                          setSelectedRestoreJobId(job.id);
                          setBackupImportResult(job.validation_result || job.result_counts);
                        }}
                      >
                        <p className="font-medium text-foreground">
                          {job.source_type === 'generated' ? 'Stored backup restore' : 'Uploaded backup restore'}
                          {job.is_encrypted ? ' • encrypted' : ''}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Started {new Date(job.started_at || job.created_at).toLocaleString()} • {job.phase}
                        </p>
                        {job.completed_at && (
                          <p className="text-xs text-muted-foreground">
                            Finished {new Date(job.completed_at).toLocaleString()}
                          </p>
                        )}
                      </button>
                      <div className="flex gap-2">
                        {job.status === 'validated' && (
                          <Button size="sm" onClick={() => handleStartRestoreJob(job)}>
                            <Play className="h-4 w-4 mr-2" />
                            Restore
                          </Button>
                        )}
                        {['failed', 'cancelled'].includes(job.status) && job.archive_available && (
                          <Button variant="outline" size="sm" onClick={() => handleStartRestoreJob(job)}>
                            <RotateCcw className="h-4 w-4 mr-2" />
                            Retry
                          </Button>
                        )}
                        {['uploaded', 'validating', 'queued', 'running', 'cancelling'].includes(job.status) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleCancelRestoreJob(job)}
                            disabled={job.status === 'cancelling'}
                          >
                            <Square className="h-4 w-4 mr-2" />
                            Stop
                          </Button>
                        )}
                        {!['uploaded', 'validating', 'queued', 'running', 'cancelling'].includes(job.status) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Delete restore job"
                            onClick={() => handleDeleteRestoreJob(job)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                    {['uploaded', 'validating', 'queued', 'running', 'cancelling'].includes(job.status) && (
                      <Progress value={job.progress} />
                    )}
                    {job.error && <p className="text-sm text-destructive">{job.error}</p>}
                    {job.expires_at && job.source_type === 'upload' && (
                      <p className="text-xs text-muted-foreground">
                        Archive expires {new Date(job.expires_at).toLocaleString()}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Dialog
            open={Boolean(recoveryDialogJob)}
            onOpenChange={(open) => {
              if (open) return;
              if (recoveryPassword && !recoveryPasswordSaved) return;
              setRecoveryDialogJob(null);
              setRecoveryPassword(null);
              setRecoveryPasswordSaved(false);
            }}
          >
            <DialogContent
              onEscapeKeyDown={(event) => {
                if (recoveryPassword && !recoveryPasswordSaved) event.preventDefault();
              }}
              onPointerDownOutside={(event) => {
                if (recoveryPassword && !recoveryPasswordSaved) event.preventDefault();
              }}
            >
              <DialogHeader>
                <DialogTitle>Encrypted backup recovery password</DialogTitle>
              </DialogHeader>
              {!recoveryPassword ? (
                <div className="space-y-4">
                  <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
                    This password is shown once. After it is revealed, UniHub cannot show it again.
                    Without it, the downloaded backup cannot be restored on another server.
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setRecoveryDialogJob(null)}
                      disabled={recoveryPasswordLoading}
                    >
                      Cancel
                    </Button>
                    <Button onClick={handleRevealRecoveryPassword} disabled={recoveryPasswordLoading}>
                      {recoveryPasswordLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Reveal recovery password
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm font-medium text-destructive">
                    Save this password now. Closing or reloading this page before saving it can make the downloaded backup unrecoverable.
                  </div>
                  <div className="space-y-2">
                    <Label>Recovery password</Label>
                    <div className="flex gap-2">
                      <Input value={recoveryPassword} readOnly className="font-mono" />
                      <Button
                        variant="outline"
                        size="icon"
                        title="Copy recovery password"
                        onClick={() => navigator.clipboard.writeText(recoveryPassword)}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <Button variant="outline" onClick={downloadRecoveryPasswordFile}>
                    <Download className="h-4 w-4 mr-2" />
                    Download password file
                  </Button>
                  <label className="flex items-start gap-3 text-sm">
                    <Checkbox
                      checked={recoveryPasswordSaved}
                      onCheckedChange={(checked) => setRecoveryPasswordSaved(checked === true)}
                    />
                    <span>I saved the recovery password in a secure place.</span>
                  </label>
                  <div className="flex justify-end">
                    <Button
                      disabled={!recoveryPasswordSaved || !recoveryDialogJob}
                      onClick={() => {
                        if (!recoveryDialogJob) return;
                        startBackupDownload(recoveryDialogJob);
                        setRecoveryDialogJob(null);
                        setRecoveryPassword(null);
                        setRecoveryPasswordSaved(false);
                      }}
                    >
                      <Download className="h-4 w-4 mr-2" />
                      Download backup
                    </Button>
                  </div>
                </div>
              )}
            </DialogContent>
          </Dialog>
          </div>
        </motion.div>
  </>);
}
