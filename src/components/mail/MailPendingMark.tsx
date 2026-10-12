import type { Email } from '@/lib/mail-api';
import { cn } from '@/lib/utils';
import { flagPendingLabel } from '@/components/mail/mail-page-model';

interface Props {
  email: Pick<Email, 'read_sync_pending' | 'star_sync_pending'>;
  /** A read or star request of this message is still on its way to UniHub. */
  saving: boolean;
  className?: string;
}

/**
 * A quiet hollow dot on a message whose read or star change is not confirmed
 * yet: on its way to UniHub, or accepted and waiting for the provider. The
 * row already shows the requested state; nothing is disabled. The label is
 * the tooltip and the screen-reader text.
 */
export function MailPendingMark({ email, saving, className }: Props) {
  const waiting = !!(email.read_sync_pending || email.star_sync_pending);
  if (!saving && !waiting) return null;
  const label = saving ? 'Saving…' : flagPendingLabel(email);
  return (
    <span title={label} data-testid="mail-pending-mark" className={cn('inline-flex shrink-0 items-center justify-center', className)}>
      <span aria-hidden="true" className="h-2 w-2 rounded-full border border-muted-foreground motion-safe:animate-pulse" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
