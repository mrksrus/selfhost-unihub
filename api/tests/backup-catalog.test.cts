import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { SECTION_POLICIES, TABLE_POLICIES, REFERENCES, FILE_POLICIES, WRITE_PATHS, assertRecoveryCatalog, getRestoreSectionForWrite } = require('../dist/src/services/backup-catalog') as typeof import('../src/services/backup-catalog');
const { assertArchiveRelationships } = require('../dist/src/services/data-inventory') as typeof import('../src/services/data-inventory');

test('adding declared data still fails if its export section, parent or file handling is missing', () => {
  assert.doesNotThrow(() => assertRecoveryCatalog());
  const sections = structuredClone(SECTION_POLICIES);
  sections.contacts.tables = [];
  assert.throws(() => assertRecoveryCatalog({ sections }), /contacts is not exported/);
  const references = structuredClone(REFERENCES);
  delete (references.emails as Record<string, string>).filing_account_id;
  assert.throws(() => assertRecoveryCatalog({ references }), /missing reference emails.filing_account_id/);
  const files = { ...FILE_POLICIES, recording: { table: 'recordings', column: 'title' } };
  assert.throws(() => assertRecoveryCatalog({ files }), /missing file policy recordings.storage_path/);
  const tables = { ...TABLE_POLICIES, future_notes: { ...TABLE_POLICIES.contacts } };
  assert.throws(() => assertRecoveryCatalog({ tables }), /future_notes is not exported/);
  assert.throws(() => assertRecoveryCatalog({ writePaths: { ...WRITE_PATHS, contacts: [] } }), /contacts has no write protection/);
});

test('changing an existing database FK cannot silently reuse a different restore mapping', () => {
  const relation = { table_name: 'emails', column_name: 'filing_account_id', parent_table: 'mail_accounts', parent_column: 'id' };
  assertArchiveRelationships([relation]);
  assert.throws(() => assertArchiveRelationships([{ ...relation, parent_table: 'contacts' }]), /Unclassified recovery relationship/);
  assert.throws(() => assertArchiveRelationships([{ ...relation, column_name: 'future_account_id' }]), /Unclassified recovery relationship/);
});

test('restore write routing covers section endpoints and specific destructive settings', () => {
  for (const [section, paths] of Object.entries(WRITE_PATHS)) for (const path of (paths)) {
    assert.equal(getRestoreSectionForWrite(path), section);
    assert.equal(getRestoreSectionForWrite(path + '/child'), section);
  }
  assert.equal(getRestoreSectionForWrite('/api/settings/account'), '*');
  assert.equal(getRestoreSectionForWrite('/api/backup/restore-jobs/id/cancel'), null);
  assert.equal(getRestoreSectionForWrite('/api/contacts-unrelated'), null);
});

test('account settings are a request-only section that exports accounts without content', () => {
  const { normalizeBackupRequest, normalizeBackupSections } = require('../dist/src/services/backup-catalog') as typeof import('../src/services/backup-catalog');
  assert.deepEqual(normalizeBackupRequest(['accounts']), { requested: ['accounts'], sections: ['calendar', 'mail'], accountOnlySections: ['calendar', 'mail'] });
  assert.deepEqual(normalizeBackupRequest(['accounts', 'settings']), { requested: ['settings', 'accounts'], sections: ['settings', 'calendar', 'mail'], accountOnlySections: ['calendar', 'mail'] });
  // A complete section already carries its accounts.
  assert.deepEqual(normalizeBackupRequest(['mail', 'accounts']), { requested: ['mail', 'accounts'], sections: ['calendar', 'mail'], accountOnlySections: ['calendar'] });
  assert.deepEqual(normalizeBackupRequest(['full', 'accounts']).accountOnlySections, []);
  assert.deepEqual(normalizeBackupRequest(['mail', 'calendar', 'accounts']).requested, ['calendar', 'mail']);
  assert.throws(() => normalizeBackupRequest(['games']), /Select at least one/);
  assert.throws(() => normalizeBackupRequest(['accounts', 'unknown']), /Unsupported backup section/);
  // Restore scope and locks: account settings write both account tables.
  assert.deepEqual(normalizeBackupSections(['settings', 'accounts']), ['settings', 'calendar', 'mail']);
});

test('an account settings archive may carry only remote account rows', () => {
  const { validateBackupPayload } = require('../dist/src/services/backup-validate') as typeof import('../src/services/backup-validate');
  const { BACKUP_VERSION } = require('../dist/src/services/backup-format') as typeof import('../src/services/backup-format');
  const mailAccount = { id: 'm1', user_id: 'u1', email_address: 'mail@example.test', imap_host: '8.8.8.8', sync_mode: 'sync', sync_window_days: 90 };
  const calendarAccount = { id: 'c1', user_id: 'u1', provider: 'caldav', base_url: 'https://8.8.8.8/dav/' };
  const archive = (extra: FixtureValue) => ({ app: 'unihub', version: BACKUP_VERSION, files: [], account_only_sections: ['calendar', 'mail'],
    ...extra, data: { mail_accounts: [mailAccount], calendar_accounts: [calendarAccount], ...extra.data } });
  assert.deepEqual(validateBackupPayload(archive({})).errors, []);
  assert.match(validateBackupPayload(archive({ data: { emails: [{ id: 'e1', user_id: 'u1', mail_account_id: 'm1' }] } })).errors.join('\n'), /must not contain emails rows/);
  assert.match(validateBackupPayload(archive({ data: { calendar_calendars: [{ id: 'k1', user_id: 'u1', account_id: 'c1' }] } })).errors.join('\n'), /must not contain calendar_calendars rows/);
  assert.match(validateBackupPayload(archive({ data: { calendar_accounts: [{ ...calendarAccount, provider: 'local' }] } })).errors.join('\n'), /only CalDAV/);
  assert.match(validateBackupPayload(archive({ account_only_sections: ['contacts'] })).errors.join('\n'), /account settings list is invalid/);
  assert.match(validateBackupPayload(archive({ files: [{ kind: 'raw_email', id: 'e1', sha256: 'x', data_base64: '' }] })).errors.join('\n'), /must not contain mail files/);
});
