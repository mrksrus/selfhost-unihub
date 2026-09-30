const test = require('node:test');
const assert = require('node:assert/strict');
const { createDurableMailScheduler } = require('../src/services/mail-sync-scheduler');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  assert.fail('Worker did not reach expected boundary');
}

test('interactive wake yields a slow same-account body, preserves it, and never aborts an operation', async () => {
  const jobs = [
    { id: 'body-a', user_id: 'owner', mail_account_id: 'A', mailbox_id: 'box-a', kind: 'body', priority: 90, state: 'queued' },
    { id: 'body-b', user_id: 'owner', mail_account_id: 'B', mailbox_id: 'box-b', kind: 'body', priority: 90, state: 'queued' },
  ];
  const started = [], finished = [], leased = new Set(), releases = new Map();
  let generation = 0;
  const repo = {
    withTransaction: fn => fn({ execute: async () => [[]] }),
    recoverExpiredJobs: async () => ({ jobs: 0, operations: 0 }),
    async claimDueJob() {
      const next = jobs.filter(j => j.state === 'queued' && !leased.has(j.mail_account_id))
        .sort((a, b) => a.priority - b.priority)[0];
      if (!next) return null;
      next.state = 'running'; next.lease_owner = 'worker'; next.worker_generation = ++generation;
      leased.add(next.mail_account_id);
      return { ...next };
    },
    async enqueueJob(input) {
      const job = { ...input, id: `continued-${input.kind}-${jobs.length}`, mail_account_id: input.accountId,
        user_id: input.userId, mailbox_id: input.mailboxId, kind: input.kind, priority: input.priority, state: 'queued' };
      jobs.push(job); return job;
    },
    async updateJob() { return { cancellationRequested: false }; },
    async completeJob({ jobId, accountId, state }) {
      jobs.find(j => j.id === jobId).state = state;
      leased.delete(accountId); finished.push({ jobId, state });
    },
  };
  const scheduler = createDurableMailScheduler((job, signal) => {
    started.push(job.id);
    if (job.kind === 'operation') return { success: true };
    if (job.id.startsWith('continued-')) return { success: true, more: false };
    return new Promise(resolve => {
      releases.set(job.id, resolve);
      signal.addEventListener('abort', () => resolve({ success: false, cancelled: true }), { once: true });
    });
  }, { repository: repo, concurrency: 2, pollMs: 60000 });
  try {
    await scheduler.start();
    await until(() => started.length === 2);
    assert.deepEqual(started, ['body-a', 'body-b']);
    // The accepted operation is durable before the read-only wake.
    jobs.push({ id: 'op-a', user_id: 'owner', mail_account_id: 'A', operation_id: 'accepted',
      kind: 'operation', priority: 0, state: 'queued' });
    assert.equal(await scheduler.yieldReadWork('A'), true);
    assert.deepEqual(finished[0], { jobId: 'body-a', state: 'idle' }, 'yield is not user cancellation');
    await until(() => started.includes('op-a'));
    assert(!finished.some(j => j.jobId === 'body-b'), 'other-account body stays running');
    await until(() => started.some(id => id.startsWith('continued-body-')));
    assert(started.indexOf('op-a') < started.findIndex(id => id.startsWith('continued-body-')),
      'interactive operation starts before the yielded body resumes');
    assert(jobs.some(j => j.id.startsWith('continued-body-')));
    assert(!finished.some(j => j.jobId === 'op-a' && j.state === 'cancelled'));
    releases.get('body-b')({ success: true });
    await until(() => finished.some(j => j.jobId === 'body-b'));
  } finally { scheduler.stop(); }
});

