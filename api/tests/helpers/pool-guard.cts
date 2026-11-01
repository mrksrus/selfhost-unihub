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

// Held from the moment the connection is handed over until its release.
interface Checkout { pool: object; released: boolean; taken: string }
// A chain, as one task can hold connections of different pools at once.
interface Holding { checkout: Checkout; outer: Holding | undefined }
const holding = new AsyncLocalStorage<Holding>();
const checkouts = new WeakMap<object, Checkout>();
// The checkout whose caller is resuming with its connection right now (see getConnection).
let handedOver: Checkout | undefined;
const violations: string[] = [];
const callers = (stack = '') => stack.split('\n').slice(2).join('\n');

// Marks the running task as holding the checkout. The task's later work, and
// work it starts from here on, inherits the mark, which release clears.
function hold(checkout: Checkout) {
  if (checkout.released) return;
  for (let held = holding.getStore(); held; held = held.outer) if (held.checkout === checkout) return;
  holding.enterWith({ checkout, outer: holding.getStore() });
}

function refuseSecond(pool: object, method: string) {
  if (handedOver) hold(handedOver);
  for (let held = holding.getStore(); held; held = held.outer) {
    if (held.checkout.released || held.checkout.pool !== pool) continue;
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
  const checkout: Checkout = { pool: this, released: false, taken };
  // Marking the caller's context here would also mark the rest of its
  // synchronous run, and so every task started beside this one in the same
  // tick (Promise.all) would hold the connection too. The hold starts in the
  // caller's own continuation instead: the first reaction to the handed-over
  // promise, registered before the caller's, opens a window that the
  // microtask queued right after the caller's resumption closes. Only the
  // caller's resumed run falls inside it, and its first pool or connection
  // call there marks it, so a request before the first statement counts.
  const handed = new Promise<object>((resolve, reject) => {
    getConnection.call(this).then(connection => {
      checkouts.set(connection, checkout);
      resolve(connection);
      queueMicrotask(() => { if (handedOver === checkout) handedOver = undefined; });
    }, reject);
  });
  handed.then(() => { handedOver = checkout; }, () => {});
  return handed;
};

// A caller that reaches the pool through a wrapper of its own (a test's
// getConnection) resumes outside that window: the connection's first
// statement marks the task that runs it.
const connection = PromisePoolConnection.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const method of ['beginTransaction', 'execute', 'query']) {
  const original = connection[method];
  connection[method] = function (this: object, ...args: unknown[]) {
    if (handedOver) hold(handedOver);
    const checkout = checkouts.get(this);
    if (checkout) hold(checkout);
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
