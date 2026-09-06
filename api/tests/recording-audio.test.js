const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { identifyRecordingAudio, inspectRecordingAudio } = require('../src/services/recording-audio');

const signatures = [
  [Buffer.from('RIFF\x00\x00\x00\x00WAVE', 'binary'), 'audio/wav', 'wav'],
  [Buffer.from('RF64\xff\xff\xff\xffWAVE', 'binary'), 'audio/wav', 'wav'],
  [Buffer.from('ID3\x04\x00\x00'), 'audio/mpeg', 'mp3'],
  [Buffer.from([0xff, 0xfb, 0x90, 0x00]), 'audio/mpeg', 'mp3'],
  [Buffer.from([0xff, 0xf1, 0x50, 0x00]), 'audio/aac', 'aac'],
  [Buffer.from('\x00\x00\x00\x18ftypM4A ', 'binary'), 'audio/mp4', 'mov'],
  [Buffer.from('OggS\x00\x00'), 'audio/ogg', 'ogg'],
  [Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 'audio/webm', 'matroska'],
  [Buffer.from('fLaC'), 'audio/flac', 'flac'],
  [Buffer.from('FORM\x00\x00\x00\x00AIFF', 'binary'), 'audio/aiff', 'aiff'],
];

test('audio signatures choose canonical types and explicit demuxers', () => {
  for (const [header, contentType, demuxer] of signatures) {
    assert.equal(identifyRecordingAudio(header)?.contentType, contentType);
    assert.equal(identifyRecordingAudio(header)?.demuxer, demuxer);
  }
});

test('audio validation rejects active documents, playlists, unrelated files and short input', () => {
  for (const text of ['', 'abc', '<html><script>alert(1)</script>', '<svg onload="alert(1)">',
    '#EXTM3U\nhttp://127.0.0.1/internal', "ffconcat version 1.0\nfile '/etc/passwd'", 'RIFF\0\0\0\0AVI ']) {
    assert.equal(identifyRecordingAudio(Buffer.from(text)), null);
  }
  assert.equal(identifyRecordingAudio(Buffer.from([0xff, 0xfb, 0xfc, 0])), null);
});

test('bounded file inspection rejects spoofed audio without loading the complete file', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unihub-audio-header-'));
  try {
    const file = path.join(dir, 'pretend.wav');
    await fs.promises.writeFile(file, '<html>Not audio</html>');
    await assert.rejects(inspectRecordingAudio(file), { status: 415 });
    await fs.promises.writeFile(file, signatures[0][0]);
    assert.equal((await inspectRecordingAudio(file)).contentType, 'audio/wav');
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
