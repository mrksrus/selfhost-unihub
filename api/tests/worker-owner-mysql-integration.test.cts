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
  const tick = async (index: number, settle = 200) => { ticks[index](); await new Promise(resolve => setTimeout(resolve, settle)); };
  const handoverMs = 100;

  const ownerA = await a.startWorkerOwnership({ pool: first, timers, handoverMs, onGained: () => events.push('a gained'), onLost: () => events.push('a lost') });
  const ownerB = await b.startWorkerOwnership({ pool: second, timers, handoverMs, onGained: () => events.push('b gained'), onLost: () => events.push('b lost') });
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

test('when the owner\'s session ends, the next owner starts only after the old one has stopped (B-06)', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 60000,
}, async t => {
  const pool = () => mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, database: process.env.MYSQL_TEST_DATABASE, connectionLimit: 3 });
  const first = pool(), second = pool(), admin = pool();
  t.after(async () => { await first.end(); await second.end(); await admin.end(); });
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const load = () => {
    const path = require.resolve('../dist/src/services/worker-owner');
    delete require.cache[path];
    return require(path) as typeof import('../src/services/worker-owner');
  };
  const a = load(), b = load();
  const events: string[] = [];
  const ticks: (() => void)[] = [];
  const timers = { setInterval: ((fn: () => void) => { ticks.push(fn); return { unref() {} }; }) as unknown as typeof setInterval, clearInterval: (() => {}) as typeof clearInterval };
  // Checks run when the test says; the handover wait is a real 1.5 s. A's
  // database can be made unreachable for new connections.
  let unreachable = false;
  const firstPool = { getConnection: () => unreachable ? Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) : first.getConnection() };
  const ownerA = await a.startWorkerOwnership({ pool: firstPool, timers, handoverMs: 1500, onGained: () => events.push('a gained'), onLost: () => events.push('a lost') });
  const ownerB = await b.startWorkerOwnership({ pool: second, timers, handoverMs: 1500, onGained: () => events.push('b gained'), onLost: () => events.push('b lost') });
  t.after(async () => { await ownerA.stop(); await ownerB.stop(); });
  assert.deepEqual(events, ['a gained']);

  // A's lock session ends (as in a database restart for that connection); A does
  // not know yet, and cannot reach the database to take the lock again.
  const [[{ holder }]] = await admin.query<FixtureRow[]>('SELECT IS_USED_LOCK(?) AS holder', [a.LOCK_NAME]);
  await admin.query(`KILL ${Number(holder)}`);
  unreachable = true;
  const bChecks = new Promise(resolve => { ticks[1](); setTimeout(resolve, 300); });
  await bChecks;
  assert.equal(b.isWorkerOwner(), false, 'B holds the lock but waits for the handover');
  ticks[0]();
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.deepEqual(events, ['a gained', 'a lost', 'b gained'], 'A stopped before B started, although it could not take the lock again');
  assert.deepEqual([a.isWorkerOwner(), b.isWorkerOwner()], [false, true]);
  // A's database is back: it stays a follower while B holds the lock.
  unreachable = false;
  ticks[0]();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual([a.isWorkerOwner(), b.isWorkerOwner()], [false, true]);
});
type FixtureRow = import('mysql2/promise').RowDataPacket & { holder: number | string };
