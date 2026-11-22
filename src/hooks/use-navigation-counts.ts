import { useAuth } from '@/contexts/useAuth';
import { useModules, type PageId } from '@/hooks/use-modules';
import { useMailUnreadCounts } from '@/hooks/use-mail-queries';
import { useChatEngine } from '@/hooks/use-chat-engine';
import { useChatSnapshot } from '@/components/chat/chat-state';
import { isOfflineMode } from '@/lib/offline';

/** Chat is not on this device yet: its navigation entry carries a quiet mark, and no count. */
export const useChatWaiting = () => useChatSnapshot(useChatEngine())?.readiness.state === 'waiting';

/** Small counts next to navigation entries: unread inbox mail and unread chat messages. */
export function useNavigationCounts(): Partial<Record<PageId, number>> {
  const { user, isOffline } = useAuth();
  const { isEnabled } = useModules();
  // Same query as the combined mail view, so both share one cached answer.
  const mail = useMailUnreadCounts(user && !isOffline && !isOfflineMode() && isEnabled('mail') ? 'all' : null);
  // The engine exists only for a signed-in person with Chat on.
  const chat = useChatSnapshot(useChatEngine());
  // A device that is not in Chat shows no count, also not one it held before it had to wait.
  const unread = chat?.readiness.state === 'waiting' ? 0 : chat?.conversations.reduce((sum, conversation) => sum + conversation.unread, 0);
  return { mail: mail.data?.unreadByFolder?.inbox ?? 0, chat: unread ?? 0 };
}
