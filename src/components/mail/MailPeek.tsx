import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, ExternalLink, Forward, Mail, Minimize2, Reply, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { Email } from '@/lib/mail-api';
import { emailPath } from '@/lib/email-tasks';
import { closeMailPeek, dockMailPeek, expandMailPeek, guardMailPeek, useMailPeek } from '@/lib/mail-peek';
import { cn } from '@/lib/utils';
import { useAuth, useUserTimezone } from '@/contexts/useAuth';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMailCompose } from '@/hooks/use-mail-compose';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { MailMessageView } from '@/components/mail/MailMessageView';
import { MailComposeDialogs, MailInlineCompose } from '@/components/mail/MailCompose';

const DOCK_DRAG_PX = 90;

/**
 * An email shown over the current page, for a task or event that came from
 * it. It does not take the page away: on wide windows it is a column on the
 * right, on phones a sheet from the bottom. "Set aside" (or dragging the sheet
 * down) shrinks it to a small bar so the page can be used, and brings it back
 * with a reply still in progress. Mounted once in the app layout.
 */
export function MailPeek() {
  const { emailId, docked } = useMailPeek();
  const userId = useAuth().user?.id;
  // Another account signs in: whatever was open belonged to the previous one.
  useEffect(() => () => closeMailPeek(), [userId]);
  if (!emailId) return null;
  return <MailPeekPanel key={emailId} emailId={emailId} docked={docked} />;
}

