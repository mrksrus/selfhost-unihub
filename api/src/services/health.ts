import { db, getDb } from '../state';
import { poolStats } from './database';

const HEALTH_PROBE_MS = 4000;

interface HealthOptions {
  probeMs?: number;
  execute?: (sql: string) => Promise<unknown>;
  stats?: typeof poolStats;
  ready?: () => boolean;
}

/**
 * The container's health check. The probe waits for a pool connection like
 * any request, so while the pool is saturated it does not answer in time.
 * That is a busy process, not a broken one: it says so with 200 and the pool
 * counts, because restarting the container would drop the work in flight and
 * not shorten the queue. A refused or failed query is 503.
 */
async function healthCheck({ probeMs = HEALTH_PROBE_MS, execute = (sql: string) => db.execute(sql), stats = poolStats, ready = () => !!getDb() }: HealthOptions = {}) {
  const timestamp = new Date().toISOString();
  if (!ready()) return { status: 503, health: 'error', database: 'not_initialized', timestamp };
  let timer: NodeJS.Timeout | undefined;
  const probe = execute('SELECT 1').then(() => 'ok' as const, (error: unknown) => { throw error; });
  const deadline = new Promise<'busy'>(resolve => { timer = setTimeout(() => resolve('busy'), probeMs); timer.unref?.(); });
  try {
    const database = await Promise.race([probe, deadline]);
    if (database === 'busy') {
      probe.catch(() => {});
      const pool = stats();
      console.warn(`[HEALTH] Database busy: no connection within ${probeMs} ms (active ${pool.active}/${pool.limit}, queued ${pool.queued})`);
      return { health: 'degraded', database: 'busy', pool, timestamp };
    }
    return { health: 'ok', database: 'ok', timestamp };
  } catch (error) {
    return { status: 503, health: 'error', database: 'unavailable', error: (error as Error).message, timestamp };
  } finally {
    clearTimeout(timer);
  }
}

export { healthCheck };
