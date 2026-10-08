const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { superviseServices, apiIdentity } = require('../dist/src/service-supervisor');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness(options = {}) {
  const children = [], exits = [], signals = new EventEmitter();
  const control = superviseServices({ delayMs: 0, graceMs: 5, signals, exit: code => exits.push(code),
    spawnChild(command, args, spawnOptions) {
      const child = new EventEmitter(); Object.assign(child, { command, args, spawnOptions, killed: [], closed: false });
      child.finish = code => { if (!child.closed) { child.closed = true; child.emit('close', code); } };
      child.kill = signal => { child.killed.push(signal); if (!options.ignoreTerm || signal === 'SIGKILL') queueMicrotask(() => child.finish(0)); };
      children.push(child);
      if (args[0] === '-t') queueMicrotask(() => child.finish(options.badConfig ? 1 : 0));
      return child;
    }, ...options.supervisor });
  return { children, exits, signals, control };
}

test('API death stops nginx and exits unsuccessfully so Docker can restart', async () => {
  const h = harness(); await delay(15);
  assert.equal(h.children.length, 3);
  h.children[0].finish(1); await delay(10);
  assert.deepEqual(h.children[2].killed, ['SIGTERM']);
  assert.deepEqual(h.exits, [1]);
  assert.equal(h.signals.listenerCount('SIGTERM'), 0);
});

test('nginx death also terminates the API', async () => {
  const h = harness(); await delay(15);
  h.children[2].finish(0); await delay(10);
  assert.deepEqual(h.children[0].killed, ['SIGTERM']);
  assert.deepEqual(h.exits, [1]);
});

test('shutdown before nginx starts cancels startup and forwards the signal', async () => {
  const h = harness({ supervisor: { delayMs: 1000 } });
  h.signals.emit('SIGTERM'); await delay(10);
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.exits, [0]);
});

test('configuration failures stop the API and unresponsive children are killed after grace', async () => {
  const h = harness({ badConfig: true, ignoreTerm: true }); await delay(30);
  assert.deepEqual(h.children[0].killed, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(h.exits, [1]);
});

test('the API runs as the configured user while nginx keeps the supervisor identity', async () => {
  const h = harness({ supervisor: { apiUser: { uid: 10001, gid: 10001 } } }); await delay(15);
  const [api, check, nginx] = h.children;
  assert.deepEqual(api.args.slice(1), ['10001', '10001', '/app/api/server.js']);
  assert.match(api.args[0], /drop-privileges\.js$/);
  assert.equal(api.spawnOptions.uid, undefined, 'the wrapper drops groups, gid and uid itself');
  assert.equal(api.spawnOptions.env.HOME, '/tmp');
  for (const child of [check, nginx]) { assert.equal(child.command, 'nginx'); assert.equal(child.spawnOptions.uid, undefined); }
  h.signals.emit('SIGTERM'); await delay(10);
});

test('API identity is dropped only from root and refuses root or malformed IDs', () => {
  const env = { UNIHUB_API_UID: '10001', UNIHUB_API_GID: '10001' };
  assert.deepEqual(apiIdentity(env, () => 0), { uid: 10001, gid: 10001 });
  assert.equal(apiIdentity(env, () => 10001), null, 'an unprivileged container starts the API as-is');
  assert.equal(apiIdentity({}, () => 0), null, 'development and tests without the image settings');
  for (const bad of [{ UNIHUB_API_UID: '0', UNIHUB_API_GID: '0' }, { UNIHUB_API_UID: '10001' }, { UNIHUB_API_UID: 'unihub', UNIHUB_API_GID: '10001' }]) {
    assert.throws(() => apiIdentity(bad, () => 0), /non-root numeric/);
  }
});

test('an API running as another user is stopped through its IPC channel, never by signal', async () => {
  const h = harness({ supervisor: { apiUser: { uid: 10001, gid: 10001 } } }); await delay(15);
  const api = h.children[0];
  assert.deepEqual(api.spawnOptions.stdio, ['inherit', 'inherit', 'inherit', 'ipc']);
  let disconnects = 0;
  Object.assign(api, { connected: true, disconnect() { disconnects++; api.connected = false; queueMicrotask(() => api.finish(0)); } });
  api.kill = () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); };
  h.signals.emit('SIGTERM'); await delay(15);
  assert.equal(disconnects, 1);
  assert.deepEqual(h.exits, [0]);
});

test('shutdown still finishes when an unprivileged API cannot be killed after grace', async () => {
  const h = harness({ supervisor: { apiUser: { uid: 10001, gid: 10001 } } }); await delay(15);
  const api = h.children[0];
  Object.assign(api, { connected: true, disconnect() { api.connected = false; /* never exits */ } });
  h.signals.emit('SIGTERM'); await delay(1100);
  assert.deepEqual(h.exits, [0]);
});
