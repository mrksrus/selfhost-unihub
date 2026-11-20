// Chat's state on this device: one IndexedDB database per person. It holds the
// device's record and preview key, the MLS module's state entries, the
// decrypted messages, the outbox, the per-conversation cursors and the
// history key. Every step of the engine writes in one transaction, so the
// module's state and the data of the step it belongs to are stored together
// or not at all.
import { fromBase64Url, toBase64Url } from './bytes';
import type { MlsEntry } from './mls';
import type { SealKey } from './seal';

const STORES = ['state', 'keys', 'messages', 'outbox', 'cursors'] as const;
export type ChatStoreName = typeof STORES[number];

/** The record under `keys`/`device`: the MLS identity's name and the server's id for it (null until enrolled). */
export interface ChatDeviceRecord { name: string; chat_device_id: string | null }

const PREFIX = 'unihub-chat:';
const databaseName = (userId: string) => `${PREFIX}${userId}`;

function done<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class ChatStore {
  private constructor(private readonly db: IDBDatabase) {}

  /** A person's store; `name` is another database for a store no person owns (the test hook's), which the wipes leave. */
  static open(userId: string, name = databaseName(userId)): Promise<ChatStore> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('Chat needs browser storage, which is not available here.')); return; }
      const opening = indexedDB.open(name, 1);
      opening.onupgradeneeded = () => {
        const db = opening.result;
        db.createObjectStore('state');
        db.createObjectStore('keys');
        db.createObjectStore('messages', { keyPath: 'id' }).createIndex('conversation', ['conversation_id', 'seq']);
        db.createObjectStore('outbox', { keyPath: 'order', autoIncrement: true });
        db.createObjectStore('cursors', { keyPath: 'conversation_id' });
      };
      opening.onsuccess = () => {
        // A wipe from another tab waits for this one to let go.
        opening.result.onversionchange = () => opening.result.close();
        resolve(new ChatStore(opening.result));
      };
      opening.onerror = () => reject(opening.error);
      opening.onblocked = () => reject(new Error('Close other UniHub tabs to update Chat\'s storage.'));
    });
  }

  get<T>(store: ChatStoreName, key: IDBValidKey): Promise<T | undefined> {
    return done(this.db.transaction(store).objectStore(store).get(key));
  }

  /** The records of a store, or of an index (`messages`: `conversation`) within a range. */
  all<T>(store: ChatStoreName, query?: IDBKeyRange, index?: string): Promise<T[]> {
    const source = this.db.transaction(store).objectStore(store);
    return done((index ? source.index(index) : source).getAll(query));
  }

  /** The MLS module's state entries, to load the device from. */
  async state(): Promise<MlsEntry[]> {
    const source = this.db.transaction('state').objectStore('state');
    const [keys, values] = await Promise.all([done(source.getAllKeys()), done(source.getAll())]);
    return keys.map((key, index) => ({ key: fromBase64Url(key as string), value: values[index] as Uint8Array }));
  }

  /**
   * One step: `writes` and then the module's changed entries, in one
   * transaction. If `writes` throws or the browser refuses any of it, nothing
   * is stored.
   */
  write(changes: readonly MlsEntry[], writes?: (transaction: IDBTransaction) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(STORES, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Chat\'s storage refused the change.'));
      try {
        writes?.(transaction);
        const state = transaction.objectStore('state');
        for (const { key, value } of changes) {
          if (value) state.put(value, toBase64Url(key));
          else state.delete(toBase64Url(key));
        }
      } catch (error) {
        transaction.onabort = null;
        transaction.abort();
        reject(error);
      }
    });
  }

  /** The history key, when this device holds it. */
  historyKey() {
    return this.get<SealKey>('keys', 'history');
  }

  /** Keeps the history key on this device once its passphrase was typed here, so a new passphrase needs no old one. */
  keepHistoryKey(key: SealKey) {
    return this.write([], transaction => { transaction.objectStore('keys').put(key, 'history'); });
  }

  close() {
    this.db.close();
  }
}

/** Deletes a person's chat state on this device, the history key included (sign-out, another person signing in). */
export function wipeChatStore(userId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deleting = indexedDB.deleteDatabase(databaseName(userId));
    deleting.onsuccess = () => resolve();
    deleting.onerror = () => reject(deleting.error);
  });
}

/** Deletes the chat state of every person on this device but `keep`'s: all at sign-out, the earlier person's when another signs in. */
export async function wipeChatStores(keep?: string) {
  if (typeof indexedDB === 'undefined') return;
  // shortcut: a browser without indexedDB.databases() (Firefox before 126) lists nothing to wipe; track the names if such browsers matter.
  const names = indexedDB.databases ? (await indexedDB.databases()).map(item => item.name ?? '') : [];
  await Promise.all(names.filter(name => name.startsWith(PREFIX) && (keep === undefined || name !== databaseName(keep)))
    .map(name => wipeChatStore(name.slice(PREFIX.length))));
}
