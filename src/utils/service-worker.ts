import { api } from '@/lib/api';

export const NOTIFICATION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const BACKGROUND_NOTIFICATION_SYNC_TAG = 'unihub-notification-check';
export const MAIL_PERIODIC_SYNC_TAG = 'check-emails-periodic';
export const CALENDAR_PERIODIC_SYNC_TAG = 'check-calendar-periodic';
const ENABLED_PREFIX = 'unihub:push-enabled:';
let messageListenerAttached = false;
let identityGeneration = 0;
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

export async function initServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  if (!messageListenerAttached) {
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'NOTIFICATION_DATA_CHANGED') {
        window.dispatchEvent(new CustomEvent('unihub-notification-data', { detail: event.data }));
      }
    });
    messageListenerAttached = true;
  }
  if (!registrationPromise) registrationPromise = new Promise(resolve => {
    const timeout = window.setTimeout(() => resolve(null), 8000);
    navigator.serviceWorker.ready.then(registration => { window.clearTimeout(timeout); resolve(registration); });
  }).then(async registration => {
    if (registration) {
      const periodic = (registration as ServiceWorkerRegistration & { periodicSync?: { getTags(): Promise<string[]>; unregister(tag: string): Promise<void> } }).periodicSync;
      if (periodic) {
        const tags = await periodic.getTags().catch(() => []);
        await Promise.all(tags.filter(tag => [BACKGROUND_NOTIFICATION_SYNC_TAG, MAIL_PERIODIC_SYNC_TAG, CALENDAR_PERIODIC_SYNC_TAG].includes(tag)).map(tag => periodic.unregister(tag).catch(() => {})));
      }
    }
    registrationPromise = null;
    return registration as ServiceWorkerRegistration | null;
  });
  return registrationPromise;
}
export async function sendNotificationWorkerMessage(message: Record<string, unknown>): Promise<boolean> {
  const registration = await initServiceWorker();
  const worker = registration?.active || navigator.serviceWorker?.controller;
  if (!worker) return false;
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => { channel.port1.close(); resolve(false); }, 5000);
    channel.port1.onmessage = event => {
      window.clearTimeout(timeout); channel.port1.close();
      resolve(event.data?.ok === true && event.data?.shown === true);
    };
    worker.postMessage(message, [channel.port2]);
  });
}
export const setNotificationUser = (userId: string) => sendNotificationWorkerMessage({ type: 'SET_NOTIFICATION_USER', userId });
export const resetBackgroundNotificationState = () => {
  identityGeneration++;
  return sendNotificationWorkerMessage({ type: 'RESET_NOTIFICATION_STATE' });
};
export function notificationSupport() {
  return window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}
export function pushEnabledForUser(userId: string) {
  try { return localStorage.getItem(`${ENABLED_PREFIX}${userId}`) === 'true'; } catch { return false; }
}
export function setPushEnabledForUser(userId: string, enabled: boolean) {
  try { localStorage.setItem(`${ENABLED_PREFIX}${userId}`, String(enabled)); } catch { /* device preference is optional */ }
}
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!('Notification' in window)) return 'unsupported';
  // Call this directly from the Enable button, before awaiting service-worker readiness.
  return Notification.permission === 'default' ? Notification.requestPermission() : Notification.permission;
}
function decodeKey(value: string) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), char => char.charCodeAt(0));
}
export async function enablePushSubscription(userId: string, permission: NotificationPermission | 'unsupported') {
  const generation = identityGeneration;
  if (permission !== 'granted') throw new Error('Allow notifications in your browser settings to enable them.');
  const registration = await initServiceWorker();
  if (!registration || !('pushManager' in registration)) throw new Error('Notifications require an installed app or supported browser over HTTPS.');
  const config = await api.get<{ publicKey: string }>('/notifications/config');
  if (config.error || !config.data?.publicKey) throw new Error(config.error || 'Notification service is unavailable.');
  const publicKey = decodeKey(config.data.publicKey);
  let subscription = await registration.pushManager.getSubscription();
  const existingKey = subscription?.options.applicationServerKey;
  if (subscription && existingKey && String(new Uint8Array(existingKey)) !== String(publicKey)) { await subscription.unsubscribe(); subscription = null; }
  subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
  if (generation !== identityGeneration) throw new Error('Your session changed. Enable notifications again after signing in.');
  if (!await setNotificationUser(userId)) throw new Error('The app is updating. Refresh and enable notifications again.');
  const response = await api.post('/notifications/subscription', { subscription: subscription.toJSON() });
  if (response.error) throw new Error(response.error);
  if (generation !== identityGeneration) throw new Error('Your session changed. Enable notifications again after signing in.');
  setPushEnabledForUser(userId, true);
  return subscription;
}
export async function syncPushSubscription(userId: string, signal?: AbortSignal) {
  const generation = identityGeneration;
  const cancelled = () => signal?.aborted || generation !== identityGeneration;
  if (cancelled()) return;
  const registration = await initServiceWorker();
  if (cancelled() || !registration) return;
  if (!await setNotificationUser(userId) || cancelled()) return;
  if (!pushEnabledForUser(userId) || !notificationSupport() || Notification.permission !== 'granted') return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription || cancelled()) return;
  const response = await api.post('/notifications/subscription', { subscription: subscription.toJSON() });
  if (response.error) throw new Error(response.error);
}
export async function revokeDevicePushSubscription() {
  identityGeneration++;
  const registration = await initServiceWorker();
  const subscription = await registration?.pushManager?.getSubscription();
  try {
    if (subscription) {
      const response = await api.post('/notifications/unsubscribe', { endpoint: subscription.endpoint });
      if (response.error) throw new Error(response.error);
    }
  } finally {
    if (subscription) await subscription.unsubscribe();
    await resetBackgroundNotificationState();
  }
}
export async function sendTestPush() {
  const registration = await initServiceWorker();
  const subscription = await registration?.pushManager?.getSubscription();
  if (!subscription) throw new Error('Enable notifications on this device first.');
  const result = await api.post<{ queued: boolean }>('/notifications/test', { endpoint: subscription.endpoint });
  if (result.error) throw new Error(result.error);
  return result.data?.queued === true;
}
export async function showNotification(title: string, options: NotificationOptions = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const data = options.data || {};
  if (!data.userId || !data.dedupeKey) return false;
  return sendNotificationWorkerMessage({ type: 'DELIVER_LOCAL_NOTIFICATION', payload: {
    version: 1, userId: data.userId, dedupeKey: data.dedupeKey, kind: data.kind || 'reminder', title, body: options.body, url: data.url, eventId: data.eventId,
  } });
}
// Compatibility for installed clients; background delivery now uses server push.
export async function registerPeriodicSync(_tag: string, _interval?: number) { return false; }
export async function registerBackgroundSync(_tag: string) { return false; }
export async function requestBackgroundNotificationCheck(_reason?: string) { return false; }
