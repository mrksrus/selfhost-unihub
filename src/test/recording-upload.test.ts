import { createHash, webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadRecordingChunks, type RecordingChunk } from '@/lib/recording-upload';

afterEach(() => vi.unstubAllGlobals());

describe('recording upload memory and integrity', () => {
  it('reads bounded slices, verifies every slice, and sends them in order', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const blob = new NodeBlob(['abcdefghij']);
    vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new Error('must not read the complete recording'));
    const chunks: RecordingChunk[] = [];
    const progress: number[] = [];
    await uploadRecordingChunks(blob as Blob, 4, async chunk => { chunks.push(chunk); }, value => progress.push(value));
    expect(chunks.map(chunk => chunk.offset)).toEqual([0, 4, 8]);
    expect(chunks.map(chunk => atob(chunk.data_base64))).toEqual(['abcd', 'efgh', 'ij']);
    for (const chunk of chunks) {
      expect(chunk.sha256).toBe(createHash('sha256').update(atob(chunk.data_base64)).digest('hex'));
    }
    expect(progress).toEqual([40, 80, 100]);
    expect(blob.arrayBuffer).not.toHaveBeenCalled();
  });

  it('stops after a rejected chunk and does not claim a completed upload', async () => {
    const blob = new NodeBlob(['abcdefghij']);
    const sendChunk = vi.fn().mockRejectedValue(new Error('bad checksum'));
    const progress = vi.fn();
    await expect(uploadRecordingChunks(blob as Blob, 4, sendChunk, progress)).rejects.toThrow('bad checksum');
    expect(sendChunk).toHaveBeenCalledTimes(1);
    expect(progress).not.toHaveBeenCalled();
  });
});
