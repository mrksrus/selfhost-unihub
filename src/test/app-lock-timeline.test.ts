import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppLockCompliance, AppLockApplied } from '../../api/src/contracts/devices';
import type { DeviceSettingValues } from '../../api/src/contracts/settings';
import { emitAppEvent } from '@/lib/app-events';
import { AppLockController, CONFIRM_VALID_MS } from '@/lib/app-lock/controller';
import { deleteLockRecords } from '@/lib/app-lock/db';
import { readPin, savePin, setPinIterationsForTests } from '@/lib/app-lock/pin';
import { noteSignIn } from '@/lib/app-lock/session';
import { readTimeline, writeTimelineConfig } from '@/lib/app-lock/timeline';
import { createWebDeviceLock } from '@/lib/app-lock/web';
import type { CurrentDeviceResponse } from '@/lib/devices-api';
import type { DeviceLockConfig, DeviceLockEvent } from '@/lib/platform';
import { DEFAULT_DEVICE_SETTINGS, defaultsResolved } from '@/lib/settings-defaults';

// The web lock's timing and reports, with the real PIN, IndexedDB records
// and visibility handling; only the server is a double. Date and the
// heartbeat are fake; IndexedDB runs on real timers.

const PIN = '482913';
let visibility: DocumentVisibilityState = 'visible';
const controllers: AppLockController[] = [];

beforeAll(() => {
  setPinIterationsForTests(1000);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-11-10T09:00:00Z'));
  visibility = 'visible';
  // A page load without a sign-in (the person signed in earlier).
  noteSignIn('nobody');
});
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.stop());
  vi.useRealTimers();
  await deleteLockRecords();
});

