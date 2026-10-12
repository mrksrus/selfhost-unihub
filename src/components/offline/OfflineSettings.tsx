import { useEffect, useRef, useState } from 'react';
import { isOnline } from '@/lib/platform';
import { onAppEvent } from '@/lib/app-events';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';
import { captureOfflineSave, clearOfflineData, getOfflineSnapshotInfo, saveOfflineSnapshot, type OfflineSnapshot } from '@/lib/offline';
import { Button } from '@/components/ui/button';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';

type Info = Awaited<ReturnType<typeof getOfflineSnapshotInfo>>;

export default function OfflineSettings() {
  const { user, isOffline } = useAuth();
  const [info, setInfo] = useState<Info>(null);
  const [busy, setBusy] = useState<'saving' | 'clearing' | null>(null);
  const [error, setError] = useState('');
  const [loadingInfo, setLoadingInfo] = useState(true);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => { void getOfflineSnapshotInfo().then(value => { if (active) { setInfo(value); setLoadingInfo(false); } }); };
    refresh();
    const stop = onAppEvent('unihub:offline-data', refresh);
    return () => { active = false; request.current?.abort(); stop(); };
  }, [user?.id]);

  const sync = async () => {
    if (!user) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy('saving');
    setError('');
    try {
      const token = captureOfflineSave(user.id);
      const response = await api.get<{ snapshot: OfflineSnapshot }>('/offline/snapshot', { signal: controller.signal });
      if (response.error || !response.data?.snapshot) throw new Error(response.error || 'Offline data was incomplete.');
      if (controller.signal.aborted) return;
      await saveOfflineSnapshot(response.data.snapshot, user, controller.signal, token);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Offline sync failed.');
    } finally {
      if (request.current === controller) { request.current = null; setBusy(null); }
    }
  };

  const clear = async () => {
    request.current?.abort();
    request.current = null;
    setBusy('clearing');
    setError('');
    try { await clearOfflineData(); setInfo(null); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not clear offline data.'); }
    finally { setBusy(null); }
  };

  const description = loadingInfo ? 'Checking saved data…'
    : info ? <>{info.emails} emails, {info.contacts} contacts and {info.events} events, {(info.bytes / 1024 / 1024).toFixed(1)} MiB. Saved {new Date(info.savedAt).toLocaleString()}.</>
    : 'Off for this device.';

  return (
    <SettingsSection title="Offline reading" description="The latest 100 emails, your contacts and events (up to 32 MiB), readable without a connection. Cleared when you sign out.">
      <SettingsRow label="This device" description={description}>
        {info && <Button type="button" variant="outline" disabled={!!busy} onClick={() => void clear()}>{busy === 'clearing' ? 'Clearing…' : 'Clear'}</Button>}
        <Button type="button" variant={info ? 'outline' : 'default'} onClick={() => void sync()} disabled={!!busy || loadingInfo || isOffline || !isOnline()}>
          {busy === 'saving' ? 'Saving…' : info ? 'Refresh now' : 'Turn on'}
        </Button>
      </SettingsRow>
      {error && <SettingsBlock><p role="alert" className="text-sm text-destructive">{error}</p></SettingsBlock>}
    </SettingsSection>
  );
}
