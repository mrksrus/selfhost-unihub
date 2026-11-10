// The app lock's records in this browser: IndexedDB `unihub-lock-v1`, so the
// service worker can read the timeline too (workers/sw-custom.ts opens the
// same database read-only and keeps the same upgrade).
//
// - `pins`: the UniHub PIN's hash and its attempt counts (pin.ts)
// - `timeline`: what the lock covers and when this person last used UniHub
//   here (timeline.ts)
//
// Both are keyed by user id. A sign-out deletes them; nothing here leaves
// the browser.
export const LOCK_DATABASE = 'unihub-lock-v1';
export type LockStore = 'pins' | 'timeline';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('This browser cannot keep the app lock.')); return; }
    const request = indexedDB.open(LOCK_DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('pins')) db.createObjectStore('pins', { keyPath: 'userId' });
      if (!db.objectStoreNames.contains('timeline')) db.createObjectStore('timeline', { keyPath: 'userId' });
    };
    request.onerror = () => reject(request.error || new Error('The app lock could not open its storage.'));
    request.onblocked = () => reject(new Error('Close other UniHub tabs and try again.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function run<T>(stores: LockStore[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => () => T): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let result: () => T;
    try {
      const tx = db.transaction(stores, mode);
      result = body(tx);
      tx.oncomplete = () => { db.close(); resolve(result()); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('The app lock could not save.')); };
    } catch (error) { db.close(); reject(error); }
  });
}

export function readRecord<T>(store: LockStore, userId: string): Promise<T | undefined> {
  return run([store], 'readonly', tx => {
    const request = tx.objectStore(store).get(userId);
    return () => request.result as T | undefined;
  });
}

/**
 * Reads, changes and writes one record in one transaction, so tabs that write
 * at the same time do not lose each other's change. `change` returns the new
 * record, or undefined to delete it. Resolves with what it returned.
 */
export function updateRecord<T extends { userId: string }>(store: LockStore, userId: string, change: (current: T | undefined) => T | undefined): Promise<T | undefined> {
  return run([store], 'readwrite', tx => {
    const objects = tx.objectStore(store);
    let next: T | undefined;
    const request = objects.get(userId);
    request.onsuccess = () => {
      next = change(request.result as T | undefined);
      if (next) objects.put(next);
      else objects.delete(userId);
    };
    return () => next;
  });
}

/** Deletes every person's lock records here, or everyone's but `keepUserId`'s. */
export async function deleteLockRecords(keepUserId?: string) {
  await run(['pins', 'timeline'], 'readwrite', tx => {
    for (const name of ['pins', 'timeline'] as const) {
      const objects = tx.objectStore(name);
      if (!keepUserId) { objects.clear(); continue; }
      const keys = objects.getAllKeys();
      keys.onsuccess = () => keys.result.filter(key => key !== keepUserId).forEach(key => objects.delete(key));
    }
    return () => undefined;
  });
}
