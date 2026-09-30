const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../state');

const NOTES_ROOT = '/app/uploads/notes';
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 512 * 1024;
const NOTE_COLUMNS = 'id, title, body, revision, trashed_at, created_at, updated_at';
function fail(message, status = 400, code) { throw Object.assign(new Error(message), { status, code }); }
function normalizeNote(input) {
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 255) fail('A title of 1–255 characters is required.');
  if (typeof input.body !== 'string' || Buffer.byteLength(input.body) > MAX_BODY_BYTES) fail('Note text must be at most 512 KiB.');
  const links = input.linked_note_ids ?? [];
  if (!Array.isArray(links) || links.length > 100 || links.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,36}$/.test(id))) fail('Invalid linked notes.');
  return { title: input.title.trim(), body: input.body, linked_note_ids: [...new Set(links)] };
}
function safeFilename(value) {
  return String(value || 'attachment').replace(/[\x00-\x1f\x7f/\\"<>:|?*]/g, '_').trim().slice(0, 180) || 'attachment';
}
function decodeAttachment(input) {
  const encoded = input.content_base64;
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('Invalid attachment encoding or attachment exceeds 2 MiB.');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) fail('Attachment must contain 1 byte to 2 MiB.');
  return { bytes, filename: safeFilename(input.filename), content_type: 'application/octet-stream' };
}
async function ownedNote(connection, userId, id, lock = false) {
  const [rows] = await connection.execute(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ? AND user_id = ?${lock ? ' FOR UPDATE' : ''}`, [id, userId]);
  if (!rows.length) fail('Note not found.', 404);
  return rows[0];
}
async function setLinks(connection, userId, id, ids) {
  for (const linked of ids) {
    if (linked === id) fail('A note cannot link to itself.');
    await ownedNote(connection, userId, linked);
  }
  await connection.execute('DELETE FROM note_links WHERE note_id = ? AND user_id = ?', [id, userId]);
  for (const linked of ids) await connection.execute('INSERT INTO note_links (user_id, note_id, linked_note_id) VALUES (?, ?, ?)', [userId, id, linked]);
}
async function snapshot(connection, userId, note) {
  await connection.execute('INSERT INTO note_revisions (id, user_id, note_id, revision, title, body) VALUES (?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), userId, note.id, note.revision, note.title, note.body]);
}
async function getNote(userId, id) {
  const note = await ownedNote(db, userId, id);
  const [revisions] = await db.execute('SELECT revision, title, created_at FROM note_revisions WHERE note_id = ? AND user_id = ? ORDER BY revision DESC', [id, userId]);
  const [attachments] = await db.execute('SELECT id, filename, content_type, size_bytes, created_at FROM note_attachments WHERE note_id = ? AND user_id = ? ORDER BY created_at, id', [id, userId]);
  const [links] = await db.execute('SELECT n.id, n.title FROM note_links l JOIN notes n ON n.id = l.linked_note_id AND n.user_id = l.user_id WHERE l.note_id = ? AND l.user_id = ? ORDER BY n.title, n.id', [id, userId]);
  return { note, revisions, attachments, links };
}
async function listNotes(userId, { q = '', trash = false, limit = 200 } = {}) {
  const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 500);
  const params = [userId];
  let where = `user_id = ? AND trashed_at IS ${trash ? 'NOT ' : ''}NULL`;
  if (q) { where += ' AND (LOCATE(?, title) > 0 OR LOCATE(?, body) > 0)'; params.push(String(q).slice(0, 255), String(q).slice(0, 255)); }
  const [notes] = await db.execute(`SELECT id, title, LEFT(body, 240) AS body, revision, trashed_at, created_at, updated_at FROM notes WHERE ${where} ORDER BY updated_at DESC, id LIMIT ${bounded}`, params);
  return notes;
}
const searchNotes = (userId, q, limit = 20) => listNotes(userId, { q, limit });
async function createNote(userId, input) {
  const value = normalizeNote(input);
  const id = crypto.randomUUID();
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('INSERT INTO notes (id, origin_key, user_id, title, body) VALUES (?, ?, ?, ?, ?)', [id, id, userId, value.title, value.body]);
    await setLinks(connection, userId, id, value.linked_note_ids);
    await snapshot(connection, userId, { ...value, id, revision: 1 });
    await connection.commit();
  } catch (error) { await connection.rollback().catch(() => {}); throw error; }
  finally { connection.release(); }
  return getNote(userId, id);
}
async function mutateNote(userId, id, input, action, extra = {}) {
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) fail('expected_revision is required.');
  const normalized = action === 'update' ? normalizeNote(input) : null;
  const attachment = action === 'attach' ? decodeAttachment(input) : null;
  const connection = await db.getConnection();
  let createdPath;
  let commitAttempted = false;
  try {
    await connection.beginTransaction();
    const note = await ownedNote(connection, userId, id, true);
    if (Number(note.revision) !== input.expected_revision) fail('Note has changed. Reload before saving.', 409, 'NOTE_REVISION_CONFLICT');
    if (note.trashed_at && action !== 'restore') fail('Restore this note from Trash before editing.', 409);
    if (normalized) { note.title = normalized.title; note.body = normalized.body; await setLinks(connection, userId, id, normalized.linked_note_ids); }
    if (action === 'revision') {
      const [rows] = await connection.execute('SELECT title, body FROM note_revisions WHERE note_id = ? AND user_id = ? AND revision = ?', [id, userId, extra.revision]);
      if (!rows.length) fail('Revision not found.', 404);
      note.title = rows[0].title; note.body = rows[0].body;
    }
    if (action === 'trash') note.trashed_at = new Date();
    if (action === 'restore') note.trashed_at = null;
    if (attachment) {
      const attachmentId = crypto.randomUUID();
      const directory = path.join(NOTES_ROOT, userId);
      await fs.promises.mkdir(directory, { recursive: true });
      createdPath = path.join(directory, attachmentId);
      await fs.promises.writeFile(createdPath, attachment.bytes, { flag: 'wx', mode: 0o600 });
      await connection.execute('INSERT INTO note_attachments (id, user_id, note_id, filename, content_type, size_bytes, storage_path) VALUES (?, ?, ?, ?, ?, ?, ?)', [attachmentId, userId, id, attachment.filename, attachment.content_type, attachment.bytes.length, createdPath]);
    }
    if (action === 'detach') {
      const [result] = await connection.execute('DELETE FROM note_attachments WHERE id = ? AND note_id = ? AND user_id = ?', [extra.attachmentId, id, userId]);
      if (!result.affectedRows) fail('Attachment not found.', 404);
      // Retain bytes: a simultaneous backup snapshot may still reference this file.
    }
    note.revision = Number(note.revision) + 1;
    await connection.execute('UPDATE notes SET title = ?, body = ?, revision = ?, trashed_at = ? WHERE id = ? AND user_id = ?', [note.title, note.body, note.revision, note.trashed_at, id, userId]);
    await snapshot(connection, userId, note);
    commitAttempted = true;
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    if (createdPath && !commitAttempted) await fs.promises.rm(createdPath, { force: true }).catch(() => {});
    throw error;
  } finally { connection.release(); }
  return getNote(userId, id);
}
async function downloadAttachment(userId, id, attachmentId) {
  await ownedNote(db, userId, id);
  const [rows] = await db.execute('SELECT storage_path, filename FROM note_attachments WHERE id = ? AND note_id = ? AND user_id = ?', [attachmentId, id, userId]);
  if (!rows.length) fail('Attachment not found.', 404);
  const file = rows[0];
  const resolved = await fs.promises.realpath(file.storage_path).catch(() => null);
  const root = await fs.promises.realpath(NOTES_ROOT).catch(() => null);
  if (!resolved || !root || !resolved.startsWith(root + path.sep)) fail('Attachment unavailable.', 404);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) fail('Attachment unavailable.', 404);
  return { __streamPath: resolved, __contentLength: stat.size, __contentType: 'application/octet-stream', __filename: safeFilename(file.filename), __disposition: 'attachment' };
}
async function exportNote(userId, id) {
  const { note, attachments, links } = await getNote(userId, id);
  const label = value => String(value).replace(/[\r\n]/g, ' ').replace(/[\\[\]]/g, '\\$&');
  let markdown = `# ${note.title.replace(/[\r\n]/g, ' ')}\n\n${note.body}\n`;
  if (links.length) markdown += '\n## Linked notes\n\n' + links.map(link => `- [${label(link.title)}](/notes?note=${encodeURIComponent(link.id)})`).join('\n') + '\n';
  if (attachments.length) markdown += '\n## Attachments\n\n' + attachments.map(file => `- [${label(file.filename)}](/api/notes/${id}/attachments/${file.id}/download) (${file.size_bytes} bytes)`).join('\n') + '\n';
  return { __raw: markdown, __contentType: 'text/markdown; charset=utf-8', __filename: `${safeFilename(note.title)}.md`, __disposition: 'attachment' };
}
module.exports = { NOTES_ROOT, MAX_ATTACHMENT_BYTES, MAX_BODY_BYTES, normalizeNote, decodeAttachment, safeFilename, createNote, getNote, listNotes, searchNotes, mutateNote, downloadAttachment, exportNote };
