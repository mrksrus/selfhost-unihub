import { prepareFolderReconciliation } from './services/mail-folder-reconciliation';
import http from 'http';
import { PORT } from './config';
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

  // The timers start after the server listens; a stop signal before that has
  // nothing to stop. Stopping them (and the IDLE sessions they own) comes
  // before the Android streams, as the explicit hooks did.
  let work: BackgroundWorkHandle | null = null;
  installShutdownHandler({ server, onShutdown: [() => work?.stop(), closeAndroidStreams] });
  server.listen(PORT, () => {
    console.log(`✓ UniHub API server running on port ${PORT}`);
  });

  work = await startBackgroundWork();
}

export {
  start,
};
