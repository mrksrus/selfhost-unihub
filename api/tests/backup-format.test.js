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
  assert.deepEqual(normalized.data.emails, original.data.emails.map(row => ({ ...row, filing_account_id: null, is_legacy: false, remote_folder: 'INBOX', remote_uid: null, remote_uidvalidity: null, remote_missing: false })));
  assert.equal(normalized.manifest_sha256, undefined);
  normalized.data.mail_accounts[0].encrypted_password = 'destination ciphertext';
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
  for (const version of [undefined, null, 0, 4, 999, '1', '2', 1.5]) {
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
    ['old', 1, 1, 1], ['v2', 2, 2, 1], ['current', 3, 3, 1], ['future', 4, 4, 1],
    ['mismatch', 1, 2, 1], ['future-archive', 2, 2, 2],
  ]) {
    const filePath = path.join(directory, name + '.zip');
    const metadata = { app: 'unihub', format: ZIP_BACKUP_FORMAT, format_version: archiveVersion };
    const data = Buffer.from(JSON.stringify({ ...metadata, version: dataVersion, data: { contacts: [] }, files: [] }));
    await writeZip([
      { name: 'manifest.json', data: JSON.stringify({ ...metadata, version: manifestVersion }) },
      { name: 'data/backup.json', data },
      { name: 'checksums.json', data: JSON.stringify({ algorithm: 'sha256', entries: { 'data/backup.json': sha256Buffer(data) } }) },
    ], filePath);
    const bytes = await fs.readFile(filePath);
    if (['old', 'v2', 'current'].includes(name)) {
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
  for (const version of [1, 2, 3]) {
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
      if (version === 3 && name !== 'valid') {
        assert.throws(() => backupFromZipBuffer(bytes), /requires valid SHA-256 metadata/);
        await assert.rejects(backupFromZipFile(filePath), /requires valid SHA-256 metadata/);
      } else {
        assert.equal(backupFromZipBuffer(bytes).backup.version, version);
        assert.equal((await backupFromZipFile(filePath)).backup.version, version);
      }
    }
    if (version === 3) {
      for (const digest of ['not-a-sha256', '0'.repeat(64)]) {
        const filePath = path.join(directory, `bad-${digest}.zip`);
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
