import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NotificationSettings from '@/components/pwa/NotificationSettings';
import { api } from '@/lib/api';
import type { AppNotificationState } from '@/lib/platform';

// The signed-in account; tests reassign it to switch accounts.
let currentUser: { id: string } | null = { id: 'owner' };
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: currentUser }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const ANDROID_BROWSER = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const APP_WITH_NOTIFICATIONS = `${ANDROID_BROWSER} UniHubAndroid/0.22.1 (22001)`;
const OLDER_APP = `${ANDROID_BROWSER} UniHubAndroid/0.21.4 (21400)`;
const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const ENDPOINT = 'unihub-android:device-1';

const off: AppNotificationState = { enabled: false, endpoint: null, permission: 'default', background: 'allowed', connected: false };
const on: AppNotificationState = { enabled: true, endpoint: ENDPOINT, permission: 'granted', background: 'allowed', connected: true };

interface Sent { id: string; type: string; action: string }

// The app's side of the bridge: records what the page sends and lets a test answer each message when it chooses.
function fakeApp() {
  const sent: Sent[] = [];
  let listener: ((event: { data: string }) => void) | undefined;
  window.UniHubAndroid = {
    postMessage: vi.fn((raw: string) => { sent.push(JSON.parse(raw)); }),
    addEventListener: (_type, handler) => { listener = handler; },
  };
  const reply = (message: Sent, payload: { ok: boolean; state?: AppNotificationState; error?: string }) =>
    act(async () => { listener?.({ data: JSON.stringify({ id: message.id, ...payload }) }); });
  return { sent, reply, last: () => sent[sent.length - 1] };
}

function useUserAgent(value: string) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(value);
}

function mount() {
  return render(<MemoryRouter><NotificationSettings /></MemoryRouter>);
}

const turnOn = () => screen.getByRole('button', { name: 'Turn on' });
const turnOff = () => screen.getByRole('button', { name: 'Turn off' });

