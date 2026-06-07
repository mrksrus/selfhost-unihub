const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  backupFromZipFile,
  backupFromZipBuffer,
  canonicalJson,
  normalizeBackupImportSections,
  normalizeMysqlDateTime,
  readBackupFileEntry,
  sha256Buffer,
  validateBackupPayload,
  writeBackupJsonFile,
} = require('../src/services/backup');

test('canonicalJson orders object keys deterministically', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ z: [{ b: true, a: false }] }), '{"z":[{"a":false,"b":true}]}');
});

test('validateBackupPayload accepts matching file checksums', () => {
  const buffer = Buffer.from('hello backup', 'utf8');
  const backup = {
    app: 'unihub',
    version: 1,
    data: { contacts: [] },
    files: [{
      kind: 'email_attachment',
      id: 'file-1',
      sha256: sha256Buffer(buffer),
      data_base64: buffer.toString('base64'),
    }],
  };
  const validation = validateBackupPayload(backup);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, []);
});

test('validateBackupPayload rejects tampered file content', () => {
  const backup = {
    app: 'unihub',
    version: 1,
    data: { contacts: [] },
    files: [{
      kind: 'email_attachment',
      id: 'file-1',
      sha256: sha256Buffer(Buffer.from('original', 'utf8')),
      data_base64: Buffer.from('tampered', 'utf8').toString('base64'),
    }],
  };
  const validation = validateBackupPayload(backup);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /Checksum mismatch/);
});

test('normalizeBackupImportSections maps full and todo scopes', () => {
  assert.deepEqual(normalizeBackupImportSections('full'), ['settings', 'contacts', 'calendar', 'mail', 'recordings']);
  assert.deepEqual(normalizeBackupImportSections(['mail', 'todo', 'unknown']), ['mail', 'calendar']);
});

test('normalizeMysqlDateTime converts backup ISO dates for MySQL columns', () => {
  assert.equal(normalizeMysqlDateTime('2026-05-16T16:10:27.000Z'), '2026-05-16 16:10:27');
  assert.equal(normalizeMysqlDateTime('2026-05-16 16:10:27'), '2026-05-16 16:10:27');
  assert.equal(normalizeMysqlDateTime(null), null);
  assert.equal(normalizeMysqlDateTime(null, new Date('2026-05-16T16:10:27.000Z')), '2026-05-16 16:10:27');
});

test('readBackupFileEntry keeps archive files file-backed when requested', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-backup-file-'));
  const filePath = path.join(dir, 'message.eml');
  const contents = Buffer.from('raw email contents', 'utf8');
  await fs.writeFile(filePath, contents);

  const entry = await readBackupFileEntry({
    kind: 'raw_email',
    id: 'email-1',
    storagePath: filePath,
    rootPath: dir,
    includeData: false,
  });

  assert.equal(entry.source_path, filePath);
  assert.equal(entry.size_bytes, contents.length);
  assert.equal(entry.sha256, sha256Buffer(contents));
  assert.equal(Object.hasOwn(entry, 'data_base64'), false);
});

test('writeBackupJsonFile writes large backup metadata incrementally', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-backup-json-'));
  const filePath = path.join(dir, 'backup.json');
  const largeBody = 'x'.repeat(2 * 1024 * 1024);
  const payload = {
    app: 'unihub',
    data: {
      emails: [
        { id: 'email-1', body_text: largeBody },
        { id: 'email-2', body_text: 'small' },
      ],
    },
    files: [{ kind: 'raw_email', id: 'email-1' }],
  };

  await writeBackupJsonFile(payload, filePath);

  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(parsed.data.emails[0].body_text.length, largeBody.length);
  assert.deepEqual(parsed.files, payload.files);
});

