import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendCaptureBatch,
  createCapture,
  deleteStoredRecording,
  discardStoredRecording,
  finishCapture,
  listCaptures,
  listStoredRecordings,
  processRecordingQueue,
  readStoredRecordingBlob,
  recoverCapture,
  saveStoredRecording,
  type StoredRecording,
} from '@/lib/recording-queue';
import type { UploadRequest } from '@/lib/recording-upload';

// fake-indexeddb copies values with structuredClone, which accepts Node's
// Blob but not the one from jsdom.
vi.stubGlobal('Blob', NodeBlob);

const details = {
  title: 'Take',
  original_filename: 'take.wav',
  content_type: 'audio/wav',
  duration_seconds: 1,
  source: 'recorded' as const,
};

function job(id: string, userId: string, blob: Blob, state: StoredRecording['state'] = 'queued'): StoredRecording {
  return { id, userId, state, details, size: blob.size, bytesUploaded: 0, error: null, recovered: false, createdAt: Date.now(), updatedAt: Date.now() };
}

// Accepts everything in one go; enough to drive the queue.
function server(fail?: (path: string) => { status: number; body: Record<string, unknown> | null } | null) {
  const stored = new Map<string, Buffer>();
  const request: UploadRequest = async (method, path, body) => {
    const failure = fail?.(path);
    if (failure) return failure;
    const payload = (body || {}) as Record<string, unknown>;
    if (path.endsWith('/start')) {
      stored.set(String(payload.upload_id), Buffer.alloc(0));
      return { status: 200, body: { upload: { id: payload.upload_id, bytes_received: 0, total_bytes: payload.total_bytes, max_chunk_bytes: 768 * 1024 } } };
    }
    const id = path.split('/')[3];
    if (path.endsWith('/chunk')) {
      const data = Buffer.from(String(payload.data_base64), 'base64');
      expect(createHash('sha256').update(data).digest('hex')).toBe(payload.sha256);
      stored.set(id, Buffer.concat([stored.get(id)!, data]));
      return { status: 200, body: { upload: { id, bytes_received: stored.get(id)!.length, total_bytes: 0, max_chunk_bytes: 0 } } };
    }
    return { status: 200, body: { recording: { id, title: 'Take' } } };
  };
  return { stored, request };
}

afterEach(async () => {
  for (const userId of ['u1', 'u2']) {
    for (const item of await listStoredRecordings(userId)) await deleteStoredRecording(item.id);
  }
});

