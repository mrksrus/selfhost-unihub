/** A deliberately small transaction harness for the offline store's get/put/delete paths. */
export function controlledIndexedDB() {
  const records = new Map<string, unknown>();
  const held: Array<() => void> = [];
  let pauseWrite = false;
  let failPut = false;
  let unavailable = false;

  const transaction = (_name: string, mode: string) => {
    const operations: Array<{ kind: 'get' | 'put' | 'delete'; key: string; value?: unknown; request?: { result?: unknown; onsuccess?: () => void } }> = [];
    let scheduled = false;
    let ended = false;
    const tx = {
      error: null as DOMException | null,
      oncomplete: null as (() => void) | null,
      onabort: null as (() => void) | null,
      onerror: null as (() => void) | null,
      abort() {
        if (ended) return;
        ended = true;
        tx.error = new DOMException('Aborted', 'AbortError');
        queueMicrotask(() => tx.onabort?.());
      },
      objectStore() {
        const schedule = () => {
          if (scheduled) return;
          scheduled = true;
          const finish = () => {
            if (ended) return;
            ended = true;
            if (failPut && operations.some(operation => operation.kind === 'put')) {
              failPut = false;
              tx.error = new DOMException('Quota exceeded', 'QuotaExceededError');
              tx.onabort?.();
              return;
            }
            for (const operation of operations) {
              if (operation.kind === 'put') records.set(operation.key, structuredClone(operation.value));
              if (operation.kind === 'delete') records.delete(operation.key);
              if (operation.kind === 'get' && operation.request) {
                operation.request.result = structuredClone(records.get(operation.key));
                operation.request.onsuccess?.();
              }
            }
            tx.oncomplete?.();
          };
          if (mode === 'readwrite' && pauseWrite) { pauseWrite = false; held.push(finish); }
          else queueMicrotask(finish);
        };
        return {
          put(value: unknown, key: string) { operations.push({ kind: 'put', value, key }); schedule(); },
          delete(key: string) { operations.push({ kind: 'delete', key }); schedule(); },
          get(key: string) { const request = { result: undefined, onsuccess: undefined }; operations.push({ kind: 'get', key, request }); schedule(); return request; },
        };
      },
    };
    return tx;
  };
  const database = { transaction, close() {}, createObjectStore() {} };
  const factory = {
    open() {
      const request = {
        result: database, error: null as Error | null,
        onsuccess: null as (() => void) | null, onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null, onupgradeneeded: null as (() => void) | null,
      };
      queueMicrotask(() => {
        if (unavailable) { request.error = new Error('Storage disabled'); request.onerror?.(); }
        else request.onsuccess?.();
      });
      return request;
    },
  };
  return {
    factory: factory as unknown as IDBFactory, records,
    pauseNextWrite: () => { pauseWrite = true; },
    pendingWrites: () => held.length,
    releaseWrite: () => { const finish = held.shift(); if (finish) queueMicrotask(finish); },
    failNextPut: () => { failPut = true; },
    disable: () => { unavailable = true; },
  };
}
