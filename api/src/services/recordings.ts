import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor, StoredFlag } from '../types';
interface RecordingRow extends RowDataPacket { id: string; user_id: string; storage_path: string; content_type: string; title: string; description: string | null; original_filename: string; size_bytes: number | string; duration_seconds: number | string | null; source: string; category: string; recorded_at: Date | string | null; created_at: Date | string | null; updated_at: Date | string | null; metadata: unknown; tags: unknown }
interface UploadRow extends RecordingRow { temp_path: string; expires_at: Date | string; bytes_received: number | string; total_bytes: number | string; is_expired: StoredFlag }
type UploadInput = Record<string, unknown>;
import crypto = require('crypto');
import fs = require('fs');
import path = require('path');
import imported1 = require('../state');
const { db } = imported1;
import imported2 = require('./recording-audio');
const { inspectRecordingAudio } = imported2;
import imported3 = require('./audio-conversion-queue');
const { createAudioConversionQueue } = imported3;
import imported4 = require('./audio-transcode');
const { MAX_CONVERTED_BYTES, runAudioConversion } = imported4;

const RECORDINGS_ROOT = process.env.RECORDINGS_ROOT || '/app/uploads/recordings';
const MAX_RECORDING_BYTES = 500 * 1024 * 1024;
const MAX_CHUNK_BYTES = 768 * 1024;
const UPLOAD_TTL_HOURS = 24;
const RECORDING_CATEGORIES = new Set(['none', 'music', 'journal', 'memory', 'reminder']);
const mp3ConversionJobs = new Map<string, Promise<unknown>>();
// Chunk, complete and abort for one upload run one at a time in this process.
// The page and the service worker can both retry the same upload.
const uploadLocks = new Map<string, Promise<unknown>>();
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mp3ConversionQueue = createAudioConversionQueue();

function sanitizeFilename(value: unknown, fallback = 'recording') {
  const cleaned = String(value || fallback)
    .replace(/[/\\]/g, '_')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return cleaned || fallback;
}

function normalizeTitle(value: unknown, fallback = 'Untitled recording') {
  return String(value || fallback).trim().replace(/\s+/g, ' ').slice(0, 255) || fallback;
}

function normalizeDescription(value: unknown) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 5000) : null;
}

function normalizeContentType(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || !normalized.startsWith('audio/')) return 'audio/webm';
  return normalized.slice(0, 128);
}

function normalizeSource(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'recorded' ? 'recorded' : 'imported';
}

function normalizeCategory(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  return RECORDING_CATEGORIES.has(normalized) ? normalized : 'none';
}

function normalizeRecordedAt(value: unknown, fallback: Date | string = new Date()) {
  if (value === null || value === undefined || value === '') {
    return fallback instanceof Date ? fallback : new Date(fallback);
  }
  const date = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(date.getTime())) {
    return fallback instanceof Date ? fallback : new Date(fallback);
  }
  return date;
}

function normalizeMetadata(value: unknown) {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      source = {};
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};

  const metadata: { chords?: string } = {};
  if (Object.prototype.hasOwnProperty.call(source, 'chords')) {
    const chords = String((source as Record<string, unknown>).chords || '').trim().slice(0, 10000);
    if (chords) metadata.chords = chords;
  }
  return metadata;
}

function serializeMetadata(value: unknown) {
  const metadata = normalizeMetadata(value);
  return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
}

function normalizeTags(tags: unknown) {
  const source = Array.isArray(tags)
    ? tags
    : String(tags || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  const seen = new Set();
  const normalized = [];
  for (const tag of source) {
    const name = String(tag || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    normalized.push(name);
  }
  return normalized.slice(0, 20);
}

function parseTagsJson(value: unknown) {
  if (!value) return [];
  if (Array.isArray(value)) return normalizeTags(value);
  try {
    return normalizeTags(JSON.parse(value as string));
  } catch {
    return [];
  }
}

function parseMetadataJson(value: unknown) {
  return normalizeMetadata(value);
}

function isMp3Audio(contentType: unknown, filename = '') {
  const normalizedType = String(contentType || '').toLowerCase();
  return normalizedType.includes('mpeg')
    || normalizedType.includes('mp3')
    || path.extname(String(filename || '')).toLowerCase() === '.mp3';
}

function replaceFilenameExtension(filename: unknown, extension: string) {
  const safeFilename = sanitizeFilename(filename || 'recording', 'recording');
  const parsed = path.parse(safeFilename);
  return `${parsed.name || 'recording'}${extension}`;
}

function isPathUnderRoot(filePath: string | null | undefined, rootPath = RECORDINGS_ROOT) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedPath = path.resolve(filePath || '');
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);
}

