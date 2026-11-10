// The app lock of this device (0.29, F5/F8), as the screens see it. The
// logic lives in AppLockProvider (src/contexts/AppLockProvider.tsx) and
// src/lib/app-lock/; this file is the contract the lock screen, the
// required prompt, Settings → App lock and the module gates build on.
//
// The provider is mounted inside SessionQueryProvider, so it is keyed by the
// account: an account switch or a sign-out ends its state and nothing of it
// reaches the next account. Its answer is the same for the web PIN and for
// the Android app's fingerprint, face or phone PIN; only `method` differs.
import { createContext, useContext } from 'react';
import type { AppLockArea, AppLockRequiredDetails, LockMethod } from '../../api/src/contracts/devices';
import type { DeviceSettingValues, ResolvedSettings } from '../../api/src/contracts/settings';
import { DEFAULT_DEVICE_SETTINGS, defaultsResolved } from '@/lib/settings-defaults';

export type { AppLockArea, LockMethod, RelockAfter } from '../../api/src/contracts/devices';
export type DeviceSettings = ResolvedSettings<DeviceSettingValues>;

/**
 * - `checking`: the lock's state is not known yet (a few milliseconds while
 *   this device's records load). Show no private view, and no lock screen
 *   either: a neutral loading state.
 * - `off`: nothing is locked on this device.
 * - `locked`: the lock is on and this tab is locked. Show the lock screen in
 *   place of what `locked(area)` names.
 * - `unlocked`: the lock is on and this tab was unlocked; it locks again
 *   after the time in the background the settings name.
 * - `setup`: the lock is on or required, and nothing can unlock it on this
 *   device yet (a new sign-in after "Forgot PIN", a phone without a screen
 *   lock). Show the set-up prompt in place of what `locked(area)` names.
 */
export type AppLockStatus = 'checking' | 'off' | 'locked' | 'unlocked' | 'setup';

/** The web PIN's attempt state, for the lock screen. */
export interface AppLockPinState {
  /** Wrong PINs since the last unlock, shared by this person's tabs. */
  failures: number;
  /** No PIN is taken until then (ms since the epoch); null without a wait. Count down to it. */
  waitUntil: number | null;
  /** Tries left before a wrong PIN signs out; null until the warning is due (from the 7th wrong PIN). */
  attemptsLeft: number | null;
}

/** What can unlock UniHub on this device. */
export interface AppLockMethodState {
  /**
   * What unlocks now: the phone's biometrics or its own PIN in an Android app
   * with bridge level 3, otherwise a UniHub PIN (the web, older apps, and
   * phones without a screen lock).
   */
  method: LockMethod;
  /** Android only: whether a fingerprint or face is set up; 'none' on the web. */
  biometric: 'available' | 'not_enrolled' | 'none';
  /** Android only: the phone has a screen lock. Without one the app offers "Set a screen lock in Android settings" or a UniHub PIN. */
  deviceSecure: boolean;
  /** A UniHub PIN is set for this person on this device. */
  pinSet: boolean;
  /** Why a UniHub PIN cannot be used in this browser (no WebCrypto or IndexedDB, for example over plain HTTP); null when it can. */
  pinUnavailable: string | null;
  /** In an Android app older than the fingerprint unlock: say "Update the UniHub app to unlock with your fingerprint". */
  appUpdateForBiometrics: boolean;
}

/** What this device can do beyond the lock itself; a control it cannot do is greyed with the reason. */
export interface AppLockCapabilities {
  /** "Also when the device locks" works here. */
  deviceLockSignal: boolean;
  /** Why it does not, in plain words; null when it does. */
  deviceLockReason: string | null;
  /** The app can block screenshots (Android); browsers cannot. */
  secureWindow: boolean;
}

/** The administrator's requirement as it applies to this device. */
export interface AppLockRequirement extends AppLockRequiredDetails {
  /** The device reports a lock that covers the requirement. When false, show the required prompt (after the rules notice). */
  meets: boolean;
}

export type UnlockFailure =
  /** A wrong PIN; `pin` has the new counts and any wait. */
  | { ok: false; reason: 'wrong'; pin: AppLockPinState }
  /** Too many wrong PINs: wait until `pin.waitUntil`. Nothing was checked. */
  | { ok: false; reason: 'wait'; pin: AppLockPinState }
  /** Not 6 to 12 digits; nothing was counted. */
  | { ok: false; reason: 'invalid' }
  /** The last allowed wrong PIN: the device is being signed out. */
  | { ok: false; reason: 'signed-out' }
  /** No UniHub PIN is set (set one up first). */
  | { ok: false; reason: 'no-pin' }
  /** Android: the person closed the prompt, the phone locked its biometrics after too many tries, or the prompt could not open. */
  | { ok: false; reason: 'cancelled' | 'lockout' | 'unavailable' }
  /** Android: this phone unlocks with a UniHub PIN; show the PIN field and call again with the PIN. */
  | { ok: false; reason: 'pin-needed' };