async function until(check: () => boolean, what = 'condition') {
  for (let tries = 0; tries < 200; tries++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

function hide() { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }
function show() { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); }
function reload() { window.dispatchEvent(new Event('pagehide')); }

function server(initial: Partial<DeviceSettingValues> = {}, compliance: AppLockCompliance = { meets: true, required: [], max_background: null, reason: null }) {
  const state = { values: { ...DEFAULT_DEVICE_SETTINGS, ...initial }, compliance, lock: null as AppLockApplied | null };
  const answer = (): CurrentDeviceResponse => ({
    device: { id: 'device-1', current: true, kind: 'web', app_version: null, user_agent: null, created_at: '', last_seen_at: '', lock: state.lock && { scope: state.lock.scope, method: state.lock.method }, notifications: false },
    settings: defaultsResolved(state.values),
    compliance: state.compliance,
    policy: { screenshots: 'allowed' },
  });
  return {
    state,
    adoptDeviceKey: vi.fn(async () => {}),
    fetchCurrentDevice: vi.fn(async () => answer()),
    saveDeviceSettings: vi.fn(async (patch: Partial<DeviceSettingValues>) => { state.values = { ...state.values, ...patch }; return defaultsResolved(state.values); }),
    reportDeviceLock: vi.fn(async (report: { applied: AppLockApplied | null }) => { state.lock = report.applied; }),
    reportLockState: vi.fn(async (_state: 'open' | 'background' | 'locked', _options?: { keepalive?: boolean }) => {}),
  };
}
type FakeServer = ReturnType<typeof server>;

function tab(fake: FakeServer, { userId = 'alex', offline = false, signOut = vi.fn(async () => {}), onCompliant = vi.fn() } = {}) {
  const controller = new AppLockController({ userId, server: fake, lock: createWebDeviceLock(), offline: () => offline, signOut, onCompliant });
  controllers.push(controller);
  const statuses: string[] = [];
  controller.subscribe(() => statuses.push(controller.getSnapshot().status));
  const started = controller.start();
  return { controller, statuses, started, signOut, onCompliant, get status() { return controller.getSnapshot().status; } };
}
const states = (fake: FakeServer) => fake.reportLockState.mock.calls.map(([state]) => state);

/** A person who turned the whole-app lock on with a PIN in this browser earlier. */
async function lockedBefore(fake: FakeServer, { scope = ['app'] as DeviceSettingValues['app_lock_scope'], relock = '60' as DeviceSettingValues['app_lock_relock_after'], lastActiveAgoMs = 10 * 60_000, visible = false } = {}) {
  fake.state.values = { ...fake.state.values, app_lock_scope: scope, app_lock_relock_after: relock };
  fake.state.lock = { scope, relock_after: relock, on_device_lock: false, method: 'pin' };
  await savePin('alex', PIN);
  await writeTimelineConfig('alex', { scope, relockAfterMs: Number(relock) * 1000, onDeviceLock: true, method: 'pin' });
  const { updateRecord } = await import('@/lib/app-lock/db');
  await updateRecord<{ userId: string; lastActiveAt: number | null; hiddenAt: number | null }>('timeline', 'alex', record => record && { ...record, lastActiveAt: Date.now() - lastActiveAgoMs, hiddenAt: visible ? null : Date.now() - lastActiveAgoMs });
}

describe('turning the web lock on', () => {
  it('a device without a lock is off, and sets one up with a PIN, then reports it', async () => {
    const fake = server();
    const page = tab(fake);
    await page.started;
    expect(page.status).toBe('off');
    expect(page.controller.getSnapshot().settingsLoaded).toBe(true);
    await expect(page.controller.saveSettings({ app_lock_scope: ['mail'] })).rejects.toThrow('Set a UniHub PIN first');
    expect(fake.saveDeviceSettings).not.toHaveBeenCalled();

    expect(await page.controller.setPin(PIN)).toEqual({ ok: true });
    await page.controller.saveSettings({ app_lock_scope: ['mail', 'contacts'] });
    expect(page.status).toBe('unlocked');
    expect(page.controller.getSnapshot().scope).toEqual(['mail', 'contacts']);
    expect(fake.reportDeviceLock).toHaveBeenLastCalledWith({
      applied: { scope: ['mail', 'contacts'], relock_after: '60', on_device_lock: false, method: 'pin' },
      capabilities: { lock: 'pin', secure_window: false, recents_hidden: false, device_lock_signal: false },
    });
    expect(states(fake)).toContain('open');
    expect(await readTimeline('alex')).toMatchObject({ scope: ['mail', 'contacts'], relockAfterMs: 60_000, method: 'pin' });
    // The PIN never leaves the browser.
    expect(JSON.stringify([...fake.reportDeviceLock.mock.calls, ...fake.saveDeviceSettings.mock.calls])).not.toContain(PIN);
  });

  it('a weakening change needs a confirmation in the last minute; off removes the PIN', async () => {
    const fake = server();
    await lockedBefore(fake, { lastActiveAgoMs: 1000 });
    const page = tab(fake);
    await page.started;
    expect(page.status).toBe('unlocked');
    await expect(page.controller.saveSettings({ app_lock_relock_after: '900' })).rejects.toThrow('Confirm');
    await expect(page.controller.saveSettings({ app_lock_scope: ['mail'] })).rejects.toThrow('Confirm');
    // Stricter needs nothing.
    await page.controller.saveSettings({ app_lock_relock_after: '0' });
    expect(await page.controller.confirm('000000')).toMatchObject({ ok: false, reason: 'wrong' });
    expect(await page.controller.confirm(PIN)).toEqual({ ok: true });
    vi.advanceTimersByTime(CONFIRM_VALID_MS + 1000);
    await expect(page.controller.saveSettings({ app_lock_scope: [] })).rejects.toThrow('Confirm');
    expect(await page.controller.confirm(PIN)).toEqual({ ok: true });
    await page.controller.saveSettings({ app_lock_scope: [] });
    expect(page.status).toBe('off');
    expect(await readPin('alex')).toBeUndefined();
    expect(fake.reportDeviceLock).toHaveBeenLastCalledWith(expect.objectContaining({ applied: null }));
  });
});

describe('when the web lock asks', () => {
  it('a cold start after the relock time asks, before anything else shows', async () => {
    const fake = server();
    await lockedBefore(fake);
    const page = tab(fake);
    await page.started;
    expect(page.statuses.filter(status => status !== 'checking')[0]).toBe('locked');
    expect(page.statuses).not.toContain('unlocked');
    expect(page.controller.getSnapshot().scope).toEqual(['app']);
    expect(await page.controller.unlock('000000')).toMatchObject({ ok: false, reason: 'wrong', pin: { failures: 1 } });
    expect(await page.controller.unlock(PIN)).toEqual({ ok: true });
    expect(page.status).toBe('unlocked');
    expect(states(fake)).toEqual(['open']);
  });

  it('a reload within the relock time does not ask; one after it does', async () => {
    const fake = server();
    await lockedBefore(fake);
    const first = tab(fake);
    await first.started;
    await first.controller.unlock(PIN);
    reload();
    await until(() => states(fake).includes('background'), 'the background report');
    expect(fake.reportLockState).toHaveBeenLastCalledWith('background', { keepalive: true });
    first.controller.stop();
    await settle();
    vi.advanceTimersByTime(50_000);
    const second = tab(fake);
    await second.started;
    expect(second.status).toBe('unlocked');
    reload();
    await settle();
    second.controller.stop();
    vi.advanceTimersByTime(61_000);
    const third = tab(fake);
    await third.started;
    expect(third.status).toBe('locked');
  });

  it('a tab locks on its return after the relock time in the background, not before', async () => {
    const fake = server();
    await lockedBefore(fake, { relock: '300', lastActiveAgoMs: 0 });
    const page = tab(fake);
    await page.started;
    expect(page.status).toBe('unlocked');
    hide();
    vi.advanceTimersByTime(2 * 60_000);
    show();
    await settle();
    expect(page.status).toBe('unlocked');
    hide();
    vi.advanceTimersByTime(5 * 60_000 + 1000);
    show();
    await until(() => page.status === 'locked', 'the lock');
    expect(states(fake)).toEqual(['open', 'background', 'open', 'background', 'locked']);
    expect(await readTimeline('alex')).toMatchObject({ lockedAt: Date.now() });
  });

  it('"Every time UniHub opens" asks after any time in the background and on every load', async () => {
    const fake = server();
    await lockedBefore(fake, { relock: '0', lastActiveAgoMs: 0 });
    const page = tab(fake);
    await page.started;
    // The lock was just used: the timeline's hide is "now".
    expect(page.status).toBe('locked');
    await page.controller.unlock(PIN);
    hide();
    vi.advanceTimersByTime(1000);
    show();
    await until(() => page.status === 'locked', 'the lock');
    await page.controller.unlock(PIN);
    reload();
    await settle();
    page.controller.stop();
    const next = tab(fake);
    await next.started;
    expect(next.status).toBe('locked');
  });

  it('while unlocked and visible it tells the server every minute, and stops when hidden', async () => {
    const fake = server();
    await lockedBefore(fake, { relock: '900', lastActiveAgoMs: 0 });
    const page = tab(fake);
    await page.started;
    expect(states(fake)).toEqual(['open']);
    vi.advanceTimersByTime(60_000);
    expect(states(fake)).toEqual(['open', 'open']);
    hide();
    await settle();
    vi.advanceTimersByTime(5 * 60_000);
    expect(states(fake)).toEqual(['open', 'open', 'background']);
    // The visible tab's heartbeat keeps the timeline current for new tabs and the service worker.
    show();
    await settle();
    vi.advanceTimersByTime(15_000);
    await settle();
    expect((await readTimeline('alex'))!.lastActiveAt).toBe(Date.now());
  });

  it('each tab locks on its own: unlocking one does not unlock another', async () => {
    const fake = server();
    await lockedBefore(fake);
    const one = tab(fake);
    const two = tab(fake);
    await Promise.all([one.started, two.started]);
    expect([one.status, two.status]).toEqual(['locked', 'locked']);
    await one.controller.unlock(PIN);
    expect([one.status, two.status]).toEqual(['unlocked', 'locked']);
    one.controller.lockNow();
    await until(() => one.status === 'locked', 'lock now');
    expect(states(fake)).toEqual(['open', 'locked']);
  });

  it('"Every time UniHub opens" asks in a new tab while another tab is unlocked and visible', async () => {
    const fake = server();
    // Another tab noted its heartbeat a moment ago and is still on screen.
    await lockedBefore(fake, { relock: '0', lastActiveAgoMs: 1000, visible: true });
    const page = tab(fake);
    await page.started;
    expect(page.statuses.filter(status => status !== 'checking')[0]).toBe('locked');
  });

  it('offline, a start within the relock time still asks before the saved copy opens', async () => {
    const fake = server();
    await lockedBefore(fake, { relock: '900', lastActiveAgoMs: 1000, visible: true });
    const page = tab(fake, { offline: true });
    await page.started;
    expect(page.statuses.filter(status => status !== 'checking')[0]).toBe('locked');
  });

  it('offline, a cold start asks from this browser’s records before the saved copy opens, without the server', async () => {
    const fake = server();
    await lockedBefore(fake);
    const page = tab(fake, { offline: true });
    await page.started;
    expect(page.statuses.filter(status => status !== 'checking')[0]).toBe('locked');
    expect(fake.fetchCurrentDevice).not.toHaveBeenCalled();
    expect(await page.controller.unlock(PIN)).toEqual({ ok: true });
    expect(fake.reportLockState).not.toHaveBeenCalled();
  });
});

describe('a lost PIN and the sign-out', () => {
  it('the tenth wrong PIN signs out', async () => {
    const fake = server();
    await lockedBefore(fake);
    const page = tab(fake);
    await page.started;
    const { updateRecord } = await import('@/lib/app-lock/db');
    await updateRecord<{ userId: string; failures: number; waitUntil: number | null }>('pins', 'alex', record => record && { ...record, failures: 9, waitUntil: null });
    expect(await page.controller.unlock('000000')).toEqual({ ok: false, reason: 'signed-out' });
    expect(page.signOut).toHaveBeenCalledTimes(1);
    expect(await readPin('alex')).toBeUndefined();
  });

  it('a lock whose PIN is gone only lets the person sign out, until they sign in again', async () => {
    const fake = server();
    await lockedBefore(fake);
    await deleteLockRecords();
    await writeTimelineConfig('alex', { scope: ['app'], relockAfterMs: 60_000, onDeviceLock: true, method: 'pin' });
    const page = tab(fake);
    await page.started;
    expect(page.status).toBe('locked');
    expect(page.controller.getSnapshot().pinLost).toBe(true);
    expect(await page.controller.unlock(PIN)).toEqual({ ok: false, reason: 'no-pin' });
    // Setting a new PIN is not a way in: only a sign-in is.
    expect(await page.controller.setPin('111111')).toEqual({ ok: false, reason: 'no-pin' });
    expect(await readPin('alex')).toBeUndefined();
    page.controller.stop();
    await deleteLockRecords();
    await writeTimelineConfig('alex', { scope: ['app'], relockAfterMs: 60_000, onDeviceLock: true, method: 'pin' });
    noteSignIn('alex');
    const after = tab(fake);
    await after.started;
    // Signed in with the password: open, and asked for a new PIN.
    expect(after.status).toBe('setup');
    expect(after.controller.getSnapshot().pinLost).toBe(false);
    expect(await after.controller.setPin('111111')).toEqual({ ok: true });
    expect(after.status).toBe('unlocked');
  });

  it('after a sign-in with the password, a lock that was on asks for a new PIN', async () => {
    const fake = server({ app_lock_scope: ['mail'] });
    fake.state.lock = { scope: ['mail'], relock_after: '60', on_device_lock: false, method: 'pin' };
    noteSignIn('alex');
    const page = tab(fake);
    await page.started;
    expect(page.status).toBe('setup');
    expect(page.controller.getSnapshot().pinLost).toBe(false);
    expect(await page.controller.setPin(PIN)).toEqual({ ok: true });
    expect(page.status).toBe('unlocked');
    expect(fake.reportDeviceLock).toHaveBeenCalledWith(expect.objectContaining({ applied: expect.objectContaining({ scope: ['mail'], method: 'pin' }) }));
  });

  it('without records in this browser, it waits for the server before it shows anything', async () => {
    const fake = server({ app_lock_scope: ['app'] });
    fake.state.lock = { scope: ['app'], relock_after: '60', on_device_lock: false, method: 'pin' };
    let answer!: () => void;
    fake.fetchCurrentDevice.mockImplementationOnce(() => new Promise(resolve => { answer = () => resolve({
      device: { id: 'device-1', current: true, kind: 'web', app_version: null, user_agent: null, created_at: '', last_seen_at: '', lock: { scope: ['app'], method: 'pin' }, notifications: false },
      settings: defaultsResolved({ ...DEFAULT_DEVICE_SETTINGS, app_lock_scope: ['app'] }), compliance: { meets: true, required: [], max_background: null, reason: null }, policy: { screenshots: 'allowed' },
    }); }));
    const page = tab(fake);
    await until(() => !!answer, 'the device request');
    await settle();
    expect(page.status).toBe('checking');
    answer();
    await page.started;
    expect(page.status).toBe('locked');
    expect(page.controller.getSnapshot().pinLost).toBe(true);
  });
});

describe('the administrator’s requirement', () => {
  it('APP_LOCK_REQUIRED shows the requirement; setting up reports the lock and fetches the refused data again', async () => {
    const fake = server();
    const page = tab(fake);
    await page.started;
    expect(page.status).toBe('off');
    // The administrator now requires Mail with at most 5 minutes: the server's floor resolves it.
    fake.state.values = { ...fake.state.values, app_lock_scope: ['mail'], app_lock_relock_after: '300' };
    fake.state.compliance = { meets: false, required: ['mail'], max_background: '300', reason: 'Your administrator requires the app lock for Mail.' };
    emitAppEvent('unihub:app-lock-required', { required: ['mail'], max_background: '300', reason: 'Your administrator requires the app lock for Mail.' });
    await until(() => page.status === 'setup', 'the set-up');
    expect(page.controller.getSnapshot().requirement).toEqual({ meets: false, required: ['mail'], max_background: '300', reason: 'Your administrator requires the app lock for Mail.' });
    expect(page.controller.getSnapshot().settings.app_lock_relock_after.value).toBe('300');
    // Only the start's "no lock" report: nothing is claimed before a method exists.
    expect(fake.reportDeviceLock).toHaveBeenCalledTimes(1);
    expect(fake.reportDeviceLock).toHaveBeenLastCalledWith(expect.objectContaining({ applied: null }));

    fake.reportDeviceLock.mockImplementation(async report => {
      fake.state.lock = report.applied;
      fake.state.compliance = { ...fake.state.compliance, meets: true };
    });
    expect(await page.controller.setPin(PIN)).toEqual({ ok: true });
    expect(fake.reportDeviceLock).toHaveBeenCalledWith(expect.objectContaining({ applied: { scope: ['mail'], relock_after: '300', on_device_lock: false, method: 'pin' } }));
    expect(page.controller.getSnapshot().requirement?.meets).toBe(true);
    expect(page.onCompliant).toHaveBeenCalledTimes(1);
    expect(page.status).toBe('unlocked');
  });
});

describe('account and session safety', () => {
  it('an answer that arrives after the session ended changes nothing and reports nothing', async () => {
    const fake = server({ app_lock_scope: ['app'] });
    let answer!: (value: CurrentDeviceResponse) => void;
    fake.fetchCurrentDevice.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    await savePin('alex', PIN);
    const page = tab(fake);
    await until(() => !!answer, 'the device request');
    const before = page.controller.getSnapshot();
    page.controller.stop();
    answer({
      device: { id: 'device-1', current: true, kind: 'web', app_version: null, user_agent: null, created_at: '', last_seen_at: '', lock: null, notifications: false },
      settings: defaultsResolved({ ...DEFAULT_DEVICE_SETTINGS, app_lock_scope: ['app'] }), compliance: { meets: false, required: ['app'], max_background: null, reason: 'x' }, policy: { screenshots: 'forbidden' },
    });
    await page.started;
    await settle();
    expect(page.controller.getSnapshot()).toBe(before);
    expect(fake.reportDeviceLock).not.toHaveBeenCalled();
    expect(fake.reportLockState).not.toHaveBeenCalled();
  });

  it('one person’s lock never applies to another', async () => {
    const fake = server();
    await lockedBefore(fake);
    const blair = tab(server(), { userId: 'blair' });
    await blair.started;
    expect(blair.status).toBe('off');
    expect(await blair.controller.unlock(PIN)).toEqual({ ok: true });
    expect(await readPin('blair')).toBeUndefined();
  });
});

describe('in the Android app (bridge level 3)', () => {
  /** The app's lock as the page sees it through lib/platform.ts. */
  function nativeLock({ method = 'biometric', deviceSecure = true, due = true } = {}) {
    let listener: ((event: DeviceLockEvent) => void) | undefined;
    const lock = {
      due,
      method: vi.fn(async () => ({ method: method as 'biometric' | 'pin', biometric: 'available' as const, deviceSecure })),
      authenticate: vi.fn(async () => 'ok' as const),
      configure: vi.fn(async (_config: DeviceLockConfig) => {}),
      state: vi.fn(async () => ({ due: lock.due, hiddenForMs: null, deviceLockedSinceHidden: false, freshProcess: true, authenticatedAt: null })),
      release: vi.fn(async (_unlocked: boolean) => {}),
      lock: vi.fn(async () => {}),
      subscribe: (next: (event: DeviceLockEvent) => void) => { listener = next; return () => { listener = undefined; }; },
      capabilities: { secureWindow: true, hideRecents: false, deviceLockSignal: true },
      tell: (event: DeviceLockEvent) => listener?.(event),
    };
    return lock;
  }
  function appTab(fake: FakeServer, lock: ReturnType<typeof nativeLock>, offline = false) {
    const controller = new AppLockController({ userId: 'alex', server: fake, lock, offline: () => offline, signOut: vi.fn(async () => {}), onCompliant: vi.fn() });
    controllers.push(controller);
    return { controller, started: controller.start(), get status() { return controller.getSnapshot().status; } };
  }

  it('follows the app’s verdict at a cold start, and tells it when the page shows its lock screen or opened', async () => {
    const fake = server({ app_lock_scope: ['app'] });
    fake.state.lock = { scope: ['app'], relock_after: '60', on_device_lock: true, method: 'biometric' };
    const lock = nativeLock({ due: true });
    const page = appTab(fake, lock);
    await page.started;
    expect(page.status).toBe('locked');
    await page.controller.release();
    expect(lock.release).toHaveBeenLastCalledWith(false);
    expect(await page.controller.unlock()).toEqual({ ok: true });
    expect(lock.authenticate).toHaveBeenCalledWith('Unlock UniHub');
    await page.controller.release();
    expect(lock.release).toHaveBeenLastCalledWith(true);
    expect(fake.reportDeviceLock).toHaveBeenLastCalledWith(expect.objectContaining({
      applied: { scope: ['app'], relock_after: '60', on_device_lock: true, method: 'biometric' },
      capabilities: { lock: 'biometric', secure_window: true, recents_hidden: false, device_lock_signal: true },
    }));
  });

  it('a phone short of a required lock is asked to turn it on, even with a fingerprint, and claims the lock only then', async () => {
    // The administrator's floor is already in the device's settings; this device never turned a lock on.
    const fake = server({ app_lock_scope: ['app'] }, { meets: false, required: ['app'], max_background: null, reason: null });
    const lock = nativeLock({ due: false });
    const page = appTab(fake, lock);
    await page.started;
    expect(page.status).toBe('setup');
    expect(fake.state.lock).toBeNull();
    fake.reportDeviceLock.mockImplementation(async report => {
      fake.state.lock = report.applied;
      fake.state.compliance = { ...fake.state.compliance, meets: !!report.applied };
    });
    // "Turn on the app lock": the finger, then the settings.
    expect(await page.controller.confirm()).toEqual({ ok: true });
    await page.controller.saveSettings({ app_lock_scope: ['app'] });
    expect(fake.state.lock).toMatchObject({ scope: ['app'], method: 'biometric' });
    expect(page.status).toBe('unlocked');
  });

  it('takes the app’s own locked and unlocked news; a relock tells the app at once', async () => {
    const fake = server({ app_lock_scope: ['mail'] });
    const lock = nativeLock({ due: false });
    const page = appTab(fake, lock);
    await page.started;
    expect(page.status).toBe('unlocked');
    lock.tell('locked');
    await until(() => page.status === 'locked', 'the app’s lock');
    expect(lock.lock).toHaveBeenCalled();
    lock.tell('unlocked');
    await until(() => page.status === 'unlocked', 'the app’s unlock');
    page.controller.lockNow();
    await until(() => page.status === 'locked', 'lock now');
    expect(lock.lock).toHaveBeenCalledTimes(2);
  });

  it('a phone without a screen lock unlocks with the UniHub PIN, says so on release, and ignores a native "unlocked"', async () => {
    const fake = server({ app_lock_scope: ['app'] });
    await savePin('alex', PIN);
    await writeTimelineConfig('alex', { scope: ['app'], relockAfterMs: 60_000, onDeviceLock: true, method: 'pin' });
    const lock = nativeLock({ method: 'pin', deviceSecure: false, due: true });
    const page = appTab(fake, lock);
    await page.started;
    expect(page.status).toBe('locked');
    lock.tell('unlocked');
    await settle();
    expect(page.status).toBe('locked');
    expect(await page.controller.unlock()).toEqual({ ok: false, reason: 'pin-needed' });
    expect(lock.authenticate).not.toHaveBeenCalled();
    expect(await page.controller.unlock(PIN)).toEqual({ ok: true });
    await page.controller.release();
    expect(lock.release).toHaveBeenLastCalledWith(true);
  });

  it('forbidden screenshots reach the app with the lock off, and also at an offline start', async () => {
    const fake = server();
    const forbidden = fake.fetchCurrentDevice.getMockImplementation()!;
    fake.fetchCurrentDevice.mockImplementation(async () => ({ ...(await forbidden()), policy: { screenshots: 'forbidden' } }));
    const lock = nativeLock({ due: false });
    const online = appTab(fake, lock);
    await online.started;
    expect(online.status).toBe('off');
    expect(online.controller.getSnapshot().screenshotsForbidden).toBe(true);
    expect(lock.configure).toHaveBeenLastCalledWith(expect.objectContaining({ scope: [], blockScreenshots: true }));
    online.controller.stop();
    const later = nativeLock({ due: false });
    const offline = appTab(fake, later, true);
    await offline.started;
    expect(later.configure).toHaveBeenCalledWith(expect.objectContaining({ blockScreenshots: true }));
  });
});
