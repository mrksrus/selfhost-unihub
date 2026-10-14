// The device boundary. Everything that works differently in the browser and in
// the Android app (android/) goes through this module or the wrappers it names
// below, so features never check which platform they run on. Each function has
// a web implementation and, where it differs, an Android one (or an explicit
// "not available").
//
// Already wrapped elsewhere, one place each:
// - notifications, push subscription and service worker messages: utils/service-worker.ts
// - app updates: lib/pwa-update.ts and the update item in hooks/use-attention.ts
// - install offer: lib/install-prompt.ts and components/pwa/InstallPrompt.tsx
// - offline copy on this device: lib/offline.ts
// - in-page events between components: lib/app-events.ts

// ── The Android app ───────────────────────────────────────────────
// The app shows these same pages in a WebView. It adds "UniHubAndroid/<version>
// (<code>)" to the user agent and gives the server's own top-level page a
// `UniHubAndroid` object to post JSON messages to (android/.../WebBridge.kt).

export const ANDROID_PACKAGE = 'io.github.mrksrus.unihub';

interface AndroidBridge { postMessage(message: string): void }
declare global { interface Window { UniHubAndroid?: AndroidBridge } }

export interface AndroidApp { versionName: string; versionCode: number }

/** The Android app this page runs in, or null in a browser. */
export function androidApp(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): AndroidApp | null {
  const match = /UniHubAndroid\/([\w.-]+) \((\d+)\)/.exec(userAgent);
  return match ? { versionName: match[1], versionCode: Number(match[2]) } : null;
}

/** An Android browser, where the app can be installed (not the app itself). */
export function canInstallAndroidApp(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
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

/** Saves data created in the page (an attachment, an export) as a file on this device. */
export function saveFile(blob: Blob, filename: string) {
  if (androidApp() && window.UniHubAndroid) {
    // A WebView cannot download blob: URLs; the app writes the file to Downloads.
    void blobBase64(blob).then(data => postToApp({ type: 'saveFile', name: filename, mime: blob.type, data }));
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

/**
 * Downloads a file the server streams (backups). The browser fetches it
 * directly, outside the service worker, so large files never pass through
 * page memory.
 */
export function downloadFromServer(url: string, filename: string) {
  // In the app the system download manager fetches it with the app's session.
  if (postToApp({ type: 'download', url: new URL(url, window.location.href).href, name: filename })) return;
  startDownload(url, filename);
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
