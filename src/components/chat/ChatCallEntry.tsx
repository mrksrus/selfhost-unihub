import { PhoneIncoming, PhoneMissed, PhoneOutgoing } from 'lucide-react';
import type { ChatPeer, ChatThreadCall } from '@/lib/chat/types';
import { cn } from '@/lib/utils';
import { CallButton } from '@/components/chat/CallButton';
import { callEntryLine, messageTime } from '@/components/chat/chat-state';

/**
 * A call's line in the chat, on the caller's side like a message: how it
 * ended, who called and when, and "Call back". The server wrote it; nobody
 * edits or deletes it, and it has no delivery state.
 */
export function ChatCallEntry({ item, peer, conversationId }: { item: ChatThreadCall; peer: ChatPeer; conversationId: string }) {
  const { call, from_me: mine } = item;
  const missed = !mine && (call.outcome === 'missed' || call.outcome === 'cancelled' || call.outcome === 'busy');
  const Icon = missed ? PhoneMissed : mine ? PhoneOutgoing : PhoneIncoming;
  return (
    <li id={`chat-message-${item.id}`} className={cn('flex py-1.5', mine ? 'justify-end' : 'justify-start')}>
      <div className="flex max-w-full items-center gap-3 rounded-2xl border border-border py-1.5 pl-3 pr-1.5 text-sm">
        <Icon aria-hidden="true" className={cn('h-4 w-4 shrink-0', missed ? 'text-destructive' : 'text-muted-foreground')} />
        <div className="min-w-0">
          <p className="font-medium">{callEntryLine(call, mine)}</p>
          <p className="truncate text-xs text-muted-foreground">{mine ? 'You called' : `${peer.name} called`}, <time dateTime={call.started_at} className="tabular-nums">{messageTime(call.started_at)}</time></p>
        </div>
        <CallButton quiet person={peer} conversationId={conversationId} label="Call back" className="shrink-0 text-accent" />
      </div>
    </li>
  );
}
