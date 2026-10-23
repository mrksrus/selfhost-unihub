import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { startBackgroundWork } = require('../dist/src/services/background-work') as typeof import('../src/services/background-work');

function fakeTimers() {
  let seq = 0;
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const timeouts = new Map<number, () => void>();
  const immediates: (() => void)[] = [];
  return {
    intervals, timeouts, immediates,
    setInterval: (fn: () => void, ms: number) => { const id = ++seq; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id: number) => { intervals.delete(id); },
    setTimeout: (fn: () => void) => { const id = ++seq; timeouts.set(id, fn); return id; },
    clearTimeout: (id: number) => { timeouts.delete(id); },
    setImmediate: (fn: () => void) => { immediates.push(fn); },
  };
}

function deps(timers: ReturnType<typeof fakeTimers>) {
  const calls: string[] = [];
  const idle = { started: 0, stopped: 0 };
  return {
    calls, idle,
    overrides: {
      db: { execute: async (sql: string) => { calls.push(sql.split(' ').slice(0, 2).join(' ')); return [sql.startsWith('SELECT') ? [] : { affectedRows: 0 }]; } },
      timers,
      poolStats: () => ({ total: 0, active: 0, free: 0, queued: 0, limit: 10 }),
      processNotificationJobs: async () => { calls.push('notifications'); },
      schedulePeriodicMailWork: async () => ({ started: false }),
      runMailServerDeletionPass: async () => ({ accounts: [] }),
      runDueWritebacks: async () => {},
      pruneFinishedJobs: async () => ({ deleted: 0 }),
      cleanupExpiredRecordingUploads: async () => 0,
      isSectionRestoreActive: async () => false,
      idleSupervisor: { start: () => { idle.started++; }, stop: () => { idle.stopped++; }, options: { maxSessions: 0 } },
      runCalendarSyncPass: async () => {},
      pruneAuditLog: async () => 0,
      runMailThreadBackfill: async () => { calls.push('thread backfill'); },
      isWorkerOwner: () => true,
      stopCalendarWork: () => { calls.push('stop calendar work'); },
    } as FixtureValue,
  };
}

async function quietly<T>(work: () => Promise<T>) {
  const original = console.log;
  console.log = () => {};
  try { return await work(); } finally { console.log = original; }
}

test('background work starts the ten timers and stop clears every one of them', async () => {
  const timers = fakeTimers();
  const { overrides, calls, idle } = deps(timers);
  const work = startBackgroundWork(overrides);
  await quietly(() => work.ready);
  assert.deepEqual([...timers.intervals.values()].map(timer => timer.ms).sort((a, b) => a - b),
    [1000, 15000, 30000, 30000, 60000, 60000, 60000, 3600000, 3600000, 3600000]);
  // Interrupted syncs are reset before their timers can pick accounts up.
  assert.ok(calls.includes('UPDATE mail_accounts'));
  assert.ok(calls.includes('UPDATE calendar_accounts'));
  assert.equal(timers.timeouts.size, 2);
  work.stop();
  assert.equal(timers.intervals.size, 0);
  assert.equal(timers.timeouts.size, 0);
  assert.equal(idle.stopped, 1);
  // The startup mail pass finishing after a stop must not open IDLE sessions.
  await quietly(async () => { for (const run of timers.immediates) run(); await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.equal(idle.started, 0);
  work.stop();
  assert.equal(idle.stopped, 1);
  assert.equal(calls.filter(call => call === 'stop calendar work').length, 1, 'running calendar syncs are stopped once');
});

test('after this process lost the background-work lock its timers do nothing, even before stop (B-06)', async () => {
  const timers = fakeTimers();
  const { overrides, calls, idle } = deps(timers);
  let owner = true;
  const work = startBackgroundWork({ ...overrides, isWorkerOwner: () => owner });
  await quietly(() => work.ready);
  owner = false;
  calls.length = 0;
  await quietly(async () => {
    for (const { fn } of timers.intervals.values()) fn();
    for (const run of timers.immediates) run();
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  assert.deepEqual(calls, [], 'no notification, mail, calendar or cleanup work ran');
  assert.equal(idle.started, 0);
  work.stop();
});

test('a stop reaches a start-up still waiting for the database: it starts and resets nothing more (B-06)', async () => {
  const timers = fakeTimers();
  const { overrides, calls, idle } = deps(timers);
  let answer!: () => void;
  const db = { execute: async (sql: string) => {
    calls.push(sql.split(' ').slice(0, 2).join(' '));
    await new Promise<void>(resolve => { answer = resolve; });
    return [{ affectedRows: 0 }];
  } };
  const work = startBackgroundWork({ ...overrides, db } as FixtureValue);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.filter(call => call.startsWith('UPDATE')), ['UPDATE mail_accounts'], 'the start-up waits on its first reset');
  work.stop();
  answer();
  await quietly(() => work.ready);
  await quietly(async () => { for (const run of timers.immediates) run(); await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.equal(timers.intervals.size, 0, 'no timer was left or added');
  assert.equal(timers.timeouts.size, 0);
  assert.ok(!calls.includes('UPDATE calendar_accounts'), 'the calendar reset belongs to the next owner');
  assert.equal(idle.started, 0);
});

test('a failed start-up says so through ready', async () => {
  const timers = fakeTimers();
  const { overrides } = deps(timers);
  const db = { execute: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } };
  const work = startBackgroundWork({ ...overrides, db } as FixtureValue);
  await assert.rejects(quietly(() => work.ready), /ECONNREFUSED/);
  work.stop();
  assert.equal(timers.intervals.size, 0);
});
