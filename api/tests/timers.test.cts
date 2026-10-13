const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { everyInterval } = require('../dist/src/services/timers') as typeof import('../src/services/timers');

function fakeTimers() {
  const ticks: (() => void)[] = [];
  return { ticks, setInterval: ((fn: () => void) => { ticks.push(fn); return 0 as unknown as NodeJS.Timeout; }) as unknown as typeof setInterval };
}

test('a tick is skipped while the previous run is still in progress', async () => {
  const timers = fakeTimers();
  let finish!: () => void;
  let runs = 0;
  const tick = everyInterval('TEST', 1000, () => { runs++; return new Promise<void>(resolve => { finish = resolve; }); }, timers);
  assert.equal(timers.ticks.length, 1);
  const first = tick();
  assert.equal(await tick(), false);
  assert.equal(await tick(), false);
  assert.equal(runs, 1);
  finish();
  assert.equal(await first, true);
  const second = tick();
  assert.equal(runs, 2);
  finish();
  assert.equal(await second, true);
});

test('a failing run is logged and the next tick runs again', async () => {
  const timers = fakeTimers();
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    let calls = 0;
    const tick = everyInterval('TEST', 1000, async () => { calls++; if (calls === 1) throw new Error('database away'); }, timers);
    assert.equal(await tick(), true);
    assert.equal(await tick(), true);
    assert.equal(calls, 2);
    assert.deepEqual(logged, [['[TEST] Failed:', 'database away']]);
  } finally {
    console.error = original;
  }
});
