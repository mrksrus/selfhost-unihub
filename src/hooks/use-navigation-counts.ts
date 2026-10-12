import { useAuth } from '@/contexts/useAuth';
import { useModules, type PageId } from '@/hooks/use-modules';
import { useMailUnreadCounts } from '@/hooks/use-mail-queries';
import { isOfflineMode } from '@/lib/offline';

/** Small counts next to navigation entries. Only unread inbox mail for now. */
export function useNavigationCounts(): Partial<Record<PageId, number>> {
  const { user, isOffline } = useAuth();
  const { isEnabled } = useModules();
  // Same query as the combined mail view, so both share one cached answer.
  const mail = useMailUnreadCounts(user && !isOffline && !isOfflineMode() && isEnabled('mail') ? 'all' : null);
  return { mail: mail.data?.unreadByFolder?.inbox ?? 0 };
}
