import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
interface PoolStatistics { _allConnections?: { length: number }; _freeConnections?: { length: number }; _connectionQueue?: { length: number } }

import imported1 = require('./services/mail-folder-reconciliation');
const { prepareFolderReconciliation } = imported1;
import http = require('http');
import imported2 = require('./config');
const { PORT } = imported2;
import imported3 = require('./state');
const { db } = imported3;
import imported4 = require('./services/database');
const { initDatabase, ensurePerformanceIndexes } = imported4;
import imported5 = require('./services/mail');
const { schedulePeriodicMailWork, runMailServerDeletionPass } = imported5;
import imported6 = require('./services/mail-writebacks');
const { runDueWritebacks } = imported6;
import imported7 = require('./services/mail-engine/runtime');
const { pruneFinishedJobs } = imported7;
import imported8 = require('./services/recordings');
const { cleanupExpiredRecordingUploads } = imported8;
import imported9 = require('./services/backup-availability');
const { suspendPendingBackupJobs, DISABLED_BACKUP_ROUTES } = imported9;
import imported10 = require('./services/export-jobs');
const { resumePendingDataExportJobs } = imported10;
import imported11 = require('./services/backup-restore-jobs');
const { resumePendingRestoreJobs } = imported11;
import imported12 = require('./services/data-inventory');
const { verifyDatabaseInventory } = imported12;
import imported13 = require('./services/restore-locks');
const { isSectionRestoreActive } = imported13;
import imported14 = require('./request-handler');
const { handleRequest } = imported14;
import imported15 = require('./services/server-events');
const { installShutdownHandler } = imported15;
import imported16 = require('./services/mail-idle');
const { idleSupervisor } = imported16;
import imported17 = require('./services/notifications');
const { ensureNotificationSchema, processNotificationJobs } = imported17;

// Wake recent discovery independently of historical backfill. The durable
// scheduler coalesces due work; this timer is not the authority for its state.
const MAIL_SYNC_INTERVAL_MS = 30 * 1000;
const MAIL_SERVER_DELETE_INTERVAL_MS = 60 * 1000;
let periodicMailSyncRunning = false;
let periodicMailServerDeleteRunning = false;

