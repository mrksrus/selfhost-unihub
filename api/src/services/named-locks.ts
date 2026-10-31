import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import { getDb } from '../state';

/**
 * Named MariaDB locks (GET_LOCK) held over a piece of work, across processes.
 * A lock lives on its connection, which only waits and holds: the work uses
 * the main pool. Lock connections come from a small pool of their own, so
 * locks can never take the main pool's connections from the work they guard
 * (50 locks on 50 main connections would leave none for their work). Each
 * kind has its own share; when it is used up, or a name already has
 * `maxWaiters` waiting in this process, a lock is refused at once instead of
 * waiting for a connection.
 */
// The connections each kind may hold, holders and waiters together.
// Sizing: every holder's work also uses the main pool (50), so the shares
// together stay well below it, leaving room for requests without a lock; a
// share is large enough when at the busiest time few changes are refused
// (409 CALENDAR_EVENT_CHANGED, or a sync skipped as busy). Not measured yet.
// One change of a calendar item (calendar-move-state.ts).
const CALENDAR_EVENT_LOCKS = 10;
// One sync of a calendar account (calendar-sync.ts); a move's removal of an old copy waits for it briefly.
const CALENDAR_SYNC_LOCKS = 8;
const SHARES = { 'calendar-event': CALENDAR_EVENT_LOCKS, 'calendar-sync': CALENDAR_SYNC_LOCKS } as const;
type LockKind = keyof typeof SHARES;

const inUse = new Map<LockKind, number>();
const contenders = new Map<string, number>();
const lockPools = new WeakMap<object, Pool>();
// The kind is one of SHARES' keys, written into the statement so the process
// list shows which kind of lock a connection waits for.
const lockName = (kind: LockKind) => `SHA2(CONCAT(DATABASE(), ':${kind}:', ?), 256)`;

interface ConnectionSettings { host?: string; port?: number; user?: string; password?: string; database?: string; socketPath?: string; ssl?: unknown }

// Derived from the main pool, so tests and scripts that set their own pool
// get locks on the same database. A test double without connection settings
// holds its locks itself.
function lockPool(): Pool {
  const main = getDb();
  if (!main) throw new Error('Database pool has not been initialized');
  const existing = lockPools.get(main);
  if (existing) return existing;
  const settings = (main as unknown as { pool?: { config?: { connectionConfig?: ConnectionSettings } } }).pool?.config?.connectionConfig;
  if (!settings) return main;
  const size = Object.values(SHARES).reduce((sum, share) => sum + share, 0);
  const pool = mysql.createPool({
    host: settings.host, port: settings.port, user: settings.user, password: settings.password, database: settings.database,
    socketPath: settings.socketPath, ssl: settings.ssl as mysql.PoolOptions['ssl'],
    connectionLimit: size, maxIdle: size, waitForConnections: false,
  });
  // An idle lock connection does not keep the process alive; the work it guards does.
  (pool as unknown as { pool: NodeJS.EventEmitter }).pool.on('connection', (connection: { stream?: { unref?: () => void } }) => connection.stream?.unref?.());
  lockPools.set(main, pool);
  return pool;
}

/**
 * A held lock. MariaDB lets go of a lock when its session ends (a killed or
 * broken connection) while the work holding it goes on: before each write
 * the work checks the lease (`stillHeld`), so after such a loss it writes
 * nothing more, and a change that has taken the lock since stands.
 */
interface Lease { readonly kind: LockKind; readonly name: string; readonly session: number; lost: boolean }

/** Whether the lease still holds its lock, read on executor (the write's own transaction where there is one). */
async function stillHeld(executor: SqlExecutor, lease: Lease) {
  if (lease.lost) return false;
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT IS_USED_LOCK(${lockName(lease.kind)}) AS holder`, [lease.name]);
  return Number(rows[0]?.holder) === lease.session;
}

/**
 * Runs fn holding the lock `kind:name`. Answers null without running fn when
 * the lock stays taken for waitSeconds, when the kind's share of lock
 * connections is in use, or when name already has maxWaiters waiting here.
 */
async function withNamedLock<T>(kind: LockKind, name: string, fn: (lease: Lease) => Promise<T>, { waitSeconds = 0, maxWaiters = Infinity }: { waitSeconds?: number; maxWaiters?: number } = {}): Promise<{ value: T } | null> {
  const key = `${kind}:${name}`;
  const used = inUse.get(kind) ?? 0;
  const others = contenders.get(key) ?? 0;
  if (used >= SHARES[kind] || others > maxWaiters) return null;
  inUse.set(kind, used + 1);
  contenders.set(key, others + 1);
  let connection: Awaited<ReturnType<Pool['getConnection']>> | null = null;
  let lease: Lease | null = null;
  // The session ending is noted at once, so the next check fails without a query.
  const lose = () => { if (lease) lease.lost = true; };
  const session = () => (connection as unknown as { connection?: NodeJS.EventEmitter } | null)?.connection;
  try {
    try {
      connection = await lockPool().getConnection();
    } catch (error) {
      if ((error as Error)?.message === 'No connections available.') return null;
      throw error;
    }
    session()?.on('error', lose).on('end', lose);
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT GET_LOCK(${lockName(kind)}, ?) AS acquired, CONNECTION_ID() AS session`, [name, waitSeconds]);
    if (Number(rows[0]?.acquired) !== 1) return null;
    lease = { kind, name, session: Number(rows[0].session), lost: false };
    return { value: await fn(lease) };
  } finally {
    session()?.off('error', lose).off('end', lose);
    let reusable = !lease?.lost;
    if (lease && !lease.lost) await connection!.execute(`SELECT RELEASE_LOCK(${lockName(kind)})`, [name]).catch(() => { reusable = false; });
    // A connection that lost its session (or its lock) is not handed out again.
    if (reusable) connection?.release(); else connection?.destroy();
    inUse.set(kind, (inUse.get(kind) ?? 1) - 1);
    const left = (contenders.get(key) ?? 1) - 1;
    if (left) contenders.set(key, left); else contenders.delete(key);
  }
}

export { withNamedLock, stillHeld };
export type { LockKind, Lease };
