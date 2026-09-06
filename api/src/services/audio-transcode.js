const { spawn } = require('child_process');

const MAX_CONVERSION_MILLISECONDS = 15 * 60 * 1000;
const MAX_CONVERTED_BYTES = 500 * 1024 * 1024;
const ALLOWED_DEMUXERS = new Set(['wav', 'mp3', 'mov', 'ogg', 'matroska', 'flac', 'aac', 'aiff']);

function buildAudioConversionArgs(inputPath, outputPath, demuxer) {
  if (!ALLOWED_DEMUXERS.has(demuxer)) throw new Error('Unsupported audio format');
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-max_alloc', String(64 * 1024 * 1024),
    '-filter_threads', '1',
    '-threads', '1',
    '-protocol_whitelist', 'file',
    '-format_whitelist', demuxer,
    '-probesize', String(1024 * 1024),
    '-analyzeduration', '5000000',
    '-max_streams', '8',
    '-fflags', '+genpts+discardcorrupt',
    '-f', demuxer,
    // MOV references must not open another file embedded in a recording.
    ...(demuxer === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
    '-vn', '-sn', '-dn',
    '-i', inputPath,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
    '-af', 'asetpts=N/SR/TB',
    '-codec:a', 'libmp3lame', '-threads', '1', '-q:a', '2',
    '-fs', String(MAX_CONVERTED_BYTES),
    outputPath,
  ];
}

function runAudioConversion(inputPath, outputPath, demuxer, {
  spawnProcess = spawn,
  timeoutMs = MAX_CONVERSION_MILLISECONDS,
} = {}) {
  const args = buildAudioConversionArgs(inputPath, outputPath, demuxer);
  return new Promise((resolve, reject) => {
    const child = spawnProcess('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timeoutError;
    const timer = setTimeout(() => {
      timeoutError = new Error('MP3 conversion took too long. The original recording is still available.');
      timeoutError.status = 503;
      // Keep the queue slot until close: otherwise a still-running encoder could
      // overlap the next job and defeat the one-conversion CPU limit.
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(0, 16000);
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT'
        ? new Error('MP3 conversion is unavailable because ffmpeg is not installed')
        : error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timeoutError) reject(timeoutError);
      else if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

module.exports = {
  MAX_CONVERSION_MILLISECONDS,
  MAX_CONVERTED_BYTES,
  buildAudioConversionArgs,
  runAudioConversion,
};
