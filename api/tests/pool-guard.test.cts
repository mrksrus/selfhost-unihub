// The pool guard (helpers/pool-guard.cts) on a pool without a database. Each
// case runs in its own process under the guard, because a refused request
// fails that process at exit even when the error is caught. The case's code
// is compiled under dist/, where the guard counts it as app code.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
const path = require('node:path') as typeof import('node:path');

const api = path.resolve(__dirname, '..');

// A pool whose connections answer every statement after a few milliseconds.
const runner = `
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const api = ${JSON.stringify(api)};
const mysqlRoot = path.dirname(require.resolve('mysql2/package.json', { paths: [api] }));
const PromisePool = require(path.join(mysqlRoot, 'lib/promise/pool.js'));
const later = callback => setTimeout(callback, 2);
const answer = (sql, values, done) => later(() => (done || values)(null, [], []));
function coreConnection() {
  const connection = new EventEmitter();
  Object.assign(connection, { query: answer, execute: answer, release() {}, destroy() {} });
  for (const method of ['beginTransaction', 'commit', 'rollback']) connection[method] = done => later(() => done(null));
  return connection;
}
const core = Object.assign(new EventEmitter(), { config: { waitForConnections: true }, query: answer, execute: answer,
  getConnection: done => later(() => done(null, coreConnection())) });
const file = path.join(api, 'dist', 'pool-guard-case.js');
const scenario = new Module(file, module);
scenario.filename = file;
scenario.paths = Module._nodeModulePaths(path.dirname(file));
scenario._compile(process.env.POOL_GUARD_CASE, file);
const { withTransaction } = require(path.join(api, 'dist/src/services/transactions.js'));
scenario.exports({ pool: new PromisePool(core, Promise), withTransaction, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) })
  .then(() => console.log('case finished'), error => { console.log('case failed: ' + error.message); process.exitCode = 2; });
`;

function run(source: string) {
  const result = spawnSync(process.execPath, ['--require', './tests/helpers/pool-guard.cts', '-e', runner], {
    cwd: api, env: { ...process.env, POOL_GUARD_CASE: `module.exports = async ({ pool, withTransaction, sleep }) => {\n${source}\n};` },
    encoding: 'utf8', timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertPasses(source: string) {
  const result = run(source);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /case finished/);
}

function assertRefused(source: string, method: string) {
  const result = run(source);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, new RegExp(`pool\\.${method}\\(\\) while this task holds a connection of the same pool`));
  assert.match(result.stderr, /Connection taken:\n[^]*pool-guard-case\.js[^]*Second request:\n[^]*pool-guard-case\.js/);
}

test('a task beside a holder may use the pool, in either order and after the handover', () => {
  // Started in the same tick as the holder, each sibling asks the pool while the
  // holder's connection is out (taken after 2 ms, released after its sleep).
  assertPasses(`
    const holder = () => withTransaction(async connection => { await connection.query('SELECT 1'); await sleep(30); }, pool);
    const sibling = async () => { await sleep(10); await pool.query('SELECT 2'); await pool.execute('SELECT 3'); };
    await Promise.all([holder(), sibling()]);
    await Promise.all([sibling(), holder()]);
  `);
  assertPasses(`
    const direct = async () => { const connection = await pool.getConnection(); await sleep(30); await connection.query('SELECT 1'); connection.release(); };
    const sibling = async () => { await sleep(10); await pool.query('SELECT 2'); };
    await Promise.all([direct(), sibling()]);
  `);
});

test('two transactions side by side each hold only their own connection', () => {
  assertPasses(`
    const work = ms => withTransaction(async connection => { await sleep(ms); await connection.query('SELECT 1'); }, pool);
    await Promise.all([work(20), work(5), (async () => { await sleep(10); await pool.query('SELECT 2'); })()]);
    await pool.query('SELECT 3');
  `);
});

test('the holder asking the pool inside its transaction still fails', () => {
  assertRefused(`await withTransaction(async () => { await pool.query('SELECT 1'); }, pool);`, 'query');
  assertRefused(`await withTransaction(async () => { await sleep(5); await pool.getConnection(); }, pool);`, 'getConnection');
});

test("the holder asking the pool before the connection's first statement still fails, also when the error is caught", () => {
  assertRefused(`
    const connection = await pool.getConnection();
    try { await pool.query('SELECT 1'); } catch {}
    connection.release();
  `, 'query');
});

test('work the holder starts after taking the connection inherits the hold', () => {
  assertRefused(`
    const connection = await pool.getConnection();
    await connection.query('SELECT 1');
    await Promise.all([connection.query('SELECT 2'), (async () => { await sleep(5); await pool.execute('SELECT 3'); })()]);
    connection.release();
  `, 'execute');
});

test('after release the task may use the pool again', () => {
  assertPasses(`
    const connection = await pool.getConnection();
    await connection.query('SELECT 1');
    connection.release();
    await pool.query('SELECT 2');
  `);
});
