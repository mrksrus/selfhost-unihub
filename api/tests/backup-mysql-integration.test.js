const test = require('node:test');
const assert = require('node:assert/strict');

const mysqlHost = process.env.MYSQL_TEST_HOST;

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'mysql-integration-encryption-key';
process.env.BACKUP_MASTER_KEY = process.env.BACKUP_MASTER_KEY || 'mysql-integration-backup-master-key';

const mysql = require('mysql2/promise');
const { protectRecoveryPassword } = require('../src/services/backup-container');
const {
  getDataExportJob,
  listDataExportJobs,
  resumePendingDataExportJobs,
  serializeJob,
} = require('../src/services/export-jobs');
const { pruneArchiveKeyIfUnreferenced } = require('../src/services/backup-archive-keys');
const routes = require('../src/routes/backup');
const { setDb } = require('../src/state');

test('MySQL 8 backup metadata queries and one-time password reveal', {
  skip: !mysqlHost,
}, async (t) => {
  const pool = mysql.createPool({
    host: mysqlHost,
    port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER || 'unihub_test',
    password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
    database: process.env.MYSQL_TEST_DATABASE || 'unihub_test',
    connectionLimit: 2,
  });
  setDb(pool);
  t.after(async () => {
    await pool.execute('DROP TABLE IF EXISTS backup_archive_keys');
    await pool.execute('DROP TABLE IF EXISTS backup_restore_jobs');
    await pool.execute('DROP TABLE IF EXISTS data_export_jobs');
    await pool.end();
    setDb(null);
  });

  await pool.execute('DROP TABLE IF EXISTS backup_archive_keys');
  await pool.execute('DROP TABLE IF EXISTS backup_restore_jobs');
  await pool.execute('DROP TABLE IF EXISTS data_export_jobs');
  await pool.execute(`CREATE TABLE data_export_jobs (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    scope VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL,
    phase VARCHAR(32) NOT NULL,
    progress INT NOT NULL,
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    requested_sections JSON NULL,
    file_path TEXT NULL,
    file_size BIGINT NULL,
    file_sha256 CHAR(64) NULL,
    content_type VARCHAR(128) NULL,
    encryption_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    backup_uuid CHAR(36) NULL,
    error TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    started_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    downloaded_at TIMESTAMP NULL
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE backup_archive_keys (
    backup_uuid CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    export_job_id CHAR(36) NULL,
    restore_job_id CHAR(36) NULL,
    server_wrapped_key LONGTEXT NOT NULL,
    recovery_password_ciphertext LONGTEXT NULL,
    recovery_password_revealed_at TIMESTAMP NULL,
    expires_at TIMESTAMP NULL,
    PRIMARY KEY (backup_uuid, user_id),
    INDEX idx_backup_archive_keys_export (export_job_id)
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE backup_restore_jobs (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    backup_uuid CHAR(36) NULL,
    archive_path TEXT NULL,
    INDEX idx_backup_restore_jobs_user_backup (user_id, backup_uuid)
  ) ENGINE=InnoDB`);

  const userId = '11111111-1111-4111-8111-111111111111';
  const jobId = '22222222-2222-4222-8222-222222222222';
  const backupUuid = '33333333-3333-4333-8333-333333333333';
  const recoveryPassword = 'mysql-integration-recovery-password';
  await pool.execute(
    `INSERT INTO data_export_jobs
       (id, user_id, scope, status, phase, progress, requested_sections,
        file_path, encryption_enabled, backup_uuid)
     VALUES (?, ?, 'full', 'ready', 'ready', 100, ?, ?, TRUE, ?)`,
    [jobId, userId, JSON.stringify(['settings']), '/app/uploads/backups/test.unihub-backup', backupUuid]
  );
  await pool.execute(
    `INSERT INTO backup_archive_keys
       (backup_uuid, user_id, export_job_id, server_wrapped_key, recovery_password_ciphertext)
     VALUES (?, ?, ?, ?, ?)`,
    [
      backupUuid,
      userId,
      jobId,
      'server-wrapped-key',
      protectRecoveryPassword(recoveryPassword, backupUuid),
    ]
  );

  const jobs = await listDataExportJobs(userId);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].recovery_password_available, true);
  assert.equal(jobs[0].recovery_password_revealed, false);
  assert.equal(jobs[0].server_unlock_available, true);

  const rawJob = await getDataExportJob(userId, jobId);
  assert.equal(serializeJob(rawJob).recovery_password_available, true);

  const reveal = await routes['POST /api/backup/jobs/:id/recovery-password/reveal'](
    { headers: { host: 'localhost' }, url: `/api/backup/jobs/${jobId}/recovery-password/reveal` },
    userId
  );
  assert.equal(reveal.recovery_password, recoveryPassword);

  const revealedJob = serializeJob(await getDataExportJob(userId, jobId));
  assert.equal(revealedJob.recovery_password_available, false);
  assert.equal(revealedJob.recovery_password_revealed, true);
  assert.equal(revealedJob.server_unlock_available, true);

  const secondReveal = await routes['POST /api/backup/jobs/:id/recovery-password/reveal'](
    { headers: { host: 'localhost' }, url: `/api/backup/jobs/${jobId}/recovery-password/reveal` },
    userId
  );
  assert.equal(secondReveal.status, 410);

  assert.equal(await resumePendingDataExportJobs({ schedule: false }), 0);

  const uploadedBackupUuid = '44444444-4444-4444-8444-444444444444';
  await pool.execute(
    `INSERT INTO backup_archive_keys
       (backup_uuid, user_id, server_wrapped_key)
     VALUES (?, ?, ?)`,
    [uploadedBackupUuid, userId, 'shared-upload-key']
  );
  await pool.execute(
    `INSERT INTO backup_restore_jobs (id, user_id, backup_uuid, archive_path)
     VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    [
      '55555555-5555-4555-8555-555555555555',
      userId,
      uploadedBackupUuid,
      '/tmp/restore-1.unihub-backup',
      '66666666-6666-4666-8666-666666666666',
      userId,
      uploadedBackupUuid,
      '/tmp/restore-2.unihub-backup',
    ]
  );
  assert.equal(await pruneArchiveKeyIfUnreferenced(userId, uploadedBackupUuid), false);
  await pool.execute(
    'UPDATE backup_restore_jobs SET archive_path = NULL WHERE id = ?',
    ['55555555-5555-4555-8555-555555555555']
  );
  assert.equal(await pruneArchiveKeyIfUnreferenced(userId, uploadedBackupUuid), false);
  await pool.execute(
    'UPDATE backup_restore_jobs SET archive_path = NULL WHERE id = ?',
    ['66666666-6666-4666-8666-666666666666']
  );
  assert.equal(await pruneArchiveKeyIfUnreferenced(userId, uploadedBackupUuid), true);
});
