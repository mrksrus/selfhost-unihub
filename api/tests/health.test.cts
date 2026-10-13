const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { healthCheck } = require('../dist/src/services/health') as typeof import('../src/services/health');

const stats = () => ({ total: 50, active: 50, free: 0, queued: 12, limit: 50 });

test('a database that answers is ok', async () => {
  const result = await healthCheck({ execute: async () => [[{ 1: 1 }]], stats, ready: () => true });
  assert.equal(result.status, undefined);
  assert.equal(result.health, 'ok');
  assert.equal(result.database, 'ok');
});

test('a saturated pool is reported busy with 200, not as a failure', async () => {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => { warnings.push(message); };
  try {
    const result = await healthCheck({ probeMs: 20, execute: () => new Promise(() => {}), stats, ready: () => true });
    assert.equal(result.status, undefined);
    assert.equal(result.health, 'degraded');
    assert.equal(result.database, 'busy');
    assert.deepEqual(result.pool, stats());
    assert.match(warnings[0], /active 50\/50, queued 12/);
  } finally {
    console.warn = original;
  }
});

test('a failed query and a missing pool are 503', async () => {
  const failed = await healthCheck({ execute: async () => { throw new Error('refused'); }, stats, ready: () => true });
  assert.equal(failed.status, 503);
  assert.equal(failed.database, 'unavailable');
  const missing = await healthCheck({ ready: () => false });
  assert.equal(missing.status, 503);
  assert.equal(missing.database, 'not_initialized');
});
