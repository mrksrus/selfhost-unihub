const test = require('node:test');
const assert = require('node:assert/strict');
const { setDb } = require('../src/state');
const { validateRestoreRows } = require('../src/services/backup-ownership');
const { buildBackupForUser, remapRestoredInlineAttachments, restoreMailFolderRemoteBox,
  findExistingEmailForRestore, assertBackupMetadataSize } = require('../src/services/backup');
const { BACKUP_METADATA_LIMITS } = require('../src/services/backup-format');

test('new backup metadata must fit the same limits enforced by restore readers', () => {
  for (const [name, maximum] of Object.entries(BACKUP_METADATA_LIMITS)) {
    assert.doesNotThrow(() => assertBackupMetadataSize(name, maximum));
    assert.throws(() => assertBackupMetadataSize(name, maximum + 1), error => error.status === 413 && /export smaller sections/.test(error.message));
  }
});

test('backup metadata uses one consistent read-only snapshot including owned remote mappings', async (t) => {
  const calls = [];
  const connection = {
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM users ')) return [[{ id: 'user', email: 'user@example.test' }]];
      if (sql.includes('FROM mail_folder_remote_boxes')) return [[{ folder_id: 'folder', mail_account_id: 'account', remote_name: 'Projects/2026' }]];
      return [[]];
    },
    async commit() { calls.push({ sql: 'COMMIT' }); },
    async rollback() { calls.push({ sql: 'ROLLBACK' }); },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  setDb({ getConnection: async () => connection, execute: () => { throw new Error('Pool reads cannot provide a shared snapshot'); } });
  t.after(() => setDb(null));
  const backup = await buildBackupForUser('user', { includeFileData: false });
  assert.equal(backup.version, 2);
  assert.equal(backup.producer.name, 'UniHub');
  assert.equal(backup.data.mail_folder_remote_boxes[0].remote_name, 'Projects/2026');
  assert.deepEqual(calls.slice(0, 2).map(item => item.sql), [
    'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
    'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
  ]);
  assert.deepEqual(calls.slice(-2).map(item => item.sql), ['COMMIT', 'RELEASE']);
  const mappingRead = calls.find(item => item.sql.includes('FROM mail_folder_remote_boxes'));
  assert.match(mappingRead.sql, /f.user_id = \? AND a.user_id = \?/);
  assert.deepEqual(mappingRead.params, ['user', 'user']);
});

test('snapshot query failure rolls back and releases the dedicated connection', async (t) => {
  const calls = [];
  setDb({ getConnection: async () => ({
    async execute(sql) { if (sql.includes('FROM contacts')) throw new Error('read failed'); return [[]]; },
    async commit() { calls.push('commit'); },
    async rollback() { calls.push('rollback'); },
    release() { calls.push('release'); },
  }) });
  t.after(() => setDb(null));
  await assert.rejects(buildBackupForUser('user'), /read failed/);
  assert.deepEqual(calls, ['rollback', 'release']);
});

test('inline attachment URLs follow the restored IDs without replacing similar or unrelated IDs', () => {
  const html = '<img src="/api/mail/attachments/old"><img src="/api/mail/attachments/old-long">'
    + '<a href="https://mail.example.test/api/mail/attachments/old?download=1">download</a>'
    + '<img src="/api/mail/attachments/unrelated">';
  assert.equal(remapRestoredInlineAttachments(html, new Map([['old', 'new']])),
    '<img src="/api/mail/attachments/new"><img src="/api/mail/attachments/old-long">'
    + '<a href="https://mail.example.test/api/mail/attachments/new?download=1">download</a>'
    + '<img src="/api/mail/attachments/unrelated">');
  assert.equal(remapRestoredInlineAttachments(null, new Map()), null);
});

test('distinct source emails cannot both claim the same existing Message-ID copy', async () => {
  const rows = [{ id: 'first' }, { id: 'second' }];
  const connection = { execute: async (sql) => sql.includes('message_id = ?') ? [rows] : [[]] };
  const row = { id: 'source', message_id: '<same@example.test>' };
  assert.equal(await findExistingEmailForRestore(connection, row, 'user', 'account', new Set()), 'first');
  assert.equal(await findExistingEmailForRestore(connection, row, 'user', 'account', new Set(['first'])), 'second');
  assert.equal(await findExistingEmailForRestore(connection, row, 'user', 'account', new Set(['first', 'second'])), null);
});

