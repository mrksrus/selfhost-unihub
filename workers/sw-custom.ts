// The browser supports renotify; the WebWorker declarations omit this option.
interface NotificationOptions { renotify?: boolean }
interface Payload { version?: unknown; userId?: unknown; dedupeKey?: unknown; title?: unknown; body?: unknown; url?: unknown; eventId?: unknown; emailId?: unknown; tag?: unknown; kind?: unknown; module?: unknown; preview?: unknown }
interface WorkerMessage { type?: string; userId?: unknown; payload?: Payload | null }
interface NotificationWorkerEvents { activate: ExtendableEvent; push: PushEvent; message: ExtendableMessageEvent & { data: WorkerMessage }; sync: ExtendableEvent & { tag: string }; periodicsync: ExtendableEvent; notificationclick: NotificationEvent }
interface NotificationWorkerScope extends Pick<ServiceWorkerGlobalScope, 'registration' | 'location' | 'clients'> { unihubWithBoundUser: <T>(userId: string, task: (bound: boolean) => Promise<T>) => Promise<T>; addEventListener<K extends keyof NotificationWorkerEvents>(type: K, listener: (event: NotificationWorkerEvents[K]) => void): void }
const notificationScope = self as unknown as NotificationWorkerScope;

// Delivery is driven by server Web Push. Periodic sync is not an alarm clock.
const NOTIFICATION_DB = 'unihub-notifications-v2';
const MAX_DELIVERED = 1000;
let deliveryQueue: Promise<unknown> = Promise.resolve();
let databasePromise: Promise<IDBDatabase> | null | undefined;

