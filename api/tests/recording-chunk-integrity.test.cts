import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-recordings-'));
process.env.RECORDINGS_ROOT = root;
const { setDb } = require('../dist/src/state');
const {
  startRecordingUpload,
  getRecordingUploadStatus,
  appendRecordingUploadChunk,
  completeRecordingUpload,
  abortRecordingUpload,
} = require('../dist/src/services/recordings');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// Enough of recording_uploads and recordings for the upload flow.
function fakeDb({ failInsert = false }: FixtureValue = {}) {
  const uploads = new Map();
  const recordings = new Map();
  const execute = async (sql: string, params: FixtureValue[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('INSERT INTO recording_uploads')) {
      const [id, userId, title, description, filename, contentType, totalBytes, duration, source, category, recordedAt, metadata, tags, tempPath, expiresAt] = params;
      uploads.set(id, { id, user_id: userId, title, description, original_filename: filename, content_type: contentType, total_bytes: totalBytes,
        bytes_received: 0, duration_seconds: duration, source, category, recorded_at: recordedAt, metadata, tags, temp_path: tempPath, expires_at: expiresAt });
      return [{ affectedRows: 1 }];
    }
    if (text.startsWith('SELECT *, expires_at < UTC_TIMESTAMP() AS is_expired FROM recording_uploads')) {
      const row = uploads.get(params[0]);
      return [row && row.user_id === params[1] ? [{ ...row, is_expired: row.expires_at < new Date() ? 1 : 0 }] : []];
    }
    if (text.startsWith('UPDATE recording_uploads SET bytes_received')) {
      const [next, expiresAt, id, userId, previous] = params;
      const row = uploads.get(id);
      if (!row || row.user_id !== userId || row.bytes_received !== previous) return [{ affectedRows: 0 }];
      Object.assign(row, { bytes_received: next, expires_at: expiresAt });
      return [{ affectedRows: 1 }];
    }
    if (text.startsWith('DELETE FROM recording_uploads')) {
      uploads.delete(params[0]);
      return [{ affectedRows: 1 }];
    }
    if (text.startsWith('INSERT INTO recordings')) {
      if (failInsert) throw new Error('database unavailable');
      const [id, userId, title] = params;
      recordings.set(id, { id, user_id: userId, title, content_type: params[5], size_bytes: params[6], storage_path: params[8],
        source: params[9], category: params[10], recorded_at: params[11], metadata: params[12], created_at: new Date(), updated_at: new Date() });
      return [{ affectedRows: 1 }];
    }
    if (text.startsWith('SELECT r.*')) {
      const row = recordings.get(params[0]);
      return [row && row.user_id === params[1] ? [row] : []];
    }
    if (text.startsWith('DELETE FROM recording_tag_links')) return [{ affectedRows: 0 }];
    throw new Error(`Unexpected query: ${text}`);
  };
  return {
    uploads,
    recordings,
    execute,
    async getConnection() {
      return { execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
    },
  };
}

function wavBytes(size: FixtureValue) {
  const bytes = Buffer.alloc(size);
  bytes.write('RIFF', 0, 'ascii');
  bytes.write('WAVE', 8, 'ascii');
  for (let index = 12; index < size; index++) bytes[index] = index % 251;
  return bytes;
}

function chunk(bytes: FixtureValue, offset: number, length: FixtureValue) {
  const part = bytes.subarray(offset, offset + length);
  return { offset, data_base64: part.toString('base64'), sha256: crypto.createHash('sha256').update(part).digest('hex') };
}

async function startUpload(db: FixtureValue, bytes: FixtureValue) {
  setDb(db);
  const { upload } = await startRecordingUpload('user', { total_bytes: bytes.length, title: 'Take', source: 'recorded', content_type: 'audio/wav' });
  return upload;
}

test('recording chunks verify their original browser bytes before writing', async t => {
  t.after(() => setDb(null));
  const db = fakeDb();
  const upload = await startUpload(db, Buffer.from('abc'));
  const payload = { offset: 0, data_base64: Buffer.from('abc').toString('base64') };
  const rejected = await appendRecordingUploadChunk('user', upload.id, { ...payload, sha256: '0'.repeat(64) });
  assert.equal(rejected.status, 409);
  assert.equal(db.uploads.get(upload.id).bytes_received, 0);
  const accepted = await appendRecordingUploadChunk('user', upload.id, {
    ...payload, sha256: crypto.createHash('sha256').update('abc').digest('hex'),
  });
  assert.equal(accepted.upload.bytes_received, 3);
  assert.equal(fs.readFileSync(db.uploads.get(upload.id).temp_path, 'utf8'), 'abc');
});

test('a repeated chunk is refused with the offset to resume from', async t => {
  t.after(() => setDb(null));
  const db = fakeDb();
  const bytes = wavBytes(300);
  const upload = await startUpload(db, bytes);
  await appendRecordingUploadChunk('user', upload.id, chunk(bytes, 0, 100));
  const repeated = await appendRecordingUploadChunk('user', upload.id, chunk(bytes, 0, 100));
  assert.equal(repeated.status, 409);
  assert.equal(repeated.upload.bytes_received, 100);
  const status = await getRecordingUploadStatus('user', upload.id);
  assert.equal(status.upload.bytes_received, 100);
});

test('concurrent copies of one chunk write it once', async t => {
  t.after(() => setDb(null));
  const db = fakeDb();
  const bytes = wavBytes(200);
  const upload = await startUpload(db, bytes);
  const results = await Promise.all([
    appendRecordingUploadChunk('user', upload.id, chunk(bytes, 0, 100)),
    appendRecordingUploadChunk('user', upload.id, chunk(bytes, 0, 100)),
  ]);
  assert.deepEqual(results.map(result => result.status || 200).sort(), [200, 409]);
  await appendRecordingUploadChunk('user', upload.id, chunk(bytes, 100, 100));
  assert.deepEqual(fs.readFileSync(db.uploads.get(upload.id).temp_path), bytes);
});

test('bytes from a write whose database update was lost are replaced', async t => {
  t.after(() => setDb(null));
  const db = fakeDb();
  const bytes = wavBytes(200);
  const upload = await startUpload(db, bytes);
  await appendRecordingUploadChunk('user', upload.id, chunk(bytes, 0, 100));
  // A crash after the file write but before bytes_received moved on.
  fs.appendFileSync(db.uploads.get(upload.id).temp_path, Buffer.from('garbage-from-a-crash'));
  await appendRecordingUploadChunk('user', upload.id, chunk(bytes, 100, 100));
  const result = await completeRecordingUpload('user', upload.id);
  assert.equal(result.recording.id, upload.id);
  assert.deepEqual(fs.readFileSync(db.recordings.get(upload.id).storage_path), bytes);
});

test('completing twice returns the same recording', async t => {
  t.after(() => setDb(null));
  const db = fakeDb();
  const bytes = wavBytes(64);
  const upload = await startUpload(db, bytes);
  await appendRecordingUploadChunk('user', upload.id, chunk(bytes, 0, 64));
  const first = await completeRecordingUpload('user', upload.id);
  const second = await completeRecordingUpload('user', upload.id);
  assert.equal(second.recording.id, first.recording.id);
  assert.equal(db.recordings.size, 1);
  const status = await getRecordingUploadStatus('user', upload.id);
  assert.equal(status.completed, true);
  assert.equal((await getRecordingUploadStatus('other', upload.id)).status, 404);
});

test('a failed completion keeps the uploaded bytes for a retry', async t => {
  t.after(() => setDb(null));
  const db = fakeDb({ failInsert: true });
  const bytes = wavBytes(64);
  const upload = await startUpload(db, bytes);
  await appendRecordingUploadChunk('user', upload.id, chunk(bytes, 0, 64));
  await assert.rejects(() => completeRecordingUpload('user', upload.id), /database unavailable/);
  assert.deepEqual(fs.readFileSync(db.uploads.get(upload.id).temp_path), bytes);
});

test('cancelling an upload removes its temporary file', async t => {
  t.after(() => setDb(null));
  const db = fakeDb();
  const bytes = wavBytes(64);
  const upload = await startUpload(db, bytes);
  const tempPath = db.uploads.get(upload.id).temp_path;
  assert.deepEqual(await abortRecordingUpload('user', upload.id), { deleted: true });
  assert.equal(fs.existsSync(tempPath), false);
  assert.deepEqual(await abortRecordingUpload('user', upload.id), { deleted: false });
});

test('repeating a start with the same upload id resumes that upload', async t => {
  t.after(() => setDb(null));
  const db = fakeDb();
  setDb(db);
  const bytes = wavBytes(200);
  const id = crypto.randomUUID();
  const payload = { upload_id: id, total_bytes: bytes.length, title: 'Take', source: 'recorded', content_type: 'audio/wav' };
  const first = await startRecordingUpload('user', payload);
  assert.equal(first.upload.id, id);
  await appendRecordingUploadChunk('user', id, chunk(bytes, 0, 100));
  const again = await startRecordingUpload('user', payload);
  assert.equal(again.upload.bytes_received, 100);
  assert.equal(db.uploads.size, 1);
  assert.equal((await startRecordingUpload('user', { ...payload, total_bytes: 10 })).status, 409);
  assert.equal((await startRecordingUpload('user', { ...payload, upload_id: '../x' })).status, 400);
  await appendRecordingUploadChunk('user', id, chunk(bytes, 100, 100));
  await completeRecordingUpload('user', id);
  const finished = await startRecordingUpload('user', payload);
  assert.equal(finished.completed, true);
  assert.equal(finished.recording.id, id);
});
