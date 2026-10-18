import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { withTransaction } = require('../dist/src/services/transactions') as typeof import('../src/services/transactions');

// One fake pool connection that records the transaction protocol it saw.
function fakePool() {
  const log: string[] = [];
  const cx = {
    async beginTransaction() { log.push('begin'); },
    async commit() { log.push('commit'); },
    async rollback() { log.push('rollback'); },
    release() { log.push('release'); },
    async execute() { log.push('execute'); return [[]]; },
    async query() { return [[]]; },
  };
  return { log, pool: { async getConnection() { log.push('get'); return cx; } } as FixtureValue };
}

test('withTransaction commits and returns the callback value; a throw rolls back, releases and rethrows', async () => {
  const { log, pool } = fakePool();
  assert.deepEqual(await withTransaction(async cx => { await cx.execute('SELECT 1'); return { count: 3 }; }, pool), { count: 3 });
  assert.deepEqual(log, ['get', 'begin', 'execute', 'commit', 'release']);

  log.length = 0;
  await assert.rejects(withTransaction(async () => { throw Object.assign(new Error('refused'), { code: 'ER_DATA_TOO_LONG' }); }, pool), /refused/);
  assert.deepEqual(log, ['get', 'begin', 'rollback', 'release'], 'a non-deadlock error is not retried');
});

test('withTransaction runs the callback again after a deadlock and gives up after the retry budget', async () => {
  const { log, pool } = fakePool();
  let attempts = 0;
  const result = await withTransaction(async () => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 });
    return 'done';
  }, pool);
  assert.equal(result, 'done');
  assert.equal(attempts, 3);
  assert.equal(log.filter(entry => entry === 'rollback').length, 2);
  assert.equal(log.filter(entry => entry === 'release').length, 3, 'every connection is released, including the rolled-back ones');
  assert.equal(log.filter(entry => entry === 'commit').length, 1);

  attempts = 0;
  await assert.rejects(withTransaction(async () => { attempts++; throw Object.assign(new Error('deadlock'), { errno: 1213 }); }, pool), /deadlock/);
  assert.equal(attempts, 4, 'first attempt plus three retries');
});

test('withTransaction refuses a plain connection so nested transactions cannot be opened by accident', async () => {
  await assert.rejects(withTransaction(async () => 1, { execute: async () => [[]] } as FixtureValue), TypeError);
});
