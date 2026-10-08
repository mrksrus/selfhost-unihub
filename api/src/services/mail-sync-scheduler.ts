import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { ClaimedJob, EngineJob, EnqueueJob } from '../types/mail-engine';

import * as runtime from './mail-engine/runtime';
import { randomUUID } from 'node:crypto';

interface ProgressChange { phase?: string | null; processed?: number | null; total?: number | null; coverage?: unknown }
interface JobResult {
  inserted?: number;
  updated?: number;
  processed?: number;
  success?: boolean;
  cancelled?: boolean;
  paused?: boolean;
  error?: string | null;
  more?: boolean;
  retryAt?: Date | null;
  refreshPending?: boolean;
  [key: string]: unknown;
}
type RunJob = (job: ClaimedJob, signal: AbortSignal, report: (change: ProgressChange) => Promise<void>) => Promise<JobResult | undefined>;
interface RunningJob {
  controller: AbortController;
  job: ClaimedJob;
  finished: Promise<void>;
  cancellationRequested: boolean;
}
type SchedulerRepository = Pick<typeof runtime, 'claimDueJob' | 'updateJob' | 'completeJob' | 'enqueueJob' | 'recoverExpiredJobs' | 'releaseUnstartedJob' | 'requestCancellation' | 'getJobStatus'> & { withTransaction?: <T>(callback: (connection: SqlExecutor) => Promise<T>) => Promise<T> };
interface SchedulerOptions {
  repository?: SchedulerRepository;
  concurrency?: number;
  readConcurrency?: number;
  workerId?: string;
  onState?: (state: Partial<Omit<EngineJob, 'processed'>> & { processed?: number | null; state: string; error?: string | null; result?: JobResult }) => void;
  pollMs?: number;
  leaseSeconds?: number;
  recoveryMs?: number;
  now?: () => number;
}
// 'prune' never contacts the provider; it applies Sync policy to local copies
// and yields to interactive work like the provider read jobs.
const READ_ONLY_MAIL_JOB_KINDS = new Set(['sync', 'recent', 'flags', 'history', 'presence', 'body', 'prune']);
// Provider writes and their outcome checks. Accepted user changes run as these.
const MUTATION_MAIL_JOB_KINDS = ['operation', 'reconcile'];
// readConcurrency caps the slots read-only jobs may hold. Below concurrency, the
// remaining slots only ever take operation/reconcile jobs, so an accepted change
// never waits behind other accounts' long history or body scans. (A read-only
// job of the same account holds its lease; yieldReadWork releases that one.)
function createDurableMailScheduler(run: RunJob, { repository = runtime, concurrency = 2, readConcurrency = concurrency,
  workerId = randomUUID(), onState = () => {}, pollMs = 1000, leaseSeconds = 30, recoveryMs = 15000, now = Date.now }: SchedulerOptions = {}) {
  if (typeof run !== 'function' || !Number.isInteger(concurrency) || concurrency < 1
    || !Number.isInteger(readConcurrency) || readConcurrency < 1 || readConcurrency > concurrency) throw new TypeError('Invalid mail worker');
  const running = new Map<string, RunningJob>();
  let draining = false, redrain = false, stopped = false, initialized = false;
  let timer: NodeJS.Timeout | null = null, startPromise: Promise<void> | null = null;
  let drainFinished = Promise.resolve();
  let recoveredAt: number | null = null;
  function start() {
    if (initialized) return Promise.resolve();
    if (startPromise) return startPromise;
    startPromise = (async () => {
      initialized = true;
      if (!stopped) {
        timer = setInterval(() => { void drain().catch(error => onState({ state: 'error', error: (error as Error).message })); }, pollMs);
        timer.unref?.();
      }
      try { await drain(); }
      catch (error) { initialized = false; clearInterval(timer!); timer = null; throw error; }
    })();
    startPromise.catch(() => { startPromise = null; });
    return startPromise;
  }
  async function execute(job: ClaimedJob) {
    const controller = new AbortController();
    let release!: () => void;
    const finished = new Promise<void>(resolve => { release = resolve; });
    const runningJob = { controller, job, finished, cancellationRequested: false };
    running.set(job.id, runningJob);
    let heartbeatError: unknown = null;
    const heartbeat = setInterval(() => {
      void repository.updateJob({ jobId: job.id, accountId: job.mail_account_id, workerId,
        generation: Number(job.worker_generation), leaseSeconds }).then(result => {
          if (result.cancellationRequested) { runningJob.cancellationRequested = true; controller.abort(); }
        }, error => { heartbeatError = error; controller.abort(); });
    }, Math.max(1000, Math.floor(leaseSeconds * 400)));
    heartbeat.unref?.();
    try {
      const report = async (change: ProgressChange) => {
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
      // paused: the account cannot take provider writes now (module, restore,
      // inactive); the due scan requeues the job once the account may run it.
      const state = yielded ? 'idle' : controller.signal.aborted || result?.cancelled ? 'cancelled'
        : result?.paused ? 'paused' : result?.success ? 'idle' : 'error';
      const completion = async (cx: SqlExecutor | undefined) => {
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
          const [pending] = await cx.execute<RowDataPacket[]>(`SELECT o.id FROM mail_remote_occurrences o
            JOIN emails e ON e.id=o.email_id AND e.user_id=o.user_id
            WHERE o.user_id=? AND o.mail_account_id=? AND o.mailbox_id=?
              AND o.presence='present' AND e.content_state='queued' AND e.import_complete=FALSE
            LIMIT 1 FOR UPDATE`, [job.user_id, job.mail_account_id, job.mailbox_id]);
          more = pending.length > 0;
        }
        if (state === 'idle' && more && (job.mailbox_id || job.kind === 'reconcile' || job.kind === 'prune')) {
          await repository.enqueueJob({ userId: job.user_id, accountId: job.mail_account_id,
            mailboxId: job.mailbox_id, operationId: job.operation_id, kind: job.kind,
            priority: job.priority, dueAt: result?.retryAt || null,
            manualRefresh: result?.refreshPending === true }, cx);
        }
      };
      const transaction = repository === runtime ? (require('./mail-engine/repository') as typeof import('./mail-engine/repository')).withTransaction : repository.withTransaction;
      if (typeof transaction === 'function') await transaction(completion);
      else await completion(undefined); // injectable legacy test repositories
      onState({ ...job, state, result });
    } catch (error) {
      const yielded = controller.signal.reason === 'interactive-yield' && !runningJob.cancellationRequested
        && READ_ONLY_MAIL_JOB_KINDS.has(job.kind)
        && (error as NodeJS.ErrnoException)?.code !== 'MAIL_WORKER_FENCED' && !heartbeatError;
      controller.abort(); // no more provider commands after lost lease
      if ((error as NodeJS.ErrnoException)?.code !== 'MAIL_WORKER_FENCED') {
        try {
          const transaction = repository === runtime ? (require('./mail-engine/repository') as typeof import('./mail-engine/repository')).withTransaction : repository.withTransaction;
          const completion = async (cx: SqlExecutor | undefined) => {
            await repository.completeJob({ jobId: job.id, accountId: job.mail_account_id,
              workerId, generation: Number(job.worker_generation), state: yielded ? 'idle' : 'error',
              error: yielded ? null : (error as Error).message }, cx);
            if (yielded) await repository.enqueueJob({ userId: job.user_id, accountId: job.mail_account_id,
              mailboxId: job.mailbox_id, kind: job.kind, priority: job.priority,
              manualRefresh: Number(job.manual_refresh) === 1 }, cx);
          };
          if (typeof transaction === 'function') await transaction(completion);
          else await completion(undefined);
        } catch (finishError) { if ((finishError as NodeJS.ErrnoException)?.code !== 'MAIL_WORKER_FENCED') onState({ ...job, state: 'error', error: (finishError as Error).message }); }
      }
      onState({ ...job, state: yielded ? 'idle' : 'error', error: yielded ? null : (error as Error).message });
    } finally {
      clearInterval(heartbeat);
      running.delete(job.id);
      release();
      if (!stopped) void drain().catch(error => onState({ state: 'error', error: (error as Error).message }));
    }
  }
  const readsRunning = () => [...running.values()].filter(({ job }) => READ_ONLY_MAIL_JOB_KINDS.has(job.kind)).length;
  // A drain requested while one is in progress repeats that pass afterwards:
  // work committed after the running pass's claim query must not wait for the
  // next poll (an accepted change nudges the scheduler this way).
  async function drain() {
    if (stopped) return;
    if (draining) { redrain = true; return drainFinished; }
    draining = true;
    let finishDrain!: () => void;
    drainFinished = new Promise<void>(resolve => { finishDrain = resolve; });
    try {
      do {
        redrain = false;
        // Recovery runs at start and then at most every recoveryMs; it touches
        // every account. Between passes claimDueJob skips any account whose
        // expired lease is not yet recovered, so a replacement claim still never
        // follows an unrecovered lease: expiry alone cannot prove that a provider
        // mutation was not transmitted.
        if (recoveredAt === null || now() - recoveredAt >= recoveryMs) {
          await repository.recoverExpiredJobs();
          recoveredAt = now();
        }
        while (running.size < concurrency && !stopped) {
          const claim: Parameters<typeof runtime.claimDueJob>[0] = { workerId, leaseSeconds };
          if (readsRunning() >= readConcurrency) claim.kinds = MUTATION_MAIL_JOB_KINDS;
          const job = await repository.claimDueJob(claim);
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
      } while (redrain && !stopped);
    } finally { draining = false; redrain = false; finishDrain(); }
  }
  async function enqueue(input: EnqueueJob) {
    if (!initialized) await start();
    const job = await repository.enqueueJob(input);
    await drain();
    return job;
  }
  async function cancel({ userId, accountId, jobId }: { userId: string; accountId: string; jobId: string }) {
    const changed = await repository.requestCancellation({ userId, accountId, jobId });
    if (changed && running.has(jobId)) {
      const active = running.get(jobId)!;
      active.cancellationRequested = true;
      active.controller.abort();
    }
    return changed;
  }
  async function yieldReadWork(accountId: string) {
    // Accepted operations already exist before admission calls this. Abort
    // *only* read-only transports and wait until their fenced account lease
    // has been completed; do not race another writer with a still-open fetch.
    const reads = [...running.values()].filter(({ job }) => job.mail_account_id === accountId &&
      READ_ONLY_MAIL_JOB_KINDS.has(job.kind));
    for (const { controller } of reads) controller.abort('interactive-yield');
    await Promise.all(reads.map(({ finished }) => finished));
    return reads.length > 0;
  }
  function interruptAccount(accountId: string) {
    for (const { controller, job } of running.values()) {
      if (job.mail_account_id === accountId) controller.abort('account-stop');
    }
  }
  function stop() {
    stopped = true; clearInterval(timer!);
    for (const { controller } of running.values()) controller.abort();
    return drainFinished.then(() => Promise.all([...running.values()].map(({ finished }) => finished)));
  }
  return { start, enqueue, cancel, yieldReadWork, interruptAccount, state: (input: { userId: string; accountId: string }) => repository.getJobStatus(input), drain, stop,
    ids: () => [...running.keys()] };
}
export { createDurableMailScheduler, READ_ONLY_MAIL_JOB_KINDS, MUTATION_MAIL_JOB_KINDS };
