// Hooks on the statements the app sends through a test pool, to reproduce an
// interleaving: run something right before or after one statement (once), or
// make it fail as a deadlock victim would. Patches the pool and every
// connection it hands out; a hook that is not armed costs nothing.
type Hook = { match: RegExp; before?: () => unknown; after?: () => unknown };

function installSqlHooks(pool: { execute: Function; getConnection: Function }) {
  const hooks: Hook[] = [];
  const wrap = (target: { execute: Function } & { __sqlHooked?: boolean }) => {
    if (target.__sqlHooked) return target;
    const execute = target.execute.bind(target);
    target.execute = async (sql: unknown, params?: unknown) => {
      const index = hooks.findIndex(hook => hook.match.test(String(sql)));
      const hook = index >= 0 ? hooks.splice(index, 1)[0] : null;
      if (hook?.before) await hook.before();
      const result = await execute(sql, params);
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
  };
}

/** A deadlock as InnoDB reports it, which the services' transactions retry. */
const deadlock = () => Object.assign(new Error('Deadlock found when trying to get lock; try restarting transaction'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 });
/** Resolves after `ms`, so a step that should wait never hangs a test. */
const within = <T>(promise: Promise<T>, ms: number) => Promise.race([promise.then(value => ({ done: true as const, value })), new Promise<{ done: false }>(resolve => setTimeout(() => resolve({ done: false }), ms))]);

export type SqlHooks = ReturnType<typeof installSqlHooks>;
module.exports = { installSqlHooks, deadlock, within };
