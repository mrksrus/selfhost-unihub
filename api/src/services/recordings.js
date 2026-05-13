const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('../state');

const RECORDINGS_ROOT = '/app/uploads/recordings';
const MAX_RECORDING_BYTES = 500 * 1024 * 1024;
const MAX_CHUNK_BYTES = 768 * 1024;
const UPLOAD_TTL_HOURS = 24;

function sanitizeFilename(value, fallback = 'recording') {
  const cleaned = String(value || fallback)
    .replace(/[/\\]/g, '_')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return cleaned || fallback;
}

function normalizeTitle(value, fallback = 'Untitled recording') {
  return String(value || fallback).trim().replace(/\s+/g, ' ').slice(0, 255) || fallback;
}

function normalizeDescription(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 5000) : null;
}

function normalizeContentType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || !normalized.startsWith('audio/')) return 'audio/webm';
  return normalized.slice(0, 128);
}

function normalizeSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'recorded' ? 'recorded' : 'imported';
}

function normalizeTags(tags) {
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

function parseTagsJson(value) {
  if (!value) return [];
  if (Array.isArray(value)) return normalizeTags(value);
  try {
    return normalizeTags(JSON.parse(value));
  } catch {
    return [];
  }
}

function extensionForContentType(contentType, originalFilename = '') {
  const filenameExt = path.extname(originalFilename || '').toLowerCase();
  if (filenameExt && filenameExt.length <= 12) return filenameExt;
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return '.mp3';
  if (contentType.includes('mp4') || contentType.includes('m4a')) return '.m4a';
  if (contentType.includes('ogg')) return '.ogg';
  if (contentType.includes('wav')) return '.wav';
  return '.webm';
}

function isPathUnderRoot(filePath, rootPath = RECORDINGS_ROOT) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedPath = path.resolve(filePath || '');
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);
}

