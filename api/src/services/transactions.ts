import type { Pool, PoolConnection } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import { db } from '../state';

// InnoDB picks a deadlock victim and rolls its whole transaction back, so the
// callback can run again from the start. Callbacks must only touch the
// database: provider commands and file writes never run inside a transaction.
const DEADLOCK_RETRIES = 3;
const isDeadlock = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ER_LOCK_DEADLOCK' || (error as NodeJS.ErrnoException)?.errno === 1213;

// Runs the callback on one pooled connection between BEGIN and COMMIT; rolls
// back and rethrows when it throws, and always releases the connection. The
// callback's return value is the result, so a service can return early values
// (a not-found marker, a count) without its own commit/rollback bookkeeping.
async function withTransaction<T>(callback: (connection: SqlExecutor) => T | PromiseLike<T>, executor: Pick<Pool, 'getConnection'> = db): Promise<T> {
  if (typeof executor.getConnection !== 'function') throw new TypeError('withTransaction requires a pool; pass your existing connection directly to helpers');
  for (let attempt = 1; ; attempt++) {
    const cx: PoolConnection = await executor.getConnection();
    try {
      await cx.beginTransaction();
      const result = await callback(cx);
      await cx.commit();
      return result;
    } catch (error) {
      await cx.rollback();
      if (!isDeadlock(error) || attempt > DEADLOCK_RETRIES) throw error;
    } finally { cx.release(); }
    await new Promise(resolve => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30)));
  }
}

export { withTransaction, isDeadlock, DEADLOCK_RETRIES };
