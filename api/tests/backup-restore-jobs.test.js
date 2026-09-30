const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-for-restore-jobs';
process.env.BACKUP_MASTER_KEY = process.env.BACKUP_MASTER_KEY || 'test-backup-master-key-for-restore-jobs';

const { pruneArchiveKeyIfUnreferenced } = require('../src/services/backup-archive-keys');
const { setDb } = require('../src/state');

test('shared archive key is retained until the last archive reference is detached', async (t) => {
  let retainedRestoreReferences = [{ id: 'restore-2' }];
  let deleteCalls = 0;
  setDb({
    async execute(sql) {
      if (sql.includes('FROM data_export_jobs')) return [[]];
      if (sql.includes('FROM backup_restore_jobs')) return [retainedRestoreReferences];
      if (sql.startsWith('DELETE FROM backup_archive_keys')) {
        deleteCalls += 1;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });
  t.after(() => setDb(null));

  assert.equal(await pruneArchiveKeyIfUnreferenced('user-1', 'backup-1'), false);
  assert.equal(deleteCalls, 0);

  retainedRestoreReferences = [];
  assert.equal(await pruneArchiveKeyIfUnreferenced('user-1', 'backup-1'), true);
  assert.equal(deleteCalls, 1);
});

test('generated backup reference keeps its server unlock key', async (t) => {
  let deleteCalls = 0;
  setDb({
    async execute(sql) {
      if (sql.includes('FROM data_export_jobs')) return [[{ id: 'export-1' }]];
      if (sql.includes('FROM backup_restore_jobs')) return [[]];
      if (sql.startsWith('DELETE FROM backup_archive_keys')) {
        deleteCalls += 1;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });
  t.after(() => setDb(null));

  assert.equal(await pruneArchiveKeyIfUnreferenced('user-1', 'backup-1'), false);
  assert.equal(deleteCalls, 0);
});

test('restore honors cancellation accepted immediately before the final commit phase', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-restore-commit-cancel-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const job = {
    id: 'test-restore', user_id: 'test-user', status: 'queued', phase: 'queued',
    source_type: 'generated', operation: 'restore', requested_sections: '["contacts"]',
    cancel_requested: 0, is_encrypted: 0, progress: 0,
  };
  let service;
  let cancellationAccepted = false;
  let completionWritten = false;
  let transactionRolledBack = false;
  const pool = {
    async execute(sql, params) {
      if (sql.startsWith('SELECT')) return [[{ ...job }]];
      if (sql.includes('SET phase = CASE')) {
        assert.equal(job.status, 'running');
        assert.notEqual(job.phase, 'commit');
        Object.assign(job, { status: 'cancelling', phase: 'cancelling', cancel_requested: 1 });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE backup_restore_jobs')) {
        const keys = sql.match(/SET ([\s\S]+?)\s+WHERE/)[1].split(',').map(field => field.trim().split(' ')[0]);
        if (keys.includes('phase') && params[keys.indexOf('phase')] === 'commit') {
          // Pause publication of the commit phase and accept a real cancellation
          // request first. This represents the final allowed cancellation window.
          const cancelled = await service.cancelRestoreJob(job.user_id, job.id);
          assert.equal(cancelled.job.cancel_requested, true);
          cancellationAccepted = true;
        }
        keys.forEach((key, index) => { job[key] = params[index]; });
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const runtime = createBackupRuntime(directory, 'synthetic-commit-cancellation-key', pool);
  const backup = runtime('services/backup');
  backup.backupFromZipFile = async () => ({ backup: {}, fileSourcesByPath: new Map() });
  backup.importBackupForUser = async (_userId, _payload, options) => {
    const result = { valid: true, errors: [], warnings: [] };
    const connection = {
      async execute(sql) {
        assert.match(sql, /SET status = 'completed'/);
        completionWritten = true;
        Object.assign(job, { status: 'completed', phase: 'completed' });
      },
    };
    try {
      await options.onProgress('commit', 99);
      await options.beforeCommit(connection, result);
      return result;
    } catch (error) {
      transactionRolledBack = true;
      throw error;
    }
  };
  service = runtime('services/backup-restore-jobs');
  await service.runRestoreJob(job.id);
  assert.equal(cancellationAccepted, true);
  assert.equal(completionWritten, false, 'An accepted cancellation must not commit restored rows');
  assert.equal(transactionRolledBack, true);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.phase, 'cancelled');
});