function openNotificationDatabase() {
  if (!databasePromise) databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
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
async function readStore(storeName: string, key: IDBValidKey): Promise<unknown> {
  const db = await openNotificationDatabase();
  return new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function setUser(userId: string | null) {
  const db = await openNotificationDatabase();
  const previousUser = await readStore('meta', 'userId');
  if (previousUser === userId) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['meta', 'delivered'], 'readwrite');
    tx.objectStore('meta').put(userId || null, 'userId');
    tx.objectStore('delivered').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  const notifications = await notificationScope.registration.getNotifications();
  notifications.forEach(notification => notification.close());
}
async function markDelivered(key: string) {
  const db = await openNotificationDatabase();
  await new Promise<void>((resolve, reject) => {
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
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
// The app lock (0.29): while this person's lock covers a notification's
// module and no tab of theirs counts as open, the notice shows no content,
// whatever the server rendered. The page writes the timeline in IndexedDB
// `unihub-lock-v1` (src/lib/app-lock/timeline.ts); `lockIsOpen` and
// `lockCovers` here are copies of its `isOpen` and `covers`, keep them equal.
const LOCK_DB = 'unihub-lock-v1';
const LOCK_VISIBLE_GRACE_MS = 30_000;
type LockArea = 'app' | 'mail' | 'contacts' | 'calendar' | 'recordings' | 'chat';
interface LockTimeline { v?: unknown; scope?: unknown; relockAfterMs?: unknown; lastActiveAt?: unknown; hiddenAt?: unknown; lockedAt?: unknown }
// Servers before 0.29 send no module; the kind names it.
const KIND_MODULES: Record<string, LockArea> = { mail: 'mail', snooze: 'mail', 'scheduled-send': 'mail', calendar: 'calendar', todo: 'calendar', reminder: 'calendar', recording: 'recordings' };
function readLockTimeline(userId: string) {
  return new Promise<LockTimeline | undefined>(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(undefined); return; }
    const request = indexedDB.open(LOCK_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('pins')) db.createObjectStore('pins', { keyPath: 'userId' });
      if (!db.objectStoreNames.contains('timeline')) db.createObjectStore('timeline', { keyPath: 'userId' });
    };
    // Storage that cannot be read holds no lock either.
    request.onerror = () => resolve(undefined);
    request.onsuccess = () => {
      const db = request.result;
      try {
        const get = db.transaction('timeline').objectStore('timeline').get(userId);
        get.onsuccess = () => { db.close(); resolve(get.result as LockTimeline | undefined); };
        get.onerror = () => { db.close(); resolve(undefined); };
      } catch { db.close(); resolve(undefined); }
    };
  });
}
const lockTime = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
function lockCovers(scope: LockArea[], area: LockArea | null) {
  return scope.includes('app') || (area !== null && area !== 'app' && scope.includes(area));
}
function lockIsOpen(timeline: LockTimeline, now: number) {
  const relockAfterMs = lockTime(timeline.relockAfterMs) ?? 0;
  const lastActiveAt = lockTime(timeline.lastActiveAt);
  const hiddenAt = lockTime(timeline.hiddenAt);
  const lockedAt = lockTime(timeline.lockedAt);
  if (lastActiveAt === null) return false;
  if (lockedAt !== null && lockedAt >= lastActiveAt) return false;
  if (hiddenAt !== null && hiddenAt >= lastActiveAt) return now - hiddenAt < relockAfterMs;
  return now - lastActiveAt < relockAfterMs + LOCK_VISIBLE_GRACE_MS;
}
async function lockedFor(userId: string, payload: Payload) {
  const timeline = await readLockTimeline(userId);
  if (!timeline || timeline.v !== 1 || !Array.isArray(timeline.scope) || !timeline.scope.length) return false;
  const area = typeof payload.module === 'string' ? payload.module as LockArea
    : typeof payload.kind === 'string' && Object.prototype.hasOwnProperty.call(KIND_MODULES, payload.kind) ? KIND_MODULES[payload.kind] : null;
  return lockCovers(timeline.scope as LockArea[], area) && !lockIsOpen(timeline, Date.now());
}
// A chat message's text, sealed by its sender to this browser's preview key
// (Web Push encryption, RFC 8291). The key is in the person's chat store
// (src/lib/chat/store.ts); `openPreview` is a copy of src/lib/chat/seal.ts
// `open`, keep them equal.
interface PreviewKey { privateKey: CryptoKey; publicKey: Uint8Array<ArrayBuffer>; auth: Uint8Array<ArrayBuffer> }
function readPreviewKey(userId: string) {
  return new Promise<PreviewKey | undefined>(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(undefined); return; }
    const request = indexedDB.open(`unihub-chat:${userId}`);
    // No chat store here: never leave an empty one in its place.
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onerror = () => resolve(undefined);
    request.onsuccess = () => {
      const db = request.result;
      try {
        const get = db.transaction('keys').objectStore('keys').get('preview');
        get.onsuccess = () => { db.close(); resolve(get.result as PreviewKey | undefined); };
        get.onerror = () => { db.close(); resolve(undefined); };
      } catch { db.close(); resolve(undefined); }
    };
  });
}
const P256 = { name: 'ECDH', namedCurve: 'P-256' };
const utf8 = (text: string) => new TextEncoder().encode(text);
async function hkdf(salt: Uint8Array<ArrayBuffer>, secret: BufferSource, info: Uint8Array<ArrayBuffer>, length: number) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}
async function openPreview(key: PreviewKey, sealed: Uint8Array<ArrayBuffer>) {
  if (sealed.length < 21 + 65 + 17 || sealed[20] !== 65) throw new Error('Not a sealed message.');
  const salt = sealed.slice(0, 16);
  const senderPublic = sealed.slice(21, 86);
  const sender = await crypto.subtle.importKey('raw', senderPublic, P256, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, key.privateKey, 256);
  const ikm = await hkdf(key.auth, shared, new Uint8Array([...utf8('WebPush: info\0'), ...key.publicKey, ...senderPublic]), 32);
  const contentKey = await crypto.subtle.importKey('raw', await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['decrypt']);
  if (sealed.length - 86 > new DataView(sealed.buffer).getUint32(16)) throw new Error('A sealed message has one record.');
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12) }, contentKey, sealed.slice(86)));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('A sealed message ends with its delimiter.');
  return new TextDecoder().decode(padded.slice(0, end));
}
// A preview that cannot be opened here (no key, damaged, sealed to another device) leaves the sender text.
async function chatPreview(userId: string, sealed: unknown) {
  if (typeof sealed !== 'string' || sealed.length > 4096) return null;
  try {
    const key = await readPreviewKey(userId);
    return key ? await openPreview(key, Uint8Array.from(atob(sealed.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))) : null;
  } catch { return null; }
}
const LOCKED_TITLE = 'UniHub';
const LOCKED_BODY = 'You have a new notification. Unlock UniHub to see it.';

function enqueueDelivery<T>(task: () => Promise<T>): Promise<T> {
  const next = deliveryQueue.then(task);
  deliveryQueue = next.catch(() => {});
  return next;
}
// Recording uploads (recording-uploads-sw.js) name a recording in a notice
// only while its account is the one bound here and its app lock does not
// cover Recordings now. The check and the notice run in this queue, so a
// sign-out or account switch cannot land between them.
notificationScope.unihubWithBoundUser = <T>(userId: string, task: (bound: boolean) => Promise<T>) => enqueueDelivery(async () =>
  task(await readStore('meta', 'userId') === userId && !await lockedFor(userId, { module: 'recordings' })));
