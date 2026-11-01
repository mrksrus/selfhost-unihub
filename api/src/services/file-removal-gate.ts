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
// now (that no row refers to the file). A process that stops with removals
// queued leaves those files behind as orphans, never a row without its file.
type Removal = () => Promise<unknown>;

let closedBy = 0;
let queue: Removal[] = [];
let draining: Promise<void> | null = null;
const opened: (() => void)[] = [];

function isClosed() {
  return closedBy > 0;
}

/** Runs `remove` now, or queues it while a backup copies files and answers 'deferred'. */
async function run<T>(remove: () => Promise<T>): Promise<T | 'deferred'> {
  // Removals queued during the copy go first.
  if (!isClosed() && draining) await draining;
  if (isClosed()) {
    queue.push(remove);
    return 'deferred';
  }
  return remove();
}

/** Settles when no backup copies files (workers that may wait instead of queueing). */
function whenOpen(): Promise<void> {
  if (!isClosed() && !draining) return Promise.resolve();
  return new Promise(resolve => opened.push(resolve));
}

async function drain() {
  while (queue.length && !isClosed()) {
    const batch = queue;
    queue = [];
    for (const remove of batch) {
      await remove().catch(error => log.error('INSTANCE BACKUP', 'A file removal queued during the backup failed', error));
    }
  }
}

/** Closes the gate until the returned function is called (once). */
function close(): () => Promise<void> {
  closedBy++;
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    closedBy--;
    if (isClosed()) return;
    if (!draining) {
      draining = drain().finally(() => { draining = null; });
    }
    await draining;
    if (!isClosed() && !draining) for (const resolve of opened.splice(0)) resolve();
  };
}

const fileRemovalGate = { run, whenOpen, isClosed, close };

export { fileRemovalGate };
