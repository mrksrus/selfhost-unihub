import type { FixtureValue } from './helpers/test-types.cts';
import type {} from 'node:module';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const {
  MAX_CHUNK_BYTES,
  getConvertedMp3Path,
  isMp3Audio,
  isPathUnderRoot,
  normalizeCategory,
  normalizeMetadata,
  normalizeSha256,
  normalizeTags,
  replaceFilenameExtension,
  serializeRecording,
  updateRecording,
  MAX_CHORDS_LENGTH,
} = require('../dist/src/services/recordings') as typeof import('../src/services/recordings');

// B-26: the Music page said "Chords saved" while the stored sheet was cut at 10,000 characters.
test('an edit refuses chords over the limit instead of saving them cut short', async () => {
  const long = 'C  G  Am  F\n'.repeat(1000);
  // Refused before the recording is looked up or anything is written.
  const refused = await updateRecording('user-1', 'recording-1', { category: 'music', metadata: { chords: long } }) as { error?: string; status?: number; code?: string };
  assert.equal(refused.status, 400);
  assert.equal(refused.code, 'CHORDS_TOO_LONG');
  assert.match(refused.error ?? '', /up to 10,000 characters long; these have 11,999/);
  // Reading (and an upload already queued on a device) keeps the cap.
  assert.equal(normalizeMetadata({ chords: long }).chords?.length, MAX_CHORDS_LENGTH);
  assert.deepEqual(normalizeMetadata(JSON.stringify({ chords: '  Em  D  ' })), { chords: 'Em  D' });
});

test('recording path guard allows root descendants only', () => {
  assert.equal(isPathUnderRoot('/app/uploads/recordings/user-1/file.webm'), true);
  assert.equal(isPathUnderRoot('/app/uploads/recordings'), true);
  assert.equal(isPathUnderRoot('/app/uploads/recordings/../mail/file.eml'), false);
  assert.equal(isPathUnderRoot('/tmp/file.webm'), false);
});

test('recording MP3 helpers identify formats and keep conversion paths under the recording root', () => {
  assert.equal(isMp3Audio('audio/mpeg', 'recording.bin'), true);
  assert.equal(isMp3Audio('application/octet-stream', 'recording.mp3'), true);
  assert.equal(isMp3Audio('audio/webm', 'recording.webm'), false);
  assert.equal(replaceFilenameExtension('meeting.webm', '.mp3'), 'meeting.mp3');
  assert.equal(
    getConvertedMp3Path('/app/uploads/recordings/user-1/recording.webm'),
    '/app/uploads/recordings/user-1/recording.converted-v2.mp3'
  );
  assert.throws(() => getConvertedMp3Path('/tmp/recording.webm'), /Invalid recording path/);
});
