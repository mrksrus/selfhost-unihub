const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { getDatabaseConfig } = require('../src/services/database-config');
const { probeDatabase, waitForDatabase, seconds } = require('../src/mysql-readiness');

const config = { host: 'database', port: 3306, user: 'unihub', password: 'test-password', database: 'unihub' };

test('readiness uses the API DATABASE_URL precedence and configured credentials without transport overrides', async () => {
  const selected = getDatabaseConfig({ DATABASE_URL: 'mysql://url-user:encoded%40password@url-db:3307/url_database',
    MYSQL_HOST: 'ignored', MYSQL_DATABASE: 'ignored', MYSQL_USER: 'ignored', MYSQL_PASSWORD: 'ignored' });
  assert.deepEqual(selected, { host: 'url-db', port: 3307, user: 'url-user', password: 'encoded@password', database: 'url_database' });
  assert.deepEqual(getDatabaseConfig({ MYSQL_HOST: config.host, MYSQL_DATABASE: config.database, MYSQL_USER: config.user, MYSQL_PASSWORD: config.password }), config);
  assert.equal(getDatabaseConfig({ MYSQL_HOST: 'database' }), null);
  const calls = [];
  await probeDatabase(selected, { timeoutMs: 2500, createConnection(options) {
    calls.push(options);
    return { promise: () => ({ query: async sql => { calls.push(sql); } }), destroy: () => calls.push('destroyed') };
  } });
  assert.deepEqual(calls, [{ ...selected, timezone: '+00:00', connectTimeout: 2500 }, 'SELECT 1', 'destroyed']);
});

test('a slow database retains the full default five-minute budget and exits only after SELECT1 succeeds', async () => {
  let elapsed = 0;
  let attempts = 0;
  const logs = [];
  const ready = await waitForDatabase(config, {
    now: () => elapsed, sleep: async ms => { elapsed += ms; }, log: line => logs.push(line),
    probe: async () => {
      attempts++;
      if (elapsed < 290000) throw Object.assign(new Error('Not ready yet'), { code: 'ECONNREFUSED' });
    },
  });
  assert.equal(ready, true);
  assert.equal(elapsed, 290000);
  assert.equal(attempts, 59);
  assert.match(logs[0], /up to 300s/);
  assert.equal(logs.filter(line => line.includes('MySQL is ready!')).length, 1);
  assert.equal(logs.some(line => line.includes('continuing anyway')), false);
});

test('failed authentication never becomes readiness and retries stop at the actual elapsed deadline', async () => {
  let elapsed = 0;
  const timeouts = [];
  const logs = [];
  const ready = await waitForDatabase(config, {
    maxWaitMs: 1000, intervalMs: 500, now: () => elapsed,
    sleep: async ms => { elapsed += ms; }, log: line => logs.push(line),
    probe: async (_config, options) => {
      timeouts.push(options.timeoutMs);
      elapsed += 700;
      throw Object.assign(new Error('Sensitive test-password'), { code: 'ER_ACCESS_DENIED_ERROR' });
    },
  });
  assert.equal(ready, false);
  assert.equal(elapsed, 1000, 'probe time counts toward the cap');
  assert.deepEqual(timeouts, [1000]);
  assert.equal(logs.some(line => line.includes('MySQL is ready!') || line.includes(config.password)), false);
  assert.match(logs.at(-1), /MySQL took longer than expected/);
  assert.equal(seconds(undefined, 300, true), 300);
  assert.equal(seconds('60', 300, true), 60, 'explicit wait overrides remain honored');
  assert.equal(seconds('0', 300, true), 0);
  assert.equal(seconds('0', 5), 5);
});

test('a stalled handshake/query is destroyed at its per-attempt deadline', async () => {
  let expire;
  let destroyed = false;
  let cleared;
  const pending = probeDatabase(config, {
    timeoutMs: 100,
    createConnection: () => ({ promise: () => ({ query: () => new Promise(() => {}) }), destroy: () => { destroyed = true; } }),
    setTimer: callback => { expire = callback; return 'deadline'; },
    clearTimer: timer => { cleared = timer; },
  });
  const rejected = assert.rejects(pending, { code: 'ETIMEDOUT' });
  expire();
  await rejected;
  assert.equal(destroyed, true);
  assert.equal(cleared, 'deadline');
});

test('container entrypoint waits for readiness before launching the service supervisor', { timeout: 10000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-readiness-'));
  await fs.writeFile(path.join(directory, 'node'), `#!/bin/sh
case "$1" in
  /app/api/src/mysql-readiness.js) echo PROBE_WAITING; IFS= read -r gate; [ "$gate" = ready ] || exit 1; echo PROBE_READY ;;
  /app/api/src/service-supervisor.js) echo SUPERVISOR_LAUNCHED; exec sleep 60 ;;
esac
`, { mode: 0o755 });
  await fs.writeFile(path.join(directory, 'nginx'), '#!/bin/sh\n[ "$1" = -t ] || echo NGINX_LAUNCHED\n', { mode: 0o755 });
  const child = spawn('sh', [path.join(__dirname, '../../docker/start.sh')], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, UNIHUB_API_START_DELAY_SECONDS: '0' },
    detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await closed;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const until = text => output.includes(text) ? Promise.resolve() : new Promise(resolve => {
    const check = () => { if (output.includes(text)) { child.stdout.off('data', check); resolve(); } };
    child.stdout.on('data', check);
  });
  await until('PROBE_WAITING');
  assert.equal(output.includes('SUPERVISOR_LAUNCHED'), false);
  child.stdin.end('ready\n');
  await until('SUPERVISOR_LAUNCHED');
  assert.ok(output.indexOf('PROBE_READY') < output.indexOf('SUPERVISOR_LAUNCHED'));
});

test('readiness authenticates against the configured MySQL CI service', { skip: !process.env.MYSQL_TEST_HOST }, async () => {
  await probeDatabase({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
    database: process.env.MYSQL_TEST_DATABASE || 'unihub_test' }, { timeoutMs: 5000 });
});