beforeEach(() => {
  currentUser = { id: 'owner' };
  vi.mocked(api.get).mockResolvedValue({ data: { subscribed: true, sessionExpiresAt: '2026-11-06T10:00:00.000Z', lastSentAt: null, pending: 0, lastError: null } });
  vi.mocked(api.post).mockResolvedValue({ data: { queued: true } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.UniHubAndroid;
});

describe('notifications in the Android app', () => {
  it('turns notifications on through the app and shows the server’s view of this phone', async () => {
    useUserAgent(APP_WITH_NOTIFICATIONS);
    const app = fakeApp();
    mount();
    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]).toMatchObject({ type: 'notifications', action: 'status' });
    expect(app.sent[0].id.length).toBeGreaterThan(0);
    expect(app.sent[0].id.length).toBeLessThanOrEqual(64);
    expect(turnOn()).toBeDisabled();
    await app.reply(app.sent[0], { ok: true, state: off });
    expect(screen.getByText('Off for this device.')).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();

    fireEvent.click(turnOn());
    expect(app.last()).toMatchObject({ type: 'notifications', action: 'enable' });
    expect(app.last().id).not.toBe(app.sent[0].id);
    expect(turnOn()).toBeDisabled();
    await app.reply(app.last(), { ok: true, state: on });
    expect(screen.getByText('On for this device, connected.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Notifications enabled on this device.');
    expect(api.get).toHaveBeenCalledWith(`/notifications/status?endpoint=${encodeURIComponent(ENDPOINT)}`);
    expect(await screen.findByText('Nothing delivered yet.')).toBeInTheDocument();
    // The app's connection keeps the session in use, so the browser's expiry line does not apply.
    expect(screen.queryByText(/Signed in here until/)).not.toBeInTheDocument();
    expect(screen.queryByText(/3 weeks/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
    await act(async () => {});
    expect(api.post).toHaveBeenCalledWith('/notifications/test', { endpoint: ENDPOINT });
    expect(screen.getByRole('status')).toHaveTextContent(/Test sent/);

    fireEvent.click(turnOff());
    expect(app.last()).toMatchObject({ action: 'disable' });
    await app.reply(app.last(), { ok: true, state: off });
    expect(screen.getByText('Off for this device.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Notifications disabled on this device.');
  });

  it('shows the app’s refusal and stays off', async () => {
    useUserAgent(APP_WITH_NOTIFICATIONS);
    const app = fakeApp();
    mount();
    await app.reply(app.sent[0], { ok: true, state: off });
    fireEvent.click(turnOn());
    await app.reply(app.last(), { ok: false, error: 'Allow notifications for UniHub in Android’s settings.' });
    expect(screen.getByRole('status')).toHaveTextContent('Allow notifications for UniHub in Android’s settings.');
    expect(screen.getByText('Off for this device.')).toBeInTheDocument();
    expect(turnOn()).toBeEnabled();
  });

  it('says what to do when Android blocks notifications', async () => {
    useUserAgent(APP_WITH_NOTIFICATIONS);
    const app = fakeApp();
    mount();
    await app.reply(app.sent[0], { ok: true, state: { ...off, permission: 'denied' } });
    expect(screen.getByText(/Blocked by Android\. Allow notifications for UniHub in Android’s settings/)).toBeInTheDocument();
    expect(turnOn()).toBeEnabled();
  });

  it('offers the background request while Android restricts the connection, and reads the answer when the page is back', async () => {
    useUserAgent(APP_WITH_NOTIFICATIONS);
    const app = fakeApp();
    mount();
    await app.reply(app.sent[0], { ok: true, state: { ...on, background: 'restricted', connected: false } });
    expect(screen.getByText('On for this device, not connected yet.')).toBeInTheDocument();
    const allow = screen.getByRole('button', { name: 'Allow in background' });
    fireEvent.click(allow);
    expect(app.last()).toMatchObject({ type: 'notifications', action: 'background' });
    await app.reply(app.last(), { ok: true, state: { ...on, background: 'restricted', connected: false } });
    expect(screen.getByRole('button', { name: 'Allow in background' })).toBeInTheDocument();

    // The person answers Android's dialog and comes back to the page.
    const before = app.sent.length;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(app.sent).toHaveLength(before + 1);
    expect(app.last()).toMatchObject({ action: 'status' });
    await app.reply(app.last(), { ok: true, state: on });
    expect(screen.queryByRole('button', { name: 'Allow in background' })).not.toBeInTheDocument();
    expect(screen.getByText('On for this device, connected.')).toBeInTheDocument();
  });

  it('does not let a slow status reply overwrite a newer state', async () => {
    useUserAgent(APP_WITH_NOTIFICATIONS);
    const app = fakeApp();
    mount();
    const firstStatus = app.sent[0];
    await app.reply(firstStatus, { ok: true, state: off });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    const slowStatus = app.last();
    expect(slowStatus).toMatchObject({ action: 'status' });
    fireEvent.click(turnOn());
    await app.reply(app.last(), { ok: true, state: on });
    expect(screen.getByText('On for this device, connected.')).toBeInTheDocument();
    await app.reply(slowStatus, { ok: true, state: off });
    expect(screen.getByText('On for this device, connected.')).toBeInTheDocument();
    expect(turnOff()).toBeInTheDocument();
  });

  it('forgets the previous account’s state when another account signs in', async () => {
    useUserAgent(APP_WITH_NOTIFICATIONS);
    const app = fakeApp();
    const view = mount();
    const ownerStatus = app.sent[0];
    currentUser = { id: 'other' };
    view.rerender(<MemoryRouter><NotificationSettings /></MemoryRouter>);
    const otherStatus = app.last();
    expect(otherStatus.id).not.toBe(ownerStatus.id);
    await app.reply(ownerStatus, { ok: true, state: on });
    expect(screen.queryByText('On for this device, connected.')).not.toBeInTheDocument();
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    await app.reply(otherStatus, { ok: true, state: off });
    expect(screen.getByText('Off for this device.')).toBeInTheDocument();
  });

  it('asks an older app to update instead of sending it messages it ignores', () => {
    useUserAgent(OLDER_APP);
    const app = fakeApp();
    mount();
    expect(screen.getByText(/Notifications need a newer app/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open General' })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('button', { name: 'Turn on' })).not.toBeInTheDocument();
    expect(app.sent).toHaveLength(0);
  });

  it('keeps the browser path in a browser', () => {
    useUserAgent(DESKTOP);
    mount();
    // jsdom has no Push API, so the browser path reports the unsupported state and does not talk to any app.
    expect(screen.getByText(/browser that supports notifications/)).toBeInTheDocument();
    expect(turnOn()).toBeDisabled();
    expect(screen.getByText(/3 weeks/)).toBeInTheDocument();
  });
});
