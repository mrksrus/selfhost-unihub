// Request and response shapes of the device routes (F5, F11). The frontend
// imports these as types only; services/devices.ts owns the devices table.
//
// A device is one browser profile, installed web app or Android app
// installation of one person. Its sessions, push channels, app lock and
// reported lock state hang off the device record, never off a session token
// or a push endpoint. Devices are installation state: never in a personal
// backup, never restored.

/** How UniHub runs on the device. `android` is taken from the app's user agent only. */
export type DeviceKind = 'web' | 'pwa' | 'android';

/** What can lock UniHub on the device: the phone's biometrics, the phone's own PIN, or a UniHub PIN kept on the device. */
export type LockMethod = 'biometric' | 'device_credential' | 'pin';

/**
 * What the app lock covers: the whole app, or modules by id (the module
 * catalog's: mail, contacts, calendar for Calendar and ToDo, recordings for
 * Recordings and Music). An empty list is off; `app` stands alone.
 */
export type AppLockArea = 'app' | 'mail' | 'contacts' | 'calendar' | 'recordings';

/** Seconds in the background before UniHub locks again; '0' is every time it opens. */
export type RelockAfter = '0' | '60' | '300' | '900';

/** What the device reports it can do; the server stores it as reported. */
export interface DeviceCapabilities {
  /** The best lock the device offers now; 'none' when it has none. */
  lock: LockMethod | 'none';
  /** The window can refuse screenshots and screen recording (Android FLAG_SECURE). */
  secure_window: boolean;
  /** The recent-apps picture can be hidden. */
  recents_hidden: boolean;
  /** The device can tell when its screen locks. */
  device_lock_signal: boolean;
}

/** What the device enforces now, as it reports it. The server takes its word: a modified app can lie. */
export interface AppLockApplied {
  scope: AppLockArea[];
  relock_after: RelockAfter;
  on_device_lock: boolean;
  method: LockMethod;
}

/** One of the person's devices, for Settings → Security → Devices. */
export interface DeviceSummary {
  id: string;
  /** The device this request came from. */
  current: boolean;
  kind: DeviceKind;
  /** The Android app's version; null in a browser. */
  app_version: string | null;
  /** The latest session's user agent, for the label. */
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  /** The app lock the device reported; null while it reports none. */
  lock: Pick<AppLockApplied, 'scope' | 'method'> | null;
  /** The device has a push channel. */
  notifications: boolean;
}

/** GET /api/devices: the person's devices with a live session, the current one first. */
export interface DevicesResponse { devices: DeviceSummary[] }

/** The device fields sign-in, sign-up and two-factor sign-in take (optional; pages before 0.29 send none). */
export interface DeviceBinding {
  /** 32 random bytes as base64url, kept by the device; not a credential, stored hashed. */
  key: string;
  kind: DeviceKind;
}

/** POST /api/devices/current/key: the device's key, for a session from before 0.29. */
export interface DeviceKeyRequest { key: string }

/** PUT /api/devices/current/lock: what the device enforces now and can do. */
export interface DeviceLockReport { applied: AppLockApplied | null; capabilities: DeviceCapabilities }

/** POST /api/devices/current/lock-state: open (unlocked, in use), background (hidden) or locked. */
export interface DeviceLockStateRequest { state: 'open' | 'background' | 'locked' }

/** Whether the device meets the app lock the person's policies require. */
export interface AppLockCompliance {
  meets: boolean;
  /** The areas the policies require; empty when none is required. */
  required: AppLockArea[];
  /** The longest time in the background the policies allow; null without a limit. */
  max_background: RelockAfter | null;
  /** The administrator's reason in plain words; null when nothing is required. */
  reason: string | null;
}

/**
 * The details of 403 APP_LOCK_REQUIRED: the route needs an app lock the
 * device does not report. The page shows the set-up prompt.
 */
export type AppLockRequiredDetails = Omit<AppLockCompliance, 'meets'>;
