import { useState, type ReactNode } from 'react';
import { format } from 'date-fns';
import { Loader2, UserPlus } from 'lucide-react';
import type { Email, EmailAttachment } from '@/lib/mail-api';
import { useContactActions } from '@/hooks/use-contact-actions';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/page-states';
import { SafeEmailContent } from '@/components/mail/SafeEmailContent';
import { EmailTasks } from '@/components/mail/EmailTasks';
import { AttachmentList } from '@/components/mail/AttachmentList';
import { AttachmentViewer } from '@/components/mail/AttachmentViewer';
import { deriveContactNameFromEmail } from '@/components/mail/mail-page-model';

interface Props {
  email: Email;
  /** The body and attachments are still loading; the header is already known. */
  loading?: boolean;
  timezone: string | null;
  /** Offers "Add contact" for the sender when false. */
  senderInContacts?: boolean;
  /** Opens an attachment some other way; without it a row opens the built-in viewer. */
  onOpenAttachment?: (attachment: EmailAttachment) => void;
  /** A notice shown under the subject (e.g. "Local copy"). */
  notice?: ReactNode;
  /** Smaller subject for compact places such as the peek sheet. */
  compact?: boolean;
}

/**
 * One message as the reader shows it: subject, who and when, the tasks made
 * from it, attachments and the body. Used by the mail reader and by the peek
 * that other pages open on a linked email.
 */
export function MailMessageView({ email, loading = false, timezone, senderInContacts = true, onOpenAttachment, notice, compact = false }: Props) {
  const { create: createContact } = useContactActions();
  // Tied to the message, so another message never opens with this one's attachment.
  const [viewing, setViewing] = useState<{ emailId: string; attachmentId: string } | null>(null);
  const openId = viewing?.emailId === email.id ? viewing.attachmentId : null;
  const openAttachment = onOpenAttachment ?? ((attachment: EmailAttachment) => setViewing({ emailId: email.id, attachmentId: attachment.id }));
  return (
    <div className="space-y-4">
      <div>
        <h1 className={compact ? 'mb-3 text-lg font-semibold' : 'mb-4 text-2xl font-bold'}>{email.subject || '(No subject)'}</h1>
        {notice}
        <div className="space-y-2 text-sm text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-all">
              <span className="font-medium text-foreground">From:</span> {email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address}
            </span>
            {!senderInContacts && (
              <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5" disabled={createContact.isPending}
                onClick={() => createContact.mutate({ ...deriveContactNameFromEmail(email), email: email.from_address })}>
                {createContact.isPending ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <UserPlus aria-hidden="true" className="h-3.5 w-3.5" />}
                Add contact
              </Button>
            )}
          </div>
          <div><span className="font-medium text-foreground">To:</span> {email.to_addresses?.join(', ') || 'N/A'}</div>
          <div><span className="font-medium text-foreground">Date:</span> {format(new Date(email.received_at), 'PPpp')}</div>
        </div>
      </div>

      {!loading && email.tasks && <EmailTasks tasks={email.tasks} timezone={timezone} />}

      {loading && <LoadingState label="Loading email…" compact className="border-t border-border" />}

      {!loading && email.attachments && <AttachmentList attachments={email.attachments} onOpen={openAttachment} />}
      {!onOpenAttachment && email.attachments && <AttachmentViewer attachments={email.attachments} openId={openId} onClose={() => setViewing(null)} />}

      {!loading && (
        <div className="border-t border-border pt-4">
          <SafeEmailContent emailId={email.id} bodyHtml={email.body_html} bodyText={email.body_text} />
        </div>
      )}
    </div>
  );
}
