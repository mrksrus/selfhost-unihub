import { AsyncLocalStorage } from 'node:async_hooks';

// A person's account management runs one change at a time. Adding, changing,
// disconnecting or removing a mail or calendar account, a mail account's
// calendar, deleting a folder or one date of a repeating event at the
// provider, clearing a module's data, deleting the person and admitting one
// of their restores each hold this lock from the first read that decides
// anything (discovery and login tests included) to the commit and the
// provider command it guards; an administrator acting for the person takes
// the person's lock. Two such changes of one person therefore never
// interleave: the later one starts from what the earlier one left. The final
// check (final-step.ts) still covers what others commit meanwhile: rules,
// module switches, restores.
//
// One API process owns this work (AGENTS.md, docs/ARCHITECTURE.md), so the
// lock is in process, like mail-account-lock.ts. The hold is bounded by the
// discovery, login and IMAP timeouts of the work it covers. Lock order
// (docs/AUTH_ADMIN_SETTINGS.md): this lock first, then a mail account's
// (mail-account-lock.ts), then rows, then the final check. Work that already
// holds a mail account's lock (the erase worker) or that must not queue asks
// with `wait: false` and stops when the person's lock is busy.
//
// A change that calls another (deleting a person clears their mail) runs it
// under the lock it holds. Background work it starts does not inherit it
// (outsidePersonLock): a sync started by a change takes the lock itself.

interface Held { userId: string; active: boolean }

const tails = new Map<string, Promise<void>>();
const holding = new AsyncLocalStorage<readonly Held[]>();

const busy = () => Object.assign(new Error('Another change is in progress. Try again in a moment.'), { status: 503, code: 'CHANGE_IN_PROGRESS' });

function holdsPersonLock(userId: string) {
  return Boolean(holding.getStore()?.some(held => held.active && held.userId === userId));
}

async function withPersonLock<T>(userId: unknown, work: () => T | PromiseLike<T>, { wait = true } = {}): Promise<T> {
  const key = String(userId || '').trim();
  if (!key) throw new Error('Person ID required');
  if (holdsPersonLock(key)) return await work();
  // Rejected before joining the queue: a refused caller never runs later.
  if (!wait && tails.has(key)) throw busy();
  const previous = tails.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  tails.set(key, current);
  await previous;
  const held: Held = { userId: key, active: true };
  try {
    return await holding.run([...(holding.getStore() ?? []).filter(entry => entry.active), held], work);
  } finally {
    held.active = false;
    release();
    if (tails.get(key) === current) tails.delete(key);
  }
}

/** Starts background work without the caller's lock: it takes the lock itself where it needs it. */
function outsidePersonLock<T>(work: () => T): T {
  return holding.exit(work);
}

/** Whether the error is withPersonLock's `wait: false` refusal. */
const isPersonLockBusy = (error: unknown) => (error as { code?: unknown } | null)?.code === 'CHANGE_IN_PROGRESS' && (error as { status?: unknown }).status === 503;

export { withPersonLock, holdsPersonLock, outsidePersonLock, isPersonLockBusy };