function safeTargetUrl(input: unknown) {
  try {
    const url = new URL(typeof input === 'string' ? input : '/dashboard', notificationScope.location.origin);
    return url.origin === notificationScope.location.origin ? url.toString() : `${notificationScope.location.origin}/dashboard`;
  } catch { return `${notificationScope.location.origin}/dashboard`; }
}
function notificationTargetUrl(data: Payload | null | undefined) {
  const url = new URL(safeTargetUrl(data?.url));
  // Older queued payloads and offline reminders stored the item ID separately.
  const parameter = url.pathname === '/mail' ? 'email' : ['/calendar', '/todo'].includes(url.pathname) ? 'event' : null;
  const id = parameter === 'email' ? data?.emailId : data?.eventId;
  if (parameter && typeof id === 'string' && id.length > 0 && id.length <= 128) url.searchParams.set(parameter, id);
  return url.toString();
}
async function bindAuthenticatedUser(userId: unknown) {
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
async function deliverNotification(payload: Payload | null | undefined) {
  if (!payload || payload.version !== 1 || typeof payload.userId !== 'string' || typeof payload.dedupeKey !== 'string' || payload.dedupeKey.length > 512) return false;
  const activeUser = await readStore('meta', 'userId');
  if (activeUser !== payload.userId) return false;
  const key = `${activeUser}:${payload.dedupeKey}`;
  if (await readStore('delivered', key)) return false;
  const locked = await lockedFor(activeUser, payload);
  const preview = locked ? null : await chatPreview(activeUser, payload.preview);
  await notificationScope.registration.showNotification(locked ? LOCKED_TITLE : String(payload.title || 'UniHub').slice(0, 120), {
    body: locked ? LOCKED_BODY : (preview || String(payload.body || '')).slice(0, 400),
    icon: '/icons/icon-192x192.png', badge: '/icons/icon-72x72.png',
    // A payload tag groups notices that replace each other, such as reminders
    // about one recording upload. Each new chat message in a conversation alerts again.
    tag: typeof payload.tag === 'string' && payload.tag && payload.tag.length <= 128 ? payload.tag : payload.dedupeKey, renotify: payload.kind === 'chat',
    data: { url: notificationTargetUrl(payload), userId: activeUser, eventId: payload.eventId, emailId: payload.emailId },
  });
  // Suppression and failures never acknowledge delivery. Shared worker storage deduplicates tabs and transports.
  await markDelivered(key);
  const clients = await notificationScope.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage({ type: 'NOTIFICATION_DATA_CHANGED', userId: activeUser, kind: payload.kind }));
  return true;
}
notificationScope.addEventListener('activate', event => {
  event.waitUntil(Promise.all(['local-api-cache', 'api-cache', 'unihub-notification-state-v1'].map(name => caches.delete(name))));
});
// A push that shows nothing can make the browser show its own message or
// revoke the subscription. When the payload cannot be shown (malformed, or
// for an account not signed in here) show a generic notice without content.
async function deliverGenericNotification() {
  await notificationScope.registration.showNotification('UniHub', {
    body: 'You have a new notification. Open UniHub to see it.',
    icon: '/icons/icon-192x192.png', badge: '/icons/icon-72x72.png',
    tag: 'unihub-generic', renotify: false, data: { url: '/', generic: true },
  });
  return true;
}
async function deliverPush(payload: Payload | null | undefined) {
  if (await deliverNotification(payload)) return true;
  // A repeated push for a notification already shown is not shown again.
  if (typeof payload?.userId === 'string' && typeof payload?.dedupeKey === 'string' && await readStore('delivered', `${payload.userId}:${payload.dedupeKey}`)) return false;
  return deliverGenericNotification();
}
notificationScope.addEventListener('push', event => {
  event.waitUntil(enqueueDelivery(async () => {
    let payload = null;
    try { payload = event.data?.json(); } catch { /* Shown as a generic notice. */ }
    try { return await deliverPush(payload); }
    catch (error) { console.error('[SW] Push delivery failed:', (error as Error).name); throw error; }
  }));
});
notificationScope.addEventListener('message', event => {
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
// Recording uploads have their own sync handler in recording-uploads-sw.js.
notificationScope.addEventListener('sync', event => { if (event.tag !== 'recording-uploads') event.waitUntil(Promise.resolve()); });
notificationScope.addEventListener('periodicsync', event => event.waitUntil(Promise.resolve()));
notificationScope.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    // Notices about recordings kept on this device carry no private content
    // and always lead to the Recordings page.
    const generic = event.notification.data?.generic === true || event.notification.data?.recordingUpload === true;
    if (!generic && await readStore('meta', 'userId') !== event.notification.data?.userId) return;
    const targetUrl = event.notification.data?.recordingUpload === true ? new URL('/recordings', notificationScope.location.origin).toString()
      : generic ? new URL('/', notificationScope.location.origin).toString() : notificationTargetUrl(event.notification.data);
    const clients = await notificationScope.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin !== notificationScope.location.origin) continue;
      if (client.url === targetUrl) return client.focus();
      if ('navigate' in client) {
        const navigated = await client.navigate(targetUrl).catch(() => null);
        if (navigated) return navigated.focus();
      }
    }
    return notificationScope.clients.openWindow(targetUrl);
  })());
});
