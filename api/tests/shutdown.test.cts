import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { EventEmitter } = (require('node:events') as typeof import('node:events'));
const { drainProcess } = require('../dist/src/services/shutdown') as typeof import('../src/services/shutdown');
const { installShutdownHandler } = require('../dist/src/services/server-events') as typeof import('../src/services/server-events');
const { captureLog } = require('../dist/src/log') as typeof import('../src/log');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('the drain waits for requests and mail jobs, then ends this worker\'s leases, then closes the pool', async t => {
  t.after(captureLog(() => {}));
  const steps: string[] = [];
  const server = deferred(), jobs = deferred();
  const drained = drainProcess({
    serverClosed: server.promise.then(() => steps.push('server closed')),
    scheduler: { workerId: 'worker-1', quiesce: () => jobs.promise.then(() => steps.push('jobs finished')) },
    expireWorkerLeases: async workerId => { steps.push(`leases of ${workerId}`); return 0; },
    closePool: async () => { steps.push('pool closed'); },
    waitMs: 60_000,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(steps, [], 'nothing is torn down while work runs');
  jobs.resolve(); server.resolve();
  await drained;
  assert.deepEqual(steps, ['jobs finished', 'server closed', 'leases of worker-1', 'pool closed']);
});

test('a job that does not finish in time is left to lease recovery, and the pool still closes', async t => {
  t.after(captureLog(() => {}));
  const steps: string[] = [];
  await drainProcess({
    serverClosed: Promise.resolve(),
    scheduler: { workerId: 'worker-1', quiesce: () => new Promise(() => {}) },
    expireWorkerLeases: async () => { steps.push('leases'); return 1; },
    closePool: async () => { steps.push('pool'); },
    waitMs: 10,
  });
  assert.deepEqual(steps, ['leases', 'pool']);
});

test('the stop signal is re-raised after the drain, or after drainMs when it hangs', async () => {
  for (const hangs of [false, true]) {
    const signals = new EventEmitter();
    const killed: string[] = [];
    const work = deferred();
    installShutdownHandler({ bus: { closeAll() {} } as FixtureValue, signals, kill: signal => killed.push(signal), graceMs: 1,
      drainMs: hangs ? 20 : 60_000, drain: () => (hangs ? new Promise(() => {}) : work.promise) });
    signals.emit('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(killed, [], 'not before the drain');
    work.resolve();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(killed, ['SIGTERM']);
  }
});
