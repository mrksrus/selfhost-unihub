import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import { getDb } from '../state';

/**
 * Small connection pools beside the main one, on the same database, for
 * connections that must never wait behind request traffic. Each is derived
 * from the main pool, so tests and scripts that set their own pool get them
 * on the same database; a test double without connection settings serves
 * them itself.
 */
interface ConnectionSettings { host?: string; port?: number; user?: string; password?: string; database?: string; socketPath?: string; ssl?: unknown; timezone?: string }
interface SidePoolOptions { connectionLimit: number; waitForConnections: boolean; utcSessions?: boolean }

const sidePools = new WeakMap<object, Map<string, Pool>>();

function derivedPool(kind: string, { connectionLimit, waitForConnections, utcSessions = false }: SidePoolOptions): Pool {
  const main = getDb();
  if (!main) throw new Error('Database pool has not been initialized');
  const byKind = sidePools.get(main) ?? new Map<string, Pool>();
  sidePools.set(main, byKind);
  const existing = byKind.get(kind);
  if (existing) return existing;
  const settings = (main as unknown as { pool?: { config?: { connectionConfig?: ConnectionSettings } } }).pool?.config?.connectionConfig;
  if (!settings) return main;
  let pool = mysql.createPool({
    host: settings.host, port: settings.port, user: settings.user, password: settings.password, database: settings.database,
    socketPath: settings.socketPath, ssl: settings.ssl as mysql.PoolOptions['ssl'], timezone: settings.timezone,
    connectionLimit, maxIdle: connectionLimit, waitForConnections,
  });
  // Written dates are UTC, as on the main pool (database.ts).
  if (utcSessions) pool = (require('./database') as typeof import('./database')).useUtcSessions(pool);
  // An idle side connection does not keep the process alive; the work using it does.
  (pool as unknown as { pool: NodeJS.EventEmitter }).pool.on('connection', (connection: { stream?: { unref?: () => void } }) => connection.stream?.unref?.());
  byKind.set(kind, pool);
  return pool;
}

// Job control: the background workers' bookkeeping that runs while their own
// work holds a main connection, and the worker owner's lock session. A
// restore's transaction holds row locks; requests waiting for those rows can
// take every main connection, so its progress writes and cancellation checks
// (which must not run on its transaction: progress has to stay visible and
// unlocked, a check has to see later commits) come from here, as do the
// export's cancellation checks during its snapshot read and the process's
// VAPID key read. Each user is one task at a time per process: the worker
// owner's lock (held all the time), the restore worker, the export worker and
// the VAPID read, so four connections never make one of them wait.
const CONTROL_CONNECTIONS = 4;

function controlPool(): Pool {
  return derivedPool('control', { connectionLimit: CONTROL_CONNECTIONS, waitForConnections: true, utcSessions: true });
}

// Ends the side pools of the main pool (a test's, at its end).
async function endSidePools(main: object | null = getDb()) {
  const byKind = main && sidePools.get(main);
  if (!byKind) return;
  sidePools.delete(main);
  await Promise.all([...byKind.values()].filter(pool => pool !== main).map(pool => pool.end()));
}

export { derivedPool, controlPool, endSidePools, CONTROL_CONNECTIONS };
