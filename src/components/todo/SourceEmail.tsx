import { Link } from 'react-router-dom';
import { Mail, Paperclip, Unlink2 } from 'lucide-react';
import { formatEventTime } from '@/lib/calendar-api';
import { emailPath, senderName, type SourceEmail } from '@/lib/email-tasks';
import { openMailPeek } from '@/lib/mail-peek';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';

/**
 * The email a task came from, kept with the task: subject, sender, date and
 * the attachment names it had. Shows the email over the page while it is still
 * in UniHub; a draft opens in the compose form instead.
 */
export function SourceEmailBlock({ source, timezone, className, onUnlink, unlinking = false }: {
  source: SourceEmail; timezone: string | null; className?: string;
  /** Offers to remove the link (and the kept summary) when given. */
  onUnlink?: () => void; unlinking?: boolean;
}) {
  const when = source.received_at ? formatEventTime(source.received_at, 'd MMM yyyy', timezone) : null;
  return (
    <div className={cn('flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md bg-muted/50 px-3 py-2.5 text-sm', className)} aria-label="From email">
      <Mail aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 basis-48">
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
      {/* On a narrow block the action wraps under the text, aligned with it. */}
      {!source.available
        ? <span className="shrink-0 self-center text-xs text-muted-foreground">No longer in UniHub</span>
        : source.draft
          ? <Link to={emailPath(source)} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'ml-7 shrink-0 sm:ml-0 sm:self-center')}>Open draft</Link>
          : <Button type="button" variant="outline" size="sm" className="ml-7 shrink-0 sm:ml-0 sm:self-center" onClick={() => openMailPeek(source.email_id)}>Show email</Button>}
      {onUnlink && (
        <Button type="button" variant="ghost" size="icon-sm" className="-mr-1 shrink-0 text-muted-foreground sm:self-center" disabled={unlinking}
          aria-label="Remove the link to the email" title="Remove the link to the email" onClick={onUnlink}>
          <Unlink2 aria-hidden="true" className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
