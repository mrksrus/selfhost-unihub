const test = require('node:test');
const assert = require('node:assert/strict');
const { SECTION_POLICIES, TABLE_POLICIES, REFERENCES, FILE_POLICIES, WRITE_PATHS, assertRecoveryCatalog, getRestoreSectionForWrite } = require('../src/services/backup-catalog');
const { assertArchiveRelationships } = require('../src/services/data-inventory');

test('adding declared data still fails if its export section, parent or file handling is missing', () => {
  assert.doesNotThrow(() => assertRecoveryCatalog());
  const sections = structuredClone(SECTION_POLICIES);
  sections.games.tables = [];
  assert.throws(() => assertRecoveryCatalog({ sections }), /tetris_scores is not exported/);
  const references = structuredClone(REFERENCES);
  delete references.emails.filing_account_id;
  assert.throws(() => assertRecoveryCatalog({ references }), /missing reference emails.filing_account_id/);
  const files = { ...FILE_POLICIES, recording: { table: 'recordings', column: 'title' } };
  assert.throws(() => assertRecoveryCatalog({ files }), /missing file policy recordings.storage_path/);
  const tables = { ...TABLE_POLICIES, future_notes: { ...TABLE_POLICIES.contacts } };
  assert.throws(() => assertRecoveryCatalog({ tables }), /future_notes is not exported/);
  assert.throws(() => assertRecoveryCatalog({ writePaths: { ...WRITE_PATHS, games: [] } }), /games has no write protection/);
});

test('changing an existing database FK cannot silently reuse a different restore mapping', () => {
  const relation = { table_name: 'emails', column_name: 'filing_account_id', parent_table: 'mail_accounts', parent_column: 'id' };
  assertArchiveRelationships([relation]);
  assert.throws(() => assertArchiveRelationships([{ ...relation, parent_table: 'contacts' }]), /Unclassified recovery relationship/);
  assert.throws(() => assertArchiveRelationships([{ ...relation, column_name: 'future_account_id' }]), /Unclassified recovery relationship/);
});

test('restore write routing covers section endpoints and specific destructive settings', () => {
  for (const [section, paths] of Object.entries(WRITE_PATHS)) for (const path of paths) {
    assert.equal(getRestoreSectionForWrite(path), section);
    assert.equal(getRestoreSectionForWrite(path + '/child'), section);
  }
  assert.equal(getRestoreSectionForWrite('/api/settings/account'), '*');
  assert.equal(getRestoreSectionForWrite('/api/backup/restore-jobs/id/cancel'), null);
  assert.equal(getRestoreSectionForWrite('/api/contacts-unrelated'), null);
});
