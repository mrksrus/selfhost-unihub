import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { Button } from '@/components/ui/button';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { settingsHref } from '@/components/settings/settings-sections';
import { api } from '@/lib/api';
import { appNeedsUpdateForNotifications, appNotifications, type AppNotifications, type AppNotificationState } from '@/lib/platform';
import { enablePushSubscription, initServiceWorker, notificationSupport, pushEnabledForUser, requestNotificationPermission, revokeDevicePushSubscription, sendTestPush, setPushEnabledForUser } from '@/utils/service-worker';

export interface DeviceNotificationStatus {
  subscribed: boolean;
  sessionExpiresAt?: string | null;
  lastSentAt?: string | null;
  pending?: number;
  lastError?: { message: string; at: string | null } | null;
}
const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** What the server knows about this device. The session line is for browsers; the app's connection keeps its session in use. */
export function DeviceStatus({ status, session = true }: { status: DeviceNotificationStatus; session?: boolean }) {
  if (!status.subscribed) return null;
  return <ul className="text-sm text-muted-foreground space-y-1">
    <li>{status.lastSentAt ? `Last delivered: ${when(status.lastSentAt)}` : 'Nothing delivered yet.'}{status.pending ? ` ${status.pending} waiting.` : ''}</li>
    {status.lastError && <li className="text-destructive">Last problem: {status.lastError.message}{status.lastError.at ? ` (${when(status.lastError.at)})` : ''}</li>}
    {session && status.sessionExpiresAt && <li>Signed in here until {when(status.sessionExpiresAt)}. Opening UniHub extends this.</li>}
  </ul>;
}

const SECTION_TITLE = 'Notifications';
const SECTION_DESCRIPTION = 'New mail and reminders, also while UniHub is closed.';
const TEST_QUEUED = 'Test sent to the delivery queue. It should arrive shortly, even with the app minimized.';
const TEST_RECENT = 'A test was recently queued. Please wait a moment.';

export default function NotificationSettings() {
  // The app object is one per mount; the bridge itself does not change while the page is open.
  const app = useMemo(appNotifications, []);
  if (appNeedsUpdateForNotifications()) return <AppUpdateNeeded />;
  if (app) return <AppNotificationSettings app={app} />;
  return <BrowserNotificationSettings />;
}

/** Inside an Android app from before 0.22.1, which cannot show notifications; the update is on the General page. */
function AppUpdateNeeded() {
  return <SettingsSection title={SECTION_TITLE} description={SECTION_DESCRIPTION}>
    <SettingsRow label="This device" description="Notifications need a newer app. The update is under Settings → General → App.">
      <Button variant="outline" asChild><Link to={settingsHref('general')}>Open General</Link></Button>
    </SettingsRow>
  </SettingsSection>;
}

/**
 * Inside the Android app (0.22.1+): the app holds the connection and shows
 * the notifications; this page only turns it on or off and shows its state.
 * The server's view of the device comes from the same status route as in a
 * browser, keyed by the endpoint the app reports.
 */
