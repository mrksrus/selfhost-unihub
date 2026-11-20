import { Fragment, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, MonitorSmartphone } from 'lucide-react';
import type { ChatConversationSummary, ChatEngine, ChatThreadMessage } from '@/lib/chat/types';
import { AuthContext } from '@/contexts/auth-context';
import { useIsMobile } from '@/hooks/use-mobile';
import { usePolicy } from '@/hooks/use-policies';
import { useToast } from '@/hooks/use-toast';
import { useSessionScope } from '@/lib/session-scope';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { EmptyState, LoadingState } from '@/components/ui/page-states';
import { ChatComposer, type ComposerMode } from '@/components/chat/ChatComposer';
import { ChatMessage } from '@/components/chat/ChatMessage';
import { PeerAvatar } from '@/components/chat/ConversationList';
import { dayLabel, useChatThread } from '@/components/chat/chat-state';

// Messages drawn at once; "Show earlier messages" adds as many again.
const PAGE = 200;

interface Props {
  engine: ChatEngine;
  conversation: ChatConversationSummary;
  draft: string;
  onDraft: (text: string) => void;
}

/**
 * One conversation: who it is with, its messages by day, and the composer.
 * On a phone it takes the visible area above the keyboard, over the page's
 * header and the bottom bar, as the mail composer does.
 */
