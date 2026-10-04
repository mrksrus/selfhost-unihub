// Upload steps shared by the Recordings page and the service worker. Only
// type imports are allowed here: the service worker bundle includes this file
// and must not pull in the page's API client or React code.
import type { Recording, RecordingUpload, RecordingUploadStartPayload } from '@/lib/recordings-api';

export interface RecordingChunk {
  offset: number;
  data_base64: string;
  sha256?: string;
}

export const RECORDING_CHUNK_BYTES = 512 * 1024;

function uint8ToBase64(bytes: Uint8Array) {
  let binary = '';
  const stride = 0x8000;
  for (let index = 0; index < bytes.length; index += stride) {
    binary += String.fromCharCode(...bytes.subarray(index, index + stride));
  }
  return btoa(binary);
}

// Only one chunk is copied and hashed at a time, so a long recording is never
// held as one recording-sized ArrayBuffer.
export async function readRecordingChunk(blob: Blob, offset: number, size: number): Promise<RecordingChunk & { length: number }> {
  const buffer = await blob.slice(offset, offset + size).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const digest = globalThis.crypto?.subtle
    ? await globalThis.crypto.subtle.digest('SHA-256', buffer)
    : null;
  const sha256 = digest
    ? Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    : undefined;
  return { offset, data_base64: uint8ToBase64(bytes), sha256, length: bytes.byteLength };
}

// status 0 means the request never got an answer (offline, timeout, abort).
export interface UploadResponse {
  status: number;
  body: Record<string, unknown> | null;
}

