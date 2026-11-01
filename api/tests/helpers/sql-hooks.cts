// Hooks on the statements the app sends through a test pool, to reproduce an
// interleaving: run something right before or after one statement (once), or
// make it fail as a deadlock victim would. Patches the pool and every
// connection it hands out; a hook that is not armed costs nothing. The codes
// of statements that failed (a real deadlock, say) are kept in `errors`;
// `watch` counts the statements matching a pattern.
type Hook = { match: RegExp; params?: (params: unknown[]) => boolean; before?: () => unknown; after?: () => unknown };
type Execute = (sql: unknown, params?: unknown) => Promise<unknown>;
type Executor = { execute: Execute; __sqlHooked?: boolean };

function installSqlHooks(pool: Executor & { getConnection: () => Promise<Executor> }) {
  const hooks: Hook[] = [];
  const errors: string[] = [];
  const watched: { match: RegExp; count: number }[] = [];
  const wrap = (target: Executor) => {
    if (target.__sqlHooked) return target;
    const execute = target.execute.bind(target);
    target.execute = async (sql: unknown, params?: unknown) => {
      for (const watch of watched) if (watch.match.test(String(sql))) watch.count += 1;
      const index = hooks.findIndex(hook => hook.match.test(String(sql)) && (!hook.params || hook.params(Array.isArray(params) ? params : [])));
      const hook = index >= 0 ? hooks.splice(index, 1)[0] : null;
      if (hook?.before) await hook.before();
      let result;
      try {
        result = await execute(sql, params);
      } catch (error) {
        errors.push(String((error as { code?: unknown }).code ?? 'error'));
        throw error;
      }
      if (hook?.after) await hook.after();
      return result;
    };
    target.__sqlHooked = true;
    return target;
  };
  wrap(pool);
  const getConnection = pool.getConnection.bind(pool);
  pool.getConnection = async () => wrap(await getConnection());
  return {
    /** Runs once, on the next statement matching `match`. */
    once(hook: Hook) { hooks.push(hook); },
    clear() { hooks.length = 0; },
    /** Counts, from now on, the statements matching `match` (read `count`). */
    watch(match: RegExp) { const watch = { match, count: 0 }; watched.push(watch); return watch; },
    errors,
  };
}

/** A deadlock as InnoDB reports it, which the services' transactions retry. */
const deadlock = () => Object.assign(new Error('Deadlock found when trying to get lock; try restarting transaction'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 });
/** Resolves after `ms`, so a step that should wait never hangs a test. */
const within = <T,>(promise: Promise<T>, ms: number) => Promise.race([promise.then(value => ({ done: true as const, value })), new Promise<{ done: false }>(resolve => setTimeout(() => resolve({ done: false }), ms))]);

export type SqlHooks = ReturnType<typeof installSqlHooks>;
module.exports = { installSqlHooks, deadlock, within };