function getConvertedMp3Path(storagePath: string | null | undefined) {
  const resolvedPath = path.resolve(storagePath || '');
  if (!isPathUnderRoot(resolvedPath)) {
    throw new Error('Invalid recording path');
  }
  const parsed = path.parse(resolvedPath);
  return path.join(parsed.dir, `${parsed.name}.converted-v2.mp3`);
}

function getLegacyConvertedMp3Path(storagePath: string | null | undefined) {
  const resolvedPath = path.resolve(storagePath || '');
  if (!isPathUnderRoot(resolvedPath)) {
    throw new Error('Invalid recording path');
  }
  const parsed = path.parse(resolvedPath);
  return path.join(parsed.dir, `${parsed.name}.converted.mp3`);
}

function normalizeSha256(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

async function calculateFileSha256(filePath: string | null | undefined) {
  const resolvedPath = path.resolve(filePath || '');
  if (!isPathUnderRoot(resolvedPath)) {
    throw new Error('Invalid recording path');
  }

  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(resolvedPath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function transcodeAudioToMp3(inputPath: string, outputPath: string) {
  const resolvedInput = path.resolve(inputPath || '');
  const resolvedOutput = path.resolve(outputPath || '');
  if (!isPathUnderRoot(resolvedInput) || !isPathUnderRoot(resolvedOutput)) {
    throw new Error('Invalid recording path');
  }

  await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true });
  const temporaryOutput = `${resolvedOutput}.${crypto.randomUUID()}.tmp.mp3`;

  try {
    const { demuxer } = await inspectRecordingAudio(resolvedInput);
    await runAudioConversion(resolvedInput, temporaryOutput, demuxer);

    const stat = await fs.promises.stat(temporaryOutput);
    if (stat.size <= 0) throw new Error('MP3 conversion produced an empty file');
    if (stat.size >= MAX_CONVERTED_BYTES) throw new Error('MP3 export exceeds the conversion size limit. Download the original recording instead.');
    await fs.promises.rename(temporaryOutput, resolvedOutput);
  } catch (error) {
    await fs.promises.rm(temporaryOutput, { force: true }).catch(() => {});
    throw error;
  }
}

async function ensureRecordingMp3(recording: RecordingRow) {
  if (!recording?.storage_path || !isPathUnderRoot(recording.storage_path)) {
    throw new Error('Invalid recording path');
  }

  const sourcePath = path.resolve(recording.storage_path);
  const sourceStat = await fs.promises.stat(sourcePath);
  if (isMp3Audio(recording.content_type, sourcePath)) {
    return { path: sourcePath, size: sourceStat.size };
  }

  const convertedPath = getConvertedMp3Path(sourcePath);
  const existing = await fs.promises.stat(convertedPath).catch(() => null);
  if (existing?.isFile() && existing.size > 0 && existing.mtimeMs >= sourceStat.mtimeMs) {
    return { path: convertedPath, size: existing.size };
  }

  let conversion = mp3ConversionJobs.get(convertedPath);
  if (!conversion) {
    conversion = mp3ConversionQueue.enqueue(String(recording.user_id), () => transcodeAudioToMp3(sourcePath, convertedPath))
      .finally(() => mp3ConversionJobs.delete(convertedPath));
    mp3ConversionJobs.set(convertedPath, conversion);
  }
  await conversion;
  const stat = await fs.promises.stat(convertedPath);
  await fs.promises.rm(getLegacyConvertedMp3Path(sourcePath), { force: true }).catch(() => {});
  return { path: convertedPath, size: stat.size };
}

async function deleteRecordingFiles(storagePath: string | null | undefined) {
  if (!storagePath || !isPathUnderRoot(storagePath)) return;
  const sourcePath = path.resolve(storagePath);
  const paths = [sourcePath];
  if (path.extname(sourcePath).toLowerCase() !== '.mp3') {
    const convertedPath = getConvertedMp3Path(sourcePath);
    const conversion = mp3ConversionJobs.get(convertedPath);
    if (conversion) await conversion.catch(() => {});
    paths.push(convertedPath, getLegacyConvertedMp3Path(sourcePath));
  }
  await Promise.all(paths.map(filePath => fs.promises.rm(filePath, { force: true }).catch(() => {})));
}

async function ensureRecordingTags(userId: string, recordingId: string, tagNames: unknown, connection: SqlExecutor = db) {
  const normalizedTags = normalizeTags(tagNames);
  await connection.execute<RowDataPacket[]>('DELETE FROM recording_tag_links WHERE user_id = ? AND recording_id = ?', [userId, recordingId]);
  for (const tagName of normalizedTags) {
    const tagId = crypto.randomUUID();
    await connection.execute<RowDataPacket[]>(
      `INSERT INTO recording_tags (id, user_id, name)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [tagId, userId, tagName]
    );
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM recording_tags WHERE user_id = ? AND name = ? LIMIT 1',
      [userId, tagName]
    );
    const existingTagId = rows[0]?.id || tagId;
    await connection.execute<RowDataPacket[]>(
      `INSERT IGNORE INTO recording_tag_links (recording_id, tag_id, user_id)
       VALUES (?, ?, ?)`,
      [recordingId, existingTagId, userId]
    );
  }
}

function serializeRecording(row: RecordingRow) {
  const recordedAt = row.recorded_at || row.created_at;
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    description: row.description || null,
    original_filename: row.original_filename || null,
    content_type: row.content_type,
    size_bytes: Number(row.size_bytes) || 0,
    duration_seconds: row.duration_seconds === null || row.duration_seconds === undefined ? null : Number(row.duration_seconds),
    source: row.source || 'imported',
    category: normalizeCategory(row.category),
    recorded_at: recordedAt instanceof Date ? recordedAt.toISOString() : recordedAt,
    metadata: parseMetadataJson(row.metadata),
    tags: row.tags ? String(row.tags).split('\u001f').filter(Boolean) : [],
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

async function listRecordings(userId: string, { search = '', tag = '', category = '', musicMissingChords = false } = {}) {
  const where = ['r.user_id = ?'];
  const params = [userId];
  const trimmedSearch = String(search || '').trim();
  if (trimmedSearch) {
    where.push(`(
      r.title LIKE ?
      OR r.description LIKE ?
      OR r.original_filename LIKE ?
      OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.metadata, '$.chords')), '') LIKE ?
    )`);
    const like = `%${trimmedSearch.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    params.push(like, like, like, like);
  }
  const trimmedCategory = String(category || '').trim();
  if (trimmedCategory) {
    where.push('r.category = ?');
    params.push(normalizeCategory(trimmedCategory));
  }
  if (musicMissingChords) {
    where.push(`r.category = 'music'`);
    where.push(`NULLIF(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.metadata, '$.chords')), '')), '') IS NULL`);
  }
  const trimmedTag = String(tag || '').trim();
  if (trimmedTag) {
    where.push(`EXISTS (
      SELECT 1
      FROM recording_tag_links rtl2
      INNER JOIN recording_tags rt2 ON rt2.id = rtl2.tag_id
      WHERE rtl2.recording_id = r.id AND rtl2.user_id = ? AND rt2.name = ?
    )`);
    params.push(userId, trimmedTag);
  }

  const [rows] = await db.execute<RecordingRow[]>(
    `SELECT r.id, r.user_id, r.title, r.description, r.original_filename, r.content_type,
            r.size_bytes, r.duration_seconds, r.source, r.category, r.recorded_at, r.metadata,
            r.created_at, r.updated_at,
            (
              SELECT GROUP_CONCAT(rt.name ORDER BY rt.name SEPARATOR '\u001f')
              FROM recording_tag_links rtl
              INNER JOIN recording_tags rt ON rt.id = rtl.tag_id
              WHERE rtl.recording_id = r.id AND rtl.user_id = r.user_id
            ) AS tags
     FROM recordings r
     WHERE ${where.join(' AND ')}
     ORDER BY r.recorded_at DESC, r.created_at DESC`,
    params
  );
  return (rows || []).map(serializeRecording);
}

