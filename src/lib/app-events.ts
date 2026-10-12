// In-page events between parts of the app that do not share React state
// (the API client, the service worker bridge, the update flow). Every event
// name is listed here once, with the data it carries.
//
// Names stored in the browser (localStorage keys, IndexedDB names, lock names)
// are not events and stay where they are defined; renaming those would lose
// saved data.

export interface AppEvents {
  /** Open the global search and command palette. */
  'unihub:open-search': undefined;
  /** A new app version is installed and waits for this tab to refresh. */
  'unihub:update-available': undefined;
  /** This tab asks the waiting app version to take over. */
  'unihub:apply-update': undefined;
  /** Applying the app update failed. */
  'unihub:update-failed': undefined;
  /** The API answered 401: the server session ended. */
  'unihub:session-expired': undefined;
  /** Check the server session again (e.g. "Retry connection" while offline). */
  'unihub:retry-session': undefined;
  /** Offline reading mode was switched on or off in this tab. */
  'unihub:offline-mode': undefined;
  /** The saved offline copy on this device changed. */
  'unihub:offline-data': undefined;
  /** The service worker forwarded notification data (e.g. a pushed mail summary). */
  'unihub:notification-data': unknown;
  /** A recording was queued for upload in this tab. */
  'unihub:recording-queued': undefined;
  /** Stop the recording upload runner in this tab. */
  'unihub:recording-stop': undefined;
}

export type AppEventName = keyof AppEvents;

export function emitAppEvent<K extends AppEventName>(name: K, ...detail: AppEvents[K] extends undefined ? [] : [AppEvents[K]]) {
  window.dispatchEvent(detail.length ? new CustomEvent(name, { detail: detail[0] }) : new Event(name));
}

/** Listens for an app event. Returns the unsubscribe function. */
export function onAppEvent<K extends AppEventName>(name: K, listener: (detail: AppEvents[K]) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<AppEvents[K]>).detail);
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}