function MailPeekPanel({ emailId, docked }: { emailId: string; docked: boolean }) {
  const phone = useIsMobile();
  const navigate = useNavigate();
  const timezone = useUserTimezone();
  const query = useQuery({
    queryKey: ['emails', 'peek', emailId],
    queryFn: async ({ signal }) => {
      const response = await api.get<{ email: Email }>(`/mail/emails/${encodeURIComponent(emailId)}`, { signal });
      if (response.error || !response.data?.email) throw new Error(response.error || 'Could not load the email');
      return response.data.email;
    },
  });
  const email = query.data;
  const accountId = email?.mail_account_id ?? null;
  // The peek has its own reply editor; it never changes which account the Mail page shows.
  const compose = useMailCompose({ activeMailAccountId: accountId, selectedAccount: accountId, isMobile: false });
  const writing = compose.isReplying;

  // Phones: drag the sheet down to set it aside.
  const [drag, setDrag] = useState<{ start: number; offset: number } | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const dragStart = (event: PointerEvent<HTMLDivElement>) => {
    if (!phone || event.pointerType === 'mouse') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ start: event.clientY, offset: 0 });
  };
  const dragMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag) setDrag({ ...drag, offset: Math.max(0, event.clientY - drag.start) });
  };
  const dragEnd = () => {
    if (!drag) return;
    const dock = drag.offset > DOCK_DRAG_PX;
    setDrag(null);
    if (dock) dockMailPeek();
  };

  // Leaving this email with an unsaved reply asks to save or discard it first,
  // as the Mail page does; the next step runs once the reply has closed.
  const afterReply = useRef<(() => void) | null>(null);
  const leave = (next: () => void) => {
    if (!writing || !compose.isDirty) return false;
    afterReply.current = next;
    expandMailPeek();
    compose.closeComposeFlow();
    return true;
  };
  useEffect(() => {
    if (compose.composeClosePromptOpen || !afterReply.current) return;
    const next = afterReply.current;
    afterReply.current = null;
    // "Keep editing" leaves the reply open, and the step is dropped.
    if (!writing) next();
  }, [compose.composeClosePromptOpen, writing]);
  // Opening another email asks too, instead of replacing this one at once.
  useEffect(() => {
    guardMailPeek(leave);
    return () => guardMailPeek(null);
  });

  const setAside = () => dockMailPeek();
  const close = () => { if (!leave(closeMailPeek)) closeMailPeek(); };
  const mailPath = emailPath({ email_id: emailId });
  const openInMail = (event: MouseEvent) => {
    if (leave(() => { navigate(mailPath); closeMailPeek(); })) event.preventDefault();
    else closeMailPeek();
  };
  const subject = email?.subject || '(No subject)';

  return (
    <>
      <DialogPrimitive.Root open modal={false} onOpenChange={open => { if (!open) (writing ? setAside : close)(); }}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content ref={content} aria-label="Email"
            onInteractOutside={event => event.preventDefault()}
            {...({ inert: docked ? '' : undefined } as object)}
            style={drag ? { transform: `translateY(${drag.offset}px)`, transition: 'none' } : undefined}
            // z-[45]: above the page and the phone's bottom bar (z-40), below dialogs and menus (z-50) opened from it.
            className={cn('fixed z-[45] flex flex-col bg-card shadow-lg outline-none transition-transform duration-200',
              phone
                ? 'inset-x-0 bottom-0 h-[calc(100dvh-2.5rem-env(safe-area-inset-top,0px))] rounded-t-2xl border-t border-border data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom'
                : 'inset-y-0 right-0 w-full max-w-xl border-l border-border data-[state=open]:animate-in data-[state=open]:slide-in-from-right',
              docked && 'invisible')}>
            <DialogPrimitive.Title className="sr-only">Email</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">The email this item came from. Set it aside to keep working on the page.</DialogPrimitive.Description>
            <div className="shrink-0 border-b border-border touch-none" onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd}>
              {phone && <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 rounded-full bg-muted-foreground/40" />}
              <div className="flex h-12 items-center gap-1 px-2">
                <Button variant="ghost" size="icon" aria-label="Set aside" title="Set aside and keep working on the page" onClick={setAside}>
                  {phone ? <ChevronDown aria-hidden="true" /> : <Minimize2 aria-hidden="true" />}
                </Button>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">Email</span>
                <Button variant="ghost" size="sm" disabled={!email} onClick={() => email && compose.startResponse(email, 'reply')}>
                  <Reply aria-hidden="true" /><span className="sr-only sm:not-sr-only">Reply</span>
                </Button>
                <Button variant="ghost" size="sm" disabled={!email} onClick={() => email && compose.startResponse(email, 'forward')}>
                  <Forward aria-hidden="true" /><span className="sr-only sm:not-sr-only">Forward</span>
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <Link to={mailPath} onClick={openInMail} title="Open in Mail">
                    <ExternalLink aria-hidden="true" /><span className="sr-only sm:not-sr-only">Open in Mail</span>
                  </Link>
                </Button>
                <Button variant="ghost" size="icon" aria-label="Close" onClick={close}><X aria-hidden="true" /></Button>
              </div>
            </div>
            {/* On a phone the reply takes the sheet; closing the reply shows the message again. */}
            <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6', phone && writing && 'hidden')}>
              {query.isPending ? <LoadingState label="Loading email…" compact />
                : query.error ? <ErrorState title="Could not load the email" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
                  : email && <MailMessageView email={email} timezone={timezone} compact />}
            </div>
            {writing && <MailInlineCompose compose={compose} fill={phone} />}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {docked && (
        <div role="region" aria-label="Email set aside"
          className={cn('fixed z-40 flex items-center gap-2 rounded-xl border border-border bg-card py-1 pl-3 pr-1 shadow-lg',
            phone ? 'inset-x-3 bottom-[calc(4.25rem+env(safe-area-inset-bottom,0px))]' : 'bottom-4 right-4 w-80')}>
          <button type="button" onClick={() => expandMailPeek()} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md">
            <Mail aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{subject}</span>
            {writing && <span className="shrink-0 text-xs text-muted-foreground">Reply in progress</span>}
            <ChevronUp aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="sr-only">Bring back</span>
          </button>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Close" onClick={close}><X aria-hidden="true" className="h-4 w-4" /></Button>
        </div>
      )}
      <MailComposeDialogs compose={compose} />
    </>
  );
}
