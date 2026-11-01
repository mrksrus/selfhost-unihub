import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-for-backup-route';
process.env.BACKUP_MASTER_KEY = process.env.BACKUP_MASTER_KEY || 'test-backup-master-key-for-backup-route';

const routes = require('../dist/src/routes/backup') as typeof import('../src/routes/backup');
const { setDb } = require('../dist/src/state') as typeof import('../src/state');

const call = (key: string, req: FixtureValue, userId: string) =>
  routes[key].handler(req, userId, {} as FixtureValue, {} as FixtureValue) as Promise<FixtureValue>;

function requestFor(pathname: FixtureValue) {
  return {
    headers: { host: 'localhost' },
    url: pathname,
    params: { id: 'job-1' },
  };
}

test('encrypted download requires recovery-password metadata', async (t) => {
  setDb({
    async execute(sql: string) {
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
  } as FixtureValue);
  t.after(() => setDb(null));

  const result = await call('GET /api/backup/jobs/:id/download',
    requestFor('/api/backup/jobs/job-1/download') as FixtureValue,
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
  } as FixtureValue);
  t.after(() => setDb(null));

  const result = await call('GET /api/backup/jobs/:id/download',
    requestFor('/api/backup/jobs/job-1/download') as FixtureValue,
    'user-1'
  );

  assert.equal(result.status, 409);
  assert.match(result.error, /Reveal and save/);
});

test('password reveal reports missing recovery metadata for an existing job', async (t) => {
  let rolledBack = false;
  const connection = {
    async beginTransaction() {},
    async execute(sql: string) {
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
  } as FixtureValue);
  t.after(() => setDb(null));

  const result = await call('POST /api/backup/jobs/:id/recovery-password/reveal',
    requestFor('/api/backup/jobs/job-1/recovery-password/reveal') as FixtureValue,
    'user-1'
  );

  assert.equal(result.status, 409);
  assert.match(result.error, /metadata is missing/i);
  assert.equal(rolledBack, true);
});


test('backup capabilities expose the shared recoverable sections and the Download-mail choice to signed-in callers', async (t) => {
  const spec = routes['GET /api/backup/capabilities'];
  assert.equal(spec.auth, 'user');
  setDb({ async execute(sql: string) { assert.match(sql, /mail_accounts/); return [[{ id: 'download-deletes' }]]; } } as FixtureValue);
  t.after(() => setDb(null));
  const capabilities = await call('GET /api/backup/capabilities', {}, 'owner');
  assert.equal(capabilities.enabled, true);
  assert.equal(capabilities.version, 7);
  assert.deepEqual(capabilities.sections.map((section: FixtureValue) => section.id), Object.keys((require('../dist/src/services/backup-catalog') as typeof import('../src/services/backup-catalog')).SECTION_POLICIES));
  assert.ok(capabilities.exclusions.some((value: string) => /Other users/.test(value)));
  // An account that deletes mail at the provider holds the only copy, so its mail is always included.
  assert.deepEqual(capabilities.download_mail, { value: true, forced: false, reason: 'Accounts that delete mail at the provider always include their downloaded mail.', forced_account_ids: ['download-deletes'] });
});
