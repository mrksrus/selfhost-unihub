import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { setDb } = require('../dist/src/state') as typeof import('../src/state');
const { buildBackupForUser, importBackupForUser, validateBackupPayload } = require('../dist/src/services/backup') as typeof import('../src/services/backup');
const { normalizeBackupPayload } = require('../dist/src/services/backup-format') as typeof import('../src/services/backup-format');
const { BACKUP_VERSION } = require('../dist/src/services/backup-format') as typeof import('../src/services/backup-format');
const { SECTION_POLICIES, TABLE_POLICIES } = require('../dist/src/services/backup-catalog') as typeof import('../src/services/backup-catalog');

function database(t: import('node:test').TestContext, execute: FixtureValue = async () => [[]]) {
  const calls: FixtureValue[] = [];
  const connection = {
    query: async (sql: string) => calls.push({ sql, params: [] }),
    execute: async (sql: string, params: FixtureValue[] = []) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT e.id, e.folder')) {
        return [inserted(calls, 'emails').filter((row: FixtureValue) => params.includes(row.id)).map((row: FixtureValue) => {
          const folder = inserted(calls, 'mail_folders').find((folder: string) => (folder as FixtureValue).slug === row.folder);
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
  setDb({ getConnection: async () => connection, execute: async () => [[]] } as FixtureValue);
  t.after(() => setDb(null));
  return calls;
}

function inserted(calls: FixtureValue, table: string) {
  return calls.filter((call: FixtureValue) => call.sql.startsWith(`INSERT INTO ${table} (`)).map((call: FixtureValue) => {
    const columns = call.sql.match(/\((.*?)\)\s*VALUES/s)[1].replaceAll('`', '').split(',').map((item: FixtureValue) => item.trim());
    return Object.fromEntries(columns.map((column: string, index: number) => [column, call.params[index]]));
  });
}

const archive = (data: FixtureValue) => ({ app: 'unihub', version: 3, data, files: [] });

test('contacts-only schema 3 export never reads mail, credentials or recording tables', async t => {
  const calls = database(t, (async (sql: string) => sql.includes('FROM contacts ')
    ? [[{ id: 'contact', user_id: 'owner', first_name: 'Local' }]] : [[]]));
  const backup = await buildBackupForUser('owner', { sections: 'contacts', includeFileData: false });
  assert.equal(backup.version, BACKUP_VERSION);
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

test('older archives with Tetris scores or a games section import without the removed Games data', async t => {
  const calls = database(t);
  const scores = [{ user_id: 'source', score: 5000, lines: 25, level: 4, achieved_at: '2026-09-01T10:00:00Z' }];
  const contacts = [{ id: 'contact', user_id: 'source', first_name: 'Local' }];
  const validation = validateBackupPayload(archive({ tetris_scores: scores, contacts }));
  assert.equal(validation.valid, true);
  assert.match(validation.warnings.join(' '), /Tetris scores from the removed Games module were skipped/);
  assert.ok(!Object.hasOwn(normalizeBackupPayload(archive({ tetris_scores: scores })).data, 'tetris_scores'));
  const result = await importBackupForUser('destination', archive({ tetris_scores: scores, contacts }), { mode: 'apply', sections: ['contacts', 'games'] });
  assert.equal(result.valid, true);
  assert.equal(inserted(calls, 'contacts').length, 1);
  assert.equal(calls.some(call => call.sql.includes('tetris_scores')), false);
  assert.equal(Object.hasOwn(SECTION_POLICIES, 'games'), false);
});

test('older archives with Notes, note files or a notes section import everything else', async t => {
  const calls = database(t);
  const crypto = (require('node:crypto') as typeof import('node:crypto'));
  const bytes = Buffer.from('Example note attachment');
  const notes = {
    notes: [{ id: 'note', user_id: 'source', title: 'Example', body: 'Text', revision: 2 }],
    note_revisions: [{ id: 'revision', user_id: 'source', note_id: 'note', revision: 1, title: 'Example', body: '' }],
    note_attachments: [{ id: 'file', user_id: 'source', note_id: 'note', filename: 'a.txt', content_type: 'text/plain', size_bytes: bytes.length }],
    note_links: [{ user_id: 'source', note_id: 'note', linked_note_id: 'note' }],
  };
  const contacts = [{ id: 'contact', user_id: 'source', first_name: 'Local' }];
  const old = () => ({ ...archive({ ...notes, contacts }), files: [{ kind: 'note_attachment', id: 'file', archive_path: 'files/notes/file',
    sha256: crypto.createHash('sha256').update('different').digest('hex'), data_base64: bytes.toString('base64') }] });
  const validation = validateBackupPayload(old());
  assert.equal(validation.valid, true, validation.errors.join('\n'));
  assert.deepEqual(validation.warnings, ['Notes from the removed Notes module were skipped.']);
  const normalized = normalizeBackupPayload(old());
  assert.deepEqual(Object.keys(normalized.data), ['contacts']);
  assert.deepEqual(normalized.files, []);
  const result = await importBackupForUser('destination', old(), { mode: 'apply', sections: ['contacts', 'notes'] });
  assert.equal(result.valid, true);
  assert.equal(inserted(calls, 'contacts').length, 1);
  assert.equal(calls.some(call => /\b(INTO|FROM|UPDATE) `?note/.test(call.sql)), false);
  assert.equal(Object.hasOwn(SECTION_POLICIES, 'notes'), false);
});

test('unknown required tables, fields, file kinds and unsafe transcript rows fail review', () => {
  for (const data of [{ future_notes: [] }, { contacts: [{ id: 'a', future_required: 'data' }] },
    { recording_transcription_jobs: [{ id: 'a', recording_id: 'r', status: 'queued', transcript_text: 'text' }] },
    { email_attachments: [{ id: 'missing-file', email_id: 'email' }] }]) {
    assert.equal(validateBackupPayload(archive(data)).valid, false);
  }
  assert.equal(validateBackupPayload({ ...archive({}), files: [{ id: 'a', kind: 'future-file', missing: true }] }).valid, false);
});

test('older protected-folder mail uses legacy defaults without inventing Legacy assignments', () => {
  const old = { ...archive({ emails: ['inbox', 'sent', 'drafts', 'trash'].map((folder, index) => ({ id: String(index), folder })) }), version: 2 };
  const normalized = normalizeBackupPayload(old);
  assert.ok(normalized.data.emails!.every((row) => row.is_legacy === false && row.filing_account_id === null));
  assert.ok(!Object.hasOwn(normalized.data, 'tetris_scores'));
  assert.equal(TABLE_POLICIES.recording_transcription_jobs.fieldPolicies.transcript_text, 'preserve');
  assert.ok(SECTION_POLICIES.recordings.tables.includes('recording_transcription_jobs'));
});