test('backupFromZipBuffer accepts restorable backup ZIP with file checksums', async () => {
  const { writeZip } = require('../src/services/export-jobs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-backup-'));
  const zipPath = path.join(dir, 'backup.zip');
  const fileBuffer = Buffer.from('attachment bytes', 'utf8');
  const backup = {
    app: 'unihub',
    version: 1,
    format: 'unihub-restorable-backup',
    format_version: 1,
    exported_at: '2026-05-15T00:00:00.000Z',
    data: { email_attachments: [] },
    files: [{
      kind: 'email_attachment',
      id: 'attachment-1',
      filename: 'invoice.pdf',
      archive_path: 'files/mail-attachments/attachment-1-invoice.pdf',
      sha256: sha256Buffer(fileBuffer),
      size_bytes: fileBuffer.length,
    }],
  };
  const dataBuffer = Buffer.from(`${JSON.stringify(backup, null, 2)}\n`, 'utf8');
  await writeZip([
    { name: 'manifest.json', data: JSON.stringify({ app: 'unihub', version: 1, format: 'unihub-restorable-backup', format_version: 1 }) },
    { name: 'data/backup.json', data: dataBuffer },
    {
      name: 'checksums.json',
      data: JSON.stringify({
        entries: {
          'data/backup.json': sha256Buffer(dataBuffer),
          'files/mail-attachments/attachment-1-invoice.pdf': sha256Buffer(fileBuffer),
        },
      }),
    },
    { name: 'files/mail-attachments/attachment-1-invoice.pdf', data: fileBuffer },
  ], zipPath);

  const parsed = backupFromZipBuffer(await fs.readFile(zipPath));
  assert.equal(parsed.backup.app, 'unihub');
  assert.equal(parsed.fileBuffersByPath.get('files/mail-attachments/attachment-1-invoice.pdf').toString('utf8'), 'attachment bytes');

  const fileBacked = await backupFromZipFile(zipPath);
  assert.equal(fileBacked.backup.app, 'unihub');
  assert.deepEqual(fileBacked.manifest.sections, undefined);
  assert.equal(
    fileBacked.fileSourcesByPath.get('files/mail-attachments/attachment-1-invoice.pdf').size,
    fileBuffer.length
  );
});

test('backupFromZipFile preserves section backup metadata', async () => {
  const { writeZip } = require('../src/services/export-jobs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-backup-section-'));
  const zipPath = path.join(dir, 'mail-backup.zip');
  const backup = {
    app: 'unihub',
    version: 1,
    format: 'unihub-restorable-backup',
    format_version: 1,
    data: { mail_accounts: [], emails: [] },
    files: [],
  };
  const dataBuffer = Buffer.from(JSON.stringify(backup), 'utf8');
  await writeZip([
    {
      name: 'manifest.json',
      data: JSON.stringify({
        app: 'unihub',
        version: 1,
        format: 'unihub-restorable-backup',
        format_version: 1,
        sections: ['mail'],
      }),
    },
    { name: 'data/backup.json', data: dataBuffer },
    {
      name: 'checksums.json',
      data: JSON.stringify({ entries: { 'data/backup.json': sha256Buffer(dataBuffer) } }),
    },
  ], zipPath);

  const parsed = await backupFromZipFile(zipPath);
  assert.deepEqual(parsed.manifest.sections, ['mail']);
  assert.deepEqual(Object.keys(parsed.backup.data), ['mail_accounts', 'emails']);
});

test('backupFromZipBuffer accepts archives written with legacy truncated filenames', async () => {
  const { writeZip } = require('../src/services/export-jobs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-backup-legacy-'));
  const zipPath = path.join(dir, 'backup.zip');
  const fileBuffer = Buffer.from('png bytes', 'utf8');
  const archivePath = 'files/mail-attachments/0a6fbcc5-351e-47cf-92a4-7b7193dbd401-8d2608f7-8d3e-4078-912d-5ea7198aa2d8-0a6fbcc5-351e-47cf-92a4-7b7193dbd401-logo-gray.png';
  const legacyArchivePath = 'files/mail-attachments/0a6fbcc5-351e-47cf-92a4-7b7193dbd401-8d2608f7-8d3e-4078-912d-5ea7198aa2d8-0a6fbcc5-351e-47cf-92a4-7b7193dbd401-logo-gray';
  const backup = {
    app: 'unihub',
    version: 1,
    format: 'unihub-restorable-backup',
    format_version: 1,
    exported_at: '2026-05-16T00:00:00.000Z',
    data: { email_attachments: [] },
    files: [{
      kind: 'email_attachment',
      id: 'attachment-1',
      filename: 'logo-gray.png',
      archive_path: archivePath,
      sha256: sha256Buffer(fileBuffer),
      size_bytes: fileBuffer.length,
    }],
  };
  const dataBuffer = Buffer.from(`${JSON.stringify(backup, null, 2)}\n`, 'utf8');
  await writeZip([
    { name: 'manifest.json', data: JSON.stringify({ app: 'unihub', version: 1, format: 'unihub-restorable-backup', format_version: 1 }) },
    { name: 'data/backup.json', data: dataBuffer },
    {
      name: 'checksums.json',
      data: JSON.stringify({
        entries: {
          'data/backup.json': sha256Buffer(dataBuffer),
          [archivePath]: sha256Buffer(fileBuffer),
        },
      }),
    },
    { name: legacyArchivePath, data: fileBuffer },
  ], zipPath);

  const parsed = backupFromZipBuffer(await fs.readFile(zipPath));
  assert.equal(parsed.fileBuffersByPath.get(archivePath).toString('utf8'), 'png bytes');
});
