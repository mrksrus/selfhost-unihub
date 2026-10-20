import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { log } from '../log';

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
// counts as lost, and a process that gets the lock waits two check intervals
// (the handover) before it starts, by which time the old owner has stopped.
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
  /** How long a new owner waits before it starts; two checks by default. */
  handoverMs?: number;
  timers?: Pick<typeof globalThis, 'setInterval' | 'clearInterval'> & Partial<Pick<typeof globalThis, 'setTimeout'>>;
}

async function startWorkerOwnership({ pool, onGained, onLost, everyMs = 5_000, handoverMs = 2 * everyMs, timers = globalThis }: OwnershipOptions) {
  owner = false;
  let held: PoolConnection | null = null;
  let checking = false, stopped = false, warned = false;

  const drop = (connection: PoolConnection | null) => { try { connection?.destroy(); } catch { /* gone already */ } };
  const acquire = async () => {
    const connection = await pool.getConnection();
    try {
      const [[row]] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS got', [LOCK_NAME]);
      if (Number(row?.got) === 1) return connection;
    } catch (error) { drop(connection); throw error; }
    connection.release();
    return null;
  };
  // Still ours: the session holding the lock is this connection's.
  const stillHeld = async () => {
    try {
      const [[row]] = await held!.query<RowDataPacket[]>({ sql: 'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS mine', timeout: Math.max(1000, everyMs - 1000) }, [LOCK_NAME]);
      return Number(row?.mine) === 1;
    } catch { return false; }
  };

  const check = async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      if (owner && await stillHeld()) return;
      if (owner) { drop(held); held = null; }
      // The session that held it may have ended with the database still up;
      // take the lock again before giving up the role.
      let next: PoolConnection | null = null;
      try { next = await acquire(); }
      catch (error) {
        // The database is unreachable: nobody can take the lock meanwhile
        // unless our session ended, which the next check finds out.
        log.error('OWNER', 'Could not check the background work lock', error);
        return;
      }
      if (next) {
        held = next;
        if (!owner) {
          // A previous owner whose session ended may still be working; it
          // notices within one check and stops.
          await new Promise(resolve => (timers.setTimeout ?? setTimeout)(resolve, handoverMs));
          if (stopped || !await stillHeld()) { drop(held); held = null; return; }
          owner = true; warned = false;
          log.info('OWNER', 'This process runs the background work');
          await onGained();
        }
      } else if (owner) {
        owner = false;
        log.error('OWNER', 'Another API process took over the background work; this one now serves requests only');
        await onLost();
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
