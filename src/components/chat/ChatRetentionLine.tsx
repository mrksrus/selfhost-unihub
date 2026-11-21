import { formatDayTime } from '@/components/admin/person-words';
import type { ChatConversationSummary } from '@/lib/chat/types';

/**
 * Under a chat's header while its messages are not kept for good: what is
 * deleted here, and during the 24 hours after the time got shorter, from
 * when. A chat follows the shortest time among its members, so the line is
 * the only place that says which time holds in this chat.
 */
export function ChatRetentionLine({ conversation: { retention_days: days, retention_from: from } }: { conversation: Pick<ChatConversationSummary, 'retention_days' | 'retention_from'> }) {
  if (!days) return null;
  const waits = !!from && Date.parse(from) > Date.now();
  return (
    <p className="shrink-0 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
      {waits ? <><span className="font-medium text-foreground">From {formatDayTime(from)}</span>, messages</> : 'Messages'} older than {days} days are deleted here
    </p>
  );
}
