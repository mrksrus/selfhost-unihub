// The device boundary. Everything that may work differently in the browser and
// in the planned Android app goes through this module or the wrappers it names
// below, so features never check which platform they run on. When the Android
// shell arrives, each function gets a second implementation here (or an
// explicit "not available"), and feature code stays unchanged.
//
// Already wrapped elsewhere, one place each:
// - notifications, push subscription and service worker messages: utils/service-worker.ts
// - app updates: lib/pwa-update.ts and the update item in hooks/use-attention.ts
// - install offer: lib/install-prompt.ts and components/pwa/InstallPrompt.tsx
// - offline copy on this device: lib/offline.ts
// - in-page events between components: lib/app-events.ts

/** Saves data created in the page (an attachment, an export) as a file on this device. */
export function saveFile(blob: Blob, filename: string) {
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
  startDownload(url, filename);
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
