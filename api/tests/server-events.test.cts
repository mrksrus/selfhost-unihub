import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { EventEmitter } = (require('node:events') as typeof import('node:events'));
const {
  createServerEvents,
  installShutdownHandler,
  publishMailJob,
  publishMailOperation,
  publishMailChanged,
} = require('../dist/src/services/server-events') as typeof import('../src/services/server-events');

function fakeTimers() {
  let now = 0, seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout: (fn: FixtureValue, ms: number) => { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id: FixtureValue) => pending.delete(id),
    setInterval: () => ({ interval: true }),
    clearInterval: () => {},
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

function fakeResponse() {
  const res: FixtureValue = new EventEmitter();
  res.chunks = [];
  res.ended = false;
  res.writableLength = 0;
  res.writeHead = (status: FixtureValue, headers: FixtureValue) => { res.status = status; res.headers = headers; };
  res.write = (chunk: FixtureValue) => { res.chunks.push(String(chunk)); return true; };
  res.end = () => { res.ended = true; };
  return res;
}

function events(res: FixtureValue) {
  return res.chunks.join('').split('\n\n').filter((block: FixtureValue) => block.startsWith('event:')).map((block: FixtureValue) => {
    const [, type] = /^event: (.+)$/m.exec(block)!;
    const [, data] = /^data: (.+)$/m.exec(block)!;
    return { type, data: JSON.parse(data) };
  });
}

function hub(options: FixtureValue = {}) {
  const timers = fakeTimers();
  const bus = createServerEvents({ timers, now: timers.now, ...options });
  const open = (userId: string, extra: FixtureValue = {}) => {
    const res = fakeResponse();
    const result = bus.attach({ userId, req: new EventEmitter(), res, modules: ['mail'], ...extra });
    return { res, result };
  };
  return { bus, timers, open };
}

test('a stream starts with SSE headers, a retry hint and a ready event', () => {
  const { open } = hub();
  const { res, result } = open('u1');
  assert.equal(result.ok, true);
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /^text\/event-stream/);
  assert.equal(res.headers['X-Accel-Buffering'], 'no');
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.match(res.chunks[0], /^retry: \d+\n\n$/);
  assert.deepEqual(events(res), [{ type: 'ready', data: { v: 1 } }]);
});

test('events reach only streams of the user they were published for', () => {
  const { bus, open } = hub();
  const a1 = open('user-a'), a2 = open('user-a'), b = open('user-b');
  bus.publish('user-a', 'mail.changed', { accountId: 'acc-a', reason: 'import' }, { module: 'mail' });
  assert.equal(events(a1.res).filter((e: FixtureValue) => e.type === 'mail.changed').length, 1);
  assert.equal(events(a2.res).filter((e: FixtureValue) => e.type === 'mail.changed').length, 1);
  assert.equal(events(b.res).filter((e: FixtureValue) => e.type === 'mail.changed').length, 0);
  assert.equal(bus.publish('nobody', 'mail.changed', {}), 0);
});

test('a stream only receives events of modules the user has enabled', () => {
  const { bus, open } = hub();
  const withMail = open('u1');
  const withoutMail = open('u1', { modules: ['calendar'] });
  bus.publish('u1', 'mail.changed', { accountId: 'a', reason: 'flags' }, { module: 'mail' });
  assert.equal(events(withMail.res).length, 2);
  assert.equal(events(withoutMail.res).length, 1);
  bus.setUserModules('u1', ['mail']);
  bus.publish('u1', 'mail.changed', { accountId: 'a', reason: 'flags' }, { module: 'mail' });
  assert.equal(events(withoutMail.res).length, 2);
});