export type UnlockResult = { ok: true } | UnlockFailure;

export type SetPinResult =
  | { ok: true }
  /** Not 6 to 12 digits. */
  | { ok: false; reason: 'invalid' }
  /** A PIN is set and `currentPin` was missing or wrong (counted like an unlock). */
  | UnlockFailure
  /** The browser cannot keep a PIN (see `method.pinUnavailable`). */
  | { ok: false; reason: 'unsupported' };

export interface AppLockValue {
  status: AppLockStatus;
  /**
   * Whether `area` is locked in this tab now. `locked('app')` is true for the
   * whole-app lock only; a module is locked by the whole-app lock or by its
   * own. Always false while `off` or `unlocked`; true for everything the lock
   * covers while `locked` or `setup`, and for everything while `checking`.
   */
  locked(area: AppLockArea): boolean;
  /** What the lock covers on this device ([] off, ['app'] the whole app), as the server resolved it with the policy floor. */
  scope: AppLockArea[];
  /** This device's settings as the server resolved them: values, sources, locks and floors. Defaults until they load. */
  settings: DeviceSettings;
  settingsLoaded: boolean;
  method: AppLockMethodState;
  capabilities: AppLockCapabilities;
  pin: AppLockPinState;
  /** Null while nothing is required. */
  requirement: AppLockRequirement | null;
  /** The administrator does not allow screenshots in the Android app (shown as a read-only row). */
  screenshotsForbidden: boolean;
  /** The lock was on here, but its PIN is gone and this is not a fresh sign-in: only "Forgot PIN? Sign out" can continue. */
  pinLost: boolean;

  /**
   * Unlocks this tab: with the PIN on the web (and in apps that use one), or
   * with the phone's own prompt in the Android app (call without a PIN; the
   * answer `pin-needed` asks for one). One unlock opens every locked module
   * until the next relock.
   */
  unlock(pin?: string): Promise<UnlockResult>;
  /**
   * Checks the person without changing the tab's state, before a weakening
   * change (turning the lock off, a longer time, fewer modules, changing the
   * PIN) and before turning the Android lock on. `saveSettings` refuses a
   * weakening change without a confirmation in the last minute.
   */
  confirm(pin?: string): Promise<UnlockResult>;
  /** Locks this tab now (and tells the server the device is locked). */
  lockNow(): void;
  /** Sets the UniHub PIN; a PIN already set needs `currentPin`. Six to twelve digits; the screen asks twice. */
  setPin(pin: string, currentPin?: string): Promise<SetPinResult>;
  /**
   * Saves this device's lock settings on the server and applies them. Rejects
   * with the server's error (403 POLICY_FLOOR carries its reason) or when a
   * weakening change was not confirmed. Turning the lock on needs a method
   * first: a PIN on the web, or `confirm()` in the Android app.
   */
  saveSettings(patch: Partial<DeviceSettingValues>): Promise<DeviceSettings>;
  /** "Forgot PIN? Sign out": the full sign-out, which removes this device's offline copy and PIN and keeps unsent recordings. */
  signOut(): Promise<void>;
}

const NO_PIN: AppLockPinState = { failures: 0, waitUntil: null, attemptsLeft: null };
const off = async () => ({ ok: false, reason: 'no-pin' }) as const;

/** Outside a provider (signed-out pages, unit tests of a single view): no lock. */
export const NO_APP_LOCK: AppLockValue = {
  status: 'off',
  locked: () => false,
  scope: [],
  settings: defaultsResolved(DEFAULT_DEVICE_SETTINGS),
  settingsLoaded: false,
  method: { method: 'pin', biometric: 'none', deviceSecure: false, pinSet: false, pinUnavailable: null, appUpdateForBiometrics: false },
  capabilities: { deviceLockSignal: false, deviceLockReason: null, secureWindow: false },
  pin: NO_PIN,
  requirement: null,
  screenshotsForbidden: false,
  pinLost: false,
  unlock: off,
  confirm: off,
  lockNow: () => {},
  setPin: async () => ({ ok: false, reason: 'unsupported' }),
  saveSettings: async () => { throw new Error('The app lock is not available here.'); },
  signOut: async () => {},
};

export const AppLockContext = createContext<AppLockValue>(NO_APP_LOCK);

/** The app lock of this device for the signed-in person. */
export function useAppLock() {
  return useContext(AppLockContext);
}
