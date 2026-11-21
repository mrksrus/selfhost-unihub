import { Link } from 'react-router-dom';
import { Users } from 'lucide-react';
import type { ChatConversationSummary } from '@/lib/chat/types';
import { cn } from '@/lib/utils';
import { chatHref, lastMessageLine, listTime } from '@/components/chat/chat-state';

/**
 * The person's initials in a circle (a dash for a deleted person, people for
 * a group chat); a dot while they have UniHub open (shown only when the
 * engine says so). `small` beside a message.
 */
export function PeerAvatar({ peer, group = false, small = false, className }: { peer: { name: string; user_id?: string | null; online?: boolean | null }; group?: boolean; small?: boolean; className?: string }) {
  const initials = peer.user_id === null ? '' : peer.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
  return (
    <span aria-hidden="true" className={cn('relative shrink-0', className)}>
      <span className={cn('flex select-none items-center justify-center rounded-full bg-muted font-medium text-muted-foreground', small ? 'h-7 w-7 text-[10px]' : 'h-9 w-9 text-xs touch:h-10 touch:w-10')}>
        {group ? <Users className="h-4 w-4" /> : initials || '–'}
      </span>
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
              <PeerAvatar peer={peer} group={!!conversation.group} />
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
                    {conversation.mentioned && <><span aria-hidden="true" className="shrink-0 text-xs font-semibold text-accent">@</span><span className="sr-only">, mentions you</span></>}
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
