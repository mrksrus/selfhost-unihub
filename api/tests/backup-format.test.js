const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  BACKUP_VERSION, ZIP_BACKUP_FORMAT, ZIP_BACKUP_FORMAT_VERSION,
  normalizeBackupPayload, validateBackupVersionFields, validateArchiveVersionFields,
} = require('../src/services/backup-format');
const { backupFromZipBuffer, backupFromZipFile, sha256Buffer, validateBackupPayload } = require('../src/services/backup');
const { writeZip } = require('../src/services/export-jobs');

test('v1 backups migrate automatically without fabricating mappings or mutating input', () => {
  const original = { app: 'unihub', version: 1, manifest_sha256: 'old hash',
    data: { mail_accounts: [{ id: 'account', encrypted_password: 'old ciphertext' }], emails: [{ id: 'mail', folder: 'shared', mail_account_id: 'account', source_folder: 'INBOX' }] }, files: [] };
  const saved = structuredClone(original);
  const normalized = normalizeBackupPayload(original);
  assert.equal(normalized.version, BACKUP_VERSION);
  assert.equal(normalized.source_backup_version, 1);
  assert.deepEqual(normalized.data.mail_folder_remote_boxes, []);
  assert.deepEqual(normalized.data.emails, original.data.emails);
  assert.equal(normalized.manifest_sha256, undefined);
  normalized.data.mail_accounts[0].encrypted_password = 'destination ciphertext';
  assert.deepEqual(original, saved);
  assert.match(validateBackupVersionFields(original).warnings[0], /does not include provider-folder mappings/);
});

test('v2 backup reader retains provider mappings and section-only backups stay scoped', () => {
  const source = { app: 'unihub', version: 2, data: { mail_folder_remote_boxes: [{ folder_id: 'folder', mail_account_id: 'account', remote_name: 'Entwürfe' }] }, files: [] };
  assert.deepEqual(normalizeBackupPayload(source).data, source.data);
  assert.deepEqual(normalizeBackupPayload({ app: 'unihub', version: 1, data: { contacts: [] }, files: [] }).data, { contacts: [] });
  assert.deepEqual(validateBackupVersionFields(source), { errors: [], warnings: [] });
});

test('future, missing and malformed data versions fail before normalization', () => {
  for (const version of [undefined, null, 0, 3, 999, '1', '2', 1.5]) {
    const backup = { app: 'unihub', version, data: {}, files: [] };
    assert.equal(validateBackupPayload(backup).valid, false);
    assert.throws(() => normalizeBackupPayload(backup), /Unsupported backup data version/);
  }
});

test('archive and payload must agree on supported versions', () => {
  const metadata = { app: 'unihub', version: 2, format: ZIP_BACKUP_FORMAT, format_version: ZIP_BACKUP_FORMAT_VERSION };
  validateArchiveVersionFields(metadata, metadata);
  for (const changed of [
    { version: 1 }, { version: 3 }, { format_version: 2 },
    { format_version: undefined }, { format: 'unknown' }, { app: 'other' },
  ]) assert.throws(() => validateArchiveVersionFields({ ...metadata, ...changed }, metadata), /version|format|app/);
});

test('both ZIP import paths reject unknown or inconsistent versions with intact checksums', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-version-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [name, manifestVersion, dataVersion, archiveVersion] of [
    ['old', 1, 1, 1], ['current', 2, 2, 1], ['future', 3, 3, 1],
    ['mismatch', 1, 2, 1], ['future-archive', 2, 2, 2],
  ]) {
    const filePath = path.join(directory, name + '.zip');
    const metadata = { app: 'unihub', format: ZIP_BACKUP_FORMAT, format_version: archiveVersion };
    const data = Buffer.from(JSON.stringify({ ...metadata, version: dataVersion, data: { contacts: [] }, files: [] }));
    await writeZip([
      { name: 'manifest.json', data: JSON.stringify({ ...metadata, version: manifestVersion }) },
      { name: 'data/backup.json', data },
      { name: 'checksums.json', data: JSON.stringify({ entries: { 'data/backup.json': sha256Buffer(data) } }) },
    ], filePath);
    const bytes = await fs.readFile(filePath);
    if (['old', 'current'].includes(name)) {
      assert.equal(backupFromZipBuffer(bytes).backup.version, dataVersion);
      assert.equal((await backupFromZipFile(filePath)).backup.version, dataVersion);
    } else {
      assert.throws(() => backupFromZipBuffer(bytes), /version|format/);
      await assert.rejects(backupFromZipFile(filePath), /version|format/);
    }
  }
});
