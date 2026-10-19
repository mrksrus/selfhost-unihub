const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { createHealthCheck } = require('../dist/src/services/health') as typeof import('../src/services/health');

const saturated = () => ({ total: 50, active: 50, free: 0, queued: 12, limit: 50 });
const idle = () => ({ total: 5, active: 1, free: 4, queued: 0, limit: 50 });

// A probe the test answers when it chooses; counts how many were started.
function controlledProbe() {
  const calls: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const execute = () => new Promise((resolve, reject) => { calls.push({ resolve, reject }); });
  return { calls, execute };
}

async function quietly<T>(run: () => Promise<T>) {
  const warn = console.warn;
  const error = console.error;
  const lines: string[] = [];
  console.warn = (message: string) => { lines.push(message); };
  console.error = (message: string) => { lines.push(message); };
  try {
    return { result: await run(), lines };
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

test('a database that answers is ok', async () => {
  const check = createHealthCheck({ execute: async () => [[{ 1: 1 }]], stats: saturated, ready: () => true });
  const result = await check();
  assert.equal(result.status, undefined);
  assert.equal(result.health, 'ok');
  assert.equal(result.database, 'ok');
});

test('a saturated pool after a recent success is busy with 200, not a failure', async () => {
  let clock = 1_000_000;
  const probe = controlledProbe();
  const check = createHealthCheck({ probeMs: 20, graceMs: 60_000, execute: probe.execute, stats: saturated, ready: () => true, now: () => clock });
  const first = check();
  probe.calls[0].resolve([]);
  assert.equal((await first).database, 'ok');

  clock += 30_000;
  const { result, lines } = await quietly(() => check());
  assert.equal(result.status, undefined);
  assert.equal(result.health, 'degraded');
  assert.equal(result.database, 'busy');
  assert.deepEqual(result.pool, saturated());
  assert.match(lines[0], /active=50 limit=50 queued=12/);
});

test('a timeout with free connections is 503: the database, not the pool, is stuck', async () => {
  let clock = 1_000_000;
  const probe = controlledProbe();
  const check = createHealthCheck({ probeMs: 20, execute: probe.execute, stats: idle, ready: () => true, now: () => clock });
  const first = check();
  probe.calls[0].resolve([]);
  await first;

  clock += 1000;
  const { result } = await quietly(() => check());
  assert.equal(result.status, 503);
  assert.equal(result.database, 'unavailable');
});

test('a pool saturated for longer than the grace is 503', async () => {
  let clock = 1_000_000;
  const probe = controlledProbe();
  const check = createHealthCheck({ probeMs: 20, graceMs: 60_000, execute: probe.execute, stats: saturated, ready: () => true, now: () => clock });
  const first = check();
  probe.calls[0].resolve([]);
  await first;

  clock += 60_001;
  const late = await quietly(() => check());
  assert.equal(late.result.status, 503);
  assert.equal(late.result.database, 'unavailable');

  const never = createHealthCheck({ probeMs: 20, execute: () => new Promise(() => {}), stats: saturated, ready: () => true });
  const { result } = await quietly(() => never());
  assert.equal(result.status, 503, 'no successful probe at all is no grace');
});

test('concurrent and repeated checks share one pending probe instead of queueing more', async () => {
  let clock = 1_000_000;
  const probe = controlledProbe();
  const check = createHealthCheck({ probeMs: 20, graceMs: 60_000, execute: probe.execute, stats: saturated, ready: () => true, now: () => clock });
  const first = check();
  probe.calls[0].resolve([]);
  await first;

  clock += 1000;
  const { result } = await quietly(async () => {
    const together = await Promise.all([check(), check(), check()]);
    await check();
    return together;
  });
  assert.equal(probe.calls.length, 2, 'one probe after the first, still pending, shared by all four checks');
  assert.deepEqual(result.map(item => item.database), ['busy', 'busy', 'busy']);

  // Once it answers, the next check starts a fresh probe.
  probe.calls[1].resolve([]);
  await new Promise(resolve => setImmediate(resolve));
  const next = check();
  assert.equal(probe.calls.length, 3);
  probe.calls[2].resolve([]);
  assert.equal((await next).database, 'ok');
});

test('a failed query and a missing pool are 503', async () => {
  const failing = createHealthCheck({ execute: async () => { throw new Error('refused'); }, stats: saturated, ready: () => true });
  const failed = await failing();
  assert.equal(failed.status, 503);
  assert.equal(failed.database, 'unavailable');
  const missing = await createHealthCheck({ ready: () => false })();
  assert.equal(missing.status, 503);
  assert.equal(missing.database, 'not_initialized');
});