export function ChatThread({ engine, conversation, draft, onDraft }: Props) {
  const { peer } = conversation;
  const items = useChatThread(engine, conversation.id);
  const phone = useIsMobile();
  // The session where one is mounted; a thread rendered on its own has none.
  const user = useContext(AuthContext)?.user;
  const deleteLock = usePolicy('bin.delete').lock;
  const scope = useSessionScope();
  const { toast } = useToast();
  const [mode, setMode] = useState<ComposerMode>(null);
  const [deleting, setDeleting] = useState<ChatThreadMessage | null>(null);
  const [shown, setShown] = useState(PAGE);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // Stays at the newest message unless the person scrolled up to read.
  const atEnd = useRef(true);
  const focusField = useRef(false);

  const toEnd = useRef(() => { const box = scroller.current; if (box && atEnd.current) box.scrollTop = box.scrollHeight; }).current;
  useLayoutEffect(() => toEnd(), [items, toEnd]);
  // The keyboard opening makes the list shorter: the newest message stays in view.
  useEffect(() => {
    if (!scroller.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(toEnd);
    observer.observe(scroller.current);
    return () => observer.disconnect();
  }, [toEnd]);

  // Read means seen: only while the messages are drawn and the page is in front.
  const loaded = items !== null;
  useEffect(() => {
    const mark = () => { if (loaded && conversation.unread > 0 && document.visibilityState === 'visible') engine.markRead(conversation.id); };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [engine, conversation.id, conversation.unread, loaded]);

  const choose = (next: ComposerMode) => { setMode(next); focusField.current = true; };
  const send = (text: string) => {
    try {
      if (mode?.kind === 'edit') engine.edit(mode.message.id, text);
      else engine.send(conversation.id, text, mode?.message.id ?? null);
    } catch (error) {
      // The message was deleted meanwhile, on another device or by the time the change was typed.
      toast({ title: mode?.kind === 'edit' ? 'The change was not saved' : 'The message was not sent', description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    }
    setMode(null);
    atEnd.current = true;
  };
  const remove = async (message: ChatThreadMessage) => {
    focusField.current = true;
    try { await engine.delete(message.id); }
    catch (error) {
      // The server's refusal, for example the rule against deleting for good.
      if (!scope.ended) toast({ title: 'Could not delete the message', description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    }
  };
  // After Reply, Edit and a confirmed Delete the writing goes on: the focus moves to the composer, not back to the menu.
  const focusAfterClose = (event: Event) => {
    if (!focusField.current) return;
    focusField.current = false;
    if (field.current) { event.preventDefault(); field.current.focus(); }
  };

  const visible = items?.slice(-shown) ?? [];
  // A quote names its writer; one's own messages read "You".
  const own = new Set(items?.filter(item => item.kind === 'message' && item.from_me).map(item => item.id));
  // Read, delivered and sent each reach up to one message: only the last of each says so.
  const left = visible.filter((item): item is ChatThreadMessage => item.kind === 'message' && !item.deleted && (item.delivery === 'sent' || item.delivery === 'delivered' || item.delivery === 'read'));
  const marked = new Set(left.filter((item, index) => item.delivery !== left[index + 1]?.delivery).map(item => item.id));

  return (
    <section aria-label={`Chat with ${peer.name}`} className={phone ? 'fixed inset-x-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top,0px)]' : 'flex min-h-0 min-w-0 flex-1 flex-col'}
      style={phone ? { top: 'var(--visible-top, 0px)', height: 'var(--visible-height, 100dvh)' } : undefined}>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-2 lg:px-4">
        <Button asChild variant="ghost" size="icon" className="lg:hidden"><Link to="/chat" aria-label="Back to chats"><ArrowLeft aria-hidden="true" /></Link></Button>
        <PeerAvatar peer={peer} />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{peer.name}</h2>
          {peer.online && <p className="text-xs text-muted-foreground">Online</p>}
        </div>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-3 md:px-4"
        onScroll={event => { const box = event.currentTarget; atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48; }}>
        {items === null ? <LoadingState label="Loading messages…" />
          : items.length === 0 ? <EmptyState title="No messages yet" description={peer.can_write ? `Only you and ${peer.name} can read what you write here.` : undefined} />
          : (
            <>
              {items.length > shown && <div className="pb-3 text-center"><Button variant="outline" size="sm" onClick={() => setShown(shown + PAGE)}>Show earlier messages</Button></div>}
              <ol aria-label={`Messages with ${peer.name}`} className="mx-auto max-w-3xl">
                {visible.map((item, index) => {
                  const day = new Date(item.created_at).toDateString();
                  const before = visible[index - 1];
                  return (
                    <Fragment key={item.id}>
                      {(!before || day !== new Date(before.created_at).toDateString()) && (
                        <li className="py-3 text-center text-xs text-muted-foreground">{dayLabel(item.created_at)}</li>
                      )}
                      {item.kind === 'device-added' ? (
                        <li className="flex items-center justify-center gap-1.5 py-2 text-center text-xs text-muted-foreground">
                          <MonitorSmartphone aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />{item.user_id && item.user_id === user?.id ? 'You' : item.name} added a device
                        </li>
                      ) : (
                        <ChatMessage message={item} turn={before?.kind === 'message' && before.from_me !== item.from_me} showDelivery={marked.has(item.id)} canWrite={peer.can_write} deleteLock={deleteLock} quotedOwn={!!item.reply_to && own.has(item.reply_to.id)}
                          onReply={() => choose({ kind: 'reply', message: item })} onEdit={() => choose({ kind: 'edit', message: item })}
                          onDelete={() => (item.seq === null ? void remove(item) : setDeleting(item))} onRetry={() => engine.retry(item.id)} onMenuCloseAutoFocus={focusAfterClose} />
                      )}
                    </Fragment>
                  );
                })}
              </ol>
            </>
          )}
      </div>

      {peer.can_write
        ? <ChatComposer peerName={peer.name} mode={mode} draft={draft} onDraft={onDraft} onSend={send} onCancel={() => setMode(null)} fieldRef={field} />
        // The server's words: the person is deactivated, has Chat off, or has not opened UniHub since the update.
        : <p className="shrink-0 border-t border-border px-4 py-3 text-sm text-muted-foreground max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">{peer.reason ?? `${peer.name} cannot be written to now.`}</p>}

      <AlertDialog open={!!deleting} onOpenChange={open => { if (!open) setDeleting(null); }}>
        <AlertDialogContent onCloseAutoFocus={focusAfterClose}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this message?</AlertDialogTitle>
            <AlertDialogDescription>It is deleted for you and for {peer.name}, with its earlier versions. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => { if (deleting) void remove(deleting); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