async function getRecordingForUser(userId: string, recordingId: string) {
  const [rows] = await db.execute<RecordingRow[]>(
    `SELECT r.*,
            (
              SELECT GROUP_CONCAT(rt.name ORDER BY rt.name SEPARATOR '\u001f')
              FROM recording_tag_links rtl
              INNER JOIN recording_tags rt ON rt.id = rtl.tag_id
              WHERE rtl.recording_id = r.id AND rtl.user_id = r.user_id
            ) AS tags
     FROM recordings r
     WHERE r.id = ? AND r.user_id = ?
     LIMIT 1`,
    [recordingId, userId]
  );
  return rows[0] || null;
}

async function withUploadLock<T>(uploadId: string, task: () => Promise<T>): Promise<T> {
  const previous = uploadLocks.get(uploadId) || Promise.resolve();
  const run = previous.then(task);
  const tail = run.catch(() => {});
  uploadLocks.set(uploadId, tail);
  try {
    return await run;
  } finally {
    if (uploadLocks.get(uploadId) === tail) uploadLocks.delete(uploadId);
  }
}

function serializeUpload(upload: Pick<UploadRow, 'id' | 'expires_at' | 'bytes_received' | 'total_bytes'>) {
  const expiresAt = upload.expires_at instanceof Date ? upload.expires_at.toISOString() : upload.expires_at;
  return {
    id: upload.id,
    bytes_received: Number(upload.bytes_received),
    total_bytes: Number(upload.total_bytes),
    max_chunk_bytes: MAX_CHUNK_BYTES,
    expires_at: expiresAt,
  };
}

