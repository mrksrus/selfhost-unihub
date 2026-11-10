// The device boundary. Everything that works differently in the browser and in
// the Android app (android/) goes through this module or the wrappers it names
// below, so features never check which platform they run on. Each function has
// a web implementation and, where it differs, an Android one (or an explicit
// "not available").
//
// Already wrapped elsewhere, one place each:
// - browser notifications, push subscription and service worker messages:
//   utils/service-worker.ts (the Android app's own notifications are
//   `appNotifications` below; Web Push does not work in its WebView)
// - app updates: lib/pwa-update.ts and the update item in hooks/use-attention.ts
// - install offer: lib/install-prompt.ts and components/pwa/InstallPrompt.tsx
// - offline copy on this device: lib/offline.ts
// - in-page events between components: lib/app-events.ts

import type { AppLockArea, LockMethod } from '../../api/src/contracts/devices';
import { createWebDeviceLock, subscribeVisibility } from '@/lib/app-lock/web';

// ── The Android app ───────────────────────────────────────────────
// The app shows these same pages in a WebView. It adds "UniHubAndroid/<version>
// (<code>)" to the user agent and gives the server's own top-level page a
// `UniHubAndroid` object to post JSON messages to (android/.../WebBridge.kt).

export const ANDROID_PACKAGE = 'io.github.mrksrus.unihub';

// Replies from the app arrive as "message" events on the same object.
interface AndroidBridge {
  postMessage(message: string): void;
  addEventListener?(type: 'message', listener: (event: { data: string }) => void): void;
  removeEventListener?(type: 'message', listener: (event: { data: string }) => void): void;
}
declare global { interface Window { UniHubAndroid?: AndroidBridge } }

export interface AndroidApp { versionName: string; versionCode: number }

/** The Android app this page runs in, or null in a browser. */
export function androidApp(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): AndroidApp | null {
  const match = /UniHubAndroid\/([\w.-]+) \((\d+)\)/.exec(userAgent);
  return match ? { versionName: match[1], versionCode: Number(match[2]) } : null;
}

/**
 * The messages the app's bridge understands (MainActivity.BRIDGE_LEVEL, sent
 * as "UniHubBridge/<level>" in the user agent): 1 for apps up to 0.24, which do
 * not say, 2 from 0.25 (file actions). 0 outside the app.
 */
export function appBridgeLevel(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
  if (!androidApp(userAgent)) return 0;
  const match = /UniHubBridge\/(\d+)/.exec(userAgent);
  return match ? Number(match[1]) : 1;
}

/**
 * An Android browser, where the app can be installed (not the app itself).
 * The app needs Android 10 (android/app/build.gradle.kts, minSdk 29). Newer
 * Chrome reports every version as "Android 10", so only older versions that
 * say so are left out; the install steps name the requirement.
 */
export function canInstallAndroidApp(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
  const version = /Android (\d+)/i.exec(userAgent);
  if (version && Number(version[1]) < 10) return false;
  return /Android/i.test(userAgent) && !androidApp(userAgent);
}

function postToApp(message: Record<string, unknown>) {
  const bridge = androidApp() ? window.UniHubAndroid : undefined;
  if (!bridge) return false;
  bridge.postMessage(JSON.stringify(message));
  return true;
}

/**
 * Opens the Android app from the browser and connects it to this server
 * (unihub://connect, android/.../MainActivity.kt). Without the app installed,
 * the browser downloads it instead.
 */
