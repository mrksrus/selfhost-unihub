const test = require('node:test');
const assert = require('node:assert/strict');
const { setDb } = require('../src/state');
const { buildBackupForUser, importBackupForUser, validateBackupPayload } = require('../src/services/backup');
const { normalizeBackupPayload } = require('../src/services/backup-format');
const { SECTION_POLICIES, TABLE_POLICIES } = require('../src/services/backup-catalog');

function database(t, execute = async () => [[]]) {
  const calls = [];
  const connection = {
    query: async sql => calls.push({ sql, params: [] }),
    execute: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT e.id, e.folder')) {
        return [inserted(calls, 'emails').filter(row => params.includes(row.id)).map(row => {
          const folder = inserted(calls, 'mail_folders').find(folder => folder.slug === row.folder);
          return { ...row, folder_id: folder?.id, slug: folder?.slug, folder_account_id: folder?.mail_account_id, is_system: folder?.is_system };
        })];
      }
      return execute(sql, params);
    },
    beginTransaction: async () => calls.push({ sql: 'BEGIN' }),
    commit: async () => calls.push({ sql: 'COMMIT' }),
    rollback: async () => calls.push({ sql: 'ROLLBACK' }),
    release() {},
  };
  setDb({ getConnection: async () => connection, execute: async () => [[]] });
  t.after(() => setDb(null));
  return calls;
}

function inserted(calls, table) {
  return calls.filter(call => call.sql.startsWith(`INSERT INTO ${table} (`)).map(call => {
    const columns = call.sql.match(/\((.*?)\)\s*VALUES/s)[1].replaceAll('`', '').split(',').map(item => item.trim());
    return Object.fromEntries(columns.map((column, index) => [column, call.params[index]]));
  });
}

const archive = data => ({ app: 'unihub', version: 3, data, files: [] });

