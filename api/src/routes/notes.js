const notes = require('../services/notes');
const parts = req => new URL(req.url, 'http://localhost').pathname.split('/');
const route = fn => async (req, userId, body = {}) => {
  if (!userId) return { error: 'Unauthorized', status: 401 };
  try { return await fn(req, userId, body); }
  catch (error) {
    if (!error.status) console.error('[Notes]', error.message);
    return { error: error.status ? error.message : 'Notes request failed.', status: error.status || 500, ...(error.code ? { code: error.code } : {}) };
  }
};
module.exports = {
  'GET /api/notes': route(async (req, userId) => {
    const query = new URL(req.url, 'http://localhost').searchParams;
    return { notes: await notes.listNotes(userId, { q: query.get('q'), trash: query.get('trash') === 'true', limit: query.get('limit') }) };
  }),
  'POST /api/notes': route((req, userId, body) => notes.createNote(userId, body)),
  'GET /api/notes/:id': route((req, userId) => notes.getNote(userId, parts(req)[3])),
  'PUT /api/notes/:id': route((req, userId, body) => notes.mutateNote(userId, parts(req)[3], body, 'update')),
  'DELETE /api/notes/:id': route((req, userId, body) => notes.mutateNote(userId, parts(req)[3], body, 'trash')),
  'POST /api/notes/:id/restore': route((req, userId, body) => notes.mutateNote(userId, parts(req)[3], body, 'restore')),
  'POST /api/notes/:id/revisions/:revision/restore': route((req, userId, body) => notes.mutateNote(userId, parts(req)[3], body, 'revision', { revision: Number(parts(req)[5]) })),
  'POST /api/notes/:id/attachments': route((req, userId, body) => notes.mutateNote(userId, parts(req)[3], body, 'attach')),
  'DELETE /api/notes/:id/attachments/:attachmentId': route((req, userId, body) => notes.mutateNote(userId, parts(req)[3], body, 'detach', { attachmentId: parts(req)[5] })),
  'GET /api/notes/:id/attachments/:attachmentId/download': route((req, userId) => notes.downloadAttachment(userId, parts(req)[3], parts(req)[5])),
  'GET /api/notes/:id/export': route((req, userId) => notes.exportNote(userId, parts(req)[3])),
};
