// The app lock of one signed-in person in this tab: what is locked, when it
// locks again, how it unlocks, and what the server is told. AppLockProvider
// (contexts/AppLockProvider.tsx) runs one per account and ends it with the
// session, so a late answer never reaches another account: every step checks
// `ended` after it waited.
//
// Where the facts come from:
// - this browser's records (db.ts): the PIN and the timeline, read first, so
//   a cold start (also offline) asks before any private view shows
// - the server (devices-api.ts): this device's settings resolved with the
//   administrator's floor, the requirement, and the screenshot policy; they
//   replace the cached ones when they arrive
// - the device boundary (lib/platform.ts deviceLock): the Android app's
//   native lock and its own clock, or this tab's time in the background
import type { AppLockArea, AppLockApplied, DeviceCapabilities, LockMethod, RelockAfter } from '../../../api/src/contracts/devices';
import type { DeviceSettingValues } from '../../../api/src/contracts/settings';
import type {
  AppLockCapabilities, AppLockMethodState, AppLockPinState, AppLockRequirement, AppLockStatus, AppLockValue, DeviceSettings, SetPinResult, UnlockResult,
} from '@/hooks/use-app-lock';
import { onAppEvent } from '@/lib/app-events';
import type { AppLockRequiredDetails } from '../../../api/src/contracts/devices';
import * as devices from '@/lib/devices-api';
import type { CurrentDeviceResponse } from '@/lib/devices-api';
import { isOfflineMode } from '@/lib/offline';
import { appLacksNativeLock, deviceLock, type DeviceLock, type DeviceLockMethod, type DeviceLockState } from '@/lib/platform';
import { DEFAULT_DEVICE_SETTINGS, defaultsResolved, settingValues } from '@/lib/settings-defaults';
import { checkPin, deletePin, PIN_PATTERN, pinState, pinSupport, readPin, savePin, type PinCheck } from '@/lib/app-lock/pin';
import { recentSignIn, signedInInThisPage } from '@/lib/app-lock/session';
import {
  covers, dueOnReturn, HEARTBEAT_MS, isOpen, normalScope, noteActive, noteHidden, noteLocked, readTimeline, writeTimelineConfig, type TimelineRecord,
} from '@/lib/app-lock/timeline';

/** While unlocked and visible, the server hears "open" this often (its open_until allows 90 s more). */
export const OPEN_REPORT_MS = 60_000;
/** A weakening change needs a confirmation this recent. */
export const CONFIRM_VALID_MS = 60_000;
// The device's state on the server is read again on return after this long.
const REFRESH_AFTER_MS = 5 * 60_000;

const WEB_DEVICE_LOCK_REASON = 'Your browser can’t tell when the device locks; UniHub locks after the time above.';
const NO_PIN: AppLockPinState = { failures: 0, waitUntil: null, attemptsLeft: null };

export type AppLockSnapshot = Omit<AppLockValue, 'locked' | 'unlock' | 'confirm' | 'lockNow' | 'setPin' | 'saveSettings' | 'signOut'> & {
  /** Counts finished checks; the provider lifts the app's cover after each one is shown. */
  checks: number;
};

type Server = Pick<typeof devices, 'adoptDeviceKey' | 'fetchCurrentDevice' | 'saveDeviceSettings' | 'reportDeviceLock' | 'reportLockState'>;

export interface AppLockControllerOptions {
  userId: string;
  signOut: () => Promise<void>;
  /** The device now meets the administrator's requirement: fetch again what was refused. */
  onCompliant: () => void;
  lock?: DeviceLock;
  server?: Server;
  now?: () => number;
  /** The session is the saved offline copy, or the server cannot be reached for writes. */
  offline?: () => boolean;
}

interface LockConfig { scope: AppLockArea[]; relockAfterMs: number; onDeviceLock: boolean }

const relockMs = (value: RelockAfter) => Number(value) * 1000;

/** Whether `next` locks less than `current`: an area left out, a longer time, or no longer on the device's own lock. */
export function isWeakening(current: DeviceSettingValues, next: DeviceSettingValues) {
  const before = normalScope(current.app_lock_scope);
  const after = normalScope(next.app_lock_scope);
  const lostArea = before.some(area => !covers(after, area));
  return lostArea || Number(next.app_lock_relock_after) > Number(current.app_lock_relock_after)
    || (current.app_lock_on_device_lock && !next.app_lock_on_device_lock);
}

export class AppLockController {
  private readonly userId: string;
  private readonly options: AppLockControllerOptions;
  private readonly lock: DeviceLock;
  private readonly server: Server;
  private readonly now: () => number;
  private readonly offline: () => boolean;