test('throttled events send at most one per interval and never lose the final state', () => {
  const { bus, timers, open } = hub({ throttleMs: 1000 });
  const { res } = open('u1');
  for (let processed = 1; processed <= 20; processed++) {
    bus.publish('u1', 'mail.job', { accountId: 'a', state: 'running', processed }, { throttleKey: 'mail.job:a' });
  }
  bus.publish('u1', 'mail.job', { accountId: 'a', state: 'idle', processed: 20 }, { throttleKey: 'mail.job:a' });
  const jobEvents = () => events(res).filter((e: FixtureValue) => e.type === 'mail.job');
  assert.deepEqual(jobEvents().map((e: FixtureValue) => e.data.processed), [1]);
  timers.advance(999);
  assert.equal(jobEvents().length, 1);
  timers.advance(1);
  assert.deepEqual(jobEvents().map((e: FixtureValue) => e.data.state), ['running', 'idle']);
  // Other accounts are throttled independently.
  bus.publish('u1', 'mail.job', { accountId: 'b', state: 'running' }, { throttleKey: 'mail.job:b' });
  assert.equal(jobEvents().length, 3);
  timers.advance(5000);
  assert.equal(bus.stats().throttled, 0);
});

test('closing the connection removes the stream and stops delivery', () => {
  const { bus, open } = hub();
  const { res } = open('u1');
  assert.deepEqual(bus.stats(), { streams: 1, users: 1, throttled: 0 });
  res.emit('close');
  assert.deepEqual(bus.stats(), { streams: 0, users: 0, throttled: 0 });
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(bus.publish('u1', 'mail.changed', {}), 0);
});

test('concurrent streams are capped per user and globally', () => {
  const { bus, open } = hub({ maxPerUser: 5, maxTotal: 7 });
  for (let i = 0; i < 5; i++) assert.equal(open('u1').result.ok, true);
  const refused: FixtureValue = open('u1');
  assert.equal(refused.result.ok, false);
  assert.equal(refused.result.status, 429);
  assert.equal(refused.res.status, undefined);
  assert.equal(open('u2').result.ok, true);
  assert.equal(open('u3').result.ok, true);
  assert.equal(open('u4').result.status, 503);
  assert.equal(bus.stats().streams, 7);
});

test('a heartbeat pings every stream and ends streams whose session was revoked', async () => {
  const { bus, open } = hub();
  let valid = true;
  const { res } = open('u1', { revalidate: async () => valid });
  await bus.tick();
  assert.match(res.chunks.join(''), /: ping\n\n/);
  assert.equal(res.ended, false);
  valid = false;
  await bus.tick();
  assert.equal(res.ended, true);
  assert.deepEqual(events(res).at(-1), { type: 'end', data: { reason: 'session_ended' } });
  assert.equal(bus.stats().streams, 0);
});

test('a transient revalidation error keeps the stream open', async () => {
  const { bus, open } = hub();
  const { res } = open('u1', { revalidate: async () => { throw new Error('database unavailable'); } });
  await bus.tick();
  assert.equal(res.ended, false);
});

test('sign-out ends only that session; a revocation can keep the current session', () => {
  const { bus, open } = hub();
  const first: FixtureValue = open('u1', { token: 'token-1' });
  const second: FixtureValue = open('u1', { token: 'token-2' });
  const other: FixtureValue = open('u2', { token: 'token-3' });
  assert.equal(bus.closeToken('token-1', { reason: 'signed_out' }), 1);
  assert.equal(first.res.ended, true);
  assert.deepEqual(events(first.res).at(-1), { type: 'end', data: { reason: 'signed_out' } });
  const third: FixtureValue = open('u1', { token: 'token-4' });
  assert.equal(bus.closeUser('u1', { exceptToken: 'token-2' }), 1);
  assert.equal(second.res.ended, false);
  assert.equal(third.res.ended, true);
  assert.equal(other.res.ended, false);
});

test('a client that stops reading is dropped instead of buffering without bound', () => {
  const { bus, open } = hub({ maxBufferedBytes: 10 });
  const { res } = open('u1');
  res.writableLength = 11;
  bus.publish('u1', 'mail.changed', { accountId: 'a' }, { module: 'mail' });
  assert.equal(res.ended, true);
  assert.equal(bus.stats().streams, 0);
});

