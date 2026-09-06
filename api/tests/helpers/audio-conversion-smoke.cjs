// Run locally with Node, or pipe into a built container with UNIHUB_API_ROOT=/app/api.
// Only short synthetic samples and temporary files are used; no audio device is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const apiRoot = process.env.UNIHUB_API_ROOT || path.resolve(__dirname, '../..');
const { inspectRecordingAudio } = require(path.join(apiRoot, 'src/services/recording-audio'));
const { runAudioConversion } = require(path.join(apiRoot, 'src/services/audio-transcode'));

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-audio-smoke-'));
  try {
    const rate = 48000;
    const samples = 12000;
    const buffer = Buffer.alloc(44 + samples * 2);
    buffer.write('RIFF'); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write('WAVEfmt ', 8);
    buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
    for (let index = 0; index < samples; index += 1) {
      buffer.writeInt16LE(Math.round(10000 * Math.sin(index * Math.PI * 2 * 440 / rate)), 44 + index * 2);
    }
    const source = path.join(directory, 'source.wav');
    fs.writeFileSync(source, buffer);
    for (const [extension, codec] of [
      ['wav', null], ['mp3', 'libmp3lame'], ['m4a', 'aac'], ['ogg', 'libvorbis'],
      ['webm', 'libopus'], ['flac', 'flac'], ['aac', 'aac'], ['aiff', 'pcm_s16be'],
    ]) {
      const input = codec ? path.join(directory, `source.${extension}`) : source;
      if (codec) {
        const encoded = spawnSync('ffmpeg', [
          '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1',
          '-i', source, '-codec:a', codec, '-threads', '1', input,
        ], { encoding: 'utf8', timeout: 10000 });
        assert.equal(encoded.status, 0, encoded.error?.message || encoded.stderr);
      }
      const format = await inspectRecordingAudio(input);
      const output = path.join(directory, `${extension}-output.mp3`);
      await runAudioConversion(input, output, format.demuxer);
      const decoded = spawnSync('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', output, '-f', 's16le', '-',
      ], { timeout: 10000 });
      assert.equal(decoded.status, 0, decoded.error?.message || decoded.stderr?.toString());
      // Lossy source formats can add encoder padding; ensure no empty/truncated
      // output and a duration within 30ms of the 250ms input plus codec padding.
      assert.ok(decoded.stdout.length >= 22000 && decoded.stdout.length <= 27000,
        `Unexpected decoded length for ${extension}: ${decoded.stdout.length}`);
      console.log(`${extension}: canonical ${format.contentType}, MP3 decoded ${decoded.stdout.length / 2} samples`);
    }
    assert.deepEqual(fs.readFileSync(source), buffer, 'Original recording must remain unchanged');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