async function ensureRecordingTags(userId, recordingId, tagNames, connection = db) {
  const normalizedTags = normalizeTags(tagNames);
  await connection.execute('DELETE FROM recording_tag_links WHERE user_id = ? AND recording_id = ?', [userId, recordingId]);
  for (const tagName of normalizedTags) {
    const tagId = crypto.randomUUID();
    await connection.execute(
      `INSERT INTO recording_tags (id, user_id, name)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [tagId, userId, tagName]
    );
    const [rows] = await connection.execute(
      'SELECT id FROM recording_tags WHERE user_id = ? AND name = ? LIMIT 1',
      [userId, tagName]
    );
    const existingTagId = rows[0]?.id || tagId;
    await connection.execute(
      `INSERT IGNORE INTO recording_tag_links (recording_id, tag_id, user_id)
       VALUES (?, ?, ?)`,
      [recordingId, existingTagId, userId]
    );
  }
}

function serializeRecording(row) {
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
    tags: row.tags ? String(row.tags).split('\u001f').filter(Boolean) : [],
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

async function listRecordings(userId, { search = '', tag = '' } = {}) {
  const where = ['r.user_id = ?'];
  const params = [userId];
  const trimmedSearch = String(search || '').trim();
  if (trimmedSearch) {
    where.push('(r.title LIKE ? OR r.description LIKE ? OR r.original_filename LIKE ?)');
    const like = `%${trimmedSearch.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    params.push(like, like, like);
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

  const [rows] = await db.execute(
    `SELECT r.id, r.user_id, r.title, r.description, r.original_filename, r.content_type,
            r.size_bytes, r.duration_seconds, r.source, r.created_at, r.updated_at,
            GROUP_CONCAT(rt.name ORDER BY rt.name SEPARATOR '\u001f') AS tags
     FROM recordings r
     LEFT JOIN recording_tag_links rtl ON rtl.recording_id = r.id AND rtl.user_id = r.user_id
     LEFT JOIN recording_tags rt ON rt.id = rtl.tag_id
     WHERE ${where.join(' AND ')}
     GROUP BY r.id, r.user_id, r.title, r.description, r.original_filename, r.content_type,
              r.size_bytes, r.duration_seconds, r.source, r.created_at, r.updated_at
     ORDER BY r.created_at DESC`,
    params
  );
  return (rows || []).map(serializeRecording);
}

async function getRecordingForUser(userId, recordingId) {
  const [rows] = await db.execute(
    `SELECT r.*, GROUP_CONCAT(rt.name ORDER BY rt.name SEPARATOR '\u001f') AS tags
     FROM recordings r
     LEFT JOIN recording_tag_links rtl ON rtl.recording_id = r.id AND rtl.user_id = r.user_id
     LEFT JOIN recording_tags rt ON rt.id = rtl.tag_id
     WHERE r.id = ? AND r.user_id = ?
     GROUP BY r.id, r.user_id, r.title, r.description, r.original_filename, r.content_type,
              r.size_bytes, r.duration_seconds, r.storage_path, r.source, r.created_at, r.updated_at
     LIMIT 1`,
    [recordingId, userId]
  );
  return rows[0] || null;
}

async function startRecordingUpload(userId, input = {}) {
  const totalBytes = Number(input.total_bytes);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return { error: 'total_bytes must be a positive number', status: 400 };
  }
  if (totalBytes > MAX_RECORDING_BYTES) {
    return { error: 'Recording exceeds the 500 MB limit', status: 400 };
  }

  const uploadId = crypto.randomUUID();
  const title = normalizeTitle(input.title || input.original_filename);
  const originalFilename = sanitizeFilename(input.original_filename || `${title}.webm`, 'recording.webm');
  const contentType = normalizeContentType(input.content_type);
  const durationSeconds = input.duration_seconds === null || input.duration_seconds === undefined
    ? null
    : Math.max(0, Number(input.duration_seconds) || 0);
  const tempDir = path.join(RECORDINGS_ROOT, '.tmp', String(userId));
  const tempPath = path.join(tempDir, `${uploadId}.part`);
  await fs.promises.mkdir(tempDir, { recursive: true });
  await fs.promises.writeFile(tempPath, Buffer.alloc(0), { flag: 'wx' });
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_HOURS * 60 * 60 * 1000);

  await db.execute(
    `INSERT INTO recording_uploads
      (id, user_id, title, description, original_filename, content_type, total_bytes, duration_seconds, source, tags, temp_path, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      JSON.stringify(normalizeTags(input.tags)),
      tempPath,
      expiresAt,
    ]
  );

  return {
    upload: {
      id: uploadId,
      bytes_received: 0,
      total_bytes: totalBytes,
      max_chunk_bytes: MAX_CHUNK_BYTES,
      expires_at: expiresAt.toISOString(),
    },
  };
}

async function appendRecordingUploadChunk(userId, uploadId, input = {}) {
  const [rows] = await db.execute(
    'SELECT * FROM recording_uploads WHERE id = ? AND user_id = ? LIMIT 1',
    [uploadId, userId]
  );
  const upload = rows[0];
  if (!upload) return { error: 'Upload not found', status: 404 };
  if (new Date(upload.expires_at).getTime() < Date.now()) {
    return { error: 'Upload expired', status: 410 };
  }
  if (!isPathUnderRoot(upload.temp_path)) {
    return { error: 'Invalid upload path', status: 500 };
  }

  const expectedOffset = Number(input.offset);
  if (!Number.isFinite(expectedOffset) || expectedOffset !== Number(upload.bytes_received)) {
    return { error: `Invalid chunk offset; expected ${upload.bytes_received}`, status: 409 };
  }

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

  const nextBytes = Number(upload.bytes_received) + buffer.length;
  if (nextBytes > Number(upload.total_bytes)) {
    return { error: 'Chunk exceeds declared upload size', status: 400 };
  }

  await fs.promises.appendFile(path.resolve(upload.temp_path), buffer);
  await db.execute(
    'UPDATE recording_uploads SET bytes_received = ? WHERE id = ? AND user_id = ?',
    [nextBytes, uploadId, userId]
  );
  return { upload: { id: uploadId, bytes_received: nextBytes, total_bytes: Number(upload.total_bytes) } };
}

async function completeRecordingUpload(userId, uploadId) {
  const [rows] = await db.execute(
    'SELECT * FROM recording_uploads WHERE id = ? AND user_id = ? LIMIT 1',
    [uploadId, userId]
  );
  const upload = rows[0];
  if (!upload) return { error: 'Upload not found', status: 404 };
  if (Number(upload.bytes_received) !== Number(upload.total_bytes)) {
    return { error: 'Upload is incomplete', status: 409 };
  }
  if (!isPathUnderRoot(upload.temp_path)) {
    return { error: 'Invalid upload path', status: 500 };
  }

  const stat = await fs.promises.stat(upload.temp_path);
  if (stat.size !== Number(upload.total_bytes)) {
    return { error: 'Uploaded file size does not match declared size', status: 409 };
  }

  const recordingId = crypto.randomUUID();
  const finalDir = path.join(RECORDINGS_ROOT, String(userId));
  const ext = extensionForContentType(upload.content_type, upload.original_filename);
  const finalPath = path.join(finalDir, `${recordingId}${ext}`);
  await fs.promises.mkdir(finalDir, { recursive: true });
  await fs.promises.rename(path.resolve(upload.temp_path), finalPath);

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO recordings
        (id, user_id, title, description, original_filename, content_type, size_bytes, duration_seconds, storage_path, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        recordingId,
        userId,
        upload.title,
        upload.description || null,
        upload.original_filename || null,
        upload.content_type,
        Number(upload.total_bytes),
        upload.duration_seconds === null ? null : Number(upload.duration_seconds),
        finalPath,
        upload.source || 'imported',
      ]
    );
    await ensureRecordingTags(userId, recordingId, parseTagsJson(upload.tags), connection);
    await connection.execute('DELETE FROM recording_uploads WHERE id = ? AND user_id = ?', [uploadId, userId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    await fs.promises.rm(finalPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    connection.release();
  }

  const recording = await getRecordingForUser(userId, recordingId);
  return { recording: serializeRecording(recording) };
}

async function updateRecording(userId, recordingId, input = {}) {
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
  if (updates.length > 0) {
    params.push(recordingId, userId);
    await db.execute(`UPDATE recordings SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'tags')) {
    await ensureRecordingTags(userId, recordingId, input.tags);
  }
  const recording = await getRecordingForUser(userId, recordingId);
  return { recording: serializeRecording(recording) };
}

