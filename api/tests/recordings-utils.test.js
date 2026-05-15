const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_CHUNK_BYTES,
  isPathUnderRoot,
  normalizeCategory,
  normalizeMetadata,
  normalizeTags,
  serializeRecording,
} = require('../src/services/recordings');

test('normalizeTags trims, deduplicates case-insensitively, and caps tag count', () => {
  const tags = normalizeTags([' Meeting ', 'meeting', 'Client', '', '  idea  ', ...Array.from({ length: 30 }, (_, index) => `tag-${index}`)]);
  assert.deepEqual(tags.slice(0, 3), ['Meeting', 'Client', 'idea']);
  assert.equal(tags.length, 20);
});

test('normalizeCategory accepts fixed recording categories only', () => {
  assert.equal(normalizeCategory('music'), 'music');
  assert.equal(normalizeCategory(' Memory '), 'memory');
  assert.equal(normalizeCategory('unknown'), 'none');
  assert.equal(normalizeCategory(''), 'none');
});

test('normalizeMetadata keeps V1 music chords only', () => {
  assert.deepEqual(normalizeMetadata({ chords: '  C G Am F  ', ignored: true }), { chords: 'C G Am F' });
  assert.deepEqual(normalizeMetadata('{"chords":"Dm G C"}'), { chords: 'Dm G C' });
  assert.deepEqual(normalizeMetadata({ chords: '   ' }), {});
  assert.deepEqual(normalizeMetadata('not json'), {});
});

test('serializeRecording defaults category and recorded_at for legacy rows', () => {
  const createdAt = new Date('2026-05-01T10:00:00.000Z');
  const recording = serializeRecording({
    id: 'recording-1',
    user_id: 'user-1',
    title: 'Legacy',
    description: null,
    original_filename: null,
    content_type: 'audio/webm',
    size_bytes: 12,
    duration_seconds: null,
    source: 'recorded',
    tags: 'music',
    created_at: createdAt,
    updated_at: createdAt,
  });

  assert.equal(recording.category, 'none');
  assert.equal(recording.recorded_at, createdAt.toISOString());
  assert.deepEqual(recording.metadata, {});
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
