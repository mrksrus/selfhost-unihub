import { AsyncLocalStorage } from 'node:async_hooks';
import { log } from '../log';

// The instance backup (instance-backup.ts) dumps the database first and then
// copies the files. A row deleted after the dump still names its file in the
// backup, so that file must stay until the copy has ended. Removals of stored
// files go through this gate: while it is closed they are queued and run, in
// order, once the copy is done. One API process runs the backup (the worker
// owner) and the removals it can race, so this is an in-process gate, not a
// lock between processes.
//
// A queued removal runs later, outside its caller: it must hold nothing of the
// caller's (no transaction connection, no lock) and check again what it checks
// now (that no row refers to the file). A caller whose removal holds those
// passes a second function for the queue that takes them afresh. A process
// that stops with removals queued leaves those files behind as orphans, never
// a row without its file. A removal the gate let through (now or from the
// queue) runs the gated removals it calls itself at once: they are part of it.
//
// The usual shape: commit the deletion of the rows first, then, holding no
// transaction or lock, `await fileRemovalGate.run(() => removeTheFiles())`.
// The answer is the removal's result, or 'deferred' when it was queued; a
// caller reports the rows as deleted either way.
type Removal = () => Promise<unknown>;

let closedBy = 0;
let queue: Removal[] = [];
let draining: Promise<void> | null = null;
const opened: (() => void)[] = [];
const admitted = new AsyncLocalStorage<true>();

function isClosed() {
  return closedBy > 0;
}

const idle = () => !isClosed() && !draining && !queue.length;

/**
 * Runs `remove` now, or queues `whenQueued` (by default `remove` itself)
 * while a backup copies files or the queue is still draining, and answers
 * 'deferred'. It never waits: a caller may hold a lock that a queued removal
 * needs (contact-photos.ts), so waiting here could wait for itself.
 */
async function run<T>(remove: () => Promise<T>, whenQueued: Removal = remove): Promise<T | 'deferred'> {
  if (admitted.getStore()) return remove();
  if (isClosed() || draining || queue.length) {
    queue.push(whenQueued);
    kick();
    return 'deferred';
  }
  return admitted.run(true, remove);
}

/** Settles once no backup copies files and the queue is empty. */
function whenOpen(): Promise<void> {
  if (idle()) return Promise.resolve();
  return new Promise(resolve => opened.push(resolve));
}

// Drains the queue in order, including removals that arrive meanwhile, while
// the gate is open; once nothing is left, whoever waits for it is told.
function kick() {
  if (isClosed() || draining) return;
  if (!queue.length) {
    for (const resolve of opened.splice(0)) resolve();
    return;
  }
  draining = (async () => {
    while (queue.length && !isClosed()) {
      const batch = queue;
      queue = [];
      for (const remove of batch) {
        await admitted.run(true, remove).catch(error => log.error('INSTANCE BACKUP', 'A file removal queued during the backup failed', error));
      }
    }
  })().finally(() => {
    draining = null;
    kick();
  });
}

/** Closes the gate until the returned function is called (once); that settles when the queue has drained. */
function close(): () => Promise<void> {
  closedBy++;
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    closedBy--;
    kick();
    if (!isClosed()) await whenOpen();
  };
}

const fileRemovalGate = { run, whenOpen, isClosed, close };

export { fileRemovalGate };
