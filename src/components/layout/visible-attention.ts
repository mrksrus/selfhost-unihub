import { useMemo } from 'react';
import { useAttentionItems, type AttentionItem } from '@/hooks/use-attention';
import { moduleForPath } from '@/hooks/use-modules';
import { useAppLock } from '@/hooks/use-app-lock';

/**
 * The attention items a locked device may show: an entry resolved on a locked
 * module's page (a mail address, a sync error) waits behind the lock with the
 * page itself. Entries of the app (an update) stay. One filter for the rail's
 * tray, the dot on More and the More page.
 */
export function useVisibleAttention(): AttentionItem[] {
  const items = useAttentionItems();
  const lock = useAppLock();
  return useMemo(() => items.filter(item => {
    const moduleId = item.href ? moduleForPath(item.href) : undefined;
    return !moduleId || !lock.locked(moduleId);
  }), [items, lock]);
}
