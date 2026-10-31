import type { FixtureValue } from './helpers/test-types.cts';
import type {} from 'node:module';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const {
  BACKUP_VERSION, ZIP_BACKUP_FORMAT, ZIP_BACKUP_FORMAT_VERSION,
  normalizeBackupPayload, validateBackupVersionFields, validateArchiveVersionFields,
} = require('../dist/src/services/backup-format') as typeof import('../src/services/backup-format');
const { backupFromZipBuffer, backupFromZipFile, sha256Buffer, validateBackupPayload } = require('../dist/src/services/backup') as typeof import('../src/services/backup');
const { writeZip } = require('../dist/src/services/export-jobs') as typeof import('../src/services/export-jobs');

test('v1 backups migrate automatically without fabricating mappings or mutating input', () => {
  const original = { app: 'unihub', version: 1, manifest_sha256: 'old hash',
    data: { mail_accounts: [{ id: 'account', encrypted_password: 'old ciphertext' }], emails: [{ id: 'mail', folder: 'shared', mail_account_id: 'account', source_folder: 'INBOX' }] }, files: [] };
  const saved = structuredClone(original);
  const normalized = normalizeBackupPayload(original);
  assert.equal(normalized.version, BACKUP_VERSION);
  assert.equal(normalized.source_backup_version, 1);
  assert.deepEqual(normalized.data.mail_folder_remote_boxes, []);
  assert.deepEqual(normalized.data.emails, original.data.emails.map(row => ({ ...row, filing_account_id: null, is_legacy: false, remote_folder: 'INBOX', remote_uid: null, remote_uidvalidity: null, remote_missing: false })));
  assert.equal(normalized.manifest_sha256, undefined);
  normalized.data.mail_accounts![0].encrypted_password = 'destination ciphertext';
  assert.deepEqual(original, saved);
  assert.match(validateBackupVersionFields(original).warnings[0], /does not include provider-folder mappings/);
});

test('v2 backup reader retains provider mappings and section-only backups stay scoped', () => {
  const source = { app: 'unihub', version: 2, data: { mail_folder_remote_boxes: [{ folder_id: 'folder', mail_account_id: 'account', remote_name: 'Entwürfe' }] }, files: [] };
  assert.deepEqual(normalizeBackupPayload(source).data, source.data);
  assert.deepEqual(normalizeBackupPayload({ app: 'unihub', version: 1, data: { contacts: [] }, files: [] }).data, { contacts: [] });
  assert.deepEqual(validateBackupVersionFields(source).errors, []);
});

test('future, missing and malformed data versions fail before normalization', () => {
  for (const version of [undefined, null, 0, 7, 999, '1', '2', 1.5]) {
    const backup = { app: 'unihub', version, data: {}, files: [] };
    assert.equal(validateBackupPayload(backup as FixtureValue).valid, false);
    assert.throws(() => normalizeBackupPayload(backup as FixtureValue), /Unsupported backup data version/);
  }
  // What an older release says about a newer archive, from the readers it has.
  assert.deepEqual(validateBackupPayload({ app: 'unihub', version: 7, data: {}, files: [] } as FixtureValue).errors,
    ['Unsupported backup data version: 7. This UniHub version reads versions 1, 2, 3, 4, 5 and 6; a newer backup may need a newer UniHub release.']);
});

test('archive and payload must agree on supported versions', () => {
  const metadata = { app: 'unihub', version: 2, format: ZIP_BACKUP_FORMAT, format_version: ZIP_BACKUP_FORMAT_VERSION };
  validateArchiveVersionFields(metadata, metadata as FixtureValue);
  for (const changed of [
    { version: 1 }, { version: 3 }, { format_version: 2 },
    { format_version: undefined }, { format: 'unknown' }, { app: 'other' },
  ]) assert.throws(() => validateArchiveVersionFields({ ...metadata, ...changed }, metadata as FixtureValue), /version|format|app/);
});

