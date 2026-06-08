const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-for-backup-route';
process.env.BACKUP_MASTER_KEY = process.env.BACKUP_MASTER_KEY || 'test-backup-master-key-for-backup-route';

const routes = require('../src/routes/backup');
const { setDb } = require('../src/state');

function requestFor(pathname) {
  return {
    headers: { host: 'localhost' },
    url: pathname,
  };
}

test('encrypted download requires recovery-password metadata', async (t) => {
  setDb({
    async execute(sql) {
      assert.match(sql, /archive_keys/);
      return [[{
        id: 'job-1',
        user_id: 'user-1',
        status: 'ready',
        phase: 'ready',
        requested_sections: '["settings"]',
        encryption_enabled: 1,
        file_path: '/app/uploads/backups/user-1/job-1.unihub-backup',
        recovery_password_available: 0,
        recovery_password_revealed: 0,
        server_unlock_available: 1,
      }]];
    },
  });
  t.after(() => setDb(null));

  const result = await routes['GET /api/backup/jobs/:id/download'](
    requestFor('/api/backup/jobs/job-1/download'),
    'user-1'
  );

  assert.equal(result.status, 409);
  assert.match(result.error, /metadata is missing/i);
});

test('encrypted download is gated while the recovery password can still be revealed', async (t) => {
  setDb({
    async execute() {
      return [[{
        id: 'job-1',
        user_id: 'user-1',
        status: 'ready',
        phase: 'ready',
        requested_sections: '["settings"]',
        encryption_enabled: 1,
        file_path: '/app/uploads/backups/user-1/job-1.unihub-backup',
        recovery_password_available: 1,
        recovery_password_revealed: 0,
        server_unlock_available: 1,
      }]];
    },
  });
  t.after(() => setDb(null));

  const result = await routes['GET /api/backup/jobs/:id/download'](
    requestFor('/api/backup/jobs/job-1/download'),
    'user-1'
  );

  assert.equal(result.status, 409);
  assert.match(result.error, /Reveal and save/);
});

test('password reveal reports missing recovery metadata for an existing job', async (t) => {
  let rolledBack = false;
  const connection = {
    async beginTransaction() {},
    async execute(sql) {
      assert.match(sql, /LEFT JOIN backup_archive_keys archive_keys/);
      return [[{
        backup_uuid: 'backup-1',
        status: 'ready',
        recovery_password_ciphertext: null,
        recovery_password_revealed_at: null,
        server_wrapped_key: null,
      }]];
    },
    async rollback() {
      rolledBack = true;
    },
    release() {},
  };
  setDb({
    async getConnection() {
      return connection;
    },
  });
  t.after(() => setDb(null));

  const result = await routes['POST /api/backup/jobs/:id/recovery-password/reveal'](
    requestFor('/api/backup/jobs/job-1/recovery-password/reveal'),
    'user-1'
  );

  assert.equal(result.status, 409);
  assert.match(result.error, /metadata is missing/i);
  assert.equal(rolledBack, true);
});
