const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function createPcm16WavHeader(sampleRate: number, sampleCount: number) {
  const bytesPerSample = PCM_BITS_PER_SAMPLE / 8;
  const dataBytes = sampleCount * PCM_CHANNELS * bytesPerSample;
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    throw new Error('Invalid WAV sample rate');
  }
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0 || dataBytes > 0xffffffff - 36) {
    throw new Error('Recording is too large for a WAV file');
  }

  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, PCM_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * PCM_CHANNELS * bytesPerSample, true);
  view.setUint16(32, PCM_CHANNELS * bytesPerSample, true);
  view.setUint16(34, PCM_BITS_PER_SAMPLE, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

export function createPcm16WavBlob(chunks: ArrayBuffer[], sampleRate: number, sampleCount: number) {
  return new Blob([createPcm16WavHeader(sampleRate, sampleCount), ...chunks], {
    type: 'audio/wav',
  });
}