async function start() {
  await initDatabase();
  await ensureNotificationSchema();
  await verifyDatabaseInventory(db);
  await prepareFolderReconciliation();
  const runNotifications = () => processNotificationJobs().catch(error => console.error('[NOTIFICATIONS] Worker failed:', (error as Error).message));
  void runNotifications();
  setInterval(runNotifications, 30 * 1000);
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

  installShutdownHandler({ server, onShutdown: [() => idleSupervisor.stop()] });
  server.listen(PORT, () => {
    console.log(`✓ UniHub API server running on port ${PORT}`);
    setTimeout(() => {
      ensurePerformanceIndexes().catch((error) => {
        console.error('[DB] Mail performance index setup failed:', (error as Error).message);
      });
    }, 5000);
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
        });
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
  setInterval(schedulePeriodicMail, MAIL_SYNC_INTERVAL_MS);
  // Re-enqueues due provider changes (with per-operation backoff) and nudges the
  // durable mail scheduler, which is the only worker that runs them.
  const runWritebacks = () => runDueWritebacks().catch(error => console.error('[MAIL WRITEBACK] Due pass failed:', (error as Error).message));
  setImmediate(runWritebacks);
  setInterval(runWritebacks, 1000);

  setInterval(async () => {
    if (periodicMailServerDeleteRunning) {
      return;
    }

    periodicMailServerDeleteRunning = true;
    try {
      const result = await runMailServerDeletionPass();
      const processed = (result.accounts || []).reduce((sum: number, item: { accountId: string; processed?: number }) => sum + (item.processed || 0), 0);
      if (processed > 0) {
        console.log(`[SERVER DELETE] Periodic pass processed ${processed} queued message(s)`);
      }
    } catch (error) {
      console.error('[SERVER DELETE] Periodic pass error:', (error as Error).message);
    } finally {
      periodicMailServerDeleteRunning = false;
    }
  }, MAIL_SERVER_DELETE_INTERVAL_MS);

  // Clean up expired sessions every hour to prevent table bloat
  setInterval(async () => {
    try {
      const [result] = await db.execute<ResultSetHeader>(
        'DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()'
      );
      if (result.affectedRows > 0) {
        console.log(`[CLEANUP] Deleted ${result.affectedRows} expired session(s)`);
      }
    } catch (error) {
      console.error('[CLEANUP] Error cleaning expired sessions:', (error as Error).message);
    }
  }, 60 * 60 * 1000); // 1 hour

  // Finished mail engine jobs older than 7 days, in bounded batches.
  const pruneMailJobs = async () => {
    try {
      const { deleted } = await pruneFinishedJobs();
      if (deleted > 0) console.log(`[CLEANUP] Deleted ${deleted} finished mail engine job(s)`);
    } catch (error) {
      console.error('[CLEANUP] Error pruning mail engine jobs:', (error as Error).message);
    }
  };
  setTimeout(pruneMailJobs, 60 * 1000).unref?.();
  setInterval(pruneMailJobs, 60 * 60 * 1000);

  // Each calendar account schedules its own next sync (next_sync_at); this
  // timer only picks up the accounts that are due. A restart interrupts runs.
  const { runCalendarSyncPass } = require('./services/calendar-sync');
  await db.execute("UPDATE calendar_accounts SET sync_status = 'pending' WHERE sync_status = 'syncing'")
    .catch(error => console.error('[CALENDAR] Could not reset interrupted syncs:', (error as Error).message));
  const runCalendarSync = () => runCalendarSyncPass().catch((error: Error) => console.error('[CALENDAR] Sync pass failed:', (error as Error).message));
  setTimeout(runCalendarSync, 20 * 1000).unref?.();
  setInterval(runCalendarSync, 60 * 1000);

  setInterval(async () => {
    try {
      const deleted = await cleanupExpiredRecordingUploads();
      if (deleted > 0) {
        console.log(`[CLEANUP] Deleted ${deleted} expired recording upload(s)`);
      }
    } catch (error) {
      console.error('[CLEANUP] Error cleaning expired recording uploads:', (error as Error).message);
    }
  }, 60 * 60 * 1000);

  // Database connection pool health check and cleanup every 15 minutes
  setInterval(async () => {
    try {
      // Test connection pool health with a simple query
      await db.execute('SELECT 1');

      // Get pool statistics (mysql2 pool internal structure)
      const pool = db.pool as unknown as PoolStatistics;
      if (pool && pool._allConnections) {
        const totalConnections = pool._allConnections.length || 0;
        const freeConnections = pool._freeConnections?.length || 0;
        const activeConnections = totalConnections - freeConnections;
        const queuedRequests = pool._connectionQueue?.length || 0;

        console.log(`[DB POOL] Total: ${totalConnections}, Active: ${activeConnections}, Free: ${freeConnections}, Queued: ${queuedRequests}`);

        // If we're using too many connections, log a warning (warn at 80% usage)
        if (activeConnections > 40) {
          console.warn(`[DB POOL] ⚠ High connection usage: ${activeConnections}/50 connections in use`);
        }

        // If we have many idle connections, we can let them timeout naturally
        if (freeConnections > 8) {
          console.log(`[DB POOL] Many idle connections (${freeConnections}), will timeout naturally`);
        }
      }
    } catch (error) {
      console.error('[DB POOL] Health check error:', (error as Error).message);
      // Try to reconnect if connection is lost
      try {
        await db.execute('SELECT 1');
        console.log('[DB POOL] Reconnection successful');
      } catch (reconnectError) {
        console.error('[DB POOL] Reconnection failed:', (reconnectError as Error).message);
      }
    }
  }, 15 * 60 * 1000); // 15 minutes

  console.log('✓ Mail INBOX follow-up every 30 seconds (every 5 minutes while IMAP IDLE is up); folder discovery every 5 minutes');
  console.log(idleSupervisor.options.maxSessions > 0
    ? `✓ Mail INBOX IMAP IDLE enabled (up to ${idleSupervisor.options.maxSessions} sessions)` : '✓ Mail INBOX IMAP IDLE disabled');
  console.log('✓ Mail server deletion worker enabled (every minute)');
  console.log('✓ Expired session cleanup enabled (every hour)');
  console.log('✓ Expired recording upload cleanup enabled (every hour)');
  console.log('✓ Finished mail engine job pruning enabled (every hour, older than 7 days)');
  console.log('✓ Database connection pool health check enabled (every 15 minutes)');
}


export = {
  start,
};