test('stop during an outstanding claim returns unstarted work without invoking its executor', async () => {
  let releaseClaim, claiming = false, executed = 0, released;
  const job = { id: 'claimed', mail_account_id: 'A', worker_generation: 7, kind: 'operation' };
  const repository = {
    recoverExpiredJobs: async () => {},
    async claimDueJob() {
      claiming = true;
      await new Promise(resolve => { releaseClaim = resolve; });
      return job;
    },
    async releaseUnstartedJob(input) { released = input; },
  };
  const scheduler = createDurableMailScheduler(() => { executed++; },
    { repository, workerId: 'stopping-worker', pollMs: 60000 });
  const starting = scheduler.start();
  await until(() => claiming);
  const stopping = scheduler.stop();
  releaseClaim();
  await Promise.all([starting, stopping]);
  assert.equal(executed, 0, 'no provider work starts after stop');
  assert.deepEqual(released, { jobId: 'claimed', accountId: 'A', workerId: 'stopping-worker', generation: 7 });
  assert.deepEqual(scheduler.ids(), []);
});

test('an explicit sync cancel wins over a simultaneous interactive yield', async () => {
  const job = { id: 'body', user_id: 'owner', mail_account_id: 'A', mailbox_id: 'box',
    kind: 'body', priority: 90, worker_generation: 1, state: 'queued' };
  let resume, started = false, enqueued = 0, finished;
  const repo = {
    withTransaction: fn => fn(), recoverExpiredJobs: async () => {},
    async claimDueJob() { if (job.state !== 'queued') return null; job.state = 'running'; return { ...job }; },
    async updateJob() { return { cancellationRequested: false }; },
    async requestCancellation() { return true; },
    async completeJob(input) { finished = input.state; job.state = input.state; },
    async enqueueJob() { enqueued++; },
  };
  const scheduler = createDurableMailScheduler((_job, signal) => {
    started = true;
    signal.addEventListener('abort', () => {}, { once: true });
    return new Promise(resolve => { resume = resolve; });
  }, { repository: repo, concurrency: 1, pollMs: 60000 });
  try {
    await scheduler.start(); await until(() => started);
    const yielded = scheduler.yieldReadWork('A');
    assert.equal(await scheduler.cancel({ userId: 'owner', accountId: 'A', jobId: 'body' }), true);
    resume({ success: false, cancelled: true });
    await yielded;
    assert.equal(finished, 'cancelled');
    assert.equal(enqueued, 0, 'cancelled body cannot be requeued by the yield');
  } finally { scheduler.stop(); }
});

test('sync cancellation selects only read-only jobs, not accepted mutation or outcome checks', async t => {
  const service = require.resolve('../src/services/mail');
  const schedulerPath = require.resolve('../src/services/mail-sync-scheduler');
  const statePath = require.resolve('../src/state');
  const old = new Map([service, schedulerPath, statePath].map(p => [p, require.cache[p]]));
  const kinds = ['sync', 'recent', 'flags', 'history', 'presence', 'body', 'operation', 'reconcile'];
  const cancelled = [], selected = [], interrupted = [], paused = [];
  const db = { async execute(sql, params) {
    if (sql.includes('FROM mail_accounts')) return [[{ user_id: 'owner' }]];
    if (sql.includes('FROM mail_engine_jobs')) {
      selected.push(sql);
      assert.deepEqual(params.slice(2, -1), kinds.slice(0, 6));
      return [params.at(-1) ? [] : kinds.map((kind, i) => ({ id: `${i}-${kind}` })).filter(j => !['operation', 'reconcile'].some(kind => j.id.endsWith(kind)))];
    }
    assert.fail(sql);
  } };
  require.cache[statePath] = { id: statePath, loaded: true, exports: { db } };
  require.cache[schedulerPath] = { id: schedulerPath, loaded: true, exports: {
    READ_ONLY_MAIL_JOB_KINDS: new Set(kinds.slice(0, 6)),
    createDurableMailScheduler: () => ({ cancel: async x => (cancelled.push(x.jobId), true),
      yieldReadWork: async () => false, interruptAccount: id => interrupted.push(id) }),
  } };
  delete require.cache[service];
  t.after(() => { for (const [p, entry] of old) { if (entry) require.cache[p] = entry; else delete require.cache[p]; } });
  const mail = require(service);
  const runtime = require('../src/services/mail-engine/runtime');
  t.mock.method(runtime, 'pauseAccount', async input => { paused.push(input); });
  assert.equal(await mail.cancelMailAccountSync('A'), true);
  assert.equal(cancelled.length, 6);
  assert(selected[0].includes('kind IN'));
  assert(cancelled.every(id => !id.endsWith('operation') && !id.endsWith('reconcile')));
  assert.deepEqual(paused, [], 'ordinary sync cancel does not fence accepted writes');
  assert.deepEqual(interrupted, []);
  assert.equal(await mail.stopMailAccountWork('A', 'Disconnected'), true);
  assert.deepEqual(paused, [{ userId: 'owner', accountId: 'A', reason: 'Disconnected' }]);
  assert.deepEqual(interrupted, ['A']);
});

