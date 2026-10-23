import { useSyncExternalStore } from 'react';
import { onAppEvent } from '@/lib/app-events';
import { isOfflineMode } from '@/lib/offline';
import { isOnline, onConnectivityChange } from '@/lib/platform';

const subscribe = (notify: () => void) => {
  const stops = [onAppEvent('unihub:offline-mode', notify), onConnectivityChange(notify)];
  return () => stops.forEach(stop => stop());
};

/** True while changes cannot be made: offline reading mode, or no connection. Actions that write are disabled then. */
export function useOfflineReadOnly() {
  return useSyncExternalStore(subscribe, () => isOfflineMode() || !isOnline(), () => false);
}
