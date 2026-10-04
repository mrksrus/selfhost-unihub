import { createHash, webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRecordingChunk, runRecordingUpload, type UploadRequest, type UploadResponse } from '@/lib/recording-upload';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

const details = {
  title: 'Take',
  original_filename: 'take.wav',
  content_type: 'audio/wav',
  duration_seconds: 1,
  source: 'recorded' as const,
};

// Follows the rules of api/src/services/recordings.js closely enough to test
// resuming: offsets must match, hashes are checked, completing is repeatable.
function fakeServer() {
  const uploads = new Map<string, { total: number; bytes: Buffer; expired: boolean }>();
  const recordings = new Map<string, Buffer>();
  const log: string[] = [];
  let answer: ((method: string, path: string) => UploadResponse | 'drop' | null) | null = null;
  const state = (id: string) => {
    const upload = uploads.get(id)!;
    return { id, bytes_received: upload.bytes.length, total_bytes: upload.total, max_chunk_bytes: 768 * 1024, expires_at: '' };
  };
  const handle = (method: string, path: string, body: Record<string, unknown>): UploadResponse => {
    if (path === '/recordings/uploads/start') {
      const id = String(body.upload_id);
      if (recordings.has(id)) return { status: 200, body: { completed: true, recording: { id, title: body.title } } };
      const existing = uploads.get(id);
      if (existing?.expired) return { status: 410, body: { error: 'Upload expired' } };
      if (!existing) uploads.set(id, { total: Number(body.total_bytes), bytes: Buffer.alloc(0), expired: false });
      return { status: 200, body: { upload: state(id) } };
    }
    const [, , , id, action] = path.split('/');
    const upload = uploads.get(id);
    if (method === 'DELETE') {
      uploads.delete(id);
      return { status: 200, body: { deleted: !!upload } };
    }
    if (action === 'complete') {
      if (!upload) return recordings.has(id) ? { status: 200, body: { recording: { id, title: 'Take' } } } : { status: 404, body: { error: 'Upload not found' } };
      if (upload.bytes.length !== upload.total) return { status: 409, body: { error: 'Upload is incomplete', upload: state(id) } };
      recordings.set(id, upload.bytes);
      uploads.delete(id);
      return { status: 200, body: { recording: { id, title: 'Take' } } };
    }
    if (!upload) return { status: 404, body: { error: 'Upload not found' } };
    if (upload.expired) return { status: 410, body: { error: 'Upload expired' } };
    const data = Buffer.from(String(body.data_base64), 'base64');
    if (createHash('sha256').update(data).digest('hex') !== body.sha256) return { status: 409, body: { error: 'Chunk checksum mismatch' } };
    if (body.offset !== upload.bytes.length) return { status: 409, body: { error: 'Invalid offset', upload: state(id) } };
    upload.bytes = Buffer.concat([upload.bytes, data]);
    return { status: 200, body: { upload: state(id) } };
  };
  const request: UploadRequest = async (method, path, body) => {
    const action = path.split('/').pop();
    log.push(`${method} ${action === 'start' || action === 'chunk' || action === 'complete' ? action : 'upload'}${body && typeof body === 'object' && 'offset' in body ? `@${(body as { offset: number }).offset}` : ''}`);
    const override = answer?.(method, path);
    if (override && override !== 'drop') return override;
    const response = handle(method, path, (body || {}) as Record<string, unknown>);
    // The server did the work, but the answer never arrived.
    return override === 'drop' ? { status: 0, body: null } : response;
  };
  return {
    uploads, recordings, log, request,
    answerWith(next: typeof answer) { answer = next; },
  };
}

function audio(size: number) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index++) bytes[index] = (index * 7) % 251;
  return { bytes, blob: new NodeBlob([bytes]) as unknown as Blob };
}

describe('recording chunks', () => {
  it('reads one bounded slice and hashes exactly those bytes', async () => {
    const blob = new NodeBlob(['abcdefghij']);
    vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new Error('must not read the complete recording'));
    const chunk = await readRecordingChunk(blob as unknown as Blob, 4, 4);
    expect(atob(chunk.data_base64)).toBe('efgh');
    expect(chunk.sha256).toBe(createHash('sha256').update('efgh').digest('hex'));
    expect(chunk.length).toBe(4);
    expect(blob.arrayBuffer).not.toHaveBeenCalled();
  });
});

