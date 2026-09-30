const test = require('node:test');
const assert = require('node:assert/strict');

function setRequireStub(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

test('admin storage route returns aggregate storage metadata only', async (t) => {
  const routePath = require.resolve('../src/routes/admin');
  const statePath = require.resolve('../src/state');
  const authPath = require.resolve('../src/auth');
  const mailPath = require.resolve('../src/services/mail');
  const recordingsPath = require.resolve('../src/services/recordings');
  const exportJobsPath = require.resolve('../src/services/export-jobs');
  const originalRoute = require.cache[routePath];
  const originalState = require.cache[statePath];
  const originalAuth = require.cache[authPath];
  const originalMail = require.cache[mailPath];
  const originalRecordings = require.cache[recordingsPath];
  const originalExportJobs = require.cache[exportJobsPath];

  t.after(() => {
    if (originalRoute) require.cache[routePath] = originalRoute;
    else delete require.cache[routePath];
    if (originalState) require.cache[statePath] = originalState;
    else delete require.cache[statePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
    if (originalMail) require.cache[mailPath] = originalMail;
    else delete require.cache[mailPath];
    if (originalRecordings) require.cache[recordingsPath] = originalRecordings;
    else delete require.cache[recordingsPath];
    if (originalExportJobs) require.cache[exportJobsPath] = originalExportJobs;
    else delete require.cache[exportJobsPath];
  });

  delete require.cache[routePath];
  setRequireStub(authPath, {
    isAdmin: async () => true,
    hashPassword: async () => 'hash',
    getSignupMode: async () => 'disabled',
  });
  setRequireStub(mailPath, { MAIL_RAW_STORAGE_ROOT: '/tmp/unihub-missing-mail-raw' });
  setRequireStub(recordingsPath, { RECORDINGS_ROOT: '/tmp/unihub-missing-recordings' });
  setRequireStub(exportJobsPath, { BACKUPS_ROOT: '/tmp/unihub-missing-backups' });
  setRequireStub(statePath, {
    db: {
      execute: async (sql) => {
        if (sql.startsWith('SELECT id, email')) {
          return [[{ id: 'user-1', email: 'user@example.com', full_name: 'Test User', is_active: 1 }]];
        }
        if (sql.includes('FROM users')) return [[{ total: 2, active: 1 }]];
        if (sql.includes('FROM emails)')) return [[{ accounts: 1, emails: 3 }]];
        if (sql.includes('FROM email_attachments')) return [[{ files: 4, bytes: 1000 }]];
        if (sql.includes('raw_storage_path')) return [[{ emails_with_raw: 3 }]];
        if (sql.includes('FROM recordings')) return [[{ files: 2, bytes: 500 }]];
        if (sql.includes('FROM data_export_jobs')) return [[{ jobs: 1, ready_jobs: 1, bytes: 250 }]];
        if (sql.includes('FROM contacts')) return [[{ contacts: 5 }]];
        if (sql.includes('FROM calendar_events')) return [[{ events: 6 }]];
        return [[]];
      },
    },
  });

  const routes = require('../src/routes/admin');
  const result = await routes['GET /api/admin/storage']({}, 'admin-user');

  assert.equal(result.storage.totals.users, 2);
  assert.equal(result.storage.totals.emails, 3);
  assert.equal(result.storage.totals.contacts, 5);
  assert.equal(result.storage.sections.some(section => section.label === 'Mail attachments'), true);
  assert.equal(result.storage.users[0].email, 'user@example.com');
  assert.equal(result.storage.users[0].bytes, 0);
});
