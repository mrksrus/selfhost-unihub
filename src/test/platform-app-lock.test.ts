import { afterEach, describe, expect, it, vi } from 'vitest';
import { appLacksNativeLock, appWithoutBridge, describeUserAgent, deviceLock } from '@/lib/platform';

// The device boundary chooses the lock: the Android app's own prompt from
// bridge level 3, the page's PIN everywhere else, including older apps and
// apps whose WebView has no bridge.
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const app = (level?: number) => `Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36 UniHubAndroid/0.29.0 (29000)${level ? ` UniHubBridge/${level}` : ''}`;

function userAgent(value: string) {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => value });
}

/** The app's bridge: answers each question with `answer(message)`, as WebBridge.kt does. */
function bridge(answer: (message: Record<string, unknown>) => Record<string, unknown>) {
  const sent: Record<string, unknown>[] = [];
  const listeners = new Set<(event: { data: string }) => void>();
  const tell = (data: unknown) => listeners.forEach(listener => listener({ data: JSON.stringify(data) }));
  window.UniHubAndroid = {
    postMessage(raw: string) {
      const message = JSON.parse(raw);
      sent.push(message);
      queueMicrotask(() => tell({ id: message.id, ok: true, ...answer(message) }));
    },
    addEventListener(_type, callback) { listeners.add(callback); },
    removeEventListener(_type, callback) { listeners.delete(callback); },
  };
  return Object.assign(sent, { tell });
}

afterEach(() => {
  delete window.UniHubAndroid;
  userAgent(BROWSER);
  document.documentElement.className = '';
});

