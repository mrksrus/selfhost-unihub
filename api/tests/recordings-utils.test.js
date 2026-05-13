const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_CHUNK_BYTES,
  isPathUnderRoot,
  normalizeTags,
} = require('../src/services/recordings');

test('normalizeTags trims, deduplicates case-insensitively, and caps tag count', () => {
  const tags = normalizeTags([' Meeting ', 'meeting', 'Client', '', '  idea  ', ...Array.from({ length: 30 }, (_, index) => `tag-${index}`)]);
  assert.deepEqual(tags.slice(0, 3), ['Meeting', 'Client', 'idea']);
  assert.equal(tags.length, 20);
});

test('recording path guard allows root descendants only', () => {
  assert.equal(isPathUnderRoot('/app/uploads/recordings/user-1/file.webm'), true);
  assert.equal(isPathUnderRoot('/app/uploads/recordings'), true);
  assert.equal(isPathUnderRoot('/app/uploads/recordings/../mail/file.eml'), false);
  assert.equal(isPathUnderRoot('/tmp/file.webm'), false);
});

test('recording chunk limit stays below request body budget', () => {
  assert.ok(MAX_CHUNK_BYTES <= 768 * 1024);
});
