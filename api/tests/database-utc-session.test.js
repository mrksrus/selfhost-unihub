const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

process.env.JWT_SECRET = 'unit-test-jwt-secret-for-utc-sessions';
process.env.ENCRYPTION_KEY = 'unit-test-encryption-key-for-utc-sessions';

function fakeConnection({ fail = false } = {}) {
  return {
    queries: [],
    destroyed: false,
    query(sql, callback) { this.queries.push(sql); process.nextTick(() => callback(typeof fail === 'function' ? fail(sql) : fail ? new Error('denied') : null)); },
    destroy() { this.destroyed = true; },
  };
}

test('every new pooled connection is switched to a UTC session', async () => {
  const { useUtcSessions } = require('../dist/src/services/database');
  const promisePool = { pool: new EventEmitter() };
  assert.equal(useUtcSessions(promisePool), promisePool);
  const first = fakeConnection();
  const second = fakeConnection();
  promisePool.pool.emit('connection', first);
  promisePool.pool.emit('connection', second);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(first.queries, ["SET time_zone = '+00:00'", 'SET innodb_snapshot_isolation = OFF']);
  assert.deepEqual(second.queries, ["SET time_zone = '+00:00'", 'SET innodb_snapshot_isolation = OFF']);
  assert.equal(first.destroyed, false);
});

test('a connection whose session time zone cannot be set is discarded', async (t) => {
  const { useUtcSessions } = require('../dist/src/services/database');
  t.mock.method(console, 'error', () => {});
  const promisePool = useUtcSessions({ pool: new EventEmitter() });
  const connection = fakeConnection({ fail: true });
  promisePool.pool.emit('connection', connection);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connection.destroyed, true);
});

test('a server without snapshot isolation keeps the connection', async () => {
  const { useUtcSessions } = require('../dist/src/services/database');
  const promisePool = useUtcSessions({ pool: new EventEmitter() });
  const unknown = Object.assign(new Error('Unknown system variable'), { errno: 1193 });
  const connection = fakeConnection({ fail: sql => (sql.includes('snapshot') ? unknown : null) });
  promisePool.pool.emit('connection', connection);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connection.destroyed, false);
});

test('initDatabase installs the UTC session hook on the app pool', async (t) => {
  delete process.env.DATABASE_URL;
  Object.assign(process.env, { MYSQL_HOST: 'db.example.test', MYSQL_DATABASE: 'unihub_unit', MYSQL_USER: 'unihub', MYSQL_PASSWORD: 'unit-test-password' });
  const mysql = require('mysql2/promise');
  const corePool = new EventEmitter();
  const stopped = new Error('stop after pool setup');
  const promisePool = {
    pool: corePool,
    async execute() { return [[{ 1: 1 }]]; },
    async query() { return [[{ version: '11.8.9-MariaDB' }]]; },
    async getConnection() { throw stopped; },
    async end() {},
  };
  t.mock.method(mysql, 'createPool', config => {
    assert.equal(config.timezone, '+00:00');
    return promisePool;
  });
  t.mock.method(console, 'log', () => {});
  const { initDatabase } = require('../dist/src/services/database');
  const { setDb } = require('../dist/src/state');
  t.after(() => setDb(null));
  await assert.rejects(initDatabase(), stopped);
  assert.equal(corePool.listenerCount('connection'), 1);
  const connection = fakeConnection();
  corePool.emit('connection', connection);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(connection.queries, ["SET time_zone = '+00:00'", 'SET innodb_snapshot_isolation = OFF']);
});