async function findUpload(userId: string, uploadId: string) {
  const [rows] = await db.execute<UploadRow[]>(
    `SELECT *, expires_at < UTC_TIMESTAMP() AS is_expired
     FROM recording_uploads WHERE id = ? AND user_id = ? LIMIT 1`,
    [uploadId, userId]
  );
  return rows[0] || null;
}

async function startRecordingUpload(userId: string, input: UploadInput = {}) {
  const totalBytes = Number(input.total_bytes);
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    return { error: 'total_bytes must be a positive number', status: 400 };
  }
  if (totalBytes > MAX_RECORDING_BYTES) {
    return { error: 'Recording exceeds the 500 MB limit', status: 400 };
  }

  // The client may name the upload so a start whose response was lost can be
  // repeated without leaving a second, abandoned upload behind.
  if (input.upload_id !== undefined) {
    const uploadId = String(input.upload_id).toLowerCase();
    if (!UPLOAD_ID_PATTERN.test(uploadId)) return { error: 'Invalid upload_id', status: 400 };
    return withUploadLock(uploadId, () => createRecordingUpload(userId, uploadId, totalBytes, input));
  }
  return createRecordingUpload(userId, crypto.randomUUID(), totalBytes, input);
}

async function createRecordingUpload(userId: string, uploadId: string, totalBytes: number, input: UploadInput) {
  const existing = await findUpload(userId, uploadId);
  if (existing) {
    if (Number(existing.total_bytes) !== totalBytes) return { error: 'Upload exists with a different size', status: 409 };
    if (Number(existing.is_expired)) return { error: 'Upload expired', status: 410 };
    return { upload: serializeUpload(existing) };
  }
  const recording = await getRecordingForUser(userId, uploadId);
  if (recording) return { completed: true, recording: serializeRecording(recording) };

  const title = normalizeTitle(input.title || input.original_filename);
  const originalFilename = sanitizeFilename(input.original_filename || `${title}.webm`, 'recording.webm');
  const contentType = normalizeContentType(input.content_type);
  const durationSeconds = input.duration_seconds === null || input.duration_seconds === undefined
    ? null
    : Math.max(0, Number(input.duration_seconds) || 0);
  const recordedAt = normalizeRecordedAt(input.recorded_at);
  const tempDir = path.join(RECORDINGS_ROOT, '.tmp', String(userId));
  const tempPath = path.join(tempDir, `${uploadId}.part`);
  await fs.promises.mkdir(tempDir, { recursive: true });
  // No upload row exists here, so a file at this path is left from a start
  // that failed before its row was written.
  await fs.promises.writeFile(tempPath, Buffer.alloc(0));
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_HOURS * 60 * 60 * 1000);

  try {
    await db.execute<RowDataPacket[]>(
      `INSERT INTO recording_uploads
        (id, user_id, title, description, original_filename, content_type, total_bytes, duration_seconds, source, category, recorded_at, metadata, tags, temp_path, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uploadId,
        userId,
        title,
        normalizeDescription(input.description),
        originalFilename,
        contentType,
        totalBytes,
        durationSeconds,
        normalizeSource(input.source),
        normalizeCategory(input.category),
        recordedAt,
        serializeMetadata(input.metadata),
        JSON.stringify(normalizeTags(input.tags)),
        tempPath,
        expiresAt,
      ]
    );
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    // Another account already uses this id.
    if ((error as NodeJS.ErrnoException).code === 'ER_DUP_ENTRY') return { error: 'Upload id is already in use', status: 409 };
    throw error;
  }

  return { upload: serializeUpload({ id: uploadId, bytes_received: 0, total_bytes: totalBytes, expires_at: expiresAt }) };
}

// The page and the service worker resume from here after a lost response or
// a closed app. A completed upload answers with its recording.
async function getRecordingUploadStatus(userId: string, uploadId: string) {
  const upload = await findUpload(userId, uploadId);
  if (upload) {
    if (Number(upload.is_expired)) return { error: 'Upload expired', status: 410 };
    return { upload: serializeUpload(upload) };
  }
  const recording = await getRecordingForUser(userId, uploadId);
  if (recording) return { completed: true, recording: serializeRecording(recording) };
  return { error: 'Upload not found', status: 404 };
}

async function appendRecordingUploadChunk(userId: string, uploadId: string, input: UploadInput = {}) {
  const chunkBase64 = String(input.data_base64 || '');
  if (!chunkBase64) return { error: 'data_base64 is required', status: 400 };
  let buffer;
  try {
    buffer = Buffer.from(chunkBase64, 'base64');
  } catch {
    return { error: 'Invalid base64 chunk', status: 400 };
  }
  if (!buffer.length) return { error: 'Chunk is empty', status: 400 };
  if (buffer.length > MAX_CHUNK_BYTES) return { error: 'Chunk exceeds max size', status: 413 };
  if (input.sha256 !== undefined) {
    const expectedHash = normalizeSha256(input.sha256);
    if (!expectedHash || crypto.createHash('sha256').update(buffer).digest('hex') !== expectedHash) {
      return { error: 'Recording chunk failed its integrity check. Please retry the upload.', status: 409 };
    }
  }

  return withUploadLock(uploadId, async () => {
    const upload = await findUpload(userId, uploadId);
    if (!upload) return { error: 'Upload not found', status: 404 };
    if (Number(upload.is_expired)) return { error: 'Upload expired', status: 410 };
    if (!isPathUnderRoot(upload.temp_path)) {
      return { error: 'Invalid upload path', status: 500 };
    }

    const received = Number(upload.bytes_received);
    const expectedOffset = Number(input.offset);
    if (!Number.isSafeInteger(expectedOffset) || expectedOffset !== received) {
      // The client resumes from bytes_received, e.g. after a lost response.
      return { error: `Invalid chunk offset; expected ${received}`, status: 409, upload: serializeUpload(upload) };
    }
    const nextBytes = received + buffer.length;
    if (nextBytes > Number(upload.total_bytes)) {
      return { error: 'Chunk exceeds declared upload size', status: 400 };
    }

    // Write at the recorded offset, not at the end of the file: bytes left by
    // a write whose database update never happened are cut off and replaced.
    const handle = await fs.promises.open(path.resolve(upload.temp_path), 'r+');
    try {
      await handle.truncate(received);
      let written = 0;
      while (written < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, written, buffer.length - written, received + written);
        written += bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    const expiresAt = new Date(Date.now() + UPLOAD_TTL_HOURS * 60 * 60 * 1000);
    const [result] = await db.execute<ResultSetHeader>(
      'UPDATE recording_uploads SET bytes_received = ?, expires_at = ? WHERE id = ? AND user_id = ? AND bytes_received = ?',
      [nextBytes, expiresAt, uploadId, userId, received]
    );
    if (!result?.affectedRows) {
      return { error: 'Upload changed while this chunk was written. Please retry.', status: 409 };
    }
    return { upload: serializeUpload({ ...upload, bytes_received: nextBytes, expires_at: expiresAt }) };
  });
}

async function completeRecordingUpload(userId: string, uploadId: string, input: UploadInput = {}) {
  return withUploadLock(uploadId, async () => {
    const upload = await findUpload(userId, uploadId);
    if (!upload) {
      // A retry after a lost response finds the recording this upload became.
      const existing = await getRecordingForUser(userId, uploadId);
      if (existing) return { recording: serializeRecording(existing) };
      return { error: 'Upload not found', status: 404 };
    }
    if (Number(upload.bytes_received) !== Number(upload.total_bytes)) {
      return { error: 'Upload is incomplete', status: 409, upload: serializeUpload(upload) };
    }
    if (!isPathUnderRoot(upload.temp_path)) {
      return { error: 'Invalid upload path', status: 500 };
    }

    const tempPath = path.resolve(upload.temp_path);
    const stat = await fs.promises.stat(tempPath);
    if (stat.size !== Number(upload.total_bytes)) {
      return { error: 'Uploaded file size does not match declared size', status: 409 };
    }

    const expectedSha256 = normalizeSha256(input.sha256);
    if (expectedSha256) {
      const actualSha256 = await calculateFileSha256(tempPath);
      if (actualSha256 !== expectedSha256) {
        return {
          error: 'Recording upload failed its integrity check. The saved bytes differ from the local preview.',
          status: 409,
        };
      }
    }

    const recordingId = upload.id;
    const finalDir = path.join(RECORDINGS_ROOT, String(userId));
    const audioFormat = await inspectRecordingAudio(tempPath);
    const storedContentType = audioFormat.contentType;
    const storedFilename = replaceFilenameExtension(upload.original_filename, audioFormat.extension);
    const finalPath = path.join(finalDir, `${recordingId}${audioFormat.extension}`);
    await fs.promises.mkdir(finalDir, { recursive: true });
    await fs.promises.rename(tempPath, finalPath);

    let connection;
    try {
      const storedStat = await fs.promises.stat(finalPath);
      connection = await db.getConnection();
      await connection.beginTransaction();
      await connection.execute<RowDataPacket[]>(
        `INSERT INTO recordings
          (id, user_id, title, description, original_filename, content_type, size_bytes, duration_seconds, storage_path, source, category, recorded_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          recordingId,
          userId,
          upload.title,
          upload.description || null,
          storedFilename || null,
          storedContentType,
          storedStat.size,
          upload.duration_seconds === null ? null : Number(upload.duration_seconds),
          finalPath,
          upload.source || 'imported',
          normalizeCategory(upload.category),
          normalizeRecordedAt(upload.recorded_at),
          serializeMetadata(upload.metadata),
        ]
      );
      await ensureRecordingTags(userId, recordingId, parseTagsJson(upload.tags), connection);
      await connection.execute<RowDataPacket[]>('DELETE FROM recording_uploads WHERE id = ? AND user_id = ?', [uploadId, userId]);
      await connection.commit();
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      // Keep the uploaded bytes so completing can be retried.
      await fs.promises.rename(finalPath, tempPath).catch(renameError => {
        console.error('Could not return a recording upload to its temporary path:', renameError.message);
      });
      throw error;
    } finally {
      connection?.release();
    }

    const recording = await getRecordingForUser(userId, recordingId);
    return { recording: serializeRecording(recording!) };
  });
}