test('contacts-only schema 3 export never reads mail, credentials, games or recording tables', async t => {
  const calls = database(t, async sql => sql.includes('FROM contacts ')
    ? [[{ id: 'contact', user_id: 'owner', first_name: 'Local' }]] : [[]]);
  const backup = await buildBackupForUser('owner', { sections: 'contacts', includeFileData: false });
  assert.equal(backup.version, 3);
  assert.deepEqual(Object.keys(backup.data), ['contacts']);
  const selects = calls.filter(call => call.sql.startsWith('SELECT'));
  assert.equal(selects.length, 1);
  assert.match(selects[0].sql, /SELECT b.`id`, b.`user_id`/);
  assert.doesNotMatch(selects[0].sql, /SELECT \*/);
  assert.ok(calls.findIndex(call => call.sql.startsWith('START TRANSACTION')) < calls.indexOf(selects[0]));
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('schema 3 import remaps source, filing, folders, overrides and recovery history together', async t => {
  const calls = database(t);
  const backup = archive({
    mail_accounts: [
      { id: 'source', email_address: 'source@example.test', provider: 'custom' },
      { id: 'filing', email_address: 'filing@example.test', provider: 'custom' },
    ],
    mail_folders: [{ id: 'folder', slug: 'filing-archive', display_name: 'Saved', is_system: false, mail_account_id: 'filing', special_use: 'archive' }],
    mail_sender_rules: [{ id: 'rule', mail_account_id: 'filing', match_type: 'email', match_value: 'sender@example.test', target_folder: 'filing-archive', priority: 0, is_active: 0 }],
    emails: [
      { id: 'recovered', mail_account_id: 'source', filing_account_id: 'filing', is_legacy: false, folder: 'filing-archive', source_folder: 'Original', imap_uid: 77, imap_uidvalidity: 9, from_address: 'sender@example.test', to_addresses: [] },
      { id: 'unresolved', mail_account_id: 'source', filing_account_id: null, is_legacy: true, folder: 'legacy-box', from_address: 'sender@example.test', to_addresses: [] },
    ],
    mail_folder_rule_overrides: [{ rule_id: 'rule', mail_account_id: 'filing', target_folder: 'filing-archive' }],
    mail_folder_recovery_items: [{ email_id: 'recovered', source_account_id: 'source', original_folder: 'old-box', original_filing_account_id: 'deleted-account', target_folder: 'filing-archive', target_account_id: 'filing', action: 'inbox', created_at: '2026-09-01T10:00:00.000Z' }],
    mail_folder_reconciliations: [{ mail_account_id: 'source', inventory: ['INBOX', 'Original'], previous_mappings: [
      { folder_id: 'folder', mail_account_id: 'source', remote_name: 'Original' },
      { folder_id: 'deleted-folder', mail_account_id: 'source', remote_name: 'Deleted' },
    ], completed_at: '2026-09-01T11:00:00.000Z' }],
  });
  const original = structuredClone(backup);
  const result = await importBackupForUser('destination', backup, { mode: 'apply', sections: 'mail', conflict_mode: 'replace' });
  assert.equal(result.valid, true);
  assert.deepEqual(backup, original);
  // The account importer deliberately disables server deletion in its SQL.
  const accountCalls = calls.filter(call => call.sql.includes('INSERT INTO mail_accounts'));
  const [source, filing] = accountCalls.map(call => call.params[0]);
  assert.notEqual(source, 'source');
  assert.notEqual(filing, 'filing');
  const [folder] = inserted(calls, 'mail_folders');
  assert.equal(folder.mail_account_id, filing);
  assert.equal(folder.special_use, 'archive');
  assert.ok(calls.indexOf(accountCalls[1]) < calls.findIndex(call => call.sql.startsWith('INSERT INTO mail_folders')));
  const [email, unresolved] = inserted(calls, 'emails');
  assert.equal(email.mail_account_id, source);
  assert.equal(email.filing_account_id, filing);
  assert.equal(email.source_folder, 'Original');
  assert.equal(email.imap_uid, 77);
  assert.equal(email.is_legacy, 0);
  assert.equal(unresolved.filing_account_id, null);
  assert.equal(unresolved.is_legacy, 1);
  const [rule] = inserted(calls, 'mail_sender_rules');
  assert.equal(rule.priority, 0);
  assert.equal(rule.is_active, 0);
  assert.deepEqual(inserted(calls, 'mail_folder_rule_overrides'), [{ rule_id: rule.id, mail_account_id: filing, target_folder: 'filing-archive' }]);
  const [journal] = inserted(calls, 'mail_folder_recovery_items');
  assert.equal(journal.email_id, email.id);
  assert.equal(journal.source_account_id, source);
  assert.equal(journal.original_filing_account_id, null);
  assert.match(result.warnings.join(' '), /historical reference was cleared/);
  assert.equal(journal.target_account_id, filing);
  assert.equal(journal.created_at, '2026-09-01 10:00:00');
  const [marker] = inserted(calls, 'mail_folder_reconciliations');
  assert.equal(marker.mail_account_id, source);
  assert.deepEqual(JSON.parse(marker.previous_mappings), [
    { folder_id: folder.id, mail_account_id: source, remote_name: 'Original' },
    { folder_id: null, mail_account_id: source, remote_name: 'Deleted', archive_folder_id: 'deleted-folder' },
  ]);
  assert.equal(marker.completed_at, '2026-09-01 11:00:00');
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('saved Tetris personal best restores with target ownership and achieved date', async t => {
  const calls = database(t);
  const result = await importBackupForUser('destination', archive({ tetris_scores: [
    { user_id: 'source', score: 5000, lines: 25, level: 4, achieved_at: '2026-09-01T10:00:00Z' },
  ] }), { mode: 'apply', sections: 'games' });
  assert.equal(result.valid, true);
  assert.deepEqual(inserted(calls, 'tetris_scores'), [{ user_id: 'destination', score: 5000, lines: 25, level: 4, achieved_at: '2026-09-01 10:00:00' }]);
});

test('unknown required tables, fields, file kinds and unsafe game or transcript rows fail review', () => {
  for (const data of [{ future_notes: [] }, { contacts: [{ id: 'a', future_required: 'data' }] },
    { tetris_scores: [{ score: -1, lines: 1, level: 1 }] },
    { recording_transcription_jobs: [{ id: 'a', recording_id: 'r', status: 'queued', transcript_text: 'text' }] },
    { email_attachments: [{ id: 'missing-file', email_id: 'email' }] }]) {
    assert.equal(validateBackupPayload(archive(data)).valid, false);
  }
  assert.equal(validateBackupPayload({ ...archive({}), files: [{ id: 'a', kind: 'future-file', missing: true }] }).valid, false);
});

test('older protected-folder mail uses legacy defaults without inventing Legacy assignments', () => {
  const old = { ...archive({ emails: ['inbox', 'sent', 'drafts', 'trash'].map((folder, index) => ({ id: String(index), folder })) }), version: 2 };
  const normalized = normalizeBackupPayload(old);
  assert.ok(normalized.data.emails.every(row => row.is_legacy === false && row.filing_account_id === null));
  assert.ok(!Object.hasOwn(normalized.data, 'tetris_scores'));
  assert.equal(TABLE_POLICIES.recording_transcription_jobs.fieldPolicies.transcript_text, 'preserve');
  assert.ok(SECTION_POLICIES.recordings.tables.includes('recording_transcription_jobs'));
});
