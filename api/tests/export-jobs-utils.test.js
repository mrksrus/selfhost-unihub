const test = require('node:test');
const assert = require('node:assert/strict');
const {
  crc32Buffer,
  normalizeSections,
  parseRequestedSections,
  writeZip,
} = require('../src/services/export-jobs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('normalizeSections returns all sections for full export', () => {
  assert.deepEqual(normalizeSections('full'), ['contacts', 'calendar', 'todo', 'mail', 'recordings', 'settings']);
});

test('normalizeSections drops unknown and duplicate sections', () => {
  assert.deepEqual(normalizeSections(['mail', 'mail', 'unknown', 'recordings']), ['mail', 'recordings']);
});

test('parseRequestedSections accepts JSON arrays returned as strings', () => {
  assert.deepEqual(parseRequestedSections('["contacts","mail"]'), ['contacts', 'mail']);
});

test('parseRequestedSections accepts parsed JSON arrays from mysql', () => {
  assert.deepEqual(parseRequestedSections(['contacts', 'calendar', 'mail']), ['contacts', 'calendar', 'mail']);
});

test('parseRequestedSections accepts legacy comma-separated values', () => {
  assert.deepEqual(parseRequestedSections('contacts,calendar,mail'), ['contacts', 'calendar', 'mail']);
});

test('crc32Buffer matches known CRC32 value', () => {
  assert.equal((crc32Buffer(Buffer.from('hello')) ^ -1) >>> 0, 0x3610a686);
});

test('writeZip preserves long backup filenames including extensions', async () => {
  const { readZipEntries } = require('../src/services/backup');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-zip-name-'));
  const zipPath = path.join(dir, 'backup.zip');
  const longName = 'files/mail-attachments/0a6fbcc5-351e-47cf-92a4-7b7193dbd401-8d2608f7-8d3e-4078-912d-5ea7198aa2d8-0a6fbcc5-351e-47cf-92a4-7b7193dbd401-logo-gray.png';

  await writeZip([{ name: longName, data: 'image' }], zipPath);

  const entries = readZipEntries(await fs.readFile(zipPath));
  assert.equal(entries.has(longName), true);
});

test('writeZip streams file-backed entries into the archive', async () => {
  const { readZipEntries } = require('../src/services/backup');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-zip-file-'));
  const sourcePath = path.join(dir, 'source.eml');
  const zipPath = path.join(dir, 'backup.zip');
  const contents = Buffer.from('file-backed raw email', 'utf8');
  await fs.writeFile(sourcePath, contents);

  await writeZip([{
    name: 'files/mail-raw/email-1.eml',
    filePath: sourcePath,
  }], zipPath);

  const entries = readZipEntries(await fs.readFile(zipPath));
  assert.deepEqual(entries.get('files/mail-raw/email-1.eml'), contents);
});
