import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
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
const SHARES = {
  // One change of a calendar item (calendar-move-state.ts), holders and waiters.
  'calendar-event': 10,
  // One sync of a calendar account (calendar-sync.ts); a move's removal of an old copy waits for it briefly.
  'calendar-sync': 8,
} as const;
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
 * Runs fn holding the lock `kind:name`. Answers null without running fn when
 * the lock stays taken for waitSeconds, when the kind's share of lock
 * connections is in use, or when name already has maxWaiters waiting here.
 */
async function withNamedLock<T>(kind: LockKind, name: string, fn: () => Promise<T>, { waitSeconds = 0, maxWaiters = Infinity }: { waitSeconds?: number; maxWaiters?: number } = {}): Promise<{ value: T } | null> {
  const key = `${kind}:${name}`;
  const used = inUse.get(kind) ?? 0;
  const others = contenders.get(key) ?? 0;
  if (used >= SHARES[kind] || others > maxWaiters) return null;
  inUse.set(kind, used + 1);
  contenders.set(key, others + 1);
  let connection: Awaited<ReturnType<Pool['getConnection']>> | null = null;
  let locked = false;
  try {
    try {
      connection = await lockPool().getConnection();
    } catch (error) {
      if ((error as Error)?.message === 'No connections available.') return null;
      throw error;
    }
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT GET_LOCK(${lockName(kind)}, ?) AS acquired`, [name, waitSeconds]);
    locked = Number(rows[0]?.acquired) === 1;
    if (!locked) return null;
    return { value: await fn() };
  } finally {
    if (locked) await connection!.execute(`SELECT RELEASE_LOCK(${lockName(kind)})`, [name]).catch(() => {});
    connection?.release();
    inUse.set(kind, (inUse.get(kind) ?? 1) - 1);
    const left = (contenders.get(key) ?? 1) - 1;
    if (left) contenders.set(key, left); else contenders.delete(key);
  }
}

export { withNamedLock };
export type { LockKind };
