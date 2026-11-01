// Loaded before every API test file (node --require). A task that holds a
// pooled connection must not ask the same pool for another one: mysql2 queues
// that request without a limit, so as many such tasks as the pool has
// connections wait for each other for ever and the API stops answering. A
// single test never fills the pool, so here the second request fails at once
// instead, naming both places, and fails the test file even when the error is
// caught. Only connections the app takes count; a test may hold one of its own.
import type { Pool, PoolConnection } from 'mysql2/promise';
const { AsyncLocalStorage } = require('node:async_hooks') as typeof import('node:async_hooks');
const path = require('node:path') as typeof import('node:path');

// The package exports hide lib/; the resolved path is the same module the app loads.
const mysqlRoot = path.dirname(require.resolve('mysql2/package.json'));
const PromisePool = require(path.join(mysqlRoot, 'lib/promise/pool.js')) as { prototype: Pool & { pool: { config: { waitForConnections?: boolean } } } };
const PromisePoolConnection = require(path.join(mysqlRoot, 'lib/promise/pool_connection.js')) as { prototype: PoolConnection };
const appCode = path.resolve(__dirname, '../../dist') + path.sep;

// Active from the moment the connection is handed over until its release.
interface Checkout { pool: object; active: boolean; released: boolean; taken: string }
// A chain, as one task can hold connections of different pools at once.
interface Holding { checkout: Checkout; outer: Holding | undefined }
const holding = new AsyncLocalStorage<Holding>();
const checkouts = new WeakMap<object, Checkout>();
const violations: string[] = [];
const callers = (stack = '') => stack.split('\n').slice(2).join('\n');

function refuseSecond(pool: object, method: string) {
  for (let held = holding.getStore(); held; held = held.outer) {
    if (!held.checkout.active || held.checkout.released || held.checkout.pool !== pool) continue;
    const message = `pool.${method}() while this task holds a connection of the same pool; pass that connection instead.\n` +
      `Connection taken:\n${held.checkout.taken}\nSecond request:\n${callers(new Error().stack)}`;
    violations.push(message);
    throw new Error(message);
  }
}

const pool = PromisePool.prototype as unknown as Record<string, (...args: unknown[]) => unknown> & { pool: { config: { waitForConnections?: boolean } } };
for (const method of ['execute', 'query']) {
  const original = pool[method];
  pool[method] = function (this: object, ...args: unknown[]) { refuseSecond(this, method); return original.apply(this, args); };
}
const getConnection = pool.getConnection as () => Promise<object>;
pool.getConnection = function (this: typeof pool) {
  refuseSecond(this, 'getConnection');
  const taken = callers(new Error().stack);
  // A pool that refuses rather than waits (the named-lock pool) cannot hang this way.
  const counted = taken.includes(appCode) && this.pool.config.waitForConnections !== false;
  if (!counted) return getConnection.call(this);
  const checkout: Checkout = { pool: this, active: false, released: false, taken };
  // The caller awaits the connection in the context marked here (its promise
  // cannot set the caller's context later), so from the handover on, a request
  // of the caller's counts, also before its first statement.
  holding.enterWith({ checkout, outer: holding.getStore() });
  return getConnection.call(this).then(connection => {
    checkout.active = true;
    checkouts.set(connection, checkout);
    return connection;
  }, error => { checkout.released = true; throw error; });
};

// A caller that reaches the pool through a wrapper of its own (a test's
// getConnection) is not marked above: the connection's first statement marks
// the task that runs it. Work it awaits or starts afterwards inherits the
// mark, which release clears.
const connection = PromisePoolConnection.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const method of ['beginTransaction', 'execute', 'query']) {
  const original = connection[method];
  connection[method] = function (this: object, ...args: unknown[]) {
    const checkout = checkouts.get(this);
    if (checkout && !checkout.released) {
      let held = holding.getStore();
      while (held && held.checkout !== checkout) held = held.outer;
      if (!held) holding.enterWith({ checkout, outer: holding.getStore() });
    }
    return original.apply(this, args);
  };
}
for (const method of ['release', 'destroy']) {
  const original = connection[method];
  connection[method] = function (this: object, ...args: unknown[]) {
    const checkout = checkouts.get(this);
    if (checkout) checkout.released = true;
    return original.apply(this, args);
  };
}

process.on('exit', () => {
  if (!violations.length) return;
  console.error(`\n${violations.length} nested pool request(s) under a held connection:\n\n${violations.join('\n\n')}`);
  process.exitCode = 1;
});
