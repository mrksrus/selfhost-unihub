// Two pools stand for two API processes on one disposable database; the
// named lock needs no tables. Run by scripts/local-db.sh test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');

test('one API process runs the background work; another takes over only when the lock is free', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 60000,
}, async t => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Only an isolated disposable schema is allowed');
  const pool = () => mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, database: process.env.MYSQL_TEST_DATABASE, connectionLimit: 3 });
  const first = pool(), second = pool();
  t.after(async () => { await first.end(); await second.end(); });
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  // Each process has its own module state: load the module twice.
  const load = () => {
    const path = require.resolve('../dist/src/services/worker-owner');
    delete require.cache[path];
    return require(path) as typeof import('../src/services/worker-owner');
  };
  const a = load(), b = load();
  const events: string[] = [];
  const ticks: (() => void)[] = [];
  const timers = { setInterval: ((fn: () => void) => { ticks.push(fn); return { unref() {} }; }) as unknown as typeof setInterval, clearInterval: (() => {}) as typeof clearInterval };
  const tick = async (index: number) => { ticks[index](); await new Promise(resolve => setTimeout(resolve, 200)); };

  const ownerA = await a.startWorkerOwnership({ pool: first, timers, onGained: () => events.push('a gained'), onLost: () => events.push('a lost') });
  const ownerB = await b.startWorkerOwnership({ pool: second, timers, onGained: () => events.push('b gained'), onLost: () => events.push('b lost') });
  assert.deepEqual([a.isWorkerOwner(), b.isWorkerOwner()], [true, false]);
  await tick(0); await tick(1);
  assert.deepEqual(events, ['a gained'], 'checks change nothing while the owner holds the lock');

  await ownerA.stop();
  assert.equal(a.isWorkerOwner(), false);
  await tick(1);
  assert.deepEqual([a.isWorkerOwner(), b.isWorkerOwner()], [false, true]);
  assert.deepEqual(events, ['a gained', 'b gained']);
  await ownerB.stop();
});
