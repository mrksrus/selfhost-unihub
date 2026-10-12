import { useEffect, useState } from 'react';
import { CloudOff } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';
import { emitAppEvent, onAppEvent } from '@/lib/app-events';
import { isOnline, onConnectivityChange } from '@/lib/platform';
import { captureOfflineSave, getOfflineSnapshotInfo, isOfflineMode, saveOfflineSnapshot, type OfflineSnapshot } from '@/lib/offline';
import { Button } from '@/components/ui/button';

const REFRESH_EVERY_MS = 5 * 60_000;
const MIN_GAP_MS = 60_000;

/** Shows that UniHub is reading saved data, and keeps that saved copy fresh while online. */
export default function OfflineBanner() {
  const { user, isOffline, offlineSavedAt } = useAuth();
  const [online, setOnline] = useState(() => isOnline() && !isOfflineMode());
  const [savedAt, setSavedAt] = useState(offlineSavedAt);

  useEffect(() => {
    const status = () => setOnline(isOnline() && !isOfflineMode());
    const info = () => { void getOfflineSnapshotInfo().then(value => setSavedAt(value?.savedAt)); };
    status();
    info();
    const stops = [onConnectivityChange(status), onAppEvent('unihub:offline-mode', status), onAppEvent('unihub:offline-data', info)];
    return () => stops.forEach(stop => stop());
  }, []);

  // Only refreshes a copy the user turned on in Settings.
  useEffect(() => {
    if (!user || isOffline) return;
    const controller = new AbortController();
    let busy = false;
    let last = 0;
    const refresh = async () => {
      if (busy || !isOnline() || isOfflineMode() || document.visibilityState === 'hidden' || Date.now() - last < MIN_GAP_MS) return;
      busy = true;
      try {
        if (!await getOfflineSnapshotInfo() || controller.signal.aborted) return;
        last = Date.now();
        const token = captureOfflineSave(user.id);
        const response = await api.get<{ snapshot: OfflineSnapshot }>('/offline/snapshot', { signal: controller.signal });
        if (response.data?.snapshot && !controller.signal.aborted) await saveOfflineSnapshot(response.data.snapshot, user, controller.signal, token);
      } catch {
        // Keep the previous complete snapshot; Settings shows its age and offers a refresh.
      } finally {
        busy = false;
      }
    };
    const trigger = () => { void refresh(); };
    trigger();
    const timer = window.setInterval(trigger, REFRESH_EVERY_MS);
    window.addEventListener('focus', trigger);
    const stopConnectivity = onConnectivityChange(online => { if (online) trigger(); });
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', trigger);
      stopConnectivity();
    };
  }, [user, isOffline]);

  if (online && !isOffline) return null;
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted px-4 py-2 text-sm">
      <CloudOff aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        Offline, read-only.{savedAt && <span className="text-muted-foreground"> Saved {new Date(savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.</span>}
      </span>
      <Button size="sm" variant="outline" type="button" onClick={() => emitAppEvent('unihub:retry-session')}>Try again</Button>
    </div>
  );
}
