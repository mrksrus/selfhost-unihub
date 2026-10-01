import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useMailAccountBackup } from '@/hooks/use-mail-account-backup';
import { cn } from '@/lib/utils';

/**
 * Starts an export of one account's mail and follows it to a download.
 * The job also appears in Settings › Backup, so leaving this view loses nothing.
 */
export function MailAccountBackupButton({ accountId, label = 'Download a backup first', size = 'sm', className }: {
  accountId: string;
  label?: string;
  size?: 'sm' | 'default';
  className?: string;
}) {
  const backup = useMailAccountBackup(accountId);
  const job = backup.job;
  const running = job && ['queued', 'running', 'cancelling'].includes(job.status);
  const buttonClass = cn(size === 'sm' && 'h-8 text-xs');

  return <div className={cn('space-y-1.5', className)}>
    {running ? <div className="space-y-1" role="status">
      <p className="text-xs text-muted-foreground">Preparing backup… {job.progress}%</p>
      <Progress value={job.progress} className="h-1.5" aria-label="Backup progress" />
    </div> : job?.status === 'ready' ? (backup.directDownload
      ? <Button type="button" size={size} variant="outline" className={buttonClass} onClick={backup.download}>
        <Download aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />Download backup
      </Button>
      : <p role="status" className="text-xs text-muted-foreground">
        Backup ready. Open Settings › Backup to save its recovery password and download it.
      </p>) : <Button type="button" size={size} variant="outline" className={buttonClass}
      disabled={backup.starting} onClick={backup.start}>
      {backup.starting && <Loader2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5 motion-safe:animate-spin" />}
      {job && ['failed', 'cancelled'].includes(job.status) ? 'Try the backup again' : label}
    </Button>}
    {job?.status === 'failed' && <p role="alert" className="text-xs text-destructive">
      The backup failed{job.error ? `: ${job.error}` : '.'}
    </p>}
    {backup.error && <p role="alert" className="text-xs text-destructive">{backup.error}</p>}
  </div>;
}