test('exact provider location is matched before an ambiguous Message-ID on repeated restore', async () => {
  const calls = [];
  const connection = { async execute(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('AND source_folder = ?')) return [[{ id: 'correct-location' }]];
    if (sql.includes('message_id = ?')) return [[{ id: 'different-copy' }]];
    return [[]];
  } };
  const matched = await findExistingEmailForRestore(connection, {
    id: 'old-id', message_id: '<same@example.test>', source_folder: 'INBOX', imap_uid: 42, imap_uidvalidity: 123,
  }, 'user', 'account');
  assert.equal(matched, 'correct-location');
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /AND imap_uidvalidity = \?/);
  assert.deepEqual(calls[1].params, ['user', 'account', 'INBOX', 42, 123]);
});

test('provider-folder restore remaps both parents and uses an ownership-scoped lookup', async () => {
  const calls = [];
  const connection = { async execute(sql, params) { calls.push({ sql, params }); return [[]]; } };
  await restoreMailFolderRemoteBox(connection, 'user', { folder_id: 'old-folder', mail_account_id: 'old-account', remote_name: 'Projects/2026' },
    new Map([['old-folder', 'new-folder']]), new Map([['old-account', 'new-account']]), 'replace', []);
  assert.match(calls[0].sql, /f.user_id = \? AND a.user_id = \?/);
  assert.match(calls[1].sql, /^INSERT INTO mail_folder_remote_boxes/);
  assert.deepEqual(calls[1].params, ['new-folder', 'new-account', 'Projects/2026']);
  assert.ok(calls.every(call => !call.sql.includes('ON DUPLICATE')));
});

test('provider-folder restore never steals another existing local folder mapping', async () => {
  const calls = [];
  const connection = { async execute(sql, params) {
    calls.push({ sql, params });
    return [[{ folder_id: 'different-folder', mail_account_id: 'new-account', remote_name: 'Projects' }]];
  } };
  const row = { folder_id: 'old-folder', mail_account_id: 'old-account', remote_name: 'Projects' };
  const folderMap = new Map([['old-folder', 'new-folder']]);
  const accountMap = new Map([['old-account', 'new-account']]);
  for (const mode of ['keep_existing', 'keep_both']) {
    const warnings = [];
    await restoreMailFolderRemoteBox(connection, 'user', row, folderMap, accountMap, mode, warnings);
    assert.equal(warnings.length, 1);
  }
  await assert.rejects(restoreMailFolderRemoteBox(connection, 'user', row, folderMap, accountMap, 'replace', []), /already mapped/);
  assert.ok(calls.every(call => call.sql.startsWith('SELECT')));
});

test('provider-folder restore rejects missing or foreign parents before inserting', async () => {
  const calls = [];
  const connection = { async execute(sql, params) { calls.push({ sql, params }); return [[]]; } };
  await assert.rejects(restoreMailFolderRemoteBox(connection, 'user', {
    folder_id: 'foreign-folder', mail_account_id: 'account', remote_name: 'Projects',
  }, new Map(), new Map([['account', 'owned-account']]), 'replace', []), /unavailable mail_folders/);
  assert.ok(calls.every(call => call.sql.startsWith('SELECT')));
  assert.deepEqual(calls[0].params, ['foreign-folder', 'user']);
});

test('invalid or duplicate provider-folder references are rejected during preview', () => {
  const row = { folder_id: 'folder', mail_account_id: 'account', remote_name: 'Projects' };
  assert.deepEqual(validateRestoreRows({ mail_folder_remote_boxes: [row] }), []);
  assert.match(validateRestoreRows({ mail_folder_remote_boxes: [row, { ...row, folder_id: 'different' }] }).join(' '), /duplicate/);
  assert.match(validateRestoreRows({ mail_folder_remote_boxes: [{ ...row, remote_name: 'bad\r\nname' }] }).join(' '), /invalid/);
});
