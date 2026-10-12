import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { Button } from '@/components/ui/button';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { api } from '@/lib/api';
import { enablePushSubscription, initServiceWorker, notificationSupport, pushEnabledForUser, requestNotificationPermission, revokeDevicePushSubscription, sendTestPush, setPushEnabledForUser } from '@/utils/service-worker';

export interface DeviceNotificationStatus {
  subscribed: boolean;
  sessionExpiresAt?: string | null;
  lastSentAt?: string | null;
  pending?: number;
  lastError?: { message: string; at: string | null } | null;
}
const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function DeviceStatus({ status }: { status: DeviceNotificationStatus }) {
  if (!status.subscribed) return null;
  return <ul className="text-sm text-muted-foreground space-y-1">
    <li>{status.lastSentAt ? `Last delivered: ${when(status.lastSentAt)}` : 'Nothing delivered yet.'}{status.pending ? ` ${status.pending} waiting.` : ''}</li>
    {status.lastError && <li className="text-destructive">Last problem: {status.lastError.message}{status.lastError.at ? ` (${when(status.lastError.at)})` : ''}</li>}
    {status.sessionExpiresAt && <li>Signed in here until {when(status.sessionExpiresAt)}. Opening UniHub extends this.</li>}
  </ul>;
}

export default function NotificationSettings() {
  const { user } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<DeviceNotificationStatus>({ subscribed: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  const supported = notificationSupport();
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  useEffect(() => {
    let cancelled = false;
    if (!user?.id || !supported || !pushEnabledForUser(user.id)) return;
    void (async () => {
      const subscription = await (await initServiceWorker())?.pushManager.getSubscription();
      if (!subscription) return;
      const result = await api.get<DeviceNotificationStatus>(`/notifications/status?endpoint=${encodeURIComponent(subscription.endpoint)}`);
      if (cancelled || !result.data) return;
      setEnabled(result.data.subscribed === true);
      setStatus(result.data);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [supported, user?.id, refresh]);
  const enable = async () => {
    if (!user?.id) return;
    // Keep permission request in the button's user activation, before any network/SW await.
    const permissionRequest = requestNotificationPermission();
    setBusy(true); setMessage('');
    try { await enablePushSubscription(user.id, await permissionRequest); setEnabled(true); setRefresh(value => value + 1); setMessage('Notifications enabled on this device.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not enable notifications.'); }
    finally { setBusy(false); }
  };
  const disable = async () => {
    if (!user?.id) return;
    setBusy(true); setMessage('');
    try { await revokeDevicePushSubscription(); setMessage('Notifications disabled on this device.'); }
    catch { setMessage('Disabled locally. The server will remove the expired subscription.'); }
    finally { setPushEnabledForUser(user.id, false); setEnabled(false); setStatus({ subscribed: false }); setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setMessage('');
    try { const queued = await sendTestPush(); window.setTimeout(() => setRefresh(value => value + 1), 5000); setMessage(queued ? 'Test sent to the delivery queue. It should arrive shortly, even with the app minimized.' : 'A test was recently queued. Please wait a moment.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not send test notification.'); }
    finally { setBusy(false); }
  };
  const state = !supported ? 'Use HTTPS and a browser that supports notifications. On iPhone or iPad, add UniHub to the Home Screen and open it there.'
    : permission === 'denied' ? 'Notifications are blocked. Allow them in your browser or device settings, then turn them on here.'
    : enabled ? 'On for this device.' : 'Off for this device.';
  return <SettingsSection title="Notifications" description="New mail and reminders, also while UniHub is closed.">
    <SettingsRow label="This device" description={state}>
      {enabled && <Button variant="outline" disabled={busy} onClick={test}>Send a test</Button>}
      <Button onClick={enabled ? disable : enable} disabled={busy || !supported || (!enabled && permission === 'denied')} variant={enabled ? 'outline' : 'default'}>
        {busy && <Loader2 aria-hidden="true" className="animate-spin" />}{enabled ? 'Turn off' : 'Turn on'}
      </Button>
    </SettingsRow>
    {(enabled || message) && <SettingsBlock className="space-y-2">
      {enabled && <DeviceStatus status={status} />}
      {message && <p role="status" className="text-sm">{message}</p>}
    </SettingsBlock>}
    <SettingsBlock><p className="text-xs text-muted-foreground">If UniHub is not opened here for 3 weeks, this device is signed out and notifications stop. You are warned 2 days before.</p></SettingsBlock>
  </SettingsSection>;
}
