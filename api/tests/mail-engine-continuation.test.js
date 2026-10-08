const test = require('node:test');
const assert = require('node:assert/strict');
const { createDurableMailScheduler } = require('../dist/src/services/mail-sync-scheduler');

test('a bounded slice and its continuation commit together before reporting idle', async () => {
  const id = 'mailbox', account = 'account', user = 'owner';
  const first = { id: 'first', user_id: user, mail_account_id: account, mailbox_id: id,
    kind: 'history', priority: 60, worker_generation: 1, lease_owner: 'worker' };
  const second = { ...first, id: 'second', worker_generation: 2 };
  const pending = [first], commits = [], calls = [];
  let completeSecond;
  const done = new Promise(resolve => { completeSecond = resolve; });
  const repository = {
    async recoverExpiredJobs() { return { jobs: 0, operations: 0 }; },
    async claimDueJob() { return pending.shift() || null; },
    async withTransaction(fn) {
      const cx = { pending: [] };
      const result = await fn(cx);
      for (const action of cx.pending) action();
      commits.push(cx.pending.length);
      return result;
    },
    async completeJob(input, cx) {
      assert(cx, 'completion is transactional');
      cx.pending.push(() => calls.push(`complete:${input.jobId}`));
    },
    async enqueueJob(input, cx) {
      assert(cx, 'continuation shares completion executor');
      assert.equal(input.mailboxId, id);
      cx.pending.push(() => { calls.push('enqueue:second'); pending.push(second); });
      return second;
    },
    async getJobStatus() { return null; },
    async updateJob() { return { cancellationRequested: false }; },
  };
  const scheduler = createDurableMailScheduler(async job => ({ success: true, more: job.id === 'first' }),
    { repository, workerId: 'worker', concurrency: 1, pollMs: 100000,
      onState: status => { if (status.id === 'second' && status.state === 'idle') completeSecond(); } });
  let deadline;
  try {
    await scheduler.start();
    await Promise.race([done, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(Error('continuation not run')), 3000);
    })]);
    assert.deepEqual(calls, ['complete:first', 'enqueue:second', 'complete:second']);
    assert.deepEqual(commits, [2, 1]);
  } finally { clearTimeout(deadline); scheduler.stop(); }
});

test('manual sweep intent survives finite continuations and is consumed exactly once', async () => {
  const pending = [{ id: 'initial', user_id: 'owner', mail_account_id: 'account',
    mailbox_id: 'box', kind: 'flags', priority: 20, manual_refresh: 1 }];
  const seen = [], enqueued = [];
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  const repository = {
    async recoverExpiredJobs() {},
    async claimDueJob() { return pending.shift() || null; },
    async withTransaction(fn) { await fn({}); },
    async completeJob() {},
    async enqueueJob(input, cx) {
      assert(cx, 'manual continuation and completion must be atomic');
      enqueued.push(input);
      const next = { id: `next-${enqueued.length}`, user_id: input.userId, mail_account_id: input.accountId,
        mailbox_id: input.mailboxId, kind: input.kind, priority: input.priority,
        manual_refresh: Number(input.manualRefresh) };
      pending.push(next);
      return next;
    },
    async updateJob() { return { cancellationRequested: false }; },
  };
  const scheduler = createDurableMailScheduler(async job => {
    seen.push(job);
    // Finish the old sweep, then make one fresh bounded pass; no loop.
    const count = seen.length;
    if (count === 5) return { success: true, more: false, refreshPending: false };
    return { success: true, more: true, refreshPending: count < 3 };
  }, { repository, concurrency: 1, pollMs: 60000,
    onState: status => { if (status.id === 'next-4' && status.state === 'idle') finished(); } });
  let deadline;
  try {
    await scheduler.start();
    await Promise.race([done, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(Error('manual sweep did not finish')), 3000);
    })]);
    assert.deepEqual(seen.map(job => Number(job.manual_refresh)), [1, 1, 1, 0, 0]);
    assert.deepEqual(enqueued.map(job => job.manualRefresh), [true, true, false, false]);
    assert.equal(pending.length, 0);
  } finally { clearTimeout(deadline); scheduler.stop(); }
});
