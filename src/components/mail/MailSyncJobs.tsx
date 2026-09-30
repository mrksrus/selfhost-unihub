import { Button } from '@/components/ui/button';
import type { MailAccount } from '@/lib/mail-api';
import type { MailSyncJob } from '@/hooks/use-mail-sync-jobs';

export function MailSyncJobs({ accounts, jobs, error, cancelling, onCancel }: {
  accounts: MailAccount[];
  jobs: MailSyncJob[];
  error: boolean;
  cancelling: Set<string>;
  onCancel: (accountId: string) => void;
}) {
  const visible = jobs.filter(job => job.state !== 'idle' || (job.coverage &&
    (job.coverage.history?.complete !== true || job.coverage.bodies?.complete !== true || job.coverage.recent?.current !== true)));
  if (!error && visible.length === 0) return null;
  return <section aria-label="Mail sync status" className="shrink-0 border-b border-border bg-muted/30 p-3 text-xs space-y-2">
    {error && <p role="alert">Mail sync status is unavailable. An accepted sync may still be running; try refreshing this page.</p>}
    {visible.map(job => {
      const label = accounts.find(account => account.id === job.account_id)?.email_address || job.account_id;
      const progress = job.total !== null ? `${job.processed} of ${job.total}` : job.processed ? `${job.processed} processed` : null;
      const coverage = [
        job.coverage?.recent?.current === true && 'Inbox current',
        job.coverage?.history && job.coverage.history.complete !== true && 'Older mail not fully covered',
        job.coverage?.bodies && job.coverage.bodies.complete !== true && 'Bodies still downloading',
        job.coverage?.flags && job.coverage.flags.complete !== true && 'Flag coverage pending',
      ].filter(Boolean).join(' · ');
      return <div key={job.account_id} className="flex flex-wrap items-center justify-between gap-2" role="status">
        <span className="min-w-0 break-words">
          <strong>{label}</strong> · {job.state === 'queued' ? 'Queued for sync' : job.state === 'running' ? 'Syncing' : job.state === 'cancelled' ? 'Sync cancelled' : job.state === 'paused' ? 'Waiting for provider or credentials' : job.state === 'idle' ? 'No sync job running' : 'Sync failed'}
          {job.phase && (job.state === 'queued' || job.state === 'running' || job.state === 'paused') ? ` · ${job.phase}` : ''}
          {progress && (job.state === 'queued' || job.state === 'running') ? ` · ${progress}` : ''}
          {coverage ? ` · ${coverage}` : ''}
          {job.cancellation_requested && job.state === 'running' ? ' · Cancellation requested; waiting for a safe boundary' : ''}
          {(job.state === 'error' || job.state === 'paused') && job.error ? ` · ${job.error}` : ''}
        </span>
        {(job.state === 'queued' || job.state === 'running') && <Button size="sm" variant="outline" className="h-7 text-xs"
          disabled={cancelling.has(job.account_id) || job.cancellation_requested === true} onClick={() => onCancel(job.account_id)}
          aria-label={`Cancel sync for ${label}`}>
          {cancelling.has(job.account_id) || job.cancellation_requested ? 'Requesting cancellation…' : 'Cancel sync'}
        </Button>}
      </div>;
    })}
  </section>;
}
