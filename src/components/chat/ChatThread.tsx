import { Fragment, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AtSign, Bell, BellOff, MonitorSmartphone, ArrowLeft, Users } from 'lucide-react';
import type { ChatConversationSummary, ChatEngine, ChatFileToSend, ChatNotify, ChatThreadFile, ChatThreadMessage } from '@/lib/chat/types';
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState, LoadingState } from '@/components/ui/page-states';
import { ChatComposer, type ComposerMode } from '@/components/chat/ChatComposer';
import { ChatFileViewer } from '@/components/chat/ChatFileViewer';
import { ChatMessage } from '@/components/chat/ChatMessage';
import { ChatPeople } from '@/components/chat/ChatPeople';
import { ChatRetentionLine } from '@/components/chat/ChatRetentionLine';
import { PeerAvatar } from '@/components/chat/ConversationList';
import { dayLabel, deliveryLabel, useChatMembers, useChatThread } from '@/components/chat/chat-state';

// Messages drawn at once; "Show earlier messages" adds as many again.
const PAGE = 200;

// What a chat notifies its reader of; the unread count shows every message either way.
const NOTIFY = { all: { label: 'All messages', icon: Bell }, mentions: { label: 'Mentions only', icon: AtSign }, none: { label: 'Nothing', icon: BellOff } } as const;

interface Props {
  engine: ChatEngine;
  conversation: ChatConversationSummary;
  draft: string;
  onDraft: (text: string) => void;
}

/**
 * One conversation: who it is with (a group chat: its name and people),
 * its messages by day, and the composer.
 * On a phone it takes the visible area above the keyboard, over the page's
 * header and the bottom bar, as the mail composer does.
 */
