// Service Worker utilities for notifications and background sync

let swRegistration: ServiceWorkerRegistration | null = null;

interface PeriodicSyncManagerLike {
  getTags(): Promise<string[]>;
  register(tag: string, options: { minInterval: number }): Promise<void>;
}

// Initialize service worker registration
export async function initServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    console.log('[SW] Service Workers not supported');
    return null;
  }

  try {
    // Wait for service worker to be ready
    const registration = await navigator.serviceWorker.ready;
    swRegistration = registration;
    console.log('[SW] Service Worker ready');
    
    // Listen for service worker messages
    navigator.serviceWorker.addEventListener('message', handleSWMessage);
    
    return registration;
  } catch (error) {
    console.error('[SW] Service Worker registration failed:', error);
    return null;
  }
}

// Handle messages from service worker
function handleSWMessage(event: MessageEvent) {
  console.log('[SW] Message from service worker:', event.data);
  
  if (event.data.type === 'CHECK_EMAILS') {
    // Trigger email check (this will be handled by the component)
    window.dispatchEvent(new CustomEvent('sw-check-emails'));
  } else if (event.data.type === 'CHECK_CALENDAR') {
    // Trigger calendar check (this will be handled by the component)
    window.dispatchEvent(new CustomEvent('sw-check-calendar'));
  }
}

// Show notification via service worker (works in background)
export async function showNotification(title: string, options: NotificationOptions = {}) {
  if (!('Notification' in window)) {
    console.log('[SW] Notifications not supported');
    return;
  }

  // Request permission if needed
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }

  if (Notification.permission !== 'granted') {
    console.log('[SW] Notification permission denied');
    return;
  }

  // Try to use service worker notification (works in background)
  if (swRegistration || await initServiceWorker()) {
    const registration = swRegistration || await navigator.serviceWorker.ready;
    if (registration) {
      try {
        // Send message to service worker to show notification
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'SHOW_NOTIFICATION',
            title,
            options: {
              ...options,
              icon: options.icon || '/favicon.ico',
              badge: '/favicon.ico',
              tag: options.tag || 'unihub-notification',
            },
          });
          return;
        }
      } catch (error) {
        console.error('[SW] Failed to send notification via SW:', error);
      }
    }
  }

  // Fallback to regular Notification API (only works when page is active)
  if (document.visibilityState === 'visible') {
    new Notification(title, {
      ...options,
      icon: options.icon || '/favicon.ico',
      tag: options.tag || 'unihub-notification',
    });
  }
}

// Register background sync task
export async function registerBackgroundSync(tag: string) {
  if (!('serviceWorker' in navigator)) {
    console.log('[SW] Service Workers not supported');
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
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
export async function registerPeriodicSync(tag: string, minInterval: number = 15) {
  if (!('serviceWorker' in navigator)) {
    console.log('[SW] Service Workers not supported');
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const maybePeriodic = registration as ServiceWorkerRegistration & {
      periodicSync?: PeriodicSyncManagerLike;
    };
    const periodicSync = maybePeriodic.periodicSync;
    if (!periodicSync) return false;

    const tags = await periodicSync.getTags();
    if (!tags.includes(tag)) {
      await periodicSync.register(tag, { minInterval });
      console.log(`[SW] Registered periodic sync: ${tag} (every ${minInterval} minutes)`);
    }
    return true;
  } catch (error) {
    console.error(`[SW] Failed to register periodic sync ${tag}:`, error);
  }
  return false;
}

// Initialize on module load
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then((registration) => {
    swRegistration = registration;
  });
}
