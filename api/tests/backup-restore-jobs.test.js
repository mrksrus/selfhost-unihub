const test = require('node:test');
const assert = require('node:assert/strict');

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