  private ended = false;
  private ready = false;
  private unlocked = false;
  private visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  private config: LockConfig = { scope: [], relockAfterMs: 60_000, onDeviceLock: true };
  private settings: DeviceSettings = defaultsResolved(DEFAULT_DEVICE_SETTINGS);
  private settingsLoaded = false;
  private native: DeviceLockMethod = { method: 'pin', biometric: 'none', deviceSecure: false };
  private pinSet = false;
  private pin: AppLockPinState = NO_PIN;
  private requirement: AppLockRequirement | null = null;
  private screenshotsForbidden = false;
  /** The method that applied the lock here before (this browser's timeline or the server's record); a lost PIN needs a sign-in. */
  private appliedMethod: LockMethod | null = null;
  private confirmedAt = Number.NEGATIVE_INFINITY;
  private reported: string | null = null;
  private lastOpenReport = Number.NEGATIVE_INFINITY;
  private refreshedAt = Number.NEGATIVE_INFINITY;
  private refreshing: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private checks = 0;
  private cleanups: (() => void)[] = [];
  private listeners = new Set<() => void>();
  private snapshot: AppLockSnapshot;

  constructor(options: AppLockControllerOptions) {
    this.options = options;
    this.userId = options.userId;
    this.lock = options.lock ?? deviceLock();
    this.server = options.server ?? devices;
    this.now = options.now ?? Date.now;
    this.offline = options.offline ?? isOfflineMode;
    this.snapshot = this.build();
  }

