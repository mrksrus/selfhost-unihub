import { Link } from 'react-router-dom';
import { Mail, Paperclip } from 'lucide-react';
import { formatEventTime } from '@/lib/calendar-api';
import { emailPath, senderName, type SourceEmail } from '@/lib/email-tasks';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button-variants';

/** One quiet mention of the email in a task row's meta line. */
export function SourceEmailHint({ source }: { source: SourceEmail }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Mail aria-hidden="true" className="h-3 w-3 shrink-0" />
      <span className="truncate">{senderName(source)}</span>
    </span>
  );
}

/**
 * The email a task came from, kept with the task: subject, sender, date and
 * the attachment names it had. Opens the email while it is still in UniHub.
 */
export function SourceEmailBlock({ source, timezone, className }: { source: SourceEmail; timezone: string | null; className?: string }) {
  const when = source.received_at ? formatEventTime(source.received_at, 'd MMM yyyy', timezone) : null;
  return (
    <div className={cn('flex items-start gap-3 rounded-md bg-muted/50 px-3 py-2.5 text-sm', className)} aria-label="From email">
      <Mail aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{source.subject || '(No subject)'}</p>
        <p className="truncate text-xs text-muted-foreground">
          {senderName(source)}{when && ` · ${when}`}
        </p>
        {source.attachments.length > 0 && (
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground" aria-label="Attachments">
            {source.attachments.map(name => (
              <li key={name} className="inline-flex min-w-0 max-w-full items-center gap-1">
                <Paperclip aria-hidden="true" className="h-3 w-3 shrink-0" /><span className="truncate">{name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {source.available
        ? <Link to={emailPath(source)} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')}>{source.draft ? 'Open draft' : 'Open email'}</Link>
        : <span className="shrink-0 self-center text-xs text-muted-foreground">No longer in UniHub</span>}
    </div>
  );
}