test('both ZIP import paths reject unknown or inconsistent versions with intact checksums', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-version-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [name, manifestVersion, dataVersion, archiveVersion] of [
    ['old', 1, 1, 1], ['v2', 2, 2, 1], ['v3', 3, 3, 1], ['v4', 4, 4, 1], ['v5', 5, 5, 1], ['current', 6, 6, 1], ['future', 7, 7, 1],
    ['mismatch', 1, 2, 1], ['future-archive', 2, 2, 2],
  ] as const) {
    const filePath = path.join(directory, name + '.zip');
    const metadata = { app: 'unihub', format: ZIP_BACKUP_FORMAT, format_version: archiveVersion };
    const data = Buffer.from(JSON.stringify({ ...metadata, version: dataVersion, data: { contacts: [] }, files: [] }));
    await writeZip([
      { name: 'manifest.json', data: JSON.stringify({ ...metadata, version: manifestVersion }) },
      { name: 'data/backup.json', data },
      { name: 'checksums.json', data: JSON.stringify({ algorithm: 'sha256', entries: { 'data/backup.json': sha256Buffer(data) } }) },
    ], filePath);
    const bytes = await fs.readFile(filePath);
    if (['old', 'v2', 'v3', 'v4', 'v5', 'current'].includes(name)) {
      assert.equal(backupFromZipBuffer(bytes).backup.version, dataVersion);
      assert.equal((await backupFromZipFile(filePath)).backup.version, dataVersion);
    } else {
      assert.throws(() => backupFromZipBuffer(bytes), /version|format/);
      await assert.rejects(backupFromZipFile(filePath), /version|format/);
    }
  }
});

test('schema 3 ZIP readers require complete SHA-256 metadata before import', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-metadata-integrity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const version of [1, 2, 3, 4]) {
    const metadata = { app: 'unihub', version, format: ZIP_BACKUP_FORMAT, format_version: ZIP_BACKUP_FORMAT_VERSION };
    const data = Buffer.from(JSON.stringify({ ...metadata, data: { contacts: [] }, files: [] }));
    const digest = sha256Buffer(data);
    const cases = [
      ['missing-file', null],
      ['missing-digest', { algorithm: 'sha256', entries: {} }],
      ['empty-digest', { algorithm: 'sha256', entries: { 'data/backup.json': '' } }],
      ['missing-algorithm', { entries: { 'data/backup.json': digest } }],
      ['unsupported-algorithm', { algorithm: 'md5', entries: { 'data/backup.json': digest } }],
      ['valid', { algorithm: 'sha256', entries: { 'data/backup.json': digest } }],
    ];
    for (const [name, checksums] of cases) {
      const filePath = path.join(directory, `${version}-${name}.zip`);
      const entries = [{ name: 'manifest.json', data: JSON.stringify(metadata) }, { name: 'data/backup.json', data }];
      if (checksums) entries.push({ name: 'checksums.json', data: JSON.stringify(checksums) });
      await writeZip(entries, filePath);
      const bytes = await fs.readFile(filePath);
      if (version >= 3 && name !== 'valid') {
        assert.throws(() => backupFromZipBuffer(bytes), /requires valid SHA-256 metadata/);
        await assert.rejects(backupFromZipFile(filePath), /requires valid SHA-256 metadata/);
      } else {
        assert.equal(backupFromZipBuffer(bytes).backup.version, version);
        assert.equal((await backupFromZipFile(filePath)).backup.version, version);
      }
    }
    if (version >= 3) {
      for (const digest of ['not-a-sha256', '0'.repeat(64)]) {
        const filePath = path.join(directory, `${version}-bad-${digest}.zip`);
        await writeZip([
          { name: 'manifest.json', data: JSON.stringify(metadata) }, { name: 'data/backup.json', data },
          { name: 'checksums.json', data: JSON.stringify({ algorithm: 'sha256', entries: { 'data/backup.json': digest } }) },
        ], filePath);
        const bytes = await fs.readFile(filePath);
        assert.throws(() => backupFromZipBuffer(bytes), /metadata|Checksum mismatch/);
        await assert.rejects(backupFromZipFile(filePath), /metadata|Checksum mismatch/);
      }
    }
  }
});