test('shutdown ends every stream and refuses new ones', () => {
  const { bus, open } = hub();
  const { res } = open('u1');
  bus.closeAll();
  assert.equal(res.ended, true);
  assert.deepEqual(events(res).at(-1), { type: 'end', data: { reason: 'shutdown' } });
  assert.equal(open('u1').result.status, 503);
});

test('the shutdown handler closes streams before the stop signal ends the process', () => {
  const signals = new EventEmitter();
  const timers = fakeTimers();
  const { bus, open } = hub();
  const { res } = open('u1');
  const killed: FixtureValue[] = [];
  let serverClosed = false;
  installShutdownHandler({ bus, signals, server: { close: () => { serverClosed = true; } },
    kill: (signal) => killed.push(signal), timers: timers as FixtureValue, graceMs: 200 });
  signals.emit('SIGTERM');
  assert.equal(res.ended, true);
  assert.equal(serverClosed, true);
  assert.deepEqual(killed, []);
  timers.advance(200);
  assert.deepEqual(killed, ['SIGTERM']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('mail job events carry ids, states and counters only', () => {
  const { bus, timers, open } = hub();
  const { res } = open('u1');
  publishMailJob({ id: 'job-1', user_id: 'u1', mail_account_id: 'acc-1', kind: 'recent', state: 'running',
    phase: 'recent', processed: 4, total: null, error: 'LOGIN failed for person@example.com',
    folder: 'Private/Bank', subject: 'Secret' } as FixtureValue, bus);
  const [job] = events(res).filter((e: FixtureValue) => e.type === 'mail.job');
  assert.deepEqual(job.data, { accountId: 'acc-1', jobId: 'job-1', kind: 'recent', state: 'running',
    phase: 'recent', processed: 4, total: null });
  assert.doesNotMatch(res.chunks.join(''), /example\.com|Bank|Secret|LOGIN/);
  timers.advance(1000);
  publishMailJob({ id: 'job-1', user_id: 'u1', mail_account_id: 'acc-1', kind: 'recent', state: 'idle',
    result: { success: true, inserted: 3, updated: 0 } as FixtureValue }, bus);
  timers.advance(1000);
  const types = events(res).map((e: FixtureValue) => `${e.type}:${e.data.state ?? e.data.reason ?? ''}`);
  assert.ok(types.includes('mail.job:idle'));
  assert.ok(types.includes('mail.changed:import'));
  assert.ok(types.includes('mail.operation:'));
});

test('a quiet job does not announce a list change', () => {
  const { bus, open } = hub();
  const { res } = open('u1');
  publishMailJob({ id: 'job-2', user_id: 'u1', mail_account_id: 'acc-1', kind: 'recent', state: 'idle',
    result: { success: true, inserted: 0, updated: 0 } as FixtureValue }, bus);
  assert.deepEqual(events(res).map((e: FixtureValue) => e.type), ['ready', 'mail.job']);
});

test('operation events coalesce ids and reject unknown values', () => {
  const { bus, timers, open } = hub();
  const { res } = open('u1');
  publishMailOperation('u1', { accountId: 'acc-1', operationIds: ['op-1'], state: 'confirmed' }, bus);
  publishMailOperation('u1', { accountId: 'acc-1', operationIds: ['op-2', 'bad id <script>'], state: 'confirmed' }, bus);
  publishMailOperation('u1', { accountId: 'acc-1', operationIds: ['op-3'], state: 'needs_attention' }, bus);
  timers.advance(1000);
  const operations = events(res).filter((e: FixtureValue) => e.type === 'mail.operation').map((e: FixtureValue) => e.data);
  assert.deepEqual(operations, [
    { accountId: 'acc-1', operationIds: ['op-1'], state: 'confirmed' },
    { accountId: 'acc-1', operationIds: ['op-2', 'op-3'], state: null },
  ]);
  publishMailChanged('u1', 'acc-1', 'not-a-reason', bus);
  assert.deepEqual(events(res).at(-1), { type: 'mail.changed', data: { accountId: 'acc-1', reason: null } });
});
