import { useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import { UserPlus } from 'lucide-react';
import type { ChatConversationSummary, ChatEngine, ChatMember } from '@/lib/chat/types';
import { AuthContext } from '@/contexts/auth-context';
import { useToast } from '@/hooks/use-toast';
import { useSessionScope } from '@/lib/session-scope';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { PeerAvatar } from '@/components/chat/ConversationList';
import { AddPeopleDialog } from '@/components/chat/NewGroupDialog';

interface Props {
  engine: ChatEngine;
  conversation: ChatConversationSummary;
  /** null while they load, and after a load that failed. */
  members: ChatMember[] | null;
  open: boolean;
  onClose: () => void;
}

interface Question { title: string; description: string; action: string; failed: string; run: () => Promise<unknown> }

/**
 * A group chat's people and what can be done with it: a manager renames it
 * and adds or removes people, anyone leaves. A chat that follows an
 * organisation group changes with the group, so there it says why nobody is
 * added, removed or leaves, and its manager can stop following.
 */
export function ChatPeople({ engine, conversation, members, open, onClose }: Props) {
  const group = conversation.group!;
  const ownId = useContext(AuthContext)?.user?.id;
  const scope = useSessionScope();
  const { toast } = useToast();
  const [name, setName] = useState(conversation.name);
  // Someone else may have renamed the chat since the panel was last open.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) setName(conversation.name); }, [open]);
  const [adding, setAdding] = useState(false);
  const [asking, setAsking] = useState<Question | null>(null);
  // The question stays in the dialog while it closes.
  const asked = useRef(asking);
  if (asking) asked.current = asking;
  const panel = useRef<HTMLDivElement>(null);
  // What opened the panel gets the focus back when it closes.
  const opener = useRef<HTMLElement | null>(null);
  // The button that asked: the focus returns to it, or to the panel when the answer removed it (a removed person's row).
  const asker = useRef<HTMLElement | null>(null);
  const ask = (question: Question) => { asker.current = document.activeElement as HTMLElement | null; setAsking(question); };
  const [busy, setBusy] = useState(false);
  // The engine does not say that loading failed: after a while the wait is offered again.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (members || !open || slow) return;
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [members, open, slow]);

  const manager = group.role === 'manager';
  const follows = group.follows && (group.follows.kind === 'everyone' ? 'everyone on this server' : `the group ${group.follows.name}`);
  const act = async ({ run, failed }: Pick<Question, 'run' | 'failed'>) => {
    setBusy(true);
    try { await run(); } catch (error) {
      // The server's refusal, for example that only a manager does this.
      if (!scope.ended) toast({ title: failed, description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    } finally { setBusy(false); setAsking(null); }
  };
  const rename = (event: FormEvent) => {
    event.preventDefault();
    void act({ run: () => engine.rename(conversation.id, name.trim()), failed: 'Could not rename the chat' });
  };
  const remove = (member: ChatMember) => ask({
    title: `Remove ${member.name} from ${conversation.name}?`, action: 'Remove', failed: `Could not remove ${member.name}`,
    description: `${member.name} reads nothing written from now on, and the chat goes from their devices when they next open UniHub. They keep nothing in UniHub. A copy they made elsewhere cannot be taken back.`,
    run: () => engine.removeMember(conversation.id, member.user_id),
  });
  const leave = () => ask({
    title: `Leave ${conversation.name}?`, action: 'Leave chat', failed: 'Could not leave the chat',
    description: 'You read nothing written from now on, and the chat with its messages goes from your devices. If a manager adds you again, you read only what is written after that.',
    // The page goes back to the list once the chat is gone from it.
    run: () => engine.leave(conversation.id),
  });
  const unfollow = () => ask({
    title: `Stop following ${follows}?`, action: 'Stop following', failed: 'Could not stop following',
    description: 'The chat keeps the people it has now. From then on its managers add and remove people, and anyone can leave.',
    run: () => engine.unfollow(conversation.id),
  });

  return (
    <Sheet open={open} onOpenChange={next => { if (!next) onClose(); }}>
      {/* The focus goes to the panel, not into the name field: on a phone that would open the keyboard over the people. */}
      <SheetContent ref={panel} className="flex w-full flex-col gap-0 p-0 sm:max-w-sm" onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus(); }}
        onOpenAutoFocus={event => { opener.current = document.activeElement as HTMLElement | null; event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}>
        <SheetHeader className="shrink-0 space-y-1 border-b border-border py-3 pl-4 pr-12 text-left">
          <SheetTitle className="truncate text-base">{conversation.name}</SheetTitle>
          <SheetDescription>{group.member_count} {group.member_count === 1 ? 'person' : 'people'}{follows && `, follows ${follows}`}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
          {manager && (
            <form onSubmit={rename} className="space-y-2">
              <Label htmlFor="chat-name">Name</Label>
              <div className="flex items-center gap-2">
                <Input id="chat-name" autoComplete="off" maxLength={80} value={name} onChange={event => setName(event.target.value)} />
                <Button type="submit" variant="outline" className="shrink-0" disabled={busy || !name.trim() || name.trim() === conversation.name}>Rename</Button>
              </div>
            </form>
          )}
          <section aria-labelledby="chat-people-heading">
            <div className="flex min-h-9 items-center justify-between gap-3">
              <h3 id="chat-people-heading" className="text-sm font-medium">People</h3>
              {manager && !follows && <Button variant="outline" size="sm" disabled={!members} onClick={() => setAdding(true)}><UserPlus aria-hidden="true" />Add people</Button>}
            </div>
            {members ? (
              <ul aria-labelledby="chat-people-heading" className="mt-1 divide-y divide-border">
                {members.map(member => (
                  <li key={member.user_id} className="flex items-center gap-3 py-2">
                    <PeerAvatar peer={member} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{member.name}{member.user_id === ownId && ' (you)'}{member.online && <span className="sr-only">, online</span>}</span>
                      {/* Why their devices are not in the chat yet, in the server's words. */}
                      <span className="block text-xs text-muted-foreground">{[member.role === 'manager' && 'Manager', member.reason].filter(Boolean).join('. ')}</span>
                    </span>
                    {manager && !follows && member.user_id !== ownId && (
                      <Button variant="outline" size="sm" className="shrink-0" disabled={busy} aria-label={`Remove ${member.name}`} onClick={() => remove(member)}>Remove</Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : slow ? <ErrorState title="Could not load the people" error="The server did not answer." onRetry={() => { setSlow(false); engine.members(conversation.id); }} />
              : <LoadingState compact label="Loading the people…" />}
          </section>
          {follows ? (
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>This chat follows {follows}: whoever joins there joins the chat, and whoever leaves there leaves it. So nobody is added or removed here, and nobody leaves.</p>
              {manager && <Button variant="outline" disabled={busy} onClick={unfollow}>Stop following</Button>}
            </div>
          ) : <Button variant="outline" className="text-destructive hover:text-destructive" disabled={busy} onClick={leave}>Leave chat</Button>}
        </div>
        {adding && members && <AddPeopleDialog engine={engine} conversationId={conversation.id} chatName={conversation.name} already={members.map(member => member.user_id)} retentionDays={conversation.retention_days} onClose={() => setAdding(false)} />}
        <AlertDialog open={!!asking} onOpenChange={next => { if (!next && !busy) setAsking(null); }}>
          <AlertDialogContent onCloseAutoFocus={event => { event.preventDefault(); (asker.current?.isConnected ? asker.current : panel.current)?.focus(); }}>
            <AlertDialogHeader>
              <AlertDialogTitle>{asked.current?.title}</AlertDialogTitle>
              <AlertDialogDescription>{asked.current?.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); if (asking) void act(asking); }}>{asked.current?.action}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
