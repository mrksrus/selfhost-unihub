import { prepareFolderReconciliation } from './services/mail-folder-reconciliation';
import http from 'http';
import { API_LISTEN_HOST, PORT } from './config';
import { db } from './state';
import { initDatabase } from './services/database';
import { suspendPendingBackupJobs, DISABLED_BACKUP_ROUTES } from './services/backup-availability';
import { resumePendingDataExportJobs } from './services/export-jobs';
import { resumePendingRestoreJobs } from './services/backup-restore-jobs';
import { verifyDatabaseInventory } from './services/data-inventory';
import { handleRequest } from './request-handler';
import { installShutdownHandler } from './services/server-events';
import { startBackgroundWork } from './services/background-work';
import type { BackgroundWorkHandle } from './services/background-work';
import { getVapidKeys } from './services/notifications';
import { closeAndroidStreams } from './services/android-push';
import { drainProcess } from './services/shutdown';
import { durableScheduler } from './services/mail-durable-jobs';
import { expireWorkerLeases } from './services/mail-engine/runtime';
import { startWorkerOwnership } from './services/worker-owner';
import { controlPool } from './services/side-pools';
import { log } from './log';

// Both are logged with their stack, so a container restart has a cause in its
// log. Startup failures exit (server.ts catches start()). A runtime rejection
// nobody awaited is only logged, not a restart (Node's default would exit):
// whatever produced it has already failed on its own path. An exception
// outside any handler leaves unknown state, so the process ends and the
// container restarts.
process.on('unhandledRejection', reason => {
  log.error('PROCESS', 'Unhandled promise rejection', reason);
});
process.on('uncaughtException', error => {
  log.error('PROCESS', 'Uncaught exception, exiting', error);
  process.exit(1);
});

async function start() {
  await initDatabase();
  await verifyDatabaseInventory(db);
  // The Web Push identity is generated once, at startup rather than on first delivery.
  await getVapidKeys();
  await prepareFolderReconciliation();
  if (DISABLED_BACKUP_ROUTES.size) {
    await suspendPendingBackupJobs(db);
    log.info('BACKUP', 'Creation and restore suspended; existing archives retained');
  } else {
    await resumePendingDataExportJobs();
    await resumePendingRestoreJobs();
    log.info('BACKUP', 'Versioned backup and restore workers enabled');
  }
  // Previously retained restore uploads stay available until explicitly deleted.
  // Re-enabling backup must not suddenly expire archives retained during suspension.

  const server = http.createServer((req, res) => {
    // Last-resort boundary, including failures while writing an error response.
    handleRequest(req, res).catch(error => {
      log.error('HTTP', 'Response failed', error);
      res.destroy();
    });
  });

  // The timers start after the server listens; a stop signal before that has
  // nothing to stop. Stopping them (and the IDLE sessions they own) comes
  // before the Android streams; then services/shutdown.ts drains the rest.
  let work: BackgroundWorkHandle | null = null;
  let ownership: Awaited<ReturnType<typeof startWorkerOwnership>> | null = null;
  let stopping = false;
  const serverClosed = new Promise(resolve => server.once('close', resolve));
  installShutdownHandler({ server, onShutdown: [() => { stopping = true; work?.stop(); }, closeAndroidStreams], drainMs: 8000,
    drain: () => drainProcess({ serverClosed, scheduler: durableScheduler, expireWorkerLeases,
      closePool: async () => { await ownership?.stop(); await db.end(); } }) });
  server.listen({ port: Number(PORT), ...(API_LISTEN_HOST ? { host: API_LISTEN_HOST } : {}) }, () => {
    log.info('STARTUP', 'UniHub API listening', { port: PORT, ...(API_LISTEN_HOST ? { host: API_LISTEN_HOST } : {}) });
  });

  // Only the process holding the database lock runs the background work
  // (services/worker-owner.ts); another one serves requests and waits.
  // The lock's session is a control connection (side-pools.ts), never one
  // the work or the requests need.
  ownership = await startWorkerOwnership({
    pool: controlPool(),
    // The handle exists at once: losing the role stops a start-up still
    // going, and only that one. A failed start-up ends the role (worker-owner.ts).
    onGained: () => {
      if (stopping) return;
      work = startBackgroundWork();
      return work.ready;
    },
    onLost: () => { work?.stop(); work = null; },
  });
}

export {
  start,
};
