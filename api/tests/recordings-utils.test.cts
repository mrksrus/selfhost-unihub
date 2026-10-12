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
} = require('../dist/src/services/recordings') as typeof import('../src/services/recordings');

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
