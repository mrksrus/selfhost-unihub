import { Link } from 'react-router-dom';
import type { ChatConversationSummary, ChatPeer } from '@/lib/chat/types';
import { cn } from '@/lib/utils';
import { chatHref, lastMessageLine, listTime } from '@/components/chat/chat-state';

/** The person's initials in a circle; a dot while they have UniHub open (shown only when the engine says so). */
export function PeerAvatar({ peer }: { peer: ChatPeer }) {
  const initials = peer.user_id ? peer.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase() : '';
  return (
    <span aria-hidden="true" className="relative shrink-0">
      <span className="flex h-9 w-9 select-none items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground touch:h-10 touch:w-10">{initials || '–'}</span>
      {peer.online && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-success ring-2 ring-background" />}
    </span>
  );
}

/** The person's conversations as rows, the latest activity first (the engine's order). */
export function ConversationList({ conversations, activeId }: { conversations: ChatConversationSummary[]; activeId: string | null }) {
  return (
    <ul aria-label="Chats" className="p-2">
      {conversations.map(conversation => {
        const { peer, unread } = conversation;
        const active = conversation.id === activeId;
        return (
          <li key={conversation.id}>
            <Link to={chatHref(conversation.id)} aria-current={active ? 'page' : undefined}
              className={cn('flex items-center gap-3 rounded-md px-2 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring touch:py-2.5',
                active ? 'bg-muted' : 'hover:bg-muted/50')}>
              <PeerAvatar peer={peer} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className={cn('min-w-0 flex-1 truncate text-sm', unread ? 'font-semibold' : 'font-medium')}>
                    {peer.name}{peer.online && <span className="sr-only">, online</span>}
                  </span>
                  {conversation.last_activity_at && (
                    <time dateTime={conversation.last_activity_at} className="shrink-0 text-xs tabular-nums text-muted-foreground">{listTime(conversation.last_activity_at)}</time>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <span className={cn('min-w-0 flex-1 truncate text-xs', unread ? 'text-foreground' : 'text-muted-foreground')}>{lastMessageLine(conversation)}</span>
                  {unread > 0 && <>
                    <span aria-hidden="true" className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums text-accent-foreground">{unread > 99 ? '99+' : unread}</span>
                    <span className="sr-only">, {unread} unread</span>
                  </>}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
