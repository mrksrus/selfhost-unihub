import { log } from '../log';

// What the API finishes after a stop signal, in order, within the time the
// supervisor allows (it sends SIGKILL 10 s after SIGTERM; installShutdownHandler
// re-raises the signal after drainMs at the latest). The timers, IDLE sessions
// and event streams have already been stopped by then, and the server accepts
// no new connections.
//
// 1. Requests in flight and mail jobs already running get up to `waitMs` to
//    finish; the mail scheduler claims nothing more.
// 2. This process's remaining mail leases end now, so the next start recovers
//    their jobs at once instead of after the 30-second lease.
// 3. The database pool closes, so no connection is left half used.
interface DrainDeps {
  serverClosed: Promise<unknown>;
  scheduler: { quiesce(): Promise<unknown>; workerId: string };
  expireWorkerLeases: (workerId: string) => Promise<number>;
  closePool: () => Promise<unknown>;
  waitMs?: number;
  timers?: Pick<typeof globalThis, 'setTimeout'>;
}

async function drainProcess({ serverClosed, scheduler, expireWorkerLeases, closePool, waitMs = 6000, timers = globalThis }: DrainDeps) {
  const started = Date.now();
  let finished = false;
  await Promise.race([
    Promise.all([serverClosed, scheduler.quiesce()]).then(() => { finished = true; }),
    new Promise(resolve => timers.setTimeout(resolve, waitMs)),
  ]);
  const expired = await expireWorkerLeases(scheduler.workerId).catch(error => { log.error('SHUTDOWN', 'Could not end mail leases', error); return 0; });
  await closePool().catch(error => log.error('SHUTDOWN', 'Could not close the database pool', error));
  log.info('SHUTDOWN', finished ? 'Drained' : 'Drain time over', { ms: Date.now() - started, leasesEnded: expired });
}

export { drainProcess };
export type { DrainDeps };
