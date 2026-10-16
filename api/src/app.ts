import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';

import { prepareFolderReconciliation } from './services/mail-folder-reconciliation';
import http from 'http';
import { PORT } from './config';
import { db } from './state';
import { initDatabase, poolStats } from './services/database';
import { everyInterval } from './services/timers';
import { schedulePeriodicMailWork, runMailServerDeletionPass } from './services/mail';
import { runDueWritebacks } from './services/mail-writebacks';
import { pruneFinishedJobs } from './services/mail-engine/runtime';
import { cleanupExpiredRecordingUploads } from './services/recordings';
import { suspendPendingBackupJobs, DISABLED_BACKUP_ROUTES } from './services/backup-availability';
import { resumePendingDataExportJobs } from './services/export-jobs';
import { resumePendingRestoreJobs } from './services/backup-restore-jobs';
import { verifyDatabaseInventory } from './services/data-inventory';
import { isSectionRestoreActive } from './services/restore-locks';
import { handleRequest } from './request-handler';
import { installShutdownHandler } from './services/server-events';
import { idleSupervisor } from './services/mail-idle';
import { getVapidKeys, processNotificationJobs } from './services/notifications';
import { closeAndroidStreams } from './services/android-push';

// Wake recent discovery independently of historical backfill. The durable
// scheduler coalesces due work; this timer is not the authority for its state.
const MAIL_SYNC_INTERVAL_MS = 30 * 1000;
const MAIL_SERVER_DELETE_INTERVAL_MS = 60 * 1000;
let periodicMailSyncRunning = false;

// Both are logged with their stack, so a container restart has a cause in its
// log. Startup failures exit (server.ts catches start()). A runtime rejection
// nobody awaited is only logged, not a restart (Node's default would exit):
// whatever produced it has already failed on its own path. An exception
// outside any handler leaves unknown state, so the process ends and the
// container restarts.
process.on('unhandledRejection', reason => {
  console.error('[PROCESS] Unhandled promise rejection:', reason instanceof Error ? reason.stack || reason.message : reason);
});
process.on('uncaughtException', error => {
  console.error('[PROCESS] Uncaught exception, exiting:', error.stack || error.message);
  process.exit(1);
});

