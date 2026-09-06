const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { superviseServices } = require('../src/service-supervisor');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness(options = {}) {
  const children = [], exits = [], signals = new EventEmitter();
  const control = superviseServices({ delayMs: 0, graceMs: 5, signals, exit: code => exits.push(code),
    spawnChild(command, args) {
      const child = new EventEmitter(); Object.assign(child, { command, args, killed: [], closed: false });
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
