const test = require('node:test');
const assert = require('node:assert/strict');
const { setDb } = require('../src/state');
const { normalizeNote, decodeAttachment, getNote, mutateNote, MAX_ATTACHMENT_BYTES } = require('../src/services/notes');
const { validateNotesData } = require('../src/services/notes-recovery');
const { validateBackupPayload } = require('../src/services/backup');
const { TABLE_POLICIES, normalizeBackupSections, getRestoreSectionForWrite } = require('../src/services/backup-catalog');

test('notes text, ownership links and attachment bounds are explicit', () => {
  assert.deepEqual(normalizeNote({ title: ' Note ', body: '<script>plain text</script>', linked_note_ids: ['a', 'a'] }), { title: 'Note', body: '<script>plain text</script>', linked_note_ids: ['a'] });
  assert.throws(() => normalizeNote({ title: '', body: '' }), /title/);
  assert.throws(() => normalizeNote({ title: 'A', body: 'a'.repeat(524289) }), /512/);
  assert.throws(() => normalizeNote({ title: 'A', body: '', linked_note_ids: ['../other'] }), /linked/);
  const attachment = decodeAttachment({ filename: '../bad\n.html', content_type: 'text/html', content_base64: Buffer.from('<script>').toString('base64') });
  assert.equal(attachment.content_type, 'application/octet-stream');
  assert.doesNotMatch(attachment.filename, /[/\n]/);
  assert.throws(() => decodeAttachment({ content_base64: '%%%=' }), /encoding/);
  assert.throws(() => decodeAttachment({ content_base64: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }), /2 MiB/);
});
test('owner scoped notes reject foreign IDs and stale writes before mutation', async t => {
  const calls = [];
  const connection = { beginTransaction: async () => {}, rollback: async () => {}, release() {}, execute: async (sql, params) => { calls.push({ sql, params }); return [[{ id: 'n', title: 'A', body: '', revision: 2, trashed_at: null }]]; } };
  setDb({ execute: async (sql, params) => { assert.match(sql, /id = \? AND user_id = \?/); assert.deepEqual(params, ['foreign', 'owner']); return [[]]; }, getConnection: async () => connection });
  t.after(() => setDb(null));
  await assert.rejects(getNote('owner', 'foreign'), error => error.status === 404);
  await assert.rejects(mutateNote('owner', 'n', { expected_revision: 1 }, 'trash'), error => error.status === 409 && error.code === 'NOTE_REVISION_CONFLICT');
  assert.equal(calls.length, 1); assert.match(calls[0].sql, /FOR UPDATE/);
});
function data() {
  return { notes: [{ id: 'n', origin_key: 'origin', user_id: 'u', title: 'Note', body: 'Current', revision: 1, trashed_at: null }], note_revisions: [{ id: 'r', user_id: 'u', note_id: 'n', title: 'Note', body: 'Current', revision: 1 }], note_links: [], note_attachments: [] };
}
test('recovery requires current history and rejects foreign parents and dangling links', () => {
  assert.deepEqual(validateNotesData(data()), []);
  let value = data(); value.note_revisions = []; assert.match(validateNotesData(value).join(), /missing/);
  value = data(); value.note_revisions[0].user_id = 'foreign'; assert.match(validateNotesData(value).join(), /parent/);
  value = data(); value.note_links.push({ user_id: 'u', note_id: 'n', linked_note_id: 'other' }); assert.match(validateNotesData(value).join(), /link/);
  value = data(); value.note_revisions[0].body = 'Wrong'; assert.match(validateNotesData(value).join(), /does not match/);
  value = data(); value.note_attachments.push({ id: 'a', user_id: 'u', note_id: 'n', filename: 'test.bin', content_type: 'application/octet-stream', size_bytes: 1, storage_path: '/old' });
  assert.equal(validateBackupPayload({ app: 'unihub', version: 3, data: value, files: [] }).valid, false);
});
test('module preference corruption fails recovery and notes stay in full backup with migration four policy', () => {
  const result = validateBackupPayload({ app: 'unihub', version: 3, data: { user_settings: [{ user_id: 'u', setting_key: 'module_preferences', setting_value: '{bad' }] }, files: [] });
  assert.equal(result.valid, false); assert.match(result.errors.join(), /module preferences/);
  assert.ok(normalizeBackupSections('full').includes('notes'));
  assert.equal(getRestoreSectionForWrite('/api/notes/n/attachments'), 'notes');
  for (const name of ['notes', 'note_revisions', 'note_attachments', 'note_links']) for (const field of TABLE_POLICIES[name].columns) assert.equal(TABLE_POLICIES[name].introducedIn[field], 4);
});