async function deleteRecording(userId, recordingId) {
  const recording = await getRecordingForUser(userId, recordingId);
  if (!recording) return { error: 'Recording not found', status: 404 };
  if (recording.storage_path && isPathUnderRoot(recording.storage_path)) {
    await fs.promises.rm(path.resolve(recording.storage_path), { force: true }).catch(() => {});
  }
  await db.execute('DELETE FROM recordings WHERE id = ? AND user_id = ?', [recordingId, userId]);
  return { deleted: true };
}

async function cleanupExpiredRecordingUploads() {
  const [rows] = await db.execute(
    'SELECT id, temp_path FROM recording_uploads WHERE expires_at < UTC_TIMESTAMP() LIMIT 100'
  );
  for (const row of rows || []) {
    if (row.temp_path && isPathUnderRoot(row.temp_path)) {
      await fs.promises.rm(path.resolve(row.temp_path), { force: true }).catch(() => {});
    }
    await db.execute('DELETE FROM recording_uploads WHERE id = ?', [row.id]).catch(() => {});
  }
  return rows.length;
}

module.exports = {
  RECORDINGS_ROOT,
  MAX_CHUNK_BYTES,
  MAX_RECORDING_BYTES,
  isPathUnderRoot,
  normalizeTags,
  serializeRecording,
  listRecordings,
  getRecordingForUser,
  startRecordingUpload,
  appendRecordingUploadChunk,
  completeRecordingUpload,
  updateRecording,
  deleteRecording,
  cleanupExpiredRecordingUploads,
};