test('expired-lease recovery runs at start and then at most once per interval', async () => {
  const clock = { now: 1000 }, calls = [];
  const repository = {
    recoverExpiredJobs: async () => { calls.push('recover'); return { jobs: 0, operations: 0 }; },
    async claimDueJob() { calls.push('claim'); return null; },
    async enqueueJob(input) { return { id: 'j', ...input }; },
  };
  const scheduler = createDurableMailScheduler(() => ({ success: true }),
    { repository, pollMs: 60000, recoveryMs: 15000, now: () => clock.now });
  try {
    await scheduler.start();
    assert.deepEqual(calls, ['recover', 'claim'], 'startup recovery precedes the first claim');
    for (let i = 0; i < 5; i++) { clock.now += 1000; await scheduler.enqueue({ userId: 'u', accountId: 'a' }); await scheduler.drain(); }
    assert.equal(calls.filter(call => call === 'recover').length, 1, 'polls, enqueues and completions do not rescan every lease');
    clock.now = 1000 + 15000;
    await scheduler.drain();
    assert.equal(calls.filter(call => call === 'recover').length, 2);
    assert.deepEqual(calls.slice(-2), ['recover', 'claim']);
  } finally { scheduler.stop(); }
});

test('a failed recovery pass is retried on the next drain before any claim', async () => {
  const calls = [];
  let fail = true;
  const repository = {
    recoverExpiredJobs: async () => { calls.push('recover'); if (fail) throw new Error('lock wait timeout'); },
    async claimDueJob() { calls.push('claim'); return null; },
  };
  const scheduler = createDurableMailScheduler(() => ({ success: true }), { repository, pollMs: 60000, now: () => 0 });
  try {
    await assert.rejects(scheduler.start(), /lock wait timeout/);
    assert.deepEqual(calls, ['recover']);
    fail = false;
    await scheduler.start();
    assert.deepEqual(calls, ['recover', 'recover', 'claim']);
  } finally { scheduler.stop(); }
});

test('a claim skips an account whose expired lease has not been recovered yet', async () => {
  const runtime = require('../src/services/mail-engine/runtime');
  const account = { generation: 4, lease_owner: 'crashed-worker', lease_until: new Date(Date.now() - 60000), paused_reason: null };
  const calls = [];
  const cx = { async execute(sql) {
    calls.push(sql);
    if (sql.includes('FROM mail_engine_jobs j JOIN mail_accounts')) return [[{ id: 'next', user_id: 'u', mail_account_id: 'a', state: 'queued' }]];
    if (sql.startsWith('INSERT INTO mail_engine_accounts')) return [{ affectedRows: 1 }];
    if (sql.includes('SELECT * FROM mail_engine_accounts')) return [[{ ...account }]];
    if (sql.includes('SELECT * FROM mail_engine_jobs WHERE id')) return [[{ id: 'next', state: 'running', worker_generation: account.generation + 1 }]];
    if (sql.startsWith('UPDATE')) return [{ affectedRows: 1 }];
    throw new Error(sql);
  } };
  assert.equal(await runtime.claimDueJob({ workerId: 'successor' }, cx), null);
  assert(!calls.some(sql => sql.startsWith('UPDATE')), 'no takeover of an unrecovered lease');
  // Recovery bumps the generation and clears the owner; only then may a successor claim.
  Object.assign(account, { generation: 5, lease_owner: null, lease_until: null });
  const claimed = await runtime.claimDueJob({ workerId: 'successor' }, cx);
  assert.equal(claimed.id, 'next'); assert.equal(claimed.worker_generation, 6);
});
