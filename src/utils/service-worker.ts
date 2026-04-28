// Service Worker utilities for notifications and background sync

export const NOTIFICATION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const BACKGROUND_NOTIFICATION_SYNC_TAG = 'unihub-notification-check';
export const MAIL_PERIODIC_SYNC_TAG = 'check-emails-periodic';
export const CALENDAR_PERIODIC_SYNC_TAG = 'check-calendar-periodic';

let swRegistration: ServiceWorkerRegistration | null = null;
let initPromise: Promise<ServiceWorkerRegistration | null> | null = null;
let messageListenerAttached = false;
let permissionRequestPromise: Promise<NotificationPermission | 'unsupported'> | null = null;

interface PeriodicSyncManagerLike {
  getTags(): Promise<string[]>;
  register(tag: string, options: { minInterval: number }): Promise<void>;
}

function attachServiceWorkerMessageListener() {
  if (messageListenerAttached || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', handleSWMessage);
  messageListenerAttached = true;
}

// Initialize service worker registration
export async function initServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    console.log('[SW] Service Workers not supported');
    return null;
  }

  if (swRegistration) {
    attachServiceWorkerMessageListener();
    return swRegistration;
  }

  if (!initPromise) {
    initPromise = navigator.serviceWorker.ready
      .then((registration) => {
        swRegistration = registration;
        attachServiceWorkerMessageListener();
        console.log('[SW] Service Worker ready');
        return registration;
      })
      .catch((error) => {
        console.error('[SW] Service Worker registration failed:', error);
        return null;
      })
      .finally(() => {
        initPromise = null;
      });
  }

  return initPromise;
}

// Handle messages from service worker
function handleSWMessage(event: MessageEvent) {
  console.log('[SW] Message from service worker:', event.data);

  if (event.data?.type === 'CHECK_EMAILS') {
    // Trigger email check (this will be handled by the component)
    window.dispatchEvent(new CustomEvent('sw-check-emails'));
  } else if (event.data?.type === 'CHECK_CALENDAR') {
    // Trigger calendar check (this will be handled by the component)
    window.dispatchEvent(new CustomEvent('sw-check-calendar'));
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!('Notification' in window)) {
    console.log('[SW] Notifications not supported');
    return 'unsupported';
  }

  if (Notification.permission !== 'default') {
    return Notification.permission;
  }

  if (!permissionRequestPromise) {
    permissionRequestPromise = Notification.requestPermission()
      .then((permission) => permission)
      .catch(() => 'default' as NotificationPermission)
      .finally(() => {
        permissionRequestPromise = null;
      });
  }

  return permissionRequestPromise;
}

// Show notification via service worker registration when possible.
export async function showNotification(title: string, options: NotificationOptions = {}) {
  const permission = await requestNotificationPermission();
  if (permission !== 'granted') {
    console.log('[SW] Notification permission denied');
    return false;
  }

  const normalizedOptions: NotificationOptions = {
    ...options,
    icon: options.icon || '/icons/icon-512x512.png',
    badge: options.badge || '/favicon.ico',
    tag: options.tag || 'unihub-notification',
    data: options.data || {},
  };

  const registration = swRegistration || await initServiceWorker();
  if (registration) {
    try {
      await registration.showNotification(title, normalizedOptions);
      return true;
    } catch (error) {
      console.error('[SW] Failed to show notification via registration:', error);
    }
  }

  try {
    new Notification(title, normalizedOptions);
    return true;
  } catch (error) {
    console.error('[SW] Failed to show notification via Notification API:', error);
  }

  return false;
}

// Register background sync task
export async function registerBackgroundSync(tag: string) {
  if (!('serviceWorker' in navigator)) {
    console.log('[SW] Service Workers not supported');
    return false;
  }

  try {
    const registration = swRegistration || await initServiceWorker();
    if (!registration) return false;
    if ('sync' in registration) {
      await registration.sync.register(tag);
      console.log(`[SW] Registered background sync: ${tag}`);
      return true;
    }
  } catch (error) {
    console.error(`[SW] Failed to register background sync ${tag}:`, error);
  }
  return false;
}

// Register periodic background sync (if supported)
export async function registerPeriodicSync(tag: string, minInterval: number = NOTIFICATION_CHECK_INTERVAL_MS) {
  if (!('serviceWorker' in navigator)) {
    console.log('[SW] Service Workers not supported');
    return false;
  }

  try {
    const registration = swRegistration || await initServiceWorker();
    if (!registration) return false;
    const maybePeriodic = registration as ServiceWorkerRegistration & {
      periodicSync?: PeriodicSyncManagerLike;
    };
    const periodicSync = maybePeriodic.periodicSync;
    if (!periodicSync) return false;

    const tags = await periodicSync.getTags();
    if (!tags.includes(tag)) {
      await periodicSync.register(tag, { minInterval });
      console.log(`[SW] Registered periodic sync: ${tag} (every ${Math.round(minInterval / 60000)} minutes)`);
    }
    return true;
  } catch (error) {
    console.error(`[SW] Failed to register periodic sync ${tag}:`, error);
  }
  return false;
}

export async function requestBackgroundNotificationCheck(reason = 'client') {
  if (!('serviceWorker' in navigator)) {
    return false;
  }

  try {
    const registration = swRegistration || await initServiceWorker();
    const worker = registration?.active || navigator.serviceWorker.controller;
    if (!worker) return false;
    worker.postMessage({
      type: 'RUN_NOTIFICATION_CHECKS',
      reason,
      suppressNotifications: true,
    });
    return true;
  } catch (error) {
    console.error('[SW] Failed to request notification check:', error);
    return false;
  }
}

export async function resetBackgroundNotificationState() {
  if (!('serviceWorker' in navigator)) {
    return false;
  }

  try {
    const registration = swRegistration || await initServiceWorker();
    const worker = registration?.active || navigator.serviceWorker.controller;
    if (!worker) return false;
    worker.postMessage({ type: 'RESET_NOTIFICATION_STATE' });
    return true;
  } catch (error) {
    console.error('[SW] Failed to reset notification state:', error);
    return false;
  }
}

// Initialize on module load
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then((registration) => {
    swRegistration = registration;
    attachServiceWorkerMessageListener();
  });
}
