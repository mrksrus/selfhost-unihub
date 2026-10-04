// Recordings kept on this device until the server has them. The Recordings
// page and the service worker share this store, so an upload continues after
// the page is closed. Like recording-upload.ts, this file is bundled into the
// service worker and must not import page code.
import { createPcm16WavBlob } from '@/lib/wav';
import {
  runRecordingUpload,
  type RecordingUploadJob,
  type RecordingUploadOutcome,
  type UploadRequest,
} from '@/lib/recording-upload';
import type { Recording } from '@/lib/recordings-api';

const DATABASE = 'unihub-recordings-v1';
export const RECORDING_UPLOADS_LOCK = 'unihub-recording-uploads';
export const RECORDING_UPLOADS_CHANNEL = 'unihub-recording-uploads';
export const RECORDING_UPLOADS_SYNC_TAG = 'recording-uploads';
// Tag of the notice that recordings are waiting on this device.
export const RECORDING_UPLOADS_NOTICE_TAG = 'recording-uploads';

// draft: recorded but not saved yet. queued: waiting for or in upload.
// failed: the server refused the file. It stays here until the user acts.
export type StoredRecordingState = 'draft' | 'queued' | 'failed';

export interface StoredRecording {
  id: string;
  userId: string;
  state: StoredRecordingState;
  details: RecordingUploadJob['details'];
  size: number;
  bytesUploaded: number;
  error: string | null;
  recovered: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface StoredCapture {
  id: string;
  userId: string;
  sampleRate: number;
  sampleCount: number;
  batches: number;
  startedAt: number;
  updatedAt: number;
}

export type RecordingQueueMessage =
  | { type: 'progress'; id: string; bytesUploaded: number }
  | { type: 'changed' }
  | { type: 'uploaded'; id: string; title: string; userId: string };

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase() {
  if (!databasePromise) databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser cannot store recordings on the device'));
      return;
    }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('jobs', { keyPath: 'id' });
      db.createObjectStore('blobs');
      db.createObjectStore('captures', { keyPath: 'id' });
      db.createObjectStore('capture-batches');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); databasePromise = null; };
      resolve(request.result);
    };
    request.onerror = () => { databasePromise = null; reject(request.error); };
  });
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T> | T,
) {
  const db = await openDatabase();
  const tx = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
  });
  const result = await work(tx);
  await done;
  return result;
}

function broadcast(message: RecordingQueueMessage) {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(RECORDING_UPLOADS_CHANNEL);
  channel.postMessage(message);
  channel.close();
}