async function start() {
  await initDatabase();
  await verifyDatabaseInventory(db);
  // The Web Push identity is generated once, at startup rather than on first delivery.
  await getVapidKeys();
  await prepareFolderReconciliation();
  const runNotifications = everyInterval('NOTIFICATIONS', 30 * 1000, processNotificationJobs);
  void runNotifications();
  if (DISABLED_BACKUP_ROUTES.size) {
    await suspendPendingBackupJobs(db);
    console.log('[BACKUP] Creation and restore suspended; existing archives retained.');
  } else {
    await resumePendingDataExportJobs();
    await resumePendingRestoreJobs();
    console.log('[BACKUP] Versioned backup and restore workers enabled.');
  }
  // Previously retained restore uploads stay available until explicitly deleted.
  // Re-enabling backup must not suddenly expire archives retained during suspension.

  const server = http.createServer((req, res) => {
    // Last-resort boundary, including failures while writing an error response.
    handleRequest(req, res).catch(error => {
      console.error('HTTP response failed:', (error as Error).message);
      res.destroy();
    });
  });

  installShutdownHandler({ server, onShutdown: [() => idleSupervisor.stop(), closeAndroidStreams] });
  server.listen(PORT, () => {
    console.log(`✓ UniHub API server running on port ${PORT}`);
  });

  // A process restart cannot resume an IMAP connection; rescan safely using
  // completed local imports. Accepted provider changes stay durable jobs.
  await db.execute("UPDATE mail_accounts SET sync_status = 'pending' WHERE sync_status = 'running'");
  const schedulePeriodicMail = async () => {
    if (periodicMailSyncRunning) return;

    periodicMailSyncRunning = true;
    try {
      const [accounts] = await db.execute<(RowDataPacket & { id: string; user_id: string; email_address: string })[]>(
        'SELECT id, user_id, email_address FROM mail_accounts WHERE is_active = TRUE'
      );
      console.log(`\n[${new Date().toISOString()}] Starting periodic mail sync for ${accounts.length} accounts...`);
      for (const account of accounts) {
        if (await isSectionRestoreActive(account.user_id, 'mail')) continue;
        const job = await schedulePeriodicMailWork(account.id);
        if (job.started) job.promise.then((result: { success?: boolean; error?: unknown } | null | undefined) => {
          if (result?.success === false) console.error(`Failed to sync account ${account.id}:`, result.error || 'Unknown error');
        }, (error: unknown) => console.error(`Failed to sync account ${account.id}:`, (error as Error).message));
      }
    } catch (error) {
      console.error('Periodic sync error:', error);
    } finally {
      periodicMailSyncRunning = false;
    }
  };
  // Let the API begin serving before starting the first bounded recovery pass.
  // IDLE sessions start after the first pass has started the durable scheduler.
  setImmediate(() => schedulePeriodicMail().catch(error => console.error('[SYNC] Startup pass failed:', (error as Error).message))
    .finally(() => idleSupervisor.start()));
  everyInterval('SYNC', MAIL_SYNC_INTERVAL_MS, schedulePeriodicMail);
  // Re-enqueues due provider changes (with per-operation backoff) and nudges the
  // durable mail scheduler, which is the only worker that runs them.
  const runWritebacks = everyInterval('MAIL WRITEBACK', 1000, runDueWritebacks);
  setImmediate(() => { void runWritebacks(); });

  everyInterval('SERVER DELETE', MAIL_SERVER_DELETE_INTERVAL_MS, async () => {
    const result = await runMailServerDeletionPass();
    const processed = (result.accounts || []).reduce((sum: number, item: { accountId: string; processed?: number }) => sum + (item.processed || 0), 0);
    if (processed > 0) console.log(`[SERVER DELETE] Periodic pass processed ${processed} queued message(s)`);
  });

  // Expired sessions, every hour, so the table does not grow.
  everyInterval('CLEANUP', 60 * 60 * 1000, async () => {
    const [result] = await db.execute<ResultSetHeader>('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()');
    if (result.affectedRows > 0) console.log(`[CLEANUP] Deleted ${result.affectedRows} expired session(s)`);
  });

  // Finished mail engine jobs older than 7 days, in bounded batches.
  const pruneMailJobs = everyInterval('CLEANUP', 60 * 60 * 1000, async () => {
    const { deleted } = await pruneFinishedJobs();
    if (deleted > 0) console.log(`[CLEANUP] Deleted ${deleted} finished mail engine job(s)`);
  });
  setTimeout(() => { void pruneMailJobs(); }, 60 * 1000).unref?.();

  // Each calendar account schedules its own next sync (next_sync_at); this
  // timer only picks up the accounts that are due. A restart interrupts runs.
  const { runCalendarSyncPass } = require('./services/calendar-sync') as typeof import('./services/calendar-sync');
  await db.execute("UPDATE calendar_accounts SET sync_status = 'pending' WHERE sync_status = 'syncing'")
    .catch(error => console.error('[CALENDAR] Could not reset interrupted syncs:', (error as Error).message));
  const runCalendarSync = everyInterval('CALENDAR', 60 * 1000, runCalendarSyncPass);
  setTimeout(() => { void runCalendarSync(); }, 20 * 1000).unref?.();

  everyInterval('CLEANUP', 60 * 60 * 1000, async () => {
    const deleted = await cleanupExpiredRecordingUploads();
    if (deleted > 0) console.log(`[CLEANUP] Deleted ${deleted} expired recording upload(s)`);
  });

  // Pool counts every 15 minutes, and every minute while work is queueing for
  // a connection: a pile-up then shows in the log as it builds, not after it.
  let poolTicks = 0;
  everyInterval('DB POOL', 60 * 1000, () => {
    const stats = poolStats();
    const busy = stats.queued > 0 || stats.active >= stats.limit / 2;
    if (busy || poolTicks++ % 15 === 0) {
      (busy ? console.warn : console.log)(`[DB POOL] Total: ${stats.total}, Active: ${stats.active}, Free: ${stats.free}, Queued: ${stats.queued}${busy ? ' (busy)' : ''}`);
    }
  });

  console.log('✓ Mail INBOX follow-up every 30 seconds (every 5 minutes while IMAP IDLE is up); folder discovery every 5 minutes');
  console.log(idleSupervisor.options.maxSessions > 0
    ? `✓ Mail INBOX IMAP IDLE enabled (up to ${idleSupervisor.options.maxSessions} sessions)` : '✓ Mail INBOX IMAP IDLE disabled');
  console.log('✓ Mail server deletion worker enabled (every minute)');
  console.log('✓ Expired session cleanup enabled (every hour)');
  console.log('✓ Expired recording upload cleanup enabled (every hour)');
  console.log('✓ Finished mail engine job pruning enabled (every hour, older than 7 days)');
  console.log('✓ Database pool counts logged every 15 minutes, every minute while busy');
}

export {
  start,
};