describe('resumable recording upload', () => {
  it('uploads in order and the server ends up with the exact bytes', async () => {
    const server = fakeServer();
    const { bytes, blob } = audio(10_000);
    const progress: number[] = [];
    const outcome = await runRecordingUpload({ id: 'a', blob, details }, { request: server.request, chunkBytes: 4096, onProgress: value => progress.push(value) });
    expect(outcome.kind).toBe('done');
    expect(server.recordings.get('a')).toEqual(bytes);
    expect(progress).toEqual([0, 4096, 8192, 10_000]);
  });

  it('continues from the server offset when a chunk answer is lost', async () => {
    const server = fakeServer();
    const { bytes, blob } = audio(10_000);
    let dropped = false;
    server.answerWith((method, path) => {
      if (!dropped && path.endsWith('/chunk') && server.uploads.get('a')?.bytes.length === 4096) {
        dropped = true;
        return 'drop';
      }
      return null;
    });
    const first = await runRecordingUpload({ id: 'a', blob, details }, { request: server.request, chunkBytes: 4096 });
    expect(first).toMatchObject({ kind: 'retry', bytesUploaded: 4096 });
    // The server stored the second chunk although the client never heard so.
    expect(server.uploads.get('a')?.bytes.length).toBe(8192);
    const second = await runRecordingUpload({ id: 'a', blob, details }, { request: server.request, chunkBytes: 4096 });
    expect(second.kind).toBe('done');
    expect(server.recordings.get('a')).toEqual(bytes);
    expect(server.log.filter(entry => entry === 'POST chunk@4096')).toHaveLength(1);
  });

  it('a lost answer to complete does not create a second recording', async () => {
    const server = fakeServer();
    const { blob } = audio(3000);
    server.answerWith((method, path) => path.endsWith('/complete') && !server.recordings.size ? 'drop' : null);
    expect((await runRecordingUpload({ id: 'a', blob, details }, { request: server.request })).kind).toBe('retry');
    const again = await runRecordingUpload({ id: 'a', blob, details }, { request: server.request });
    expect(again).toMatchObject({ kind: 'done', recording: { id: 'a' } });
    expect(server.recordings.size).toBe(1);
    expect(server.log.slice(-1)).toEqual(['POST start']);
  });

  it('starts over when the server lost or expired the upload', async () => {
    const server = fakeServer();
    const { bytes, blob } = audio(10_000);
    await runRecordingUpload({ id: 'a', blob, details }, {
      request: server.request, chunkBytes: 4096, signal: AbortSignal.abort(),
    });
    server.uploads.get('a')!.expired = true;
    const outcome = await runRecordingUpload({ id: 'a', blob, details }, { request: server.request, chunkBytes: 4096 });
    expect(outcome.kind).toBe('done');
    expect(server.recordings.get('a')).toEqual(bytes);
    expect(server.log).toContain('DELETE upload');
  });

  it('retries a chunk whose bytes changed on the way', async () => {
    const server = fakeServer();
    const { bytes, blob } = audio(5000);
    let corrupted = false;
    server.answerWith((method, path) => {
      if (!corrupted && path.endsWith('/chunk')) {
        corrupted = true;
        return { status: 409, body: { error: 'Chunk checksum mismatch' } };
      }
      return null;
    });
    expect((await runRecordingUpload({ id: 'a', blob, details }, { request: server.request })).kind).toBe('done');
    expect(server.recordings.get('a')).toEqual(bytes);
  });

  it('keeps the recording for later on network errors, sign-out and server errors', async () => {
    const { blob } = audio(100);
    for (const [response, kind] of [
      [{ status: 0, body: null }, 'retry'],
      [{ status: 503, body: null }, 'retry'],
      [{ status: 403, body: { error: 'Invalid CSRF token' } }, 'retry'],
      [{ status: 401, body: null }, 'signed-out'],
      [{ status: 413, body: { error: 'Recording exceeds the 500 MB limit' } }, 'failed'],
    ] as const) {
      const server = fakeServer();
      server.answerWith(() => response);
      expect((await runRecordingUpload({ id: 'a', blob, details }, { request: server.request })).kind).toBe(kind);
    }
  });

  it('waits for a Recordings restore at any step instead of failing the recording', async () => {
    const { blob } = audio(10_000);
    const restoring = { status: 409, body: { error: 'Restore in progress for recordings. This section is temporarily read-only.', code: 'RESTORE_IN_PROGRESS' } };
    for (const step of ['start', 'chunk', 'complete']) {
      const server = fakeServer();
      let answered = 0;
      server.answerWith((_method, path) => path.endsWith(`/${step}`) && (step !== 'chunk' || ++answered === 2) ? restoring : null);
      const outcome = await runRecordingUpload({ id: 'a', blob, details }, { request: server.request, chunkBytes: 4096 });
      expect(outcome).toMatchObject({ kind: 'retry', error: restoring.body.error, bytesUploaded: step === 'start' ? 0 : step === 'chunk' ? 4096 : 10_000 });
      // Nothing was restarted or deleted on the way.
      expect(server.log.filter(entry => entry.startsWith('DELETE'))).toEqual([]);
    }
    // A 409 without the code at start is still a lasting conflict.
    const server = fakeServer();
    server.answerWith((_method, path) => path.endsWith('/start') ? { status: 409, body: { error: 'Upload id is taken' } } : null);
    expect((await runRecordingUpload({ id: 'a', blob, details }, { request: server.request })).kind).toBe('failed');
  });

  it('stops between chunks when paused', async () => {
    const server = fakeServer();
    const { blob } = audio(10_000);
    const controller = new AbortController();
    const outcome = await runRecordingUpload({ id: 'a', blob, details }, {
      request: server.request, chunkBytes: 4096, signal: controller.signal,
      onProgress: value => { if (value === 4096) controller.abort(); },
    });
    expect(outcome).toEqual({ kind: 'paused', bytesUploaded: 4096 });
  });
});
