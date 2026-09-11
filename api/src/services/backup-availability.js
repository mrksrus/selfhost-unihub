// Temporarily suspended while the account data model evolves. Existing archives stay readable.
const BACKUP_DISABLED_MESSAGE = 'Backup creation, import and restore are temporarily disabled while the data model changes. Existing completed backups can still be downloaded.';
const DISABLED_BACKUP_ROUTES = new Set([
  'POST /api/backup/jobs',
  'POST /api/backup/import',
  'POST /api/backup/jobs/:id/restore',
  'POST /api/backup/restore-jobs/:id/unlock',
  'POST /api/backup/restore-jobs/:id/start',
]);

async function suspendPendingBackupJobs(connection) {
  // A restart stops the old worker. Retain its files/keys, release write locks,
  // and never resume an old restore against the changed schema automatically.
  for (const table of ['data_export_jobs', 'backup_restore_jobs']) {
    await connection.execute(
      `UPDATE ${table} SET status = 'failed', phase = 'disabled', error = ?, completed_at = UTC_TIMESTAMP()
       WHERE status IN ('queued', 'running', 'cancelling', 'uploaded', 'validating')`,
      [BACKUP_DISABLED_MESSAGE]);
  }
}

module.exports = { BACKUP_DISABLED_MESSAGE, DISABLED_BACKUP_ROUTES, suspendPendingBackupJobs };
