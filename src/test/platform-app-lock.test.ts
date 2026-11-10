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
  let listener: ((event: { data: string }) => void) | undefined;
  window.UniHubAndroid = {
    postMessage(raw: string) {
      const message = JSON.parse(raw);
      sent.push(message);
      queueMicrotask(() => listener?.({ data: JSON.stringify({ id: message.id, ok: true, ...answer(message) }) }));
    },
    addEventListener(_type, callback) { listener = callback; },
  };
  return sent;
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
      if (message.action === 'method') return { method: 'biometric', biometric: 'available', deviceSecure: true };
      if (message.action === 'authenticate') return { result: 'ok' };
      if (message.action === 'state') return { due: true, hiddenForMs: 400_000, deviceLockedSinceHidden: true, freshProcess: false, authenticatedAt: null };
      return {};
    });
    const lock = deviceLock();
    expect(await lock.method()).toEqual({ method: 'biometric', biometric: 'available', deviceSecure: true });
    expect(await lock.authenticate('Unlock UniHub')).toBe('ok');
    await lock.configure({ userId: 'alex', scope: ['mail'], relockAfterMs: 60_000, onDeviceLock: true, blockScreenshots: true });
    expect(await lock.state()).toEqual({ due: true, hiddenForMs: 400_000, deviceLockedSinceHidden: true, freshProcess: false, authenticatedAt: null });
    await lock.release();
    expect(sent.map(({ type, action }) => `${type}:${action}`)).toEqual(['appLock:method', 'appLock:authenticate', 'appLock:configure', 'appLock:state', 'appLock:release']);
    expect(sent[1]).toMatchObject({ reason: 'Unlock UniHub' });
    expect(sent[2]).toMatchObject({ userId: 'alex', on: true, scope: ['mail'], relockAfterMs: 60_000, onDeviceLock: true, blockScreenshots: true });
    expect(new Set(sent.map(message => message.id)).size).toBe(5);
    expect(lock.capabilities).toEqual({ secureWindow: true, hideRecents: true, deviceLockSignal: true });
    expect(appLacksNativeLock()).toBe(false);
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
      expect(sent).toEqual([]);
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
    await lock.release();
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