test('schema 5 holds each archive to the fields of its own version, and contact photos to their names', () => {
  const user = 'user';
  const contact = { id: 'c1', user_id: user, first_name: 'Zoë' };
  const archive = (version: number, data: FixtureValue, files: FixtureValue[] = []) => ({ app: 'unihub', version, data, files });
  const errors = (version: number, data: FixtureValue, files?: FixtureValue[]) => validateBackupPayload(archive(version, data, files)).errors;
  // The fixed fields up to schema 4, the vCard model from schema 5 on.
  assert.deepEqual(errors(4, { contacts: [{ ...contact, email: 'a@example.test', avatar_url: null }] }), []);
  assert.deepEqual(errors(5, { contacts: [{ ...contact, uid: 'urn:uuid:c1', middle_name: 'M' }], contact_values: [{ id: 'v1', contact_id: 'c1', user_id: user, kind: 'email', value: 'a@example.test' }] }), []);
  assert.deepEqual(errors(5, { contacts: [{ ...contact, email: 'a@example.test' }] }), ['Unsupported backup field: contacts.email']);
  assert.deepEqual(errors(4, { contacts: [{ ...contact, uid: 'urn:uuid:c1' }] }), ['Unsupported backup field: contacts.uid']);
  assert.deepEqual(errors(3, { contact_values: [] }), ['Unsupported backup table: contact_values']);
  assert.deepEqual(errors(2, { contact_photos: [] }), ['Unsupported backup table: contact_photos']);
  // A photo file is named by its SHA-256, is a JPEG and no larger than a stored photo.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const name = sha256Buffer(jpeg);
  const file = (bytes: Buffer, extra: FixtureValue = {}) => ({ kind: 'contact_photo', id: sha256Buffer(bytes), sha256: sha256Buffer(bytes), size_bytes: bytes.length, data_base64: bytes.toString('base64'), ...extra });
  const photo = (sha: string) => ({ contacts: [contact], contact_photos: [{ contact_id: 'c1', user_id: user, sha256: sha, thumb_sha256: sha, width: 1, height: 1, bytes: 7 }] });
  assert.deepEqual(errors(5, photo(name), [file(jpeg)]), []);
  assert.deepEqual(errors(4, {}, [file(jpeg)]), ['Unsupported backup file kind: contact_photo']);
  assert.match(errors(5, photo(name), [file(jpeg, { id: sha256Buffer(Buffer.from('x')) })]).join('\n'), /does not match its name/);
  assert.match(errors(5, photo(name), [file(jpeg, { data_base64: Buffer.from('not the photo').toString('base64') })]).join('\n'), /Checksum mismatch for file contact_photo/);
  const png = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1');
  assert.match(errors(5, photo(sha256Buffer(png)), [file(png)]).join('\n'), /is not a stored contact photo/);
  assert.match(errors(5, photo(name), []).join('\n'), new RegExp(`has no referenced file: contact_photo:${name}`));
});

test('the schema 5 reader turns fixed contact fields into values as upgrade 22 does, deterministically', () => {
  const old = { app: 'unihub', version: 4, files: [], data: { contacts: [{ id: 'c1', user_id: 'u', first_name: 'Li', email: null, email2: '  ', email3: 'x@example.test',
    phone: 'same', phone2: 'same', phone3: '', avatar_url: 'https://example.test/a.png' }] } };
  const saved = structuredClone(old);
  const first = normalizeBackupPayload(structuredClone(old));
  assert.deepEqual(old, saved);
  assert.equal(first.version, 6);
  assert.deepEqual(first.data.contacts, [{ id: 'c1', user_id: 'u', first_name: 'Li', uid: 'urn:uuid:c1' }]);
  assert.deepEqual((first.data.contact_values as FixtureValue[]).map(row => [row.kind, row.position, row.legacy_slot, row.value, row.label]),
    [['email', 0, 1, 'x@example.test', ''], ['phone', 0, 1, 'same', ''], ['phone', 1, 2, 'same', '']]);
  assert.deepEqual(normalizeBackupPayload(structuredClone(old)).data.contact_values, first.data.contact_values, 'Same archive, same value ids');
  assert.equal(new Set((first.data.contact_values as FixtureValue[]).map(row => row.id)).size, 3);
  // A schema 5 archive passes unchanged.
  const current = { app: 'unihub', version: 5, files: [], data: { contacts: [{ id: 'c1', user_id: 'u', first_name: 'Li', uid: 'urn:uuid:own' }], contact_values: [] } };
  assert.deepEqual(normalizeBackupPayload(structuredClone(current)).data, current.data);
});

test('task order arrives with schema 6: an older schema may not carry it, and an older archive restores in date order', () => {
  const row = { user_id: 'u', item_key: 'a'.repeat(64), calendar_id: null, event_id: 'e1', remote_uid: null, recurrence_id: '', sort_rank: 5, updated_at: '2026-10-30 10:00:00' };
  const archive = (version: number) => ({ app: 'unihub', version, files: [], data: { calendar_events: [{ id: 'e1' }], task_order: [row] } }) as FixtureValue;
  assert.deepEqual(validateBackupPayload(archive(6)).errors, []);
  assert.deepEqual(validateBackupPayload(archive(5)).errors, ['Unsupported backup table: task_order']);
  // A schema 5 archive is read unchanged: no order, so every task keeps its date's place.
  const old = { app: 'unihub', version: 5, files: [], data: { calendar_events: [] } };
  const read = normalizeBackupPayload(structuredClone(old));
  assert.equal(read.version, 6);
  assert.equal(read.source_backup_version, 5);
  assert.deepEqual(read.data, old.data);
});
