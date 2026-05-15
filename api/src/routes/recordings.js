const fs = require('fs');
const path = require('path');
const {
  isPathUnderRoot,
  listRecordings,
  getRecordingForUser,
  startRecordingUpload,
  appendRecordingUploadChunk,
  completeRecordingUpload,
  updateRecording,
  deleteRecording,
} = require('../services/recordings');

function getPathPart(req, marker) {
  const parts = new URL(req.url, `http://${req.headers.host}`).pathname.split('/').filter(Boolean);
  const index = parts.indexOf(marker);
  return index === -1 ? null : parts[index + 1] || null;
}

function getUploadId(req) {
  return getPathPart(req, 'uploads');
}

function getRecordingId(req) {
  return getPathPart(req, 'recordings');
}

module.exports = {
  'GET /api/recordings': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const recordings = await listRecordings(userId, {
        search: url.searchParams.get('search') || '',
        tag: url.searchParams.get('tag') || '',
        category: url.searchParams.get('category') || '',
        musicMissingChords: url.searchParams.get('music_missing_chords') === 'true',
      });
      return { recordings };
    } catch (error) {
      console.error('List recordings error:', error);
      return { error: 'Failed to load recordings', status: 500 };
    }
  },

  'POST /api/recordings/uploads/start': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return await startRecordingUpload(userId, body || {});
    } catch (error) {
      console.error('Start recording upload error:', error);
      return { error: error.message || 'Failed to start recording upload', status: 500 };
    }
  },

  'POST /api/recordings/uploads/:id/chunk': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const uploadId = getUploadId(req);
      if (!uploadId) return { error: 'Invalid upload id', status: 400 };
      return await appendRecordingUploadChunk(userId, uploadId, body || {});
    } catch (error) {
      console.error('Append recording upload chunk error:', error);
      return { error: error.message || 'Failed to upload recording chunk', status: 500 };
    }
  },

  'POST /api/recordings/uploads/:id/complete': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const uploadId = getUploadId(req);
      if (!uploadId) return { error: 'Invalid upload id', status: 400 };
      return await completeRecordingUpload(userId, uploadId);
    } catch (error) {
      console.error('Complete recording upload error:', error);
      return { error: error.message || 'Failed to complete recording upload', status: 500 };
    }
  },

  'GET /api/recordings/:id/file': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const recordingId = getRecordingId(req);
      if (!recordingId) return { error: 'Invalid recording id', status: 400 };
      const recording = await getRecordingForUser(userId, recordingId);
      if (!recording) return { error: 'Recording not found', status: 404 };
      if (!isPathUnderRoot(recording.storage_path)) return { error: 'Invalid recording path', status: 500 };
      const filePath = path.resolve(recording.storage_path);
      const stat = await fs.promises.stat(filePath);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const download = url.searchParams.get('download') === '1';
      return {
        __streamPath: filePath,
        __contentType: recording.content_type || 'application/octet-stream',
        __contentLength: stat.size,
        __filename: recording.original_filename || `${recording.title || 'recording'}`,
        __disposition: download ? 'attachment' : 'inline',
      };
    } catch (error) {
      console.error('Download recording error:', error);
      return { error: 'Failed to load recording file', status: 500 };
    }
  },

  'PUT /api/recordings/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const recordingId = getRecordingId(req);
      if (!recordingId) return { error: 'Invalid recording id', status: 400 };
      return await updateRecording(userId, recordingId, body || {});
    } catch (error) {
      console.error('Update recording error:', error);
      return { error: error.message || 'Failed to update recording', status: 500 };
    }
  },

  'DELETE /api/recordings/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const recordingId = getRecordingId(req);
      if (!recordingId) return { error: 'Invalid recording id', status: 400 };
      return await deleteRecording(userId, recordingId);
    } catch (error) {
      console.error('Delete recording error:', error);
      return { error: error.message || 'Failed to delete recording', status: 500 };
    }
  },
};
