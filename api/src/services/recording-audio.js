const fs = require('fs');

// Read only a small prefix. The decoder still validates the full file when an
// MP3 export is requested; these signatures prevent playlists/HTML from being
// treated as audio and select an explicit, restricted FFmpeg demuxer.
const AUDIO_HEADER_BYTES = 4096;

function identifyRecordingAudio(header) {
  if (!Buffer.isBuffer(header) || header.length < 4) return null;
  const ascii = (start, end) => header.toString('ascii', start, end);
  if (header.length >= 12 && ['RIFF', 'RF64'].includes(ascii(0, 4)) && ascii(8, 12) === 'WAVE') {
    return { contentType: 'audio/wav', extension: '.wav', demuxer: 'wav' };
  }
  if (ascii(0, 4) === 'fLaC') return { contentType: 'audio/flac', extension: '.flac', demuxer: 'flac' };
  if (ascii(0, 4) === 'OggS') return { contentType: 'audio/ogg', extension: '.ogg', demuxer: 'ogg' };
  if (header.readUInt32BE(0) === 0x1a45dfa3) {
    return { contentType: 'audio/webm', extension: '.webm', demuxer: 'matroska' };
  }
  if (header.length >= 12 && ascii(0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(8, 12))) {
    return { contentType: 'audio/aiff', extension: '.aiff', demuxer: 'aiff' };
  }
  if (header.length >= 12 && ascii(4, 8) === 'ftyp') {
    return { contentType: 'audio/mp4', extension: '.m4a', demuxer: 'mov' };
  }
  if (ascii(0, 3) === 'ID3') return { contentType: 'audio/mpeg', extension: '.mp3', demuxer: 'mp3' };
  // ADTS AAC and MPEG audio frames share a sync prefix; distinguish their layer
  // bits before accepting MPEG headers with valid bitrate/sample-rate fields.
  if (header[0] === 0xff && (header[1] & 0xf6) === 0xf0) {
    return { contentType: 'audio/aac', extension: '.aac', demuxer: 'aac' };
  }
  if (header[0] === 0xff && (header[1] & 0xe0) === 0xe0
      && (header[1] & 0x18) !== 0x08 && (header[1] & 0x06) !== 0
      && (header[2] & 0xf0) !== 0xf0 && (header[2] & 0x0c) !== 0x0c) {
    return { contentType: 'audio/mpeg', extension: '.mp3', demuxer: 'mp3' };
  }
  return null;
}

async function inspectRecordingAudio(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const header = Buffer.alloc(AUDIO_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const format = identifyRecordingAudio(header.subarray(0, bytesRead));
    if (!format) {
      const error = new Error('Unsupported audio file. Use WAV, MP3, M4A, OGG, WebM, FLAC, AAC, or AIFF.');
      error.status = 415;
      throw error;
    }
    return format;
  } finally {
    await handle.close();
  }
}

module.exports = { AUDIO_HEADER_BYTES, identifyRecordingAudio, inspectRecordingAudio };