  // ── State for the screens ──────────────────────────────────────

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    if (this.ended) return;
    this.snapshot = this.build();
    this.listeners.forEach(listener => listener());
  }

  private get nativeUnlock() { return this.native.method !== 'pin' && this.native.deviceSecure; }
  private get hasMethod() { return this.nativeUnlock || this.pinSet; }
  private get methodName(): LockMethod { return this.nativeUnlock ? this.native.method : 'pin'; }
  private get scope() { return this.config.scope; }

  /** The lock was on with a UniHub PIN that is gone (storage cleared, the tenth wrong PIN), and nobody signed in since. */
  private get pinLost() {
    return this.scope.length > 0 && !this.hasMethod && this.appliedMethod === 'pin' && !recentSignIn(this.userId, this.now());
  }

  private status(): AppLockStatus {
    if (!this.ready) return 'checking';
    if (!this.scope.length) return 'off';
    if (!this.hasMethod) return this.pinLost ? 'locked' : 'setup';
    return this.unlocked ? 'unlocked' : 'locked';
  }

  private build(): AppLockSnapshot {
    const support = pinSupport();
    const method: AppLockMethodState = {
      method: this.methodName,
      biometric: this.native.biometric,
      deviceSecure: this.native.deviceSecure,
      pinSet: this.pinSet,
      pinUnavailable: support.reason,
      appUpdateForBiometrics: appLacksNativeLock(),
    };
    const capabilities: AppLockCapabilities = {
      deviceLockSignal: this.lock.capabilities.deviceLockSignal,
      deviceLockReason: this.lock.capabilities.deviceLockSignal ? null : WEB_DEVICE_LOCK_REASON,
      secureWindow: this.lock.capabilities.secureWindow,
    };
    return {
      status: this.status(),
      scope: this.scope,
      settings: this.settings,
      settingsLoaded: this.settingsLoaded,
      method,
      capabilities,
      pin: this.pin,
      requirement: this.requirement,
      screenshotsForbidden: this.screenshotsForbidden,
      pinLost: this.ready && this.pinLost,
      checks: this.checks,
    };
  }

  // ── Start and end ──────────────────────────────────────────────

  async start() {
    this.cleanups.push(
      this.lock.subscribe(event => { void this.onVisibility(event); }),
      onAppEvent('unihub:app-lock-required', details => this.onRequired(details)),
      onAppEvent('unihub:offline-mode', () => { if (!this.offline()) void this.refresh(); }),
    );
    const [timeline, pin, native, state] = await Promise.all([
      readTimeline(this.userId).catch(() => undefined),
      readPin(this.userId).catch(() => undefined),
      this.lock.method().catch(() => this.native),
      this.lock.state().catch((): DeviceLockState | null => null),
    ]);
    if (this.ended) return;
    this.native = native;
    this.pinSet = !!pin;
    this.pin = pin ? pinState(pin, this.now()) : NO_PIN;
    if (timeline?.v === 1) {
      this.config = { scope: normalScope(timeline.scope), relockAfterMs: timeline.relockAfterMs, onDeviceLock: timeline.onDeviceLock };
      this.appliedMethod = timeline.method;
    }
    this.unlocked = signedInInThisPage(this.userId) || this.openAtStart(timeline, state, !!pin);
    // With this browser's records the answer is known now, also offline. A
    // browser without them waits for the server, so a cleared storage does
    // not show private views before the server says whether a lock is on.
    if (timeline || this.offline()) this.settle();
    if (!this.offline()) await this.refresh({ adopt: true, start: true });
    if (this.ended) return;
    if (!this.ready) {
      // No records and no answer: a PIN without its timeline still locks everything.
      if (pin) this.config = { ...this.config, scope: ['app'] };
      this.settle();
    }
    await this.apply();
    if (this.ended) return;
    if (this.unlocked && this.scope.length && this.hasMethod) await this.opened();
  }

  stop() {
    this.ended = true;
    this.stopHeartbeat();
    this.cleanups.forEach(cleanup => cleanup());
    this.cleanups = [];
    this.listeners.clear();
  }

  /** The page shows the outcome of the last check: the app lifts its cover. */
  release() {
    if (this.ended || !this.ready) return Promise.resolve();
    return this.lock.release().catch(() => {});
  }

  private settle() {
    this.ready = true;
    this.checks++;
    this.emit();
  }

  private openAtStart(timeline: TimelineRecord | undefined, state: DeviceLockState | null, pinKept: boolean) {
    // The app decides by its own monotonic clock, and knows a fresh start.
    if (state && state.due !== null) return !state.due;
    if (!timeline) return !pinKept;
    return isOpen(timeline, this.now());
  }

  // ── The server ─────────────────────────────────────────────────

  private refresh({ adopt = false, start = false } = {}) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        // A session from before 0.29 joins this device's record first, so the reports below reach it.
        if (adopt) await this.server.adoptDeviceKey().catch(() => {});
        if (this.ended) return;
        const current = await this.server.fetchCurrentDevice();
        if (this.ended) return;
        this.refreshedAt = this.now();
        await this.applyServer(current, start);
      } catch {
        // Unreachable, or a server before 0.29: keep what this browser knows.
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async applyServer(current: CurrentDeviceResponse, start: boolean) {
    const wasMet = this.requirement ? this.requirement.meets : true;
    this.applySettings(current.settings);
    const { compliance } = current;
    this.requirement = compliance.required.length || !compliance.meets
      ? { meets: compliance.meets, required: normalScope(compliance.required), max_background: compliance.max_background, reason: compliance.reason }
      : null;
    this.screenshotsForbidden = current.policy?.screenshots === 'forbidden';
    if (current.device.lock) this.appliedMethod ??= current.device.lock.method;
    // The server keeps no lock for this device (turned off elsewhere in this
    // browser, or an installation restored without devices): a PIN left
    // here is from before and is not used again. Only at start, so a PIN
    // just chosen for the lock being turned on is never taken for one.
    if (start && !this.scope.length && this.pinSet) {
      await deletePin(this.userId).catch(() => {});
      if (this.ended) return;
      this.pinSet = false;
      this.pin = NO_PIN;
      this.appliedMethod = null;
    }
    if (!this.ready) this.settle();
    else this.emit();
    if (!wasMet && this.requirement?.meets !== false) this.options.onCompliant();
  }

  private applySettings(settings: DeviceSettings) {
    this.settings = { ...defaultsResolved(DEFAULT_DEVICE_SETTINGS), ...settings };
    this.settingsLoaded = true;
    const values = settingValues(this.settings);
    this.config = {
      scope: normalScope(values.app_lock_scope),
      relockAfterMs: relockMs(values.app_lock_relock_after),
      onDeviceLock: values.app_lock_on_device_lock,
    };
  }

  private onRequired(details: AppLockRequiredDetails) {
    if (this.ended) return;
    this.requirement = { meets: false, ...details };
    this.emit();
    // The policy may have tightened: read the floors, apply them while a
    // method exists, report, and read the compliance again.
    void this.refresh().then(() => this.apply());
  }

  /** What the device enforces now, for PUT /api/devices/current/lock. */
  private applied(): AppLockApplied | null {
    if (!this.scope.length || !this.hasMethod) return null;
    const relock = String(this.config.relockAfterMs / 1000) as RelockAfter;
    return {
      scope: this.scope,
      relock_after: relock,
      on_device_lock: this.config.onDeviceLock && this.lock.capabilities.deviceLockSignal,
      method: this.methodName,
    };
  }

  private deviceCapabilities(): DeviceCapabilities {
    return {
      lock: this.hasMethod ? this.methodName : this.native.deviceSecure ? this.native.method : pinSupport().available ? 'pin' : 'none',
      secure_window: this.lock.capabilities.secureWindow,
      recents_hidden: this.lock.capabilities.hideRecents,
      device_lock_signal: this.lock.capabilities.deviceLockSignal,
    };
  }

  /** Hands the settings to the device boundary and the timeline, and reports them when they changed. */
  private async apply() {
    if (this.ended) return;
    const lost = this.status() === 'setup' || this.pinLost;
    await this.lock.configure({
      userId: this.userId,
      scope: this.scope,
      relockAfterMs: this.config.relockAfterMs,
      onDeviceLock: this.config.onDeviceLock,
      blockScreenshots: this.screenshotsForbidden,
    }).catch(() => {});
    if (this.ended) return;
    await writeTimelineConfig(this.userId, {
      ...this.config,
      // A lock waiting for its method keeps the one it had, so a lost PIN stays lost.
      method: this.scope.length ? (this.hasMethod ? this.methodName : this.appliedMethod) : null,
    }).catch(() => {});
    if (this.ended || lost || !this.settingsLoaded || this.offline()) return;
    const report = { applied: this.applied(), capabilities: this.deviceCapabilities() };
    const key = JSON.stringify(report);
    if (key === this.reported) return;
    try {
      await this.server.reportDeviceLock(report);
    } catch { return; }
    if (this.ended) return;
    this.reported = key;
    if (report.applied) this.appliedMethod = report.applied.method;
    if (this.requirement && !this.requirement.meets) await this.refresh();
  }

  private reportState(state: 'open' | 'background' | 'locked') {
    if (this.ended || this.offline() || !this.scope.length || !this.hasMethod) return;
    if (state === 'open') this.lastOpenReport = this.now();
    void this.server.reportLockState(state, { keepalive: state === 'background' }).catch(() => {});
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  private async onVisibility(event: 'hidden' | 'visible') {
    if (this.ended) return;
    if (event === 'hidden') {
      this.visible = false;
      this.stopHeartbeat();
      if (this.unlocked && this.scope.length && this.hasMethod) {
        this.reportState('background');
        await noteHidden(this.userId, this.now()).catch(() => {});
      }
      return;
    }
    this.visible = true;
    const state = await this.lock.state().catch((): DeviceLockState | null => null);
    if (this.ended) return;
    if (this.unlocked && this.scope.length && this.hasMethod) {
      const due = state && state.due !== null ? state.due : dueOnReturn(state?.hiddenForMs ?? null, this.config.relockAfterMs);
      if (due) await this.closeTab();
      else await this.opened();
    }
    this.checks++;
    this.emit();
    if (this.now() - this.refreshedAt > REFRESH_AFTER_MS && !this.offline()) void this.refresh().then(() => this.apply());
  }

  private async opened() {
    this.reportState('open');
    this.startHeartbeat();
    await noteActive(this.userId, this.now()).catch(() => {});
  }

  private async closeTab() {
    this.unlocked = false;
    this.stopHeartbeat();
    this.reportState('locked');
    this.emit();
    await noteLocked(this.userId, this.now()).catch(() => {});
  }

  private startHeartbeat() {
    if (this.heartbeat || this.ended) return;
    this.heartbeat = setInterval(() => {
      if (this.ended || !this.visible || !this.unlocked || !this.scope.length || !this.hasMethod) return;
      void noteActive(this.userId, this.now()).catch(() => {});
      if (this.now() - this.lastOpenReport >= OPEN_REPORT_MS) this.reportState('open');
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  // ── Actions ────────────────────────────────────────────────────

  private async checkPinCounted(pin: string): Promise<UnlockResult> {
    let check: PinCheck;
    try { check = await checkPin(this.userId, pin, this.now); }
    catch { return { ok: false, reason: 'unavailable' }; }
    if (this.ended) return { ok: false, reason: 'unavailable' };
    switch (check.result) {
      case 'ok': this.pin = NO_PIN; this.emit(); return { ok: true };
      case 'wrong': case 'wait': this.pin = check.state; this.emit(); return { ok: false, reason: check.result, pin: check.state };
      case 'invalid': return { ok: false, reason: 'invalid' };
      case 'no-pin': this.pinSet = false; this.emit(); return { ok: false, reason: 'no-pin' };
      case 'sign-out':
        this.pinSet = false;
        this.unlocked = false;
        this.emit();
        void this.options.signOut();
        return { ok: false, reason: 'signed-out' };
    }
  }

  /** Checks the person: the app's own prompt where it has one, otherwise the PIN. */
  private async verify(pin: string | undefined, reason: string): Promise<UnlockResult> {
    if (this.nativeUnlock && pin === undefined) {
      const result = await this.lock.authenticate(reason).catch(() => 'unavailable' as const);
      if (this.ended) return { ok: false, reason: 'unavailable' };
      if (result === 'ok') return { ok: true };
      return { ok: false, reason: result === 'pin' ? 'pin-needed' : result };
    }
    if (pin === undefined) return { ok: false, reason: this.pinSet ? 'pin-needed' : 'no-pin' };
    return this.checkPinCounted(pin);
  }

  unlock = async (pin?: string): Promise<UnlockResult> => {
    const status = this.status();
    if (status === 'off' || status === 'unlocked') return { ok: true };
    if (status === 'checking' || !this.hasMethod) return { ok: false, reason: this.pinSet ? 'unavailable' : 'no-pin' };
    const result = await this.verify(pin, 'Unlock UniHub');
    if (!result.ok || this.ended) return result;
    this.unlocked = true;
    await this.opened();
    this.checks++;
    this.emit();
    return result;
  };

  confirm = async (pin?: string): Promise<UnlockResult> => {
    if (!this.hasMethod) return this.scope.length ? { ok: false, reason: 'no-pin' } : { ok: true };
    const result = await this.verify(pin, 'Confirm it’s you');
    if (result.ok && !this.ended) this.confirmedAt = this.now();
    return result;
  };

  lockNow = () => {
    if (this.ended || !this.scope.length || !this.hasMethod || !this.unlocked) return;
    void this.closeTab().then(() => { this.checks++; this.emit(); });
  };

  setPin = async (pin: string, currentPin?: string): Promise<SetPinResult> => {
    if (!pinSupport().available) return { ok: false, reason: 'unsupported' };
    if (!PIN_PATTERN.test(pin)) return { ok: false, reason: 'invalid' };
    // A lost PIN is replaced only after a sign-in; a new one here would open the lock.
    if (this.pinLost) return { ok: false, reason: 'no-pin' };
    if (this.pinSet) {
      if (currentPin === undefined) return { ok: false, reason: 'pin-needed' };
      const check = await this.checkPinCounted(currentPin);
      if (!check.ok) return check;
    }
    if (this.ended) return { ok: false, reason: 'unavailable' };
    const settingUp = this.status() === 'setup';
    try { await savePin(this.userId, pin); }
    catch { return { ok: false, reason: 'unsupported' }; }
    if (this.ended) return { ok: false, reason: 'unavailable' };
    this.pinSet = true;
    this.pin = NO_PIN;
    this.confirmedAt = this.now();
    // Choosing the PIN is the person's unlock; a lock already on stays as it was.
    if (settingUp) this.unlocked = true;
    await this.apply();
    if (settingUp && this.unlocked) await this.opened();
    this.checks++;
    this.emit();
    return { ok: true };
  };

  saveSettings = async (patch: Partial<DeviceSettingValues>): Promise<DeviceSettings> => {
    const current = settingValues(this.settings);
    const next = { ...current, ...patch, app_lock_scope: normalScope(patch.app_lock_scope ?? current.app_lock_scope) };
    if (this.scope.length && this.hasMethod && isWeakening(current, next) && this.now() - this.confirmedAt > CONFIRM_VALID_MS) {
      throw new Error('Confirm it’s you first, then change the app lock.');
    }
    if (next.app_lock_scope.length && !this.hasMethod) {
      throw new Error(this.native.deviceSecure || !pinSupport().available ? 'This device has no way to unlock UniHub yet.' : 'Set a UniHub PIN first.');
    }
    const saved = await this.server.saveDeviceSettings(patch.app_lock_scope ? { ...patch, app_lock_scope: next.app_lock_scope } : patch);
    if (this.ended) return saved;
    const wasOn = this.scope.length > 0;
    this.applySettings(saved);
    if (!this.scope.length && this.pinSet) {
      // Off: the PIN goes with it, and turning the lock on again sets a new one.
      await deletePin(this.userId).catch(() => {});
      this.pinSet = false;
      this.pin = NO_PIN;
    }
    if (!wasOn && this.scope.length) this.unlocked = true;
    this.emit();
    await this.apply();
    if (this.unlocked && this.scope.length) await this.opened();
    // The new settings may now meet the requirement.
    if (this.requirement && !this.requirement.meets) await this.refresh();
    return saved;
  };

  signOut = () => this.options.signOut();
}
