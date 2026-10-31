import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { log } from '../log';
import { outsideHeldConnection } from './transactions';

// One API process per database runs the background work: the timers, the
// mail IDLE sessions and the durable mail scheduler. Two of them would hold
// duplicate IDLE sessions and race each other's jobs. The owner holds a
// MariaDB named lock on a connection it keeps; another process (a second
// container by mistake, or the next one starting while the old one stops)
// serves requests only and takes over when the lock becomes free. Jobs it
// accepts stay queued in the database until the owner's scheduler claims them.
//
// The lock can change hands without the owner noticing at once: when its
// session ends (a database restart, a dropped connection) another process
// gets the lock while the old one still runs work until its next check. So
// the owner checks every few seconds, a check that does not answer in time
// counts as lost, and a process that gets the lock waits three check
// intervals (the handover) before it starts, by which time the old owner has
// stopped. Starting the work does not hold up the checks: a slow start-up is
// told it lost the role like running work (the caller fences both). A start-up
// that fails ends the role at the next check, which frees the lock and tries
// to take it again: the work starts afresh here or in another process.
//
// Before startWorkerOwnership runs (tests, scripts) every caller counts as the
// owner, as the single-process design always assumed.
const LOCK_NAME = 'unihub:background-work';
let owner: boolean | null = null;

function isWorkerOwner() {
  return owner ?? true;
}

interface OwnershipOptions {
  pool: Pick<Pool, 'getConnection'>;
  onGained: () => unknown;
  onLost: () => unknown;
  everyMs?: number;
  /** How long a new owner waits before it starts; three checks by default, more than an old owner needs to notice (one check plus its bounded query). */
  handoverMs?: number;
  timers?: Pick<typeof globalThis, 'setInterval' | 'clearInterval'> & Partial<Pick<typeof globalThis, 'setTimeout'>>;
}

async function startWorkerOwnership({ pool, onGained, onLost, everyMs = 5_000, handoverMs = 3 * everyMs, timers = globalThis }: OwnershipOptions) {
  owner = false;
  // The work runs beside the lock's connection, not inside it.
  const gained = outsideHeldConnection(onGained);
  let held: PoolConnection | null = null;
  let checking = false, stopped = false, warned = false;
  // Counts the roles this process gained; failedRole is one whose start-up failed.
  let role = 0, failedRole = 0;

  const drop = (connection: PoolConnection | null) => { try { connection?.destroy(); } catch { /* gone already */ } };
  // Every database step of a check ends within one interval, so a stalled
  // database cannot keep a check (and an old role) alive.
  const stepMs = Math.max(1000, everyMs - 1000);
  const connect = () => new Promise<PoolConnection>((resolve, reject) => {
    let late = false;
    const timer = setTimeout(() => { late = true; reject(new Error('Timed out waiting for a database connection')); }, stepMs);
    pool.getConnection().then(connection => {
      if (late) drop(connection); else { clearTimeout(timer); resolve(connection); }
    }, error => { if (!late) { clearTimeout(timer); reject(error); } });
  });
  const acquire = async () => {
    const connection = await connect();
    try {
      const [[row]] = await connection.query<RowDataPacket[]>({ sql: 'SELECT GET_LOCK(?, 0) AS got', timeout: stepMs }, [LOCK_NAME]);
      if (Number(row?.got) === 1) return connection;
    } catch (error) { drop(connection); throw error; }
    connection.release();
    return null;
  };
  // Still ours: the session holding the lock is this connection's.
  const stillHeld = async () => {
    try {
      const [[row]] = await held!.query<RowDataPacket[]>({ sql: 'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS mine', timeout: stepMs }, [LOCK_NAME]);
      return Number(row?.mine) === 1;
    } catch { return false; }
  };

  const check = async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      if (owner) {
        const failed = failedRole === role;
        if (!failed && await stillHeld()) return;
        // Not ours any more, or no answer: another process may hold the lock
        // already, so the work stops before anything else. Taking the lock
        // again below then waits for the handover like any new owner. Ending
        // the lock's session frees it.
        drop(held); held = null;
        owner = false; warned = true;
        if (failed) log.warn('OWNER', 'Background work did not start; this process lets the lock go and tries again');
        else log.error('OWNER', 'Lost the background work lock; background work stops until this process holds it again');
        await onLost();
      }
      let next: PoolConnection | null = null;
      try { next = await acquire(); }
      catch (error) {
        log.error('OWNER', 'Could not check the background work lock', error);
        return;
      }
      if (next) {
        held = next;
        // A previous owner whose session ended may still be working; it
        // notices within one check and stops.
        await new Promise(resolve => (timers.setTimeout ?? setTimeout)(resolve, handoverMs));
        if (stopped || !await stillHeld()) { drop(held); held = null; return; }
        owner = true; warned = false;
        const mine = ++role;
        log.info('OWNER', 'This process runs the background work');
        Promise.resolve().then(gained).catch(error => {
          log.error('OWNER', 'Starting the background work failed', error);
          // A start-up of a role already lost has been stopped; its failure says nothing about the current one.
          if (mine === role && owner) failedRole = mine;
        });
      } else if (!warned) {
        warned = true;
        log.warn('OWNER', 'Another UniHub API process runs the background work on this database; this one serves requests only (docs/ARCHITECTURE.md, Operational Notes)');
      }
    } finally { checking = false; }
  };

  await check();
  const timer = timers.setInterval(() => { void check(); }, everyMs);
  timer.unref?.();
  return {
    /** Ends the role and frees the lock for the next process. */
    async stop() {
      stopped = true;
      timers.clearInterval(timer);
      if (held) {
        await held.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
        held.release();
        held = null;
      }
      owner = false;
    },
  };
}

export { isWorkerOwner, startWorkerOwnership, LOCK_NAME };