export function ChatThread({ engine, conversation, draft, onDraft }: Props) {
  const { peer, group } = conversation;
  const items = useChatThread(engine, conversation.id);
  // Asked for as the thread opens: the engine marks a former colleague, and a group message's readers, only once it has the people.
  const members = useChatMembers(engine, conversation.id);
  const [people, setPeople] = useState(false);
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
  // Files dropped on the thread go to the composer.
  const attach = useRef<(files: File[]) => void>(() => undefined);
  const [dragging, setDragging] = useState(false);
  const [viewing, setViewing] = useState<{ messageId: string; file: ChatThreadFile } | null>(null);

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

  // A search result opens the chat at its message ("m" in the address): earlier messages are drawn as far back as it, and it is outlined for a moment.
  const location = useLocation();
  const target = new URLSearchParams(location.search).get('m');
  const [found, setFound] = useState<{ id: string } | null>(null);
  const targetAt = target && items ? items.findIndex(item => item.id === target) : -1;
  useEffect(() => {
    if (targetAt < 0) return;
    setShown(now => Math.max(now, Math.ceil((items!.length - targetAt) / PAGE) * PAGE));
    setFound({ id: target! });
    // Once per opening, and once the device holds the message; not whenever a message arrives, since the person may have scrolled on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, location.key, targetAt >= 0]);
  useEffect(() => {
    if (!found) return;
    document.getElementById(`chat-message-${found.id}`)?.scrollIntoView({ block: 'center' });
    // Set here, after the scroll: the chat's own scroll to its end may still report itself and would otherwise send the next update back there.
    atEnd.current = false;
    const timer = setTimeout(() => setFound(null), 2500);
    return () => clearTimeout(timer);
  }, [found]);

  const choose = (next: ComposerMode) => { setMode(next); focusField.current = true; };
  const send = (text: string, mentions: string[], files: ChatFileToSend[]) => {
    try {
      if (mode?.kind === 'edit') engine.edit(mode.message.id, text);
      else engine.send(conversation.id, text, mode?.message.id ?? null, ...((files.length ? [mentions, files] : mentions.length ? [mentions] : []) as [string[]?, ChatFileToSend[]?]));
    } catch (error) {
      // The message was deleted meanwhile, on another device or by the time the change was typed.
      toast({ title: mode?.kind === 'edit' ? 'The change was not saved' : 'The message was not sent', description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    }
    setMode(null);
    atEnd.current = true;
  };
  const notify = (next: string) => {
    engine.setNotify(conversation.id, next as ChatNotify).catch((error: unknown) => {
      if (!scope.ended) toast({ title: 'Could not change the notifications', description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    });
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
  // Read (by so many), delivered and sent each reach up to one message: only the last of each says so.
  const left = visible.filter((item): item is ChatThreadMessage => item.kind === 'message' && !item.deleted && (item.delivery === 'sent' || item.delivery === 'delivered' || item.delivery === 'read'));
  const marked = new Set(left.filter((item, index) => deliveryLabel(item) !== (left[index + 1] && deliveryLabel(left[index + 1]))).map(item => item.id));
  const NotifyIcon = NOTIFY[conversation.notify].icon;
  // A file whose message was deleted meanwhile leaves the viewer too.
  const viewed = viewing && items?.some(item => item.kind === 'message' && item.id === viewing.messageId && item.files.some(file => file.id === viewing.file.id)) ? viewing : null;

  return (
    <section aria-label={`Chat with ${peer.name}`} className={phone ? 'fixed inset-x-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top,0px)]' : 'relative flex min-h-0 min-w-0 flex-1 flex-col'}
      style={phone ? { top: 'var(--visible-top, 0px)', height: 'var(--visible-height, 100dvh)' } : undefined}
      onDragOver={event => { if (peer.can_write && event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { setDragging(false); if (!peer.can_write || !event.dataTransfer.files.length) return; event.preventDefault(); attach.current([...event.dataTransfer.files]); field.current?.focus(); }}>
      {dragging && <p aria-hidden="true" className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-background/90 text-sm font-medium">Drop the files to attach them</p>}
      {/* As high as its lines need: a chat can say more under its name. */}
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-2 py-1.5 lg:px-4">
        <Button asChild variant="ghost" size="icon" className="lg:hidden"><Link to="/chat" aria-label="Back to chats"><ArrowLeft aria-hidden="true" /></Link></Button>
        <PeerAvatar peer={peer} group={!!group} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{peer.name}</h2>
          {group ? <p className="truncate text-xs text-muted-foreground">{group.member_count} {group.member_count === 1 ? 'person' : 'people'}{group.follows && `, follows ${group.follows.kind === 'everyone' ? 'everyone' : group.follows.name}`}</p>
            : peer.online && <p className="text-xs text-muted-foreground">Online</p>}
        </div>
        <div className="flex shrink-0 items-center touch:gap-1">
          {group && <Button variant="ghost" size="icon" aria-label="People in this chat" onClick={() => setPeople(true)}><Users aria-hidden="true" /></Button>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`Notifications: ${NOTIFY[conversation.notify].label}`}><NotifyIcon aria-hidden="true" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Notify me of</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={conversation.notify} onValueChange={notify}>
                {(group ? ['all', 'mentions', 'none'] as const : ['all', 'none'] as const).map(value => <DropdownMenuRadioItem key={value} value={value}>{NOTIFY[value].label}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {conversation.catching_up && <p role="status" className="shrink-0 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">Catching up on the messages since you were last here…</p>}
      <ChatRetentionLine conversation={conversation} />

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-3 md:px-4"
        onScroll={event => { const box = event.currentTarget; atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48; }}>
        {items === null ? <LoadingState label="Loading messages…" />
          : items.length === 0 ? <EmptyState title="No messages yet" description={group ? (group.added_by ? `You were added by ${group.added_by}. Messages appear from now on.` : 'Only the people in this chat can read what is written here.')
            : peer.can_write ? `Only you and ${peer.name} can read what you write here.` : undefined} />
          : (
            <>
              {items.length > shown && <div className="pb-3 text-center"><Button variant="outline" size="sm" onClick={() => setShown(shown + PAGE)}>Show earlier messages</Button></div>}
              <ol aria-label={`Messages with ${peer.name}`} className="mx-auto max-w-3xl">
                {visible.map((item, index) => {
                  const day = new Date(item.created_at).toDateString();
                  const before = visible[index - 1];
                  const newDay = !before || day !== new Date(before.created_at).toDateString();
                  const sameSender = before?.kind === 'message' && item.kind === 'message' && before.sender_user_id === item.sender_user_id && before.sender_name === item.sender_name;
                  return (
                    <Fragment key={item.id}>
                      {newDay && (
                        <li className="py-3 text-center text-xs text-muted-foreground">{dayLabel(item.created_at)}</li>
                      )}
                      {item.kind !== 'message' ? (
                        <li className="flex items-center justify-center gap-1.5 py-2 text-center text-xs text-muted-foreground">
                          {item.kind === 'device-added' && <MonitorSmartphone aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
                          {item.user_id && item.user_id === user?.id ? 'You' : item.name} {{ 'device-added': 'added a device', joined: 'joined the chat', left: 'left the chat' }[item.kind]}
                        </li>
                      ) : (
                        <ChatMessage engine={engine} message={item} found={found?.id === item.id} onOpenFile={file => setViewing({ messageId: item.id, file })} turn={before?.kind === 'message' && !sameSender} named={(!!group || item.former_colleague) && (!sameSender || newDay)} avatar={!!group}
                          mentions={item.mentions.length ? members?.filter(member => item.mentions.includes(member.user_id)).map(member => ({ name: member.name, me: member.user_id === user?.id })) : undefined}
                          showDelivery={marked.has(item.id)} canWrite={peer.can_write} deleteLock={deleteLock} quotedOwn={!!item.reply_to && own.has(item.reply_to.id)}
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
        ? <ChatComposer peerName={peer.name} mode={mode} draft={draft} people={group ? members?.filter(member => member.active && member.user_id !== user?.id) : undefined} onDraft={onDraft} onSend={send} onCancel={() => setMode(null)} fieldRef={field} attachRef={attach} />
        // The server's words: the person is deactivated, has Chat off, has not set up Chat yet or is not signed in to Chat on any device.
        : <p className="shrink-0 border-t border-border px-4 py-3 text-sm text-muted-foreground max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">{peer.reason ?? `${peer.name} cannot be written to now.`}</p>}

      <AlertDialog open={!!deleting} onOpenChange={open => { if (!open) setDeleting(null); }}>
        <AlertDialogContent onCloseAutoFocus={focusAfterClose}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this message?</AlertDialogTitle>
            <AlertDialogDescription>It is deleted for {group ? 'everyone in this chat' : `you and for ${peer.name}`}, with its earlier versions. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => { if (deleting) void remove(deleting); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ChatFileViewer engine={engine} open={viewed} onClose={() => setViewing(null)} />
      {group && <ChatPeople engine={engine} conversation={conversation} members={members} open={people} onClose={() => setPeople(false)} />}
    </section>
  );
}
