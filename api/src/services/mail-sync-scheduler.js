// Bounded FIFO runner. A queued account is not mistaken for another account's
// running job; duplicate requests return the same job without changing its age.
function createMailSyncScheduler(run, { concurrency = 2, onState = () => {} } = {}) {
  const jobs = new Map();
  const states = new Map();
  const queue = [];
  let running = 0;
  const publish = (id, change) => {
    const now = new Date().toISOString();
    const state = { account_id: id, state: 'idle', phase: null, processed: 0, total: null,
      started_at: null, updated_at: now, error: null, ...states.get(id), ...change, updated_at: now };
    states.set(id, state);
    onState(state);
  };
  const drain = () => {
    while (running < concurrency && queue.length) {
      const job = queue.shift();
      if (job.controller.signal.aborted) {
        publish(job.id, { state: 'cancelled', phase: null });
        jobs.delete(job.id);
        job.resolve({ success: false, cancelled: true });
        continue;
      }
      running++;
      publish(job.id, { state: 'running', phase: 'connecting', started_at: new Date().toISOString() });
      Promise.resolve().then(() => run(job.id, job.controller.signal, job.background, change => {
        if (jobs.get(job.id) === job) publish(job.id, change);
      })).then(result => {
        publish(job.id, { state: result?.cancelled || job.controller.signal.aborted ? 'cancelled' : result?.success ? 'idle' : 'error',
          phase: null, error: result?.success || result?.cancelled ? null : result?.error || 'Mail sync failed' });
        running--;
        if (jobs.get(job.id) === job) jobs.delete(job.id);
        drain();
        job.resolve(result);
      }, error => {
        publish(job.id, { state: job.controller.signal.aborted ? 'cancelled' : 'error', phase: null, error: error.message });
        running--;
        if (jobs.get(job.id) === job) jobs.delete(job.id);
        drain();
        job.resolve({ success: false, error: error.message, cancelled: job.controller.signal.aborted });
      });
    }
  };
  function enqueue(id, { background = false } = {}) {
    const old = jobs.get(id);
    if (old) return { started: false, alreadyRunning: true, promise: old.promise };
    const controller = new AbortController();
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const job = { id, controller, promise, resolve, background };
    jobs.set(id, job);
    publish(id, { state: 'queued', phase: null, processed: 0, total: null, started_at: null, error: null });
    queue.push(job);
    drain();
    return { started: true, alreadyRunning: false, promise };
  }
  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return false;
    job.controller.abort();
    // Queued jobs are removed immediately; an in-flight job finishes cooperatively.
    if (queue.includes(job)) {
      queue.splice(queue.indexOf(job), 1);
      jobs.delete(id);
      publish(id, { state: 'cancelled', phase: null });
      job.resolve({ success: false, cancelled: true });
    }
    return true;
  }
  return { enqueue, cancel, state: id => states.get(id), ids: () => [...jobs.keys()], has: id => jobs.has(id),
    report: (id, change) => { if (jobs.has(id)) publish(id, change); } };
}
// Durable worker is opt-in during cutover. Legacy in-memory scheduler remains
// available until routes/scan have switched to the persisted job contract.
const runtime = require('./mail-engine/runtime');
const { randomUUID } = require('node:crypto');
const READ_ONLY_MAIL_JOB_KINDS = new Set(['sync', 'recent', 'flags', 'history', 'presence', 'body']);
function createDurableMailScheduler(run, { repository = runtime, concurrency = 2,
  workerId = randomUUID(), onState = () => {}, pollMs = 1000, leaseSeconds = 30 } = {}) {
  if (typeof run !== 'function' || !Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('Invalid mail worker');
  const running = new Map();
  let draining = false, stopped = false, initialized = false, timer = null, startPromise = null;
  let drainFinished = Promise.resolve();
  function start() {
    if (initialized) return Promise.resolve();
    if (startPromise) return startPromise;
    startPromise = (async () => {
      initialized = true;
      if (!stopped) {
        timer = setInterval(() => { void drain().catch(error => onState({ state: 'error', error: error.message })); }, pollMs);
        timer.unref?.();
      }
      try { await drain(); }
      catch (error) { initialized = false; clearInterval(timer); timer = null; throw error; }
    })();
    startPromise.catch(() => { startPromise = null; });
    return startPromise;
  }
  async function execute(job) {
    const controller = new AbortController();
    let release;
    const finished = new Promise(resolve => { release = resolve; });
    const runningJob = { controller, job, finished, cancellationRequested: false };
    running.set(job.id, runningJob);
    let heartbeatError = null;
    const heartbeat = setInterval(() => {
      void repository.updateJob({ jobId: job.id, accountId: job.mail_account_id, workerId,
        generation: Number(job.worker_generation), leaseSeconds }).then(result => {
          if (result.cancellationRequested) { runningJob.cancellationRequested = true; controller.abort(); }
        }, error => { heartbeatError = error; controller.abort(); });
    }, Math.max(1000, Math.floor(leaseSeconds * 400)));
    heartbeat.unref?.();
    try {
      const report = async change => {
        const status = await repository.updateJob({ jobId: job.id, accountId: job.mail_account_id,
          workerId, generation: Number(job.worker_generation), phase: change.phase,
          processed: change.processed, total: change.total, coverage: change.coverage, leaseSeconds });
        if (status.cancellationRequested) { runningJob.cancellationRequested = true; controller.abort(); }
        onState({ ...job, ...change, state: 'running' });
      };
      onState({ ...job, state: 'running' });
      const result = await run(job, controller.signal, report);
      if (heartbeatError) throw heartbeatError;
      const yielded = controller.signal.reason === 'interactive-yield' && !runningJob.cancellationRequested
        && READ_ONLY_MAIL_JOB_KINDS.has(job.kind);
      const state = yielded ? 'idle' : controller.signal.aborted || result?.cancelled ? 'cancelled' : result?.success ? 'idle' : 'error';
      const completion = async cx => {
        await repository.completeJob({ jobId: job.id, accountId: job.mail_account_id,
          workerId, generation: Number(job.worker_generation), state, error: result?.error || null }, cx);
        // A read-only yield is not user cancellation. Even a partly fetched
        // body remains queued; its next job starts after the interactive intent.
        if (yielded) {
          await repository.enqueueJob({ userId: job.user_id, accountId: job.mail_account_id,
            mailboxId: job.mailbox_id, kind: job.kind, priority: job.priority,
            manualRefresh: Number(job.manual_refresh) === 1 }, cx);
          return;
        }
        // Persist the next bounded slice with the completion. A crash between
        // these effects must not strand a finite history/presence checkpoint.
        let more = result?.more;
        if (state === 'idle' && !more && job.kind === 'body' && job.mailbox_id && cx) {
          // Discovery can queue a body while this job is still running; active
          // deduplication returns that running job. Recheck under completion's
          // transaction so the last empty slice cannot lose the new work.
          const [pending] = await cx.execute(`SELECT o.id FROM mail_remote_occurrences o
            JOIN emails e ON e.id=o.email_id AND e.user_id=o.user_id
            WHERE o.user_id=? AND o.mail_account_id=? AND o.mailbox_id=?
              AND o.presence='present' AND e.content_state='queued' AND e.import_complete=FALSE
            LIMIT 1 FOR UPDATE`, [job.user_id, job.mail_account_id, job.mailbox_id]);
          more = pending.length > 0;
        }
        if (state === 'idle' && more && (job.mailbox_id || job.kind === 'reconcile')) {
          await repository.enqueueJob({ userId: job.user_id, accountId: job.mail_account_id,
            mailboxId: job.mailbox_id, operationId: job.operation_id, kind: job.kind,
            priority: job.priority, dueAt: result?.retryAt || null,
            manualRefresh: result?.refreshPending === true }, cx);
        }
      };
      const transaction = repository === runtime ? require('./mail-engine/repository').withTransaction : repository.withTransaction;
      if (typeof transaction === 'function') await transaction(completion);
      else await completion(undefined); // injectable legacy test repositories
      onState({ ...job, state, result });
    } catch (error) {
      const yielded = controller.signal.reason === 'interactive-yield' && !runningJob.cancellationRequested
        && READ_ONLY_MAIL_JOB_KINDS.has(job.kind)
        && error?.code !== 'MAIL_WORKER_FENCED' && !heartbeatError;
      controller.abort(); // no more provider commands after lost lease
      if (error?.code !== 'MAIL_WORKER_FENCED') {
        try {
          const transaction = repository === runtime ? require('./mail-engine/repository').withTransaction : repository.withTransaction;
          const completion = async cx => {
            await repository.completeJob({ jobId: job.id, accountId: job.mail_account_id,
              workerId, generation: Number(job.worker_generation), state: yielded ? 'idle' : 'error',
              error: yielded ? null : error.message }, cx);
            if (yielded) await repository.enqueueJob({ userId: job.user_id, accountId: job.mail_account_id,
              mailboxId: job.mailbox_id, kind: job.kind, priority: job.priority,
              manualRefresh: Number(job.manual_refresh) === 1 }, cx);
          };
          if (typeof transaction === 'function') await transaction(completion);
          else await completion(undefined);
        } catch (finishError) { if (finishError?.code !== 'MAIL_WORKER_FENCED') onState({ ...job, state: 'error', error: finishError.message }); }
      }
      onState({ ...job, state: yielded ? 'idle' : 'error', error: yielded ? null : error.message });
    } finally {
      clearInterval(heartbeat);
      running.delete(job.id);
      release();
      if (!stopped) void drain().catch(error => onState({ state: 'error', error: error.message }));
    }
  }
  async function drain() {
    if (stopped || draining) return;
    draining = true;
    let finishDrain;
    drainFinished = new Promise(resolve => { finishDrain = resolve; });
    try {
      // Recovery precedes every replacement claim. Lease expiry alone cannot
      // prove a provider mutation was not transmitted.
      await repository.recoverExpiredJobs();
      while (running.size < concurrency && !stopped) {
        const job = await repository.claimDueJob({ workerId, leaseSeconds });
        if (!job) break;
        // stop() can run during the database claim. Do not create a fresh,
        // unaborted executor after shutdown; retain the same accepted job.
        if (stopped) {
          await repository.releaseUnstartedJob({ jobId: job.id, accountId: job.mail_account_id,
            workerId, generation: Number(job.worker_generation) });
          break;
        }
        void execute(job);
      }
    } finally { draining = false; finishDrain(); }
  }
  async function enqueue(input) {
    if (!initialized) await start();
    const job = await repository.enqueueJob(input);
    await drain();
    return job;
  }
  async function cancel({ userId, accountId, jobId }) {
    const changed = await repository.requestCancellation({ userId, accountId, jobId });
    if (changed && running.has(jobId)) {
      const active = running.get(jobId);
      active.cancellationRequested = true;
      active.controller.abort();
    }
    return changed;
  }
  async function yieldReadWork(accountId) {
    // Accepted operations already exist before admission calls this. Abort
    // *only* read-only transports and wait until their fenced account lease
    // has been completed; do not race another writer with a still-open fetch.
    const reads = [...running.values()].filter(({ job }) => job.mail_account_id === accountId &&
      READ_ONLY_MAIL_JOB_KINDS.has(job.kind));
    for (const { controller } of reads) controller.abort('interactive-yield');
    await Promise.all(reads.map(({ finished }) => finished));
    return reads.length > 0;
  }
  function interruptAccount(accountId) {
    for (const { controller, job } of running.values()) {
      if (job.mail_account_id === accountId) controller.abort('account-stop');
    }
  }
  function stop() {
    stopped = true; clearInterval(timer);
    for (const { controller } of running.values()) controller.abort();
    return drainFinished.then(() => Promise.all([...running.values()].map(({ finished }) => finished)));
  }
  return { start, enqueue, cancel, yieldReadWork, interruptAccount, state: input => repository.getJobStatus(input), drain, stop,
    ids: () => [...running.keys()] };
}
module.exports = { createMailSyncScheduler, createDurableMailScheduler, READ_ONLY_MAIL_JOB_KINDS };
