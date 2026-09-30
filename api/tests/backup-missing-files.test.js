const test = require('node:test');
const assert = require('node:assert/strict');
const { setDb } = require('../src/state');
const { importBackupForUser } = require('../src/services/backup');

function installConnection(t, selectRows) {
  const writes = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, params = []) {
      if (sql.startsWith('SELECT')) return [selectRows(sql, params)];
      writes.push({ sql, params });
      return [{ affectedRows: 1 }];
    },
  };
  setDb({ execute: async () => [[]], getConnection: async () => connection });
  t.after(() => setDb(null));
  return writes;
}

test('replacing from a legacy missing-file backup retains existing raw files and attachments', async (t) => {
  const writes = installConnection(t, sql => {
    if (sql.includes('FROM `mail_accounts`')) return [{ id: 'account' }];
    if (sql.includes('FROM emails WHERE id') || sql.includes('FROM `emails`')) return [{ id: 'email' }];
    if (sql.includes('FROM email_attachments WHERE id')) return [{ id: 'attachment' }];
    return [];
  });
  const backup = { app: 'unihub', version: 1, data: {
    emails: [{ id: 'email', mail_account_id: 'account', from_address: 'sender@example.test', to_addresses: [],
      raw_storage_path: '/old/raw.eml', raw_sha256: 'old', import_complete: false, body_text: 'Restored text' }],
    email_attachments: [{ id: 'attachment', email_id: 'email', filename: 'old.png', size_bytes: 10 }],
  }, files: [{ kind: 'raw_email', id: 'email', missing: true }, { kind: 'email_attachment', id: 'attachment', missing: true }] };
  const result = await importBackupForUser('user', backup, { mode: 'apply', sections: ['mail'], conflict_mode: 'replace' });
  assert.equal(result.valid, true);
  const emailWrite = writes.find(call => call.sql.startsWith('UPDATE `emails`'));
  assert.ok(emailWrite);
  assert.doesNotMatch(emailWrite.sql, /`raw_storage_path`|`raw_sha256`|`import_complete`/);
  assert.ok(writes.every(call => !call.sql.includes('email_attachments')));
  assert.ok(result.warnings.some(warning => warning.includes('Kept the existing raw message')));
  assert.ok(result.warnings.some(warning => warning.includes('Kept existing attachment')));
});

test('legacy missing recordings retain existing audio or skip new recordings and their links', async (t) => {
  const writes = installConnection(t, (sql, params) => {
    if (sql.startsWith('SELECT id FROM recordings WHERE id') && params[0] === 'old-recording') return [{ id: 'old-recording' }];
    if (sql.includes('FROM recording_tags WHERE user_id') || sql.includes('FROM `recording_tags`')) return [{ id: 'owned-tag' }];
    return [];
  });
  const backup = { app: 'unihub', version: 1, data: {
    recordings: [{ id: 'old-recording', title: 'Existing' }, { id: 'missing-recording', title: 'Missing' }],
    recording_tags: [{ id: 'source-tag', name: 'Journal' }],
    recording_tag_links: [{ recording_id: 'old-recording', tag_id: 'source-tag' }, { recording_id: 'missing-recording', tag_id: 'source-tag' }],
  }, files: [{ kind: 'recording', id: 'old-recording', missing: true }, { kind: 'recording', id: 'missing-recording', missing: true }] };
  const result = await importBackupForUser('user', backup, { mode: 'apply', sections: ['recordings'], conflict_mode: 'replace' });
  assert.equal(result.valid, true);
  assert.ok(writes.every(call => !/^(?:INSERT INTO recordings|UPDATE `recordings`)/.test(call.sql)));
  const links = writes.filter(call => call.sql.startsWith('INSERT INTO recording_tag_links'));
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].params, ['old-recording', 'owned-tag', 'user']);
  assert.ok(result.warnings.some(warning => warning.includes('Kept existing recording')));
  assert.ok(result.warnings.some(warning => warning.includes('Skipped recording missing-recording and its tag links')));
});