async function abortRecordingUpload(userId: string, uploadId: string) {
  return withUploadLock(uploadId, async () => {
    const upload = await findUpload(userId, uploadId);
    if (!upload) return { deleted: false };
    if (upload.temp_path && isPathUnderRoot(upload.temp_path)) {
      await fs.promises.rm(path.resolve(upload.temp_path), { force: true });
    }
    await db.execute<RowDataPacket[]>('DELETE FROM recording_uploads WHERE id = ? AND user_id = ?', [uploadId, userId]);
    return { deleted: true };
  });
}

async function updateRecording(userId: string, recordingId: string, input: UploadInput = {}) {
  const existing = await getRecordingForUser(userId, recordingId);
  if (!existing) return { error: 'Recording not found', status: 404 };
  const updates = [];
  const params = [];
  if (Object.prototype.hasOwnProperty.call(input, 'title')) {
    updates.push('title = ?');
    params.push(normalizeTitle(input.title));
  }
  if (Object.prototype.hasOwnProperty.call(input, 'description')) {
    updates.push('description = ?');
    params.push(normalizeDescription(input.description));
  }
  if (Object.prototype.hasOwnProperty.call(input, 'category')) {
    updates.push('category = ?');
    params.push(normalizeCategory(input.category));
  }
  if (Object.prototype.hasOwnProperty.call(input, 'recorded_at')) {
    updates.push('recorded_at = ?');
    params.push(normalizeRecordedAt(input.recorded_at, existing.created_at || new Date()));
  }
  if (Object.prototype.hasOwnProperty.call(input, 'metadata')) {
    updates.push('metadata = ?');
    params.push(serializeMetadata(input.metadata));
  }
  if (updates.length > 0) {
    params.push(recordingId, userId);
    await db.execute<RowDataPacket[]>(`UPDATE recordings SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'tags')) {
    await ensureRecordingTags(userId, recordingId, input.tags);
  }
  const recording = await getRecordingForUser(userId, recordingId);
  return { recording: serializeRecording(recording!) };
}

async function deleteRecording(userId: string, recordingId: string) {
  const recording = await getRecordingForUser(userId, recordingId);
  if (!recording) return { error: 'Recording not found', status: 404 };
  await deleteRecordingFiles(recording.storage_path);
  await db.execute<RowDataPacket[]>('DELETE FROM recordings WHERE id = ? AND user_id = ?', [recordingId, userId]);
  return { deleted: true };
}

async function cleanupExpiredRecordingUploads() {
  const [rows] = await db.execute<RowDataPacket[]>(
    'SELECT id, temp_path FROM recording_uploads WHERE expires_at < UTC_TIMESTAMP() LIMIT 100'
  );
  for (const row of rows || []) {
    await withUploadLock(row.id, async () => {
      // A chunk that arrived meanwhile extended the upload.
      const [[current]] = await db.execute<RowDataPacket[]>(
        'SELECT expires_at < UTC_TIMESTAMP() AS is_expired FROM recording_uploads WHERE id = ?',
        [row.id]
      );
      if (!current || !Number(current.is_expired)) return;
      if (row.temp_path && isPathUnderRoot(row.temp_path)) {
        await fs.promises.rm(path.resolve(row.temp_path), { force: true }).catch(() => {});
      }
      await db.execute<RowDataPacket[]>('DELETE FROM recording_uploads WHERE id = ?', [row.id]);
    }).catch(() => {});
  }
  return rows.length;
}

export = {
  RECORDINGS_ROOT,
  MAX_CHUNK_BYTES,
  MAX_RECORDING_BYTES,
  isPathUnderRoot,
  isMp3Audio,
  replaceFilenameExtension,
  getConvertedMp3Path,
  normalizeSha256,
  calculateFileSha256,
  normalizeCategory,
  normalizeMetadata,
  normalizeTags,
  serializeRecording,
  listRecordings,
  getRecordingForUser,
  ensureRecordingMp3,
  deleteRecordingFiles,
  startRecordingUpload,
  getRecordingUploadStatus,
  appendRecordingUploadChunk,
  completeRecordingUpload,
  abortRecordingUpload,
  updateRecording,
  deleteRecording,
  cleanupExpiredRecordingUploads,
};