export function openInAndroidAppHref(apkUrl: string, origin = window.location.origin) {
  const fallback = new URL(apkUrl, origin).href;
  return `intent://connect?server=${encodeURIComponent(origin)}#Intent;scheme=unihub;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

/** In the Android app: forget this server and show the connect screen. */
export function changeAppServer() {
  postToApp({ type: 'changeServer' });
}

/** In the Android app: colours the status and navigation bars like the page. */
export function showThemeInApp(dark: boolean, background: string) {
  postToApp({ type: 'theme', dark, background });
}

/**
 * Saves data created in the page (an attachment, an export) as a file on this
 * device. Rejects when the file could not be handed over.
 */
export async function saveFile(blob: Blob, filename: string) {
  const bridge = androidApp() ? window.UniHubAndroid : undefined;
  if (bridge) {
    // A WebView cannot download blob: URLs; the app writes the file to Downloads.
    await sendFileToApp(bridge, blob, filename);
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    startDownload(url, filename);
  } finally {
    // Revoke after the click has been handled; some browsers read the URL asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// Files go to the app in pieces, each confirmed before the next, so a large
// recording never becomes one huge string or piles up in the app's memory.
const FILE_CHUNK_BYTES = 1536 * 1024;
const APP_REPLY_TIMEOUT_MS = 60_000;

// A question to the app carries an id; the app answers with the same id, `ok`
// and, depending on the question, more fields.
interface AppReply { id?: string; ok?: boolean; error?: string; [key: string]: unknown }
const appReplies = new Map<string, (reply: AppReply | null) => void>();
let listening: AndroidBridge | null = null;

/**
 * Posts a message with an id and resolves with the app's reply once `ok` is
 * true. Rejects with the app's `error` text, or `failure`, when the app says
 * no or does not answer in time.
 */
function askApp(bridge: AndroidBridge, message: { type: string; id: string } & Record<string, unknown>, { timeoutMs = APP_REPLY_TIMEOUT_MS, failure }: { timeoutMs?: number; failure: string }) {
  if (listening !== bridge) {
    listening = bridge;
    bridge.addEventListener?.('message', event => {
      try {
        const reply = JSON.parse(event.data) as AppReply;
        if (reply && typeof reply === 'object' && reply.id) appReplies.get(reply.id)?.(reply);
      } catch { /* Not a reply. */ }
    });
  }
  return new Promise<AppReply>((resolve, reject) => {
    const timer = setTimeout(() => settle(null), timeoutMs);
    function settle(reply: AppReply | null) {
      clearTimeout(timer);
      appReplies.delete(message.id);
      if (reply?.ok === true) resolve(reply);
      else reject(new Error(typeof reply?.error === 'string' && reply.error ? reply.error : failure));
    }
    appReplies.set(message.id, settle);
    bridge.postMessage(JSON.stringify(message));
  });
}

async function sendFileToApp(bridge: AndroidBridge, blob: Blob, filename: string) {
  const id = crypto.randomUUID();
  const failure = 'The app could not save the file';
  try {
    // A start that times out may still open the file later; the abort closes it.
    await askApp(bridge, { type: 'saveFileStart', id, name: filename, mime: blob.type }, { failure });
    for (let offset = 0; offset < blob.size; offset += FILE_CHUNK_BYTES) {
      const data = await blobBase64(blob.slice(offset, offset + FILE_CHUNK_BYTES));
      await askApp(bridge, { type: 'saveFileChunk', id, data }, { failure });
    }
    await askApp(bridge, { type: 'saveFileEnd', id }, { failure });
  } catch (error) {
    bridge.postMessage(JSON.stringify({ type: 'saveFileAbort', id }));
    throw error;
  }
}

// ── Notifications in the app ──────────────────────────────────────
// Web Push does not reach a WebView, so from 0.22.1 the app holds its own
// connection to the server and shows notifications itself. The page only asks
// the app to turn that on or off and reads its state; the server side uses the
// same /api/notifications routes with the endpoint the app reports.

/** The first app (versionCode) that answers "notifications" messages. Older apps ignore them silently. */
export const APP_NOTIFICATIONS_MIN_VERSION_CODE = 22001;

export interface AppNotificationState {
  /** On for this server and the signed-in user on this phone. */
  enabled: boolean;
  /** "unihub-android:<device id>" while registered; the endpoint for /api/notifications/status and /test. */
  endpoint: string | null;
  /** Android's permission to show notifications. */
  permission: 'granted' | 'denied' | 'default';
  /** Whether Android lets the app keep its connection in the background (battery optimisation exemption). */
  background: 'allowed' | 'restricted';
  /** The app currently holds a connection to the server. */
  connected: boolean;
}

export interface AppNotifications {
  /** The current state, without any prompt. */
  status(): Promise<AppNotificationState>;
  /** Asks for the permission if needed, registers this phone and starts the connection; may take as long as the system dialogs. */
  enable(): Promise<AppNotificationState>;
  /** Unregisters, stops the connection and removes shown notifications. */
  disable(): Promise<AppNotificationState>;
  /** Asks Android to let the app run in the background; answers once the person has answered Android. */
  background(): Promise<AppNotificationState>;
}

// Turning on and the background question wait for Android's dialogs.
const DIALOG_REPLY_TIMEOUT_MS = 120_000;

/** Native notifications of the Android app, or null in a browser or in an app older than 0.22.1. */
export function appNotifications(): AppNotifications | null {
  const app = androidApp();
  const bridge = app && app.versionCode >= APP_NOTIFICATIONS_MIN_VERSION_CODE ? window.UniHubAndroid : undefined;
  if (!bridge) return null;
  const ask = async (action: 'status' | 'enable' | 'disable' | 'background', timeoutMs?: number) => {
    const reply = await askApp(bridge, { type: 'notifications', id: crypto.randomUUID(), action }, { timeoutMs, failure: 'The app did not answer. Try again.' });
    return readNotificationState(reply.state);
  };
  return {
    status: () => ask('status'),
    enable: () => ask('enable', DIALOG_REPLY_TIMEOUT_MS),
    disable: () => ask('disable'),
    background: () => ask('background', DIALOG_REPLY_TIMEOUT_MS),
  };
}

/**
 * In a 0.22.1+ app whose WebView is too old for the message bridge (WebView
 * before about 80, never updated): the page cannot reach the app, which asks
 * about notifications itself after sign-in instead.
 */
export function appWithoutBridge() {
  const app = androidApp();
  return !!app && app.versionCode >= APP_NOTIFICATIONS_MIN_VERSION_CODE && !window.UniHubAndroid;
}

/** In an Android app older than 0.22.1, which has no notifications of its own yet. */
export function appNeedsUpdateForNotifications() {
  const app = androidApp();
  return !!app && app.versionCode < APP_NOTIFICATIONS_MIN_VERSION_CODE;
}

function readNotificationState(value: unknown): AppNotificationState {
  const state = value as Partial<AppNotificationState> | null | undefined;
  if (!state || typeof state !== 'object' || typeof state.enabled !== 'boolean') throw new Error('The app sent an unexpected answer. Update the app and try again.');
  return {
    enabled: state.enabled,
    endpoint: typeof state.endpoint === 'string' && state.endpoint ? state.endpoint : null,
    permission: state.permission === 'granted' || state.permission === 'denied' ? state.permission : 'default',
    background: state.background === 'restricted' ? 'restricted' : 'allowed',
    connected: state.connected === true,
  };
}

// ── App lock ──────────────────────────────────────────────────────
// What locks UniHub on this device (0.29): the Android app's own prompt
// (fingerprint, face or the phone's PIN, bridge level 3) or the UniHub PIN in
// the page (src/lib/app-lock/). The lock's logic is the same for both
// (contexts/AppLockProvider.tsx); only this boundary knows which one runs.

export type { LockMethod } from '../../api/src/contracts/devices';

/** The first bridge level with the `appLock` messages (android/.../AppLock.kt). */
export const APP_LOCK_BRIDGE_LEVEL = 3;

export interface DeviceLockMethod {
  method: LockMethod;
  biometric: 'available' | 'not_enrolled' | 'none';
  /** The phone has a screen lock (Android KeyguardManager.isDeviceSecure); false on the web. */
  deviceSecure: boolean;
}

export type DeviceLockAuthentication = 'ok' | 'cancelled' | 'lockout' | 'unavailable' | 'pin';

export interface DeviceLockConfig {
  /** The person the lock is for; the app keeps its configuration per server and person. */
  userId: string;
  /** What the lock covers ([] off, ['app'] the whole app): the app hides notification text of a locked module with it. */
  scope: AppLockArea[];
  relockAfterMs: number;
  onDeviceLock: boolean;
  /** The administrator forbids screenshots: the app sets FLAG_SECURE. */
  blockScreenshots: boolean;
}

export interface DeviceLockState {
  /**
   * In the app: whether the lock is due now, by the app's own monotonic clock
   * (a fresh start, longer in the background than the setting, or the screen
   * locked with "Also when the device locks"), and no native unlock lifted the
   * cover since. Null on the web, where the page decides from its timeline.
   */
  due: boolean | null;
  /** How long the page or app was last in the background, or null if it has not been since it started. */
  hiddenForMs: number | null;
  /** The device's screen locked while UniHub was in the background (only where `capabilities.deviceLockSignal`). */
  deviceLockedSinceHidden: boolean;
  /** This is the first state since the app process (or, on the web, the page) started. */
  freshProcess: boolean;
  /** When the app's own cover last unlocked with the native prompt (Date.now() clock), or null. */
  authenticatedAt: number | null;
}

/**
 * What the device tells the page without being asked: UniHub went to the
 * background or came back, and, in the app, its own lock locked (a return
 * that was due) or its cover unlocked with the native prompt.
 */
export type DeviceLockEvent = 'hidden' | 'visible' | 'locked' | 'unlocked';

export interface DeviceLockCapabilities { secureWindow: boolean; hideRecents: boolean; deviceLockSignal: boolean }

export interface DeviceLock {
  /** Also refreshes `capabilities` from the app's answer. */
  method(): Promise<DeviceLockMethod>;
  /** The native prompt; resolves 'pin' where the page asks for its UniHub PIN instead (the web, apps without a screen lock). */
  authenticate(reason: string): Promise<DeviceLockAuthentication>;
  /**
   * The app caches the configuration and sets FLAG_SECURE and the hidden
   * recents picture; the web keeps it for its own timing. Sent at every start
   * after sign-in, also with the lock off: FLAG_SECURE follows
   * `blockScreenshots` on its own.
   */
  configure(config: DeviceLockConfig): Promise<void>;
  state(): Promise<DeviceLockState>;
  /**
   * The page shows the outcome of a check: its lock screen (`unlocked`
   * false) or an open view after an unlock (true). The app lifts its cover,
   * and with `unlocked` it stops counting as locked (a UniHub PIN unlock the
   * app could not see itself).
   */
  release(unlocked: boolean): Promise<void>;
  /** Locks now ("Lock now", a relock, sign-out): the app hides notification text at once. */
  lock(): Promise<void>;
  /** Calls `listener` for each DeviceLockEvent. Returns the unsubscribe function. */
  subscribe(listener: (event: DeviceLockEvent) => void): () => void;
  /** What the device can do; in the app, as it last answered (`hideRecents` needs Android 13). */
  capabilities: DeviceLockCapabilities;
}

let webLock: DeviceLock | null = null;
let nativeLock: { bridge: AndroidBridge; lock: DeviceLock } | null = null;

/** The app lock of this device: the Android app's from bridge level 3, otherwise the page's own. */
export function deviceLock(): DeviceLock {
  const bridge = appBridgeLevel() >= APP_LOCK_BRIDGE_LEVEL ? window.UniHubAndroid : undefined;
  if (bridge) {
    if (nativeLock?.bridge !== bridge) nativeLock = { bridge, lock: createNativeDeviceLock(bridge) };
    return nativeLock.lock;
  }
  webLock ??= createWebDeviceLock();
  return webLock;
}

/** In an Android app with the message bridge but older than the native app lock: the page offers its PIN and "Update the app". */
export function appLacksNativeLock() {
  const level = appBridgeLevel();
  return level > 0 && level < APP_LOCK_BRIDGE_LEVEL;
}

// The prompt waits for the person; the other questions answer at once.
const APP_LOCK_PROMPT_TIMEOUT_MS = 5 * 60_000;
const APP_LOCK_TIMEOUT_MS = 10_000;

function createNativeDeviceLock(bridge: AndroidBridge): DeviceLock {
  const ask = (action: string, fields: Record<string, unknown> = {}, timeoutMs = APP_LOCK_TIMEOUT_MS) =>
    askApp(bridge, { type: 'appLock', id: crypto.randomUUID(), action, ...fields }, { timeoutMs, failure: 'The app did not answer. Try again.' });
  // Until the app answers: what every app with bridge level 3 can do; the
  // recents picture can be hidden from Android 13 only.
  const capabilities: DeviceLockCapabilities = { secureWindow: true, hideRecents: false, deviceLockSignal: true };
  const readCapabilities = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const reported = value as Partial<Record<keyof DeviceLockCapabilities, unknown>>;
    for (const key of ['secureWindow', 'hideRecents', 'deviceLockSignal'] as const) {
      if (typeof reported[key] === 'boolean') capabilities[key] = reported[key];
    }
  };
  return {
    async method() {
      const reply = await ask('method');
      readCapabilities(reply.capabilities);
      return {
        method: reply.method === 'biometric' || reply.method === 'device_credential' ? reply.method : 'pin',
        biometric: reply.biometric === 'available' || reply.biometric === 'not_enrolled' ? reply.biometric : 'none',
        deviceSecure: reply.deviceSecure === true,
      };
    },
    async authenticate(reason) {
      const reply = await ask('authenticate', { reason }, APP_LOCK_PROMPT_TIMEOUT_MS).catch(() => null);
      const result = reply?.result;
      return result === 'ok' || result === 'cancelled' || result === 'lockout' || result === 'pin' ? result : 'unavailable';
    },
    async configure(config) {
      const reply = await ask('configure', { ...config, on: config.scope.length > 0 });
      readCapabilities(reply.capabilities);
    },
    async state() {
      const reply = await ask('state');
      return {
        due: typeof reply.due === 'boolean' ? reply.due : true,
        hiddenForMs: typeof reply.hiddenForMs === 'number' ? reply.hiddenForMs : null,
        deviceLockedSinceHidden: reply.deviceLockedSinceHidden === true,
        freshProcess: reply.freshProcess === true,
        authenticatedAt: typeof reply.authenticatedAt === 'number' ? reply.authenticatedAt : null,
      };
    },
    async release(unlocked) { await ask('release', { unlocked }); },
    async lock() { await ask('lock'); },
    subscribe(listener) {
      const stopVisibility = subscribeVisibility(listener);
      let subscribed = true;
      // The app's own news: an appLock message without an id.
      const onMessage = (event: { data: string }) => {
        if (!subscribed) return;
        try {
          const message = JSON.parse(event.data) as { type?: unknown; id?: unknown; event?: unknown };
          if (message?.type === 'appLock' && message.id === undefined && (message.event === 'locked' || message.event === 'unlocked')) listener(message.event);
        } catch { /* Not a message for the lock. */ }
      };
      bridge.addEventListener?.('message', onMessage);
      return () => {
        subscribed = false;
        stopVisibility();
        bridge.removeEventListener?.('message', onMessage);
      };
    },
    capabilities,
  };
}

// ── Describing a device ──────────────────────────────────────────

const BROWSERS: [RegExp, string][] = [
  [/UniHubAndroid\//, 'UniHub app'], [/Edg\//, 'Edge'], [/OPR\//, 'Opera'], [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'], [/Safari\//, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [
  [/UniHubAndroid\/|Android/, 'Android'], [/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Windows/, 'Windows'], [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'], [/Linux/, 'Linux'],
];

/** "Firefox on Linux" or "UniHub app on Android" from a user agent, enough to recognise a device. */
export function describeUserAgent(userAgent: string | null | undefined) {
  if (!userAgent) return 'Unknown device';
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser || system || 'Unknown device';
}

// ── Files in the app: Open with, Save to Downloads, Share ────────
// The page gets a download ticket (lib/file-tickets-api.ts) and hands its URL
// to the app, which fetches the file without the session cookie and passes it
// to Android's own chooser or to Downloads (android/.../FileActions.kt).

export type AppFileAction = 'open' | 'save' | 'share';
export interface AppFile { url: string; name: string; type: string }
export interface AppFileActions {
  /** Resolves once Android has the file (the chooser is open, or it is saved); rejects with the app's reason. */
  run(action: AppFileAction, file: AppFile): Promise<void>;
}

// The app downloads the whole file before it answers.
const FILE_ACTION_TIMEOUT_MS = 10 * 60_000;

/** The Android app's file actions, or null in a browser and in apps before 0.25. */
export function appFileActions(): AppFileActions | null {
  const bridge = appBridgeLevel() >= 2 ? window.UniHubAndroid : undefined;
  if (!bridge) return null;
  return {
    run: async (action, file) => {
      await askApp(bridge, { type: 'fileAction', id: crypto.randomUUID(), action, url: new URL(file.url, window.location.href).href, name: file.name, mime: file.type },
        { timeoutMs: FILE_ACTION_TIMEOUT_MS, failure: 'The app could not get the file. Try again.' });
    },
  };
}

/**
 * Downloads a file through its ticket URL (lib/file-tickets-api.ts): backups
 * and other large files the server streams. The browser fetches it directly,
 * outside the service worker, so it never passes through page memory; in the
 * app the system download manager fetches it, and the ticket means the
 * session cookie never leaves the page (F9). Apps before 0.28 still attach
 * the cookie to the ticket URL; the server ignores it.
 */
export function downloadTicket({ url, filename }: { url: string; filename: string }) {
  downloadFromServer(url, filename);
}

/**
 * Downloads a public file the server serves without a session (the Android
 * app update). A file of the person's own goes through `downloadTicket`.
 */
export function downloadFromServer(url: string, filename: string) {
  const href = new URL(url, window.location.href).href;
  // In the app the system download manager fetches it.
  if (postToApp({ type: 'download', url: href, name: filename })) return;
  startDownload(href, filename);
}

function blobBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function startDownload(href: string, filename: string) {
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Copies text to the clipboard. Resolves false when the device refuses. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Whether the device reports a network connection. Not proof that the server is reachable. */
export function isOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

/** Calls `listener` when the device's network connection changes. Returns the unsubscribe function. */
export function onConnectivityChange(listener: (online: boolean) => void) {
  const update = () => listener(isOnline());
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}
