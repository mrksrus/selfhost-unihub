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
  timers?: Pick<typeof globalThis, 'setInterval' | 'clearInterval'>;
}

async function startWorkerOwnership({ pool, onGained, onLost, everyMs = 30_000, timers = globalThis }: OwnershipOptions) {
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
      const [[row]] = await held!.query<RowDataPacket[]>('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS mine', [LOCK_NAME]);
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
