const test = require('node:test');
const assert = require('node:assert/strict');
const {
  crc32Buffer,
  normalizeSections,
} = require('../src/services/export-jobs');

test('normalizeSections returns all sections for full export', () => {
  assert.deepEqual(normalizeSections('full'), ['contacts', 'calendar', 'todo', 'mail', 'recordings', 'settings']);
});

test('normalizeSections drops unknown and duplicate sections', () => {
  assert.deepEqual(normalizeSections(['mail', 'mail', 'unknown', 'recordings']), ['mail', 'recordings']);
});

test('crc32Buffer matches known CRC32 value', () => {
  assert.equal((crc32Buffer(Buffer.from('hello')) ^ -1) >>> 0, 0x3610a686);
});
