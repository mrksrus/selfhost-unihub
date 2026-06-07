import { describe, expect, it } from 'vitest';
import { createPcm16WavBlob, createPcm16WavHeader } from '@/lib/wav';

describe('PCM WAV encoding', () => {
  it('writes a mono 16-bit WAV header with the correct sizes', () => {
    const header = createPcm16WavHeader(48000, 48000);
    const view = new DataView(header);

    expect(new TextDecoder().decode(header.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(header.slice(8, 12))).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(96000);
    expect(view.getUint32(4, true)).toBe(96036);
  });

  it('builds a WAV blob from PCM chunks', () => {
    const pcm = new ArrayBuffer(8);
    const blob = createPcm16WavBlob([pcm], 44100, 4);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(52);
  });
});