describe('the app lock at the device boundary', () => {
  it('in an app with bridge level 3, every action is an appLock message the app answers', async () => {
    userAgent(app(3));
    const sent = bridge(message => {
      if (message.action === 'method') return { method: 'biometric', biometric: 'available', deviceSecure: true, capabilities: { secureWindow: true, hideRecents: false, deviceLockSignal: true } };
      if (message.action === 'authenticate') return { result: 'ok' };
      if (message.action === 'state') return { due: true, hiddenForMs: 400_000, deviceLockedSinceHidden: true, freshProcess: false, authenticatedAt: null };
      return {};
    });
    const lock = deviceLock();
    expect(await lock.method()).toEqual({ method: 'biometric', biometric: 'available', deviceSecure: true });
    expect(await lock.authenticate('Unlock UniHub')).toBe('ok');
    await lock.configure({ userId: 'alex', scope: ['mail'], relockAfterMs: 60_000, onDeviceLock: true, blockScreenshots: true });
    expect(await lock.state()).toEqual({ due: true, hiddenForMs: 400_000, deviceLockedSinceHidden: true, freshProcess: false, authenticatedAt: null });
    await lock.release(true);
    await lock.release(false);
    await lock.lock();
    // The lock off with screenshots forbidden: FLAG_SECURE stays.
    await lock.configure({ userId: 'alex', scope: [], relockAfterMs: 60_000, onDeviceLock: true, blockScreenshots: true });
    expect(sent.map(({ type, action }) => `${type}:${action}`)).toEqual([
      'appLock:method', 'appLock:authenticate', 'appLock:configure', 'appLock:state', 'appLock:release', 'appLock:release', 'appLock:lock', 'appLock:configure',
    ]);
    expect(sent[1]).toMatchObject({ reason: 'Unlock UniHub' });
    expect(sent[2]).toMatchObject({ userId: 'alex', on: true, scope: ['mail'], relockAfterMs: 60_000, onDeviceLock: true, blockScreenshots: true });
    expect([sent[4].unlocked, sent[5].unlocked]).toEqual([true, false]);
    expect(sent[7]).toMatchObject({ on: false, scope: [], blockScreenshots: true });
    expect(new Set(sent.map(message => message.id)).size).toBe(8);
    // As the app answered: no hidden recents picture below Android 13.
    expect(lock.capabilities).toEqual({ secureWindow: true, hideRecents: false, deviceLockSignal: true });
    expect(appLacksNativeLock()).toBe(false);
  });

  it('passes on the app’s own locked and unlocked news, and nothing else', async () => {
    userAgent(app(3));
    const sent = bridge(() => ({}));
    const heard: string[] = [];
    const stop = deviceLock().subscribe(event => heard.push(event));
    sent.tell({ type: 'appLock', event: 'locked' });
    sent.tell({ type: 'appLock', event: 'unlocked' });
    sent.tell({ type: 'appLock', id: 'a-reply', event: 'unlocked' });
    sent.tell({ type: 'notifications', event: 'unlocked' });
    sent.tell({ type: 'appLock', event: 'open-everything' });
    stop();
    sent.tell({ type: 'appLock', event: 'unlocked' });
    expect(heard).toEqual(['locked', 'unlocked']);
  });

  it('an unexpected or missing answer never reads as unlocked', async () => {
    userAgent(app(3));
    bridge(message => message.action === 'authenticate' ? { result: 'maybe' } : message.action === 'state' ? {} : { method: 'face' });
    const lock = deviceLock();
    expect(await lock.authenticate('Unlock UniHub')).toBe('unavailable');
    expect((await lock.state()).due).toBe(true);
    expect(await lock.method()).toEqual({ method: 'pin', biometric: 'none', deviceSecure: false });
  });

  it('a phone without a screen lock answers "pin": the page asks for its UniHub PIN', async () => {
    userAgent(app(3));
    bridge(message => message.action === 'authenticate' ? { result: 'pin' } : { method: 'pin', biometric: 'none', deviceSecure: false });
    const lock = deviceLock();
    expect(await lock.method()).toEqual({ method: 'pin', biometric: 'none', deviceSecure: false });
    expect(await lock.authenticate('Unlock UniHub')).toBe('pin');
  });

  it('an app before level 3 and a browser use the page PIN and send the app nothing', async () => {
    for (const [agent, older] of [[app(2), true], [app(), true], [BROWSER, false]] as const) {
      userAgent(agent);
      const sent = bridge(() => ({}));
      const lock = deviceLock();
      expect(await lock.method()).toEqual({ method: 'pin', biometric: 'none', deviceSecure: false });
      expect(await lock.authenticate('Unlock UniHub')).toBe('pin');
      expect((await lock.state()).due).toBeNull();
      expect(lock.capabilities).toEqual({ secureWindow: false, hideRecents: false, deviceLockSignal: false });
      expect(sent).toHaveLength(0);
      expect(appLacksNativeLock()).toBe(older);
    }
  });

  it('an app whose WebView has no bridge gets the page PIN', async () => {
    userAgent(app(3));
    expect(appWithoutBridge()).toBe(true);
    expect(await deviceLock().authenticate('Unlock UniHub')).toBe('pin');
  });

  it('the page lock blurs a tab in the background only while a lock is on, until the page shows the outcome', async () => {
    const lock = deviceLock();
    await lock.configure({ userId: 'alex', scope: [], relockAfterMs: 60_000, onDeviceLock: false, blockScreenshots: false });
    window.dispatchEvent(new Event('pagehide'));
    expect(document.documentElement).not.toHaveClass('app-lock-hidden');
    await lock.configure({ userId: 'alex', scope: ['mail'], relockAfterMs: 60_000, onDeviceLock: false, blockScreenshots: false });
    window.dispatchEvent(new Event('pagehide'));
    expect(document.documentElement).toHaveClass('app-lock-hidden');
    await lock.release(false);
    expect(document.documentElement).not.toHaveClass('app-lock-hidden');
  });

  it('names a device from its user agent', () => {
    expect(describeUserAgent(BROWSER)).toBe('Chrome on Linux');
    expect(describeUserAgent(app(3))).toBe('UniHub app on Android');
    expect(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) Gecko/20100101 Firefox/140.0')).toBe('Firefox on macOS');
    expect(describeUserAgent(null)).toBe('Unknown device');
  });
});

describe('the device key', () => {
  it('is made once per browser profile and goes with the kind of device', async () => {
    const { deviceBinding, deviceKey, DEVICE_KEY_STORAGE } = await import('@/lib/devices-api');
    localStorage.removeItem(DEVICE_KEY_STORAGE);
    const key = deviceKey();
    expect(key).toMatch(/^[\w-]{43}$/);
    expect(deviceKey()).toBe(key);
    expect(deviceBinding()).toEqual({ key, kind: 'web' });
    userAgent(app(3));
    expect(deviceBinding()).toEqual({ key, kind: 'android' });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage is off'); });
    expect(deviceBinding()).toBeUndefined();
    vi.restoreAllMocks();
  });
});