export async function listStoredRecordings(userId: string) {
  const jobs = await transaction(['jobs'], 'readonly', tx => requestResult(tx.objectStore('jobs').getAll()));
  return (jobs as StoredRecording[])
    .filter(job => job.userId === userId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function listQueuedUserIds() {
  const jobs = await transaction(['jobs'], 'readonly', tx => requestResult(tx.objectStore('jobs').getAll()));
  return [...new Set((jobs as StoredRecording[]).filter(job => job.state === 'queued').map(job => job.userId))];
}

export async function readStoredRecordingBlob(id: string) {
  const blob = await transaction(['blobs'], 'readonly', tx => requestResult(tx.objectStore('blobs').get(id)));
  return blob instanceof Blob ? blob : null;
}

export async function saveStoredRecording(job: StoredRecording, blob: Blob) {
  await transaction(['jobs', 'blobs'], 'readwrite', tx => {
    tx.objectStore('jobs').put(job);
    tx.objectStore('blobs').put(blob, job.id);
  });
  broadcast({ type: 'changed' });
}

export async function updateStoredRecording(id: string, patch: Partial<Omit<StoredRecording, 'id' | 'userId'>>) {
  const updated = await transaction(['jobs'], 'readwrite', async tx => {
    const store = tx.objectStore('jobs');
    const current = await requestResult(store.get(id)) as StoredRecording | undefined;
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    store.put(next);
    return next;
  });
  if (updated) broadcast({ type: 'changed' });
  return updated;
}

export async function deleteStoredRecording(id: string) {
  await transaction(['jobs', 'blobs'], 'readwrite', tx => {
    tx.objectStore('jobs').delete(id);
    tx.objectStore('blobs').delete(id);
  });
  broadcast({ type: 'changed' });
}

// Captures hold the audio of a recording in progress, written every few
// seconds. A crash or closed app then loses only the last batch.
export async function createCapture(capture: StoredCapture) {
  await transaction(['captures'], 'readwrite', tx => { tx.objectStore('captures').put(capture); });
}

export async function appendCaptureBatch(id: string, batch: Blob, samples: number) {
  await transaction(['captures', 'capture-batches'], 'readwrite', async tx => {
    const captures = tx.objectStore('captures');
    const capture = await requestResult(captures.get(id)) as StoredCapture | undefined;
    if (!capture) return;
    tx.objectStore('capture-batches').put(batch, [id, capture.batches]);
    captures.put({
      ...capture,
      batches: capture.batches + 1,
      sampleCount: capture.sampleCount + samples,
      updatedAt: Date.now(),
    });
  });
}

export async function listCaptures(userId: string) {
  const captures = await transaction(['captures'], 'readonly', tx => requestResult(tx.objectStore('captures').getAll()));
  return (captures as StoredCapture[]).filter(capture => capture.userId === userId);
}

async function deleteCaptureIn(tx: IDBTransaction, id: string) {
  tx.objectStore('captures').delete(id);
  tx.objectStore('capture-batches').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
}

export async function deleteCapture(id: string) {
  await transaction(['captures', 'capture-batches'], 'readwrite', tx => deleteCaptureIn(tx, id));
}

// Stores the finished recording and drops its capture in one step, so a crash
// in between cannot leave both behind and recover the recording twice.
export async function finishCapture(captureId: string, job: StoredRecording, blob: Blob) {
  await transaction(['jobs', 'blobs', 'captures', 'capture-batches'], 'readwrite', tx => {
    tx.objectStore('jobs').put(job);
    tx.objectStore('blobs').put(blob, job.id);
    return deleteCaptureIn(tx, captureId);
  });
  broadcast({ type: 'changed' });
}

// Builds a WAV file from a capture that never reached "stop" and keeps it as
// a draft. Batches are Blobs, so this does not load the audio into memory.
export async function recoverCapture(capture: StoredCapture, details: RecordingUploadJob['details']) {
  const batches = await transaction(['capture-batches'], 'readonly', tx => requestResult(
    tx.objectStore('capture-batches').getAll(IDBKeyRange.bound([capture.id, 0], [capture.id, Number.MAX_SAFE_INTEGER])),
  )) as Blob[];
  if (!capture.sampleCount || !batches.length) {
    await deleteCapture(capture.id);
    return null;
  }
  const blob = createPcm16WavBlob(batches, capture.sampleRate, capture.sampleCount);
  const now = Date.now();
  const job: StoredRecording = {
    id: capture.id,
    userId: capture.userId,
    state: 'draft',
    details: { ...details, duration_seconds: capture.sampleCount / capture.sampleRate },
    size: blob.size,
    bytesUploaded: 0,
    error: null,
    recovered: true,
    createdAt: capture.startedAt,
    updatedAt: now,
  };
  await finishCapture(capture.id, job, blob);
  return job;
}

export interface QueueRunResult {
  // The upload that stopped the run, if any.
  stoppedBy: Exclude<RecordingUploadOutcome['kind'], 'done' | 'failed'> | null;
  error: string | null;
  uploaded: Recording[];
  failed: StoredRecording[];
  remaining: number;
  progressed: boolean;
}

// Uploads the queued recordings of one account, oldest first. Stops at the
// first upload that has to wait (no connection, signed out, paused), since
// the next one would wait for the same reason.
export async function processRecordingQueue(options: {
  userId: string;
  request: UploadRequest;
  signal?: AbortSignal;
}): Promise<QueueRunResult> {
  const result: QueueRunResult = { stoppedBy: null, error: null, uploaded: [], failed: [], remaining: 0, progressed: false };
  const jobs = (await listStoredRecordings(options.userId)).filter(job => job.state === 'queued');
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const blob = await readStoredRecordingBlob(job.id);
    if (!blob) {
      const failed = await updateStoredRecording(job.id, { state: 'failed', error: 'The audio of this recording is missing on this device' });
      if (failed) result.failed.push(failed);
      continue;
    }
    let lastSaved = job.bytesUploaded;
    const outcome = await runRecordingUpload({ id: job.id, blob, details: job.details }, {
      request: options.request,
      signal: options.signal,
      onProgress: bytesUploaded => {
        if (bytesUploaded > lastSaved) result.progressed = true;
        broadcast({ type: 'progress', id: job.id, bytesUploaded });
        // Progress is only shown, never trusted: the server's offset decides.
        // Saving it every few MB keeps storage writes rare.
        if (Math.abs(bytesUploaded - lastSaved) >= 4 * 1024 * 1024) {
          lastSaved = bytesUploaded;
          void updateStoredRecording(job.id, { bytesUploaded }).catch(() => {});
        }
      },
    });
    if (outcome.kind === 'done') {
      await deleteStoredRecording(job.id);
      result.uploaded.push(outcome.recording);
      result.progressed = true;
      broadcast({ type: 'uploaded', id: job.id, title: outcome.recording.title, userId: job.userId });
      continue;
    }
    if (outcome.kind === 'failed') {
      const failed = await updateStoredRecording(job.id, { state: 'failed', error: outcome.error, bytesUploaded: outcome.bytesUploaded });
      if (failed) result.failed.push(failed);
      continue;
    }
    await updateStoredRecording(job.id, {
      bytesUploaded: outcome.bytesUploaded,
      error: outcome.kind === 'retry' ? outcome.error : null,
    });
    result.stoppedBy = outcome.kind;
    result.error = outcome.kind === 'retry' ? outcome.error : null;
    result.remaining = jobs.length - index;
    break;
  }
  return result;
}

export type DiscardResult =
  | { kind: 'discarded' }
  | { kind: 'uploaded' }
  | { kind: 'busy' }
  | { kind: 'unsupported' }
  | { kind: 'not-cancelled'; status: number };

// Discarding a waiting upload needs the upload lock: without Web Locks another
// tab or the service worker could keep the audio in memory and finish the
// upload after it was deleted here.
export const canDiscardQueuedRecordings = () => typeof navigator !== 'undefined' && !!navigator.locks;

// Discards a recording that may have a partial upload on the server. Holding
// the upload lock keeps every uploader away; then the server's copy is
// removed, since left there it would remind the user about an upload that can
// no longer finish. Without the server's answer the copy here is kept, unless
// the user confirmed discarding it anyway (force). An upload that finished in
// the meantime is reported as uploaded and is in the library.
export async function discardStoredRecording(id: string, request: UploadRequest, options: { force?: boolean; timeoutMs?: number } = {}): Promise<DiscardResult> {
  if (!canDiscardQueuedRecordings()) return { kind: 'unsupported' };
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  try {
    return await withRecordingUploadLock<DiscardResult>(signal, async () => {
      // Another uploader held the lock and finished; it deleted the local copy.
      const job = await transaction(['jobs'], 'readonly', tx => requestResult<StoredRecording | undefined>(tx.objectStore('jobs').get(id)));
      if (!job) return { kind: 'uploaded' };
      const removed = await request('DELETE', `/recordings/uploads/${id}`);
      if (removed.status === 200 && removed.body?.deleted === false) {
        // No upload in progress: it never started, expired, or became a
        // recording whose answer did not reach the uploader. Completing again
        // returns that recording (the upload id is the recording id) and
        // changes nothing otherwise.
        const finished = await request('POST', `/recordings/uploads/${id}/complete`, {});
        if (finished.status === 200 && finished.body?.recording) {
          await deleteStoredRecording(id);
          return { kind: 'uploaded' };
        }
        if (finished.status !== 404 && !options.force) return { kind: 'not-cancelled', status: finished.status };
      } else if (removed.status !== 200 && !options.force) {
        return { kind: 'not-cancelled', status: removed.status };
      }
      await deleteStoredRecording(id);
      return { kind: 'discarded' };
    });
  } catch (error) {
    // Another tab or the service worker kept uploading for the whole wait.
    if (signal.aborted) return { kind: 'busy' };
    throw error;
  }
}

// One uploader at a time across tabs and the service worker. Without Web
// Locks (old browsers) the uploads still work: the server refuses a chunk at
// the wrong offset, so two uploaders cannot corrupt a file.
export async function withRecordingUploadLock<T>(signal: AbortSignal | undefined, task: () => Promise<T>) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return task();
  return locks.request(RECORDING_UPLOADS_LOCK, signal ? { signal } : {}, task) as Promise<T>;
}
