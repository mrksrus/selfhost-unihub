// This person's devices (F5) and this device's app lock settings and reports
// (/api/devices, /api/settings/values/device). A device is this browser
// profile, installed web app or Android app installation for one person; the
// server knows it by the key below and keeps its lock settings with it.
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import { isStandaloneDisplay } from '@/lib/install-prompt';
import { androidApp, describeUserAgent } from '@/lib/platform';
import { DEFAULT_DEVICE_SETTINGS, defaultsResolved } from '@/lib/settings-defaults';
import type {
  CurrentDeviceResponse, DeviceBinding, DeviceKind, DeviceKeyRequest, DeviceLockReport, DeviceLockStateRequest, DeviceSummary, DevicesResponse,
} from '../../api/src/contracts/devices';
import type { DeviceSettingsResponse, DeviceSettingValues, ResolvedSettings } from '../../api/src/contracts/settings';

export type {
  AppLockApplied, AppLockArea, AppLockCompliance, AppLockRequiredDetails, CurrentDeviceResponse, DeviceCapabilities, DeviceKind, DeviceSummary, LockMethod, RelockAfter,
} from '../../api/src/contracts/devices';
export type DeviceSettings = ResolvedSettings<DeviceSettingValues>;

// ── The device key ───────────────────────────────────────────────
// 32 random bytes, made once per browser profile and origin. Not a
// credential (the session cookie authenticates): it only lets the server
// recognise this device again at the next sign-in. The Android app's
// WebView has its own storage, so the app is a device of its own.
export const DEVICE_KEY_STORAGE = 'unihub:device-key';

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** This browser's device key, made on first use; null where storage is off. */
export function deviceKey(): string | null {
  try {
    const stored = localStorage.getItem(DEVICE_KEY_STORAGE);
    if (stored && /^[\w-]{43}$/.test(stored)) return stored;
    const key = base64url(crypto.getRandomValues(new Uint8Array(32)));
    localStorage.setItem(DEVICE_KEY_STORAGE, key);
    return localStorage.getItem(DEVICE_KEY_STORAGE) === key ? key : null;
  } catch { return null; }
}

/** How UniHub runs here. The server takes `android` from the app's user agent only. */
export function deviceKind(): DeviceKind {
  if (androidApp()) return 'android';
  return isStandaloneDisplay() ? 'pwa' : 'web';
}

/** The `device` field of sign-in, sign-up and two-factor sign-in; undefined without a key. */
export function deviceBinding(): DeviceBinding | undefined {
  const key = deviceKey();
  return key ? { key, kind: deviceKind() } : undefined;
}

/** POST /api/devices/current/key: a session from before 0.29 takes this device's key (and joins the device that has it). */
export async function adoptDeviceKey() {
  const key = deviceKey();
  if (!key) return;
  unwrap(await api.post('/devices/current/key', { key } satisfies DeviceKeyRequest));
}

// ── Devices ──────────────────────────────────────────────────────

export const devicesQueryKey = ['devices'] as const;
export const currentDeviceQueryKey = ['devices', 'current'] as const;

export async function fetchDevices(signal?: AbortSignal): Promise<DeviceSummary[]> {
  return unwrap(await api.get<DevicesResponse>('/devices', { signal }))?.devices ?? [];
}

export const devicesQueryOptions = queryOptions({
  queryKey: devicesQueryKey,
  queryFn: ({ signal }) => fetchDevices(signal),
});

/** Signs another of the person's devices out (404 DEVICE_NOT_FOUND, 400 DEVICE_CURRENT for this one: use sign-out). */
export async function removeDevice(id: string) {
  unwrap(await api.delete(`/devices/${encodeURIComponent(id)}`));
}

export async function fetchCurrentDevice(signal?: AbortSignal): Promise<CurrentDeviceResponse> {
  const answer = unwrap(await api.get<CurrentDeviceResponse>('/devices/current', { signal }));
  if (!answer?.device || !answer.compliance) throw new Error('The server did not describe this device.');
  return { ...answer, settings: { ...defaultsResolved(DEFAULT_DEVICE_SETTINGS), ...answer.settings } };
}

/** "UniHub app 0.29.0 on Android", "Firefox on Linux". */
export function deviceLabel(device: Pick<DeviceSummary, 'kind' | 'app_version' | 'user_agent'>) {
  const label = describeUserAgent(device.user_agent);
  if (device.kind === 'android' && device.app_version) return label.replace(/^UniHub app\b/, `UniHub app ${device.app_version}`);
  return label;
}

// ── This device's lock settings (F1 `device` scope) ──────────────

export const deviceSettingsQueryKey = ['settings', 'values', 'device'] as const;

export async function fetchDeviceSettings(signal?: AbortSignal): Promise<DeviceSettings> {
  const answer = unwrap(await api.get<DeviceSettingsResponse>('/settings/values/device', { signal }));
  return { ...defaultsResolved(DEFAULT_DEVICE_SETTINGS), ...answer?.settings };
}

/** Saves the changed values only (403 POLICY_FLOOR below the administrator's minimum); the answer is every setting as now resolved. */
export async function saveDeviceSettings(values: Partial<DeviceSettingValues>): Promise<DeviceSettings> {
  const answer = unwrap(await api.put<DeviceSettingsResponse>('/settings/values/device', { values }));
  return { ...defaultsResolved(DEFAULT_DEVICE_SETTINGS), ...answer?.settings };
}

// ── Reports ──────────────────────────────────────────────────────
// What this device enforces, and whether it is open now. The server takes
// the device's word (a modified page can lie) and uses it for the required
// lock and to hide notification text while the device is locked.

/** PUT /api/devices/current/lock. */
export async function reportDeviceLock(report: DeviceLockReport) {
  unwrap(await api.put('/devices/current/lock', report));
}

/** POST /api/devices/current/lock-state. `keepalive` lets the report outlive a page that is closing. */
export async function reportLockState(state: DeviceLockStateRequest['state'], { keepalive = false } = {}) {
  unwrap(await api.post('/devices/current/lock-state', { state } satisfies DeviceLockStateRequest, { keepalive }));
}