describe('recordings kept on the device', () => {
  it('uploads queued recordings of the signed-in account only and removes them afterwards', async () => {
    const mine = new Blob(['first take']);
    await saveStoredRecording(job('a', 'u1', mine), mine);
    await saveStoredRecording(job('b', 'u2', new Blob(['other account'])), new Blob(['other account']));
    await saveStoredRecording(job('c', 'u1', mine, 'draft'), mine);
    const { stored, request } = server();
    const result = await processRecordingQueue({ userId: 'u1', request });
    expect(result.uploaded.map(recording => recording.id)).toEqual(['a']);
    expect(stored.get('a')?.toString()).toBe('first take');
    expect(stored.has('b')).toBe(false);
    expect((await listStoredRecordings('u1')).map(item => item.id)).toEqual(['c']);
    expect(await readStoredRecordingBlob('a')).toBeNull();
    expect(await listStoredRecordings('u2')).toHaveLength(1);
  });

  it('keeps a recording when the connection drops and marks refused files as failed', async () => {
    const blob = new Blob(['take']);
    await saveStoredRecording(job('a', 'u1', blob), blob);
    const offline = await processRecordingQueue({ userId: 'u1', request: server(() => ({ status: 0, body: null })).request });
    expect(offline).toMatchObject({ stoppedBy: 'retry', remaining: 1 });
    expect((await listStoredRecordings('u1'))[0]).toMatchObject({ state: 'queued', error: 'No connection to the server' });

    const refused = await processRecordingQueue({ userId: 'u1', request: server(() => ({ status: 400, body: { error: 'Unsupported file' } })).request });
    expect(refused.failed).toHaveLength(1);
    expect((await listStoredRecordings('u1'))[0]).toMatchObject({ state: 'failed', error: 'Unsupported file' });
    expect(await readStoredRecordingBlob('a')).not.toBeNull();
  });

  it('discards a queued recording only after the server cancelled its upload, unless forced', async () => {
    const blob = new Blob(['take']);
    await saveStoredRecording(job('a', 'u1', blob), blob);
    const calls: string[] = [];
    const unreachable: UploadRequest = async (method, path) => { calls.push(`${method} ${path}`); return { status: 0, body: null }; };
    expect(await discardStoredRecording('a', unreachable)).toEqual({ kind: 'not-cancelled', status: 0 });
    expect(await readStoredRecordingBlob('a')).not.toBeNull();
    expect(await discardStoredRecording('a', unreachable, { force: true })).toEqual({ kind: 'discarded' });
    expect(await readStoredRecordingBlob('a')).toBeNull();
    expect(calls).toEqual(['DELETE /recordings/uploads/a', 'DELETE /recordings/uploads/a']);

    await saveStoredRecording(job('b', 'u1', blob), blob);
    const cancelled: UploadRequest = async () => ({ status: 200, body: { deleted: true } });
    expect(await discardStoredRecording('b', cancelled)).toEqual({ kind: 'discarded' });
    expect(await listStoredRecordings('u1')).toHaveLength(0);
  });

  it('does not discard while another uploader keeps the upload lock', async () => {
    const blob = new Blob(['take']);
    await saveStoredRecording(job('a', 'u1', blob), blob);
    // An uploader in another tab holds the lock; the request waits until it gives up.
    const request = vi.fn<UploadRequest>(async () => ({ status: 200, body: { deleted: true } }));
    vi.stubGlobal('navigator', { ...navigator, locks: { request: (_name: string, options: { signal?: AbortSignal }) => new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal?.reason))) } });
    try {
      expect(await discardStoredRecording('a', request, { timeoutMs: 20 })).toEqual({ kind: 'busy' });
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal('Blob', NodeBlob);
    }
    expect(request).not.toHaveBeenCalled();
    expect(await readStoredRecordingBlob('a')).not.toBeNull();
  });

  it('recovers an interrupted recording as a playable WAV draft', async () => {
    await createCapture({ id: 'cap', userId: 'u1', sampleRate: 8000, sampleCount: 0, batches: 0, startedAt: 1000, updatedAt: 1000 });
    const samples = new Int16Array([1, -1, 2, -2, 3, -3]);
    await appendCaptureBatch('cap', new Blob([samples.slice(0, 4).buffer]), 4);
    await appendCaptureBatch('cap', new Blob([samples.slice(4).buffer]), 2);
    const [capture] = await listCaptures('u1');
    expect(capture).toMatchObject({ sampleCount: 6, batches: 2 });

    const draft = await recoverCapture(capture, { ...details, duration_seconds: null });
    expect(draft).toMatchObject({ id: 'cap', state: 'draft', recovered: true, details: { duration_seconds: 6 / 8000 } });
    const wav = Buffer.from(await (await readStoredRecordingBlob('cap'))!.arrayBuffer());
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt32LE(40)).toBe(12);
    expect(new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + 56))).toEqual(samples);
    expect(await listCaptures('u1')).toHaveLength(0);
  });

  it('a stopped recording replaces its capture, so it is not recovered twice', async () => {
    await createCapture({ id: 'cap', userId: 'u1', sampleRate: 8000, sampleCount: 0, batches: 0, startedAt: 1000, updatedAt: 1000 });
    await appendCaptureBatch('cap', new Blob([new Int16Array([1, 2]).buffer]), 2);
    const blob = new Blob(['finished wav']);
    await finishCapture('cap', job('cap', 'u1', blob, 'draft'), blob);
    expect(await listCaptures('u1')).toHaveLength(0);
    expect((await listStoredRecordings('u1')).map(item => item.state)).toEqual(['draft']);
  });
});
