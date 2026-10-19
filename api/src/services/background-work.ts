import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor } from '../types';

import { db } from '../state';
import { poolStats } from './database';
import { everyInterval } from './timers';
import { schedulePeriodicMailWork, runMailServerDeletionPass } from './mail';
import { runDueWritebacks } from './mail-writebacks';
import { pruneFinishedJobs } from './mail-engine/runtime';
import { cleanupExpiredRecordingUploads } from './recordings';
import { isSectionRestoreActive } from './restore-locks';
import { idleSupervisor } from './mail-idle';
import { processNotificationJobs } from './notifications';
import { log } from '../log';

// The periodic work of this API process: the nine timers listed in
// docs/ARCHITECTURE.md "Scheduled Jobs", the startup resets they rely on and
// the mail IDLE supervisor they start. app.ts starts it once after the server
// listens and stops it on shutdown. UniHub runs one API process; everything
// here assumes it is the only process doing this work. Keeping it behind one
// start/stop pair is what lets a later worker process run it instead.

// Wake recent discovery independently of historical backfill. The durable
// scheduler coalesces due work; this timer is not the authority for its state.
const MAIL_SYNC_INTERVAL_MS = 30 * 1000;
const MAIL_SERVER_DELETE_INTERVAL_MS = 60 * 1000;

type TimerApi = Pick<typeof globalThis, 'setInterval' | 'clearInterval' | 'setTimeout' | 'clearTimeout' | 'setImmediate'>;
interface BackgroundWorkDeps {
  db: SqlExecutor;
  timers: TimerApi;
  poolStats: typeof poolStats;
  processNotificationJobs: typeof processNotificationJobs;
  schedulePeriodicMailWork: typeof schedulePeriodicMailWork;
  runMailServerDeletionPass: typeof runMailServerDeletionPass;
  runDueWritebacks: typeof runDueWritebacks;
  pruneFinishedJobs: typeof pruneFinishedJobs;
  cleanupExpiredRecordingUploads: typeof cleanupExpiredRecordingUploads;
  isSectionRestoreActive: typeof isSectionRestoreActive;
  idleSupervisor: Pick<typeof idleSupervisor, 'start' | 'stop' | 'options'>;
  runCalendarSyncPass: () => Promise<unknown>;
}
interface BackgroundWorkHandle { stop(): void }

function defaultDeps(): BackgroundWorkDeps {
  return {
    db,
    timers: globalThis,
    poolStats,
    processNotificationJobs,
    schedulePeriodicMailWork,
    runMailServerDeletionPass,
    runDueWritebacks,
    pruneFinishedJobs,
    cleanupExpiredRecordingUploads,
    isSectionRestoreActive,
    idleSupervisor,
    runCalendarSyncPass: (...args) => (require('./calendar-sync') as typeof import('./calendar-sync')).runCalendarSyncPass(...args),
  };
}