function AppNotificationSettings({ app }: { app: AppNotifications }) {
  const { user } = useAuth();
  const [state, setState] = useState<AppNotificationState | null>(null);
  const [status, setStatus] = useState<DeviceNotificationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  // Every question to the app gets a ticket; a reply is applied only when no
  // later one has been. Status reads wait while an action is in flight, so an
  // action's reply is never overtaken by a status read sent after it. The
  // epoch changes on an account switch and on unmount, which drops every
  // outstanding reply.
  const tickets = useRef({ sent: 0, applied: 0, epoch: 0 });
  const busyRef = useRef(false);

  const applyReply = useCallback((epoch: number, ticket: number, next: AppNotificationState) => {
    if (epoch !== tickets.current.epoch || ticket <= tickets.current.applied) return false;
    tickets.current.applied = ticket;
    setState(next);
    return true;
  }, []);

  useEffect(() => {
    // Another account: what the app said about the previous one no longer applies.
    const outstanding = tickets.current;
    outstanding.epoch++;
    setState(null); setStatus(null); setMessage('');
    return () => { outstanding.epoch++; };
  }, [user?.id]);
  useEffect(() => {
    if (!user?.id || busyRef.current) return;
    const { epoch } = tickets.current;
    const ticket = ++tickets.current.sent;
    app.status().then(next => { applyReply(epoch, ticket, next); })
      .catch(error => { if (epoch === tickets.current.epoch) setMessage(error instanceof Error ? error.message : 'Could not read the app’s notification state.'); });
  }, [app, applyReply, user?.id, refresh]);

  // Android's dialogs (permission, background) cover the page; its state is read again when the page is back.
  useEffect(() => {
    let last = 0;
    const onBack = () => {
      if (document.visibilityState !== 'visible' || busyRef.current || Date.now() - last < 1000) return;
      last = Date.now();
      setRefresh(value => value + 1);
    };
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);
    return () => { document.removeEventListener('visibilitychange', onBack); window.removeEventListener('focus', onBack); };
  }, []);

  const endpoint = state?.enabled ? state.endpoint : null;
  useEffect(() => {
    if (!endpoint) { setStatus(null); return; }
    let cancelled = false;
    api.get<DeviceNotificationStatus>(`/notifications/status?endpoint=${encodeURIComponent(endpoint)}`)
      .then(result => { if (!cancelled && result.data) setStatus(result.data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [endpoint, refresh]);

  const run = async (action: () => Promise<AppNotificationState>, done: (next: AppNotificationState) => string) => {
    const { epoch } = tickets.current;
    const ticket = ++tickets.current.sent;
    setBusy(true); busyRef.current = true; setMessage('');
    try {
      const next = await action();
      if (applyReply(epoch, ticket, next)) setMessage(done(next));
    } catch (error) {
      if (epoch === tickets.current.epoch) setMessage(error instanceof Error ? error.message : 'Could not change notifications.');
    } finally {
      busyRef.current = false; setBusy(false);
    }
  };
  const enable = () => run(() => app.enable(), next => next.enabled ? 'Notifications enabled on this device.' : '');
  const disable = () => run(() => app.disable(), () => 'Notifications disabled on this device.');
  const background = () => run(() => app.background(), () => '');
  const test = async () => {
    if (!endpoint) return;
    setBusy(true); busyRef.current = true; setMessage('');
    try {
      const result = await api.post<{ queued: boolean }>('/notifications/test', { endpoint });
      if (result.error) throw new Error(result.error);
      window.setTimeout(() => setRefresh(value => value + 1), 5000);
      setMessage(result.data?.queued ? TEST_QUEUED : TEST_RECENT);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not send test notification.');
    } finally {
      busyRef.current = false; setBusy(false);
    }
  };

  const enabled = state?.enabled === true;
  const description = !state ? (message ? 'Not available right now.' : 'Checking…')
    : state.permission === 'denied' ? (enabled
      ? 'On, but blocked by Android. Allow notifications for UniHub in Android’s settings.'
      : 'Blocked by Android. Allow notifications for UniHub in Android’s settings, then turn them on here.')
    : enabled ? (state.connected ? 'On for this device, connected.' : 'On for this device, not connected yet.')
    : 'Off for this device.';
  const unregistered = enabled && status !== null && !status.subscribed;
  return <SettingsSection title={SECTION_TITLE} description={SECTION_DESCRIPTION}>
    <SettingsRow label="This device" description={description}>
      {enabled && <Button variant="outline" disabled={busy || !endpoint} onClick={test}>Send a test</Button>}
      <Button onClick={enabled ? disable : enable} disabled={busy || !state} variant={enabled ? 'outline' : 'default'}>
        {busy && <Loader2 aria-hidden="true" className="animate-spin" />}{enabled ? 'Turn off' : 'Turn on'}
      </Button>
    </SettingsRow>
    {enabled && state.background === 'restricted' && <SettingsRow label="In the background" description="Android may pause the connection while the app is not open, so notifications can arrive late or not at all.">
      <Button variant="outline" disabled={busy} onClick={background}>Allow in background</Button>
    </SettingsRow>}
    {(enabled || message) && <SettingsBlock className="space-y-2">
      {enabled && status && <DeviceStatus status={status} session={false} />}
      {unregistered && <p className="text-sm text-destructive">The server has no registration for this phone. Turn notifications off and on again.</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
    </SettingsBlock>}
    <SettingsBlock><p className="text-xs text-muted-foreground">While notifications are on, the app stays connected to this server and keeps you signed in here. Android shows a quiet ongoing notification for the connection; it can be hidden in Android’s notification settings.</p></SettingsBlock>
  </SettingsSection>;
}

/** In a browser or the installed web app: Web Push through the service worker. */
function BrowserNotificationSettings() {
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
    try { const queued = await sendTestPush(); window.setTimeout(() => setRefresh(value => value + 1), 5000); setMessage(queued ? TEST_QUEUED : TEST_RECENT); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not send test notification.'); }
    finally { setBusy(false); }
  };
  const state = !supported ? 'Use HTTPS and a browser that supports notifications. On iPhone or iPad, add UniHub to the Home Screen and open it there.'
    : permission === 'denied' ? 'Notifications are blocked. Allow them in your browser or device settings, then turn them on here.'
    : enabled ? 'On for this device.' : 'Off for this device.';
  return <SettingsSection title={SECTION_TITLE} description={SECTION_DESCRIPTION}>
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
