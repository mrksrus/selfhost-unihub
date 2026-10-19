import { db, getDb } from '../state';
import { poolStats } from './database';
import { log } from '../log';

const HEALTH_PROBE_MS = 4000;
// How long a saturated pool may keep the probe from answering before it counts
// as a failure. Long enough to ride out a burst of sync work; short enough that
// a pool that never drains, or a hung database, ends in a restart.
const BUSY_GRACE_MS = 10 * 60 * 1000;

interface HealthOptions {
  probeMs?: number;
  graceMs?: number;
  execute?: (sql: string) => Promise<unknown>;
  stats?: typeof poolStats;
  ready?: () => boolean;
  now?: () => number;
}

/**
 * The container's health check. The probe waits for a pool connection like
 * any request, so while the pool is saturated it does not answer in time.
 * That is a busy process, not a broken one, as long as the probe succeeded
 * recently: it says so with 200 and the pool counts, because restarting the
 * container would drop the work in flight and not shorten the queue. A timeout
 * with free connections, a pool saturated for longer than the grace, or a
 * refused or failed query is 503.
 *
 * One probe at a time: callers share the pending one, so checks that keep
 * timing out against a full pool do not each queue another SELECT 1.
 */
function createHealthCheck({
  probeMs = HEALTH_PROBE_MS,
  graceMs = BUSY_GRACE_MS,
  execute = (sql: string) => db.execute(sql),
  stats = poolStats,
  ready = () => !!getDb(),
  now = Date.now,
}: HealthOptions = {}) {
  let pending: Promise<'ok'> | null = null;
  let lastSuccessAt: number | null = null;

  const probe = () => {
    if (!pending) {
      const current: Promise<'ok'> = execute('SELECT 1').then(() => {
        lastSuccessAt = now();
        return 'ok' as const;
      }).finally(() => {
        if (pending === current) pending = null;
      });
      pending = current;
    }
    return pending;
  };

  return async function healthCheck() {
    const timestamp = new Date().toISOString();
    if (!ready()) return { status: 503, health: 'error', database: 'not_initialized', timestamp };
    let timer: NodeJS.Timeout | undefined;
    const answer = probe();
    const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), probeMs); timer.unref?.(); });
    try {
      const database = await Promise.race([answer, deadline]);
      if (database === 'ok') return { health: 'ok', database: 'ok', timestamp };
      answer.catch(() => {});
      const pool = stats();
      const saturated = pool.queued > 0 || pool.active >= pool.limit;
      const recent = lastSuccessAt !== null && now() - lastSuccessAt <= graceMs;
      const counts = { active: pool.active, limit: pool.limit, queued: pool.queued };
      if (saturated && recent) {
        log.warn('HEALTH', `Database busy: no connection within ${probeMs} ms`, counts);
        return { health: 'degraded', database: 'busy', pool, timestamp };
      }
      const reason = saturated ? `pool saturated with no successful probe for ${Math.round(graceMs / 1000)} s` : 'no answer with connections free';
      log.error('HEALTH', `Database unavailable: ${reason}`, undefined, counts);
      return { status: 503, health: 'error', database: 'unavailable', pool, timestamp };
    } catch (error) {
      return { status: 503, health: 'error', database: 'unavailable', error: (error as Error).message, timestamp };
    } finally {
      clearTimeout(timer);
    }
  };
}

const healthCheck = createHealthCheck();

export { createHealthCheck, healthCheck };