async function startBackgroundWork(overrides: Partial<BackgroundWorkDeps> = {}): Promise<BackgroundWorkHandle> {
  const deps = { ...defaultDeps(), ...overrides };
  const { timers } = deps;
  const intervals: { stop(): void }[] = [];
  const delayed: NodeJS.Timeout[] = [];
  let stopped = false;
  const every = (label: string, intervalMs: number, task: () => unknown) => {
    const handle = everyInterval(label, intervalMs, task, timers);
    intervals.push(handle);
    return handle;
  };
  const after = (ms: number, task: () => unknown) => {
    const timer = timers.setTimeout(task, ms);
    timer.unref?.();
    delayed.push(timer);
  };

  const notifications = every('NOTIFICATIONS', 30 * 1000, deps.processNotificationJobs);
  void notifications.run();

  // A process restart cannot resume an IMAP connection; rescan safely using
  // completed local imports. Accepted provider changes stay durable jobs.
  await deps.db.execute("UPDATE mail_accounts SET sync_status = 'pending' WHERE sync_status = 'running'");
  let periodicMailSyncRunning = false;
  const schedulePeriodicMail = async () => {
    if (periodicMailSyncRunning) return;

    periodicMailSyncRunning = true;
    try {
      const [accounts] = await deps.db.execute<(RowDataPacket & { id: string; user_id: string; email_address: string })[]>(
        'SELECT id, user_id, email_address FROM mail_accounts WHERE is_active = TRUE'
      );
      log.info('SYNC', 'Periodic mail sync', { accounts: accounts.length });
      for (const account of accounts) {
        if (await deps.isSectionRestoreActive(account.user_id, 'mail')) continue;
        const job = await deps.schedulePeriodicMailWork(account.id);
        if (job.started) job.promise.then((result: { success?: boolean; error?: unknown } | null | undefined) => {
          if (result?.success === false) log.error('SYNC', 'Account sync failed', result.error || 'Unknown error', { account: account.id });
        }, (error: unknown) => log.error('SYNC', 'Account sync failed', error, { account: account.id }));
      }
    } catch (error) {
      log.error('SYNC', 'Periodic sync failed', error);
    } finally {
      periodicMailSyncRunning = false;
    }
  };
  // Let the API begin serving before starting the first bounded recovery pass.
  // IDLE sessions start after the first pass has started the durable scheduler.
  timers.setImmediate(() => schedulePeriodicMail().catch(error => log.error('SYNC', 'Startup pass failed', error))
    .finally(() => { if (!stopped) deps.idleSupervisor.start(); }));
  every('SYNC', MAIL_SYNC_INTERVAL_MS, schedulePeriodicMail);
  // Re-enqueues due provider changes (with per-operation backoff) and nudges the
  // durable mail scheduler, which is the only worker that runs them.
  const writebacks = every('MAIL WRITEBACK', 1000, deps.runDueWritebacks);
  timers.setImmediate(() => { void writebacks.run(); });

  every('SERVER DELETE', MAIL_SERVER_DELETE_INTERVAL_MS, async () => {
    const result = await deps.runMailServerDeletionPass();
    const processed = (result.accounts || []).reduce((sum: number, item: { accountId: string; processed?: number }) => sum + (item.processed || 0), 0);
    if (processed > 0) log.info('SERVER DELETE', 'Periodic pass processed queued messages', { processed });
  });

  // Expired sessions, every hour, so the table does not grow.
  every('CLEANUP', 60 * 60 * 1000, async () => {
    const [result] = await deps.db.execute<ResultSetHeader>('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()');
    if (result.affectedRows > 0) log.info('CLEANUP', 'Deleted expired sessions', { deleted: result.affectedRows });
  });

  // Finished mail engine jobs older than 7 days, in bounded batches.
  const pruneMailJobs = every('CLEANUP', 60 * 60 * 1000, async () => {
    const { deleted } = await deps.pruneFinishedJobs();
    if (deleted > 0) log.info('CLEANUP', 'Deleted finished mail engine jobs', { deleted });
  });
  after(60 * 1000, () => { void pruneMailJobs.run(); });

  // Each calendar account schedules its own next sync (next_sync_at); this
  // timer only picks up the accounts that are due. A restart interrupts runs.
  await deps.db.execute("UPDATE calendar_accounts SET sync_status = 'pending' WHERE sync_status = 'syncing'")
    .catch(error => log.error('CALENDAR', 'Could not reset interrupted syncs', error));
  const calendarSync = every('CALENDAR', 60 * 1000, deps.runCalendarSyncPass);
  after(20 * 1000, () => { void calendarSync.run(); });

  every('CLEANUP', 60 * 60 * 1000, async () => {
    const deleted = await deps.cleanupExpiredRecordingUploads();
    if (deleted > 0) log.info('CLEANUP', 'Deleted expired recording uploads', { deleted });
  });

  // Pool counts every 15 minutes, and every minute while work is queueing for
  // a connection: a pile-up then shows in the log as it builds, not after it.
  let poolTicks = 0;
  every('DB POOL', 60 * 1000, () => {
    const stats = deps.poolStats();
    const busy = stats.queued > 0 || stats.active >= stats.limit / 2;
    if (busy || poolTicks++ % 15 === 0) {
      const counts = { total: stats.total, active: stats.active, free: stats.free, queued: stats.queued };
      if (busy) log.warn('DB POOL', 'Busy', counts); else log.info('DB POOL', 'Connections', counts);
    }
  });

  log.info('STARTUP', 'Background work started', { timers: intervals.length, imapIdleSessions: deps.idleSupervisor.options.maxSessions });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      for (const timer of delayed) timers.clearTimeout(timer);
      for (const handle of intervals) handle.stop();
      deps.idleSupervisor.stop();
    },
  };
}

export { startBackgroundWork };
export type { BackgroundWorkDeps, BackgroundWorkHandle };
