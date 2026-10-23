import { useRef, type CSSProperties, type ReactNode } from 'react';

import { ArrowLeft, CheckCircle2, Forward, ListTodo, Loader2, Mail, Reply, ReplyAll, Star } from 'lucide-react';
import type { Email, MailAccount, MailFlagKind } from '@/lib/mail-api';
import { useResizableWidth } from '@/hooks/use-resizable-width';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { MailPendingMark } from '@/components/mail/MailPendingMark';
import { MailMessageView } from '@/components/mail/MailMessageView';

interface Props {
  /** The open message. The reader hook only sets it for the current selection. */
  email: Email;
  /** The body and attachments are still loading; the header comes from the list row. */
  loading?: boolean;
  accounts: MailAccount[];
  /** "Account / folder" shown next to the back button. */
  location: string;
  backLabel: string;
  isMobile: boolean;
  isReplying: boolean;
  flagRequests: Set<string>;
  requestFlag: (email: Email, kind: MailFlagKind, value: boolean) => void;
  senderInContacts: boolean;
  onBack: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  /** Opens the dialog that makes a task from this message. */
  onAddTask: () => void;
  timezone: string | null;
  /** Desktop inline reply editor, shown below the message. */
  inlineCompose: ReactNode;
}

/**
 * Reader pane: full screen on narrow screens, the right column of the split
 * view on wide ones, where its left edge can be dragged to change its share
 * of the page (remembered in this browser); the list keeps at least 20rem.
 */
export function MailReader({ email, loading = false, accounts, location, backLabel, isMobile, isReplying, flagRequests, requestFlag,
  senderInContacts, onBack, onReply, onReplyAll, onForward, onAddTask, timezone, inlineCompose }: Props) {
  const pane = useRef<HTMLDivElement>(null);
  const width = useResizableWidth('unihub:mail:reader-width', { element: pane, defaultValue: 0.45, min: 0.3, max: 0.7 });
  return (
    <div ref={pane} style={{ '--reader-width': `${(width.value * 100).toFixed(1)}%` } as CSSProperties}
      className="fixed inset-0 z-50 bg-background xl:relative xl:inset-auto xl:z-auto xl:h-full xl:w-[var(--reader-width)] xl:max-w-[calc(100%-20rem)] xl:shrink-0 xl:border-l xl:border-border">
      {/* The handle straddles the border; a thin accent line shows it while hovered, dragged or focused. */}
      <div {...width.handle} aria-label="Reader width" title="Drag to resize, double-click to reset"
        className={cn('absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize touch-none select-none xl:block focus-visible:outline-none',
          "before:absolute before:inset-y-0 before:left-[3px] before:w-0.5 before:rounded-full before:bg-accent before:opacity-0 before:transition-opacity before:content-['']",
          'hover:before:opacity-100 active:before:opacity-100 focus-visible:before:opacity-100')} />
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="shrink-0 border-b border-border p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-2 sm:gap-4">
            <Button
              variant="ghost"
              size="icon"
              className="[&_svg]:size-5 touch:[&_svg]:size-5"
              aria-label={backLabel}
              title={backLabel}
              onClick={onBack}
            >
              <ArrowLeft />
            </Button>
            <span className="text-xs text-muted-foreground truncate max-w-64">{location}</span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onReply}
                disabled={loading}
              >
                <Reply className="h-4 w-4 mr-2" />
                Reply
              </Button>
              <Button variant="outline" size="sm" onClick={onReplyAll} disabled={loading}>
                <ReplyAll className="h-4 w-4 mr-2" />
                Reply all
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onForward}
                disabled={loading}
              >
                <Forward className="h-4 w-4 mr-2" />
                Forward
              </Button>
              <Button variant="outline" size="sm" onClick={onAddTask} disabled={loading}>
                <ListTodo className="h-4 w-4 mr-2" />
                Add task
              </Button>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 ml-auto">
            {accounts.find(account => account.id === email.mail_account_id)?.disconnected_at && <span className="text-xs text-muted-foreground">Disconnected · retained locally; provider presence unverified</span>}
            {email.remote_missing && <span className="text-xs text-muted-foreground">Local copy · provider presence unverified</span>}
            <MailPendingMark email={email} saving={flagRequests.has(`read:${email.id}`) || flagRequests.has(`star:${email.id}`)} className="h-8 w-8" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => requestFlag(email, 'read', !email.is_read)}
            >
              {email.is_read ? (
                <>
                  <Mail className="h-4 w-4 mr-2" />
                  Mark unread
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Mark read
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="[&_svg]:size-5 touch:[&_svg]:size-5"
              aria-label={email.is_starred ? 'Unstar message' : 'Star message'}
              onClick={() => requestFlag(email, 'star', !email.is_starred)}
            >
              <Star className={email.is_starred ? 'fill-warning text-warning' : 'text-muted-foreground'} />
            </Button>
          </div>
        </div>

        {/* Email Content */}
        <div className={`flex-1 overflow-auto p-6 ${!isMobile && isReplying ? 'pb-0' : ''}`}>
          <div className="max-w-4xl mx-auto">
            <MailMessageView email={email} loading={loading} timezone={timezone} senderInContacts={senderInContacts}
              notice={email.remote_missing && <p className="mb-4 rounded-md border border-border p-3 text-sm text-muted-foreground">Local copy: this email was not found on the server during the last complete sync. Its content and attachments are kept here.</p>} />
          </div>
        </div>

        {inlineCompose}
      </div>
    </div>
  );
}

/** Shown while a message loads; cancelling abandons the request. */
export function MailReaderLoading({ onCancel }: { onCancel: () => void }) {
  return <div role="status" className="fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-md border bg-card p-3 shadow-lg"><Loader2 className="h-4 w-4 animate-spin" />Loading email…<Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button></div>;
}
