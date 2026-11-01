// Schema 3 recovery has passed the upgrade and recovery gate.
// Retain a single emergency suspension switch for both HTTP dispatch paths.
import type { SqlExecutor } from '../types';
import type { PolicyKey } from '../contracts/policies';

const BACKUP_MUTATIONS_ENABLED = true;
const BACKUP_DISABLED_MESSAGE = 'Backup creation, import and restore are temporarily disabled while the data model changes. Existing completed backups can still be downloaded.';
const DISABLED_BACKUP_ROUTES = new Set(BACKUP_MUTATIONS_ENABLED ? [] : [
  'POST /api/backup/jobs',
  'POST /api/backup/import',
  'POST /api/backup/jobs/:id/restore',
  'POST /api/backup/restore-jobs/:id/unlock',
  'POST /api/backup/restore-jobs/:id/start',
]);

async function suspendPendingBackupJobs(connection: SqlExecutor) {
  // A restart stops the old worker. Retain its files/keys, release write locks,
  // and never resume an old restore against the changed schema automatically.
  for (const table of ['data_export_jobs', 'backup_restore_jobs']) {
    await connection.execute(
      `UPDATE ${table} SET status = 'failed', phase = 'disabled', error = ?, completed_at = UTC_TIMESTAMP()
       WHERE status IN ('queued', 'running', 'cancelling', 'uploaded', 'validating')`,
      [BACKUP_DISABLED_MESSAGE]);
  }
}

// F13: the data-safety policies of these routes, for the request boundary
// to resolve before the handler (C1 puts them on the specs of routes/backup.ts; until
// then nothing reads them). `requires` gates creating and restoring;
// `destructive` names what removes a backup.
const BACKUP_ROUTE_POLICIES: Readonly<Record<string, { requires?: readonly PolicyKey[]; destructive?: readonly PolicyKey[] }>> = Object.freeze({
  'POST /api/backup/jobs': { requires: ['backup.create'] },
  'POST /api/backup/import': { requires: ['backup.restore'] },
  'POST /api/backup/jobs/:id/restore': { requires: ['backup.restore'] },
  'POST /api/backup/restore-jobs/:id/start': { requires: ['backup.restore'] },
  'DELETE /api/backup/jobs/:id': { destructive: ['backup.delete'] },
  'DELETE /api/backup/restore-jobs/:id': { destructive: ['backup.delete'] },
  // A mail route (routes/mail-accounts.ts): one account's backup.
  'POST /api/mail/accounts/:id/backup-export': { requires: ['backup.create'] },
});

export { BACKUP_DISABLED_MESSAGE, DISABLED_BACKUP_ROUTES, BACKUP_ROUTE_POLICIES, suspendPendingBackupJobs };
