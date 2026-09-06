// Delivery is driven by server Web Push. Periodic sync is not an alarm clock.
const NOTIFICATION_DB = 'unihub-notifications-v2';
const MAX_DELIVERED = 1000;
let deliveryQueue = Promise.resolve();
let databasePromise;

function openNotificationDatabase() {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(NOTIFICATION_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('meta');
      const delivered = db.createObjectStore('delivered', { keyPath: 'key' });
      delivered.createIndex('shownAt', 'shownAt');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); databasePromise = null; };
      resolve(request.result);
    };
    request.onerror = () => { databasePromise = null; reject(request.error); };
  });
  return databasePromise;
}
async function readStore(storeName, key) {
  const db = await openNotificationDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function setUser(userId) {
  const db = await openNotificationDatabase();
  const previousUser = await readStore('meta', 'userId');
  if (previousUser === userId) return;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['meta', 'delivered'], 'readwrite');
    tx.objectStore('meta').put(userId || null, 'userId');
    tx.objectStore('delivered').clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  const notifications = await self.registration.getNotifications();
  notifications.forEach(notification => notification.close());
}
async function markDelivered(key) {
  const db = await openNotificationDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('delivered', 'readwrite');
    const store = tx.objectStore('delivered');
    store.put({ key, shownAt: Date.now() });
    const count = store.count();
    count.onsuccess = () => {
      let excess = count.result - MAX_DELIVERED;
      const cursor = store.index('shownAt').openCursor();
      cursor.onsuccess = () => {
        if (excess-- > 0 && cursor.result) { cursor.result.delete(); cursor.result.continue(); }
      };
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
function enqueueDelivery(task) {
  const next = deliveryQueue.then(task);
  deliveryQueue = next.catch(() => {});
  return next;
}
function safeTargetUrl(input) {
  try {
    const url = new URL(typeof input === 'string' ? input : '/dashboard', self.location.origin);
    return url.origin === self.location.origin ? url.toString() : `${self.location.origin}/dashboard`;
  } catch { return `${self.location.origin}/dashboard`; }
}
async function bindAuthenticatedUser(userId) {
  if (typeof userId !== 'string' || userId.length > 64) return false;
  const currentUser = await readStore('meta', 'userId');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch('/api/auth/me?background=1', { credentials: 'include', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json', 'X-Background-Sync': '1' } });
    if (!response.ok) return false;
    const data = await response.json();
    if (data?.user?.id !== userId) return false;
    await setUser(userId);
    return true;
  } catch {
    // Offline clients may retain the already bound account, but cannot claim a new identity.
    return currentUser === userId;
  } finally { clearTimeout(timeout); }
}
async function deliverNotification(payload) {
  if (!payload || payload.version !== 1 || typeof payload.userId !== 'string' || typeof payload.dedupeKey !== 'string' || payload.dedupeKey.length > 512) return false;
  const activeUser = await readStore('meta', 'userId');
  if (activeUser !== payload.userId) return false;
  const key = `${activeUser}:${payload.dedupeKey}`;
  if (await readStore('delivered', key)) return false;
  await self.registration.showNotification(String(payload.title || 'UniHub').slice(0, 120), {
    body: String(payload.body || '').slice(0, 400),
    icon: '/icons/icon-192x192.png', badge: '/icons/icon-72x72.png',
    tag: payload.dedupeKey, renotify: false,
    data: { url: safeTargetUrl(payload.url), userId: activeUser, eventId: payload.eventId, emailId: payload.emailId },
  });
  // Suppression and failures never acknowledge delivery. Shared worker storage deduplicates tabs and transports.
  await markDelivered(key);
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage({ type: 'NOTIFICATION_DATA_CHANGED', userId: activeUser, kind: payload.kind }));
  return true;
}
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all(['local-api-cache', 'api-cache', 'unihub-notification-state-v1'].map(name => caches.delete(name))));
});
self.addEventListener('push', event => {
  event.waitUntil(enqueueDelivery(async () => {
    try { return await deliverNotification(event.data?.json()); }
    catch (error) { console.error('[SW] Push delivery failed:', error.name); throw error; }
  }));
});
self.addEventListener('message', event => {
  const task = enqueueDelivery(async () => {
    if (event.data?.type === 'SET_NOTIFICATION_USER') {
      return bindAuthenticatedUser(event.data.userId);
    }
    if (event.data?.type === 'RESET_NOTIFICATION_STATE') {
      await setUser(null);
      await caches.delete('unihub-notification-state-v1');
      return true;
    }
    if (event.data?.type === 'DELIVER_LOCAL_NOTIFICATION') return deliverNotification(event.data.payload);
    return false;
  });
  event.waitUntil(task.then(shown => event.ports?.[0]?.postMessage({ ok: true, shown }), () => event.ports?.[0]?.postMessage({ ok: false })));
});
// Retired installations may have a pending one-shot/periodic registration. Do not poll or consume reminders.
self.addEventListener('sync', event => event.waitUntil(Promise.resolve()));
self.addEventListener('periodicsync', event => event.waitUntil(Promise.resolve()));
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    if (await readStore('meta', 'userId') !== event.notification.data?.userId) return;
    const targetUrl = safeTargetUrl(event.notification.data?.url);
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if (client.url !== targetUrl && 'navigate' in client) await client.navigate(targetUrl);
      return client.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});