export type UploadRequest = (
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<UploadResponse>;

export interface RecordingUploadJob {
  // Also the server upload id and the id of the finished recording.
  id: string;
  blob: Blob;
  details: Omit<RecordingUploadStartPayload, 'total_bytes'>;
}

export type RecordingUploadOutcome =
  | { kind: 'done'; recording: Recording }
  // Kept on the device and tried again later.
  | { kind: 'retry'; error: string; bytesUploaded: number }
  | { kind: 'signed-out'; bytesUploaded: number }
  | { kind: 'paused'; bytesUploaded: number }
  // The server will not accept this file. Retrying cannot help.
  | { kind: 'failed'; error: string; bytesUploaded: number };

interface RunOptions {
  request: UploadRequest;
  signal?: AbortSignal;
  chunkBytes?: number;
  onProgress?: (bytesUploaded: number) => void;
}

const MAX_RESTARTS = 2;
const MAX_STALLED_CHUNKS = 3;

function errorText(response: UploadResponse, fallback: string) {
  const error = response.body?.error;
  if (typeof error === 'string' && error) return error;
  if (response.status === 0) return 'No connection to the server';
  return `${fallback} (${response.status})`;
}

function uploadState(response: UploadResponse) {
  const upload = response.body?.upload as RecordingUpload | undefined;
  return upload && Number.isSafeInteger(upload.bytes_received) ? upload : null;
}

function completedRecording(response: UploadResponse) {
  const recording = response.body?.recording as Recording | undefined;
  return response.status === 200 && recording && typeof recording.id === 'string' ? recording : null;
}

function classify(response: UploadResponse, fallback: string, bytesUploaded: number): RecordingUploadOutcome {
  const error = errorText(response, fallback);
  if (response.status === 401) return { kind: 'signed-out', bytesUploaded };
  // 403 also covers a rotated CSRF token and a module switched off for a while.
  if (response.status === 0 || response.status === 403 || response.status === 408
    || response.status === 409 || response.status === 429 || response.status >= 500) {
    return { kind: 'retry', error, bytesUploaded };
  }
  return { kind: 'failed', error, bytesUploaded };
}

// Starts or resumes one upload. Every step can be repeated safely: the start
// is keyed by the job id, chunks carry their offset and hash, and completing a
// finished upload returns its recording. A lost response therefore never
// corrupts or duplicates the recording.
export async function runRecordingUpload(job: RecordingUploadJob, options: RunOptions): Promise<RecordingUploadOutcome> {
  const { request, signal } = options;
  const path = `/recordings/uploads/${job.id}`;
  let offset = 0;
  let restarts = 0;
  let stalled = 0;
  let chunkBytes = options.chunkBytes ?? RECORDING_CHUNK_BYTES;
  const progress = (value: number) => {
    offset = value;
    options.onProgress?.(value);
  };

  const start = async (): Promise<RecordingUploadOutcome | null> => {
    const response = await request('POST', '/recordings/uploads/start', {
      ...job.details,
      upload_id: job.id,
      total_bytes: job.blob.size,
    });
    const recording = completedRecording(response);
    if (recording) return { kind: 'done', recording };
    const upload = uploadState(response);
    if (response.status === 200 && upload) {
      if (upload.max_chunk_bytes > 0) chunkBytes = Math.min(chunkBytes, upload.max_chunk_bytes);
      progress(upload.bytes_received);
      return null;
    }
    // An expired upload is removed, then started again from the first byte.
    if (response.status === 410 && restarts < MAX_RESTARTS) {
      restarts += 1;
      const removed = await request('DELETE', path);
      if (removed.status !== 200) return classify(removed, 'Could not restart the upload', offset);
      return start();
    }
    // A 409 here means the id is taken or the size differs: a retry cannot fix that.
    if (response.status === 409) return { kind: 'failed', error: errorText(response, 'Upload conflict'), bytesUploaded: offset };
    return classify(response, 'Could not start the upload', offset);
  };

  const restart = async () => {
    if (restarts >= MAX_RESTARTS) return { kind: 'retry', error: 'The server lost the upload', bytesUploaded: offset } as const;
    restarts += 1;
    progress(0);
    return start();
  };

  let outcome = await start();
  if (outcome) return outcome;

  for (;;) {
    while (offset < job.blob.size) {
      if (signal?.aborted) return { kind: 'paused', bytesUploaded: offset };
      const chunk = await readRecordingChunk(job.blob, offset, chunkBytes);
      const response = await request('POST', `${path}/chunk`, {
        offset: chunk.offset,
        data_base64: chunk.data_base64,
        sha256: chunk.sha256,
      });
      const upload = uploadState(response);
      if ((response.status === 200 || response.status === 409) && upload) {
        // A 409 with state means the server already has a different offset,
        // for example after a response was lost. Continue from there.
        stalled = upload.bytes_received > offset ? 0 : stalled + 1;
        if (upload.bytes_received > job.blob.size) return { kind: 'failed', error: 'The server reports more bytes than the file has', bytesUploaded: offset };
        progress(upload.bytes_received);
        if (stalled >= MAX_STALLED_CHUNKS) return { kind: 'retry', error: 'The upload is not moving forward', bytesUploaded: offset };
        continue;
      }
      if (response.status === 404 || response.status === 410) {
        if (response.status === 410) await request('DELETE', path);
        outcome = await restart();
        if (outcome) return outcome;
        continue;
      }
      // A 409 without state is a checksum mismatch: the bytes changed on the way.
      if (response.status === 409 && ++stalled < MAX_STALLED_CHUNKS) continue;
      return classify(response, 'Could not upload the recording', offset);
    }

    if (signal?.aborted) return { kind: 'paused', bytesUploaded: offset };
    const response = await request('POST', `${path}/complete`, {});
    const recording = completedRecording(response);
    if (recording) return { kind: 'done', recording };
    const upload = uploadState(response);
    if (response.status === 409 && upload && upload.bytes_received < job.blob.size) {
      progress(upload.bytes_received);
      continue;
    }
    // 404: the upload is gone. 409 without state: the server's copy does not
    // match its size. Both start over from the bytes kept on this device.
    if (response.status === 404 || (response.status === 409 && !upload)) {
      if (response.status === 409) await request('DELETE', path);
      outcome = await restart();
      if (outcome) return outcome;
      continue;
    }
    return classify(response, 'Could not finish the upload', offset);
  }
}
