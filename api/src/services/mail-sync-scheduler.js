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
module.exports = { createMailSyncScheduler };
