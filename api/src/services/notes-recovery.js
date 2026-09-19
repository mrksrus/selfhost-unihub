const crypto = require('node:crypto');
const { TABLE_POLICIES } = require('./backup-catalog');
const { writeOwnedRow, chooseTargetId } = require('./backup-ownership');
const { normalizeNote, MAX_ATTACHMENT_BYTES } = require('./notes');

function validateNotesData(data) {
  const errors = [];
  const tables = ['notes', 'note_revisions', 'note_attachments', 'note_links'];
  if (!tables.some(table => data?.[table] !== undefined)) return errors;
  const rows = table => Array.isArray(data?.[table]) ? data[table] : [];
  const notes = new Map(rows('notes').map(row => [row?.id, row]));
  const revisions = new Set();
  const links = new Set();
  for (const note of rows('notes')) {
    try { normalizeNote(note); } catch { errors.push('Backup has invalid note text.'); }
    if (typeof note?.origin_key !== 'string' || !/^[a-zA-Z0-9-]{1,36}$/.test(note.origin_key)) errors.push('Backup has an invalid note origin key.');
    if (!Number.isSafeInteger(note?.revision) || note.revision < 1 || note.revision > 4294967295) errors.push('Backup has an invalid note revision.');
    if (note?.trashed_at != null && !Number.isFinite(Date.parse(note.trashed_at))) errors.push('Backup has an invalid note trash date.');
  }
  for (const table of tables.slice(1)) for (const row of rows(table)) {
    const parent = notes.get(row?.note_id);
    if (!parent || parent.user_id !== row?.user_id) { errors.push(`Backup has an invalid ${table} parent.`); continue; }
    if (table === 'note_revisions') {
      try { normalizeNote(row); } catch { errors.push('Backup has invalid note revision text.'); }
      const key = `${row.note_id}:${row.revision}`;
      if (!Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision > parent.revision || revisions.has(key)) errors.push('Backup has invalid or duplicate note revisions.');
      if (row.revision === parent.revision && (row.title !== parent.title || row.body !== parent.body)) errors.push('Backup current note revision does not match its text.');
      revisions.add(key);
    }
    if (table === 'note_attachments' && (typeof row.filename !== 'string' || !row.filename || row.filename.length > 255 || typeof row.content_type !== 'string' || row.content_type.length > 128 || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 1 || row.size_bytes > MAX_ATTACHMENT_BYTES)) errors.push('Backup has invalid note attachment metadata.');
    if (table === 'note_links') {
      const linked = notes.get(row.linked_note_id);
      const key = `${row.note_id}:${row.linked_note_id}`;
      if (!linked || linked.user_id !== row.user_id || row.note_id === row.linked_note_id || links.has(key)) errors.push('Backup has an invalid or duplicate note link.');
      links.add(key);
    }
  }
  for (const note of rows('notes')) if (!revisions.has(`${note?.id}:${note?.revision}`)) errors.push('Backup is missing the current note revision.');
  return errors;
}

async function restoreNotes({ connection, userId, data, restoredPaths, conflictMode, checkCancelled }) {
  const idMap = new Map();
  const kept = new Set();
  const claimed = new Set();
  const exactIds = new Map();
  const reservedIds = new Set();
  // Reserve every exact owned identity before matching lineage. An earlier copy
  // must never consume a later source note's exact destination.
  for (const note of data.notes || []) {
    await checkCancelled();
    const [rows] = await connection.execute('SELECT id FROM notes WHERE id = ? AND user_id = ? FOR UPDATE', [note.id, userId]);
    if (rows.length) { exactIds.set(note.id, rows[0].id); reservedIds.add(rows[0].id); }
  }
  const write = async (table, row) => {
    for (const field of ['created_at', 'updated_at', 'trashed_at']) {
      if (row[field] != null) {
        const date = new Date(row[field]);
        if (!Number.isFinite(date.getTime())) throw new Error('Backup has an invalid note timestamp.');
        row[field] = date.toISOString().slice(0, 19).replace('T', ' ');
      }
    }
    const columns = TABLE_POLICIES[table].columns;
    await writeOwnedRow(connection, userId, table, columns, columns.map(column => row[column] ?? null), columns);
  };
  for (const note of data.notes || []) {
    await checkCancelled();
    let existing = exactIds.get(note.id);
    if (existing && claimed.has(existing)) throw new Error('Backup notes cannot share a restore target.');
    if (!existing) {
      const [matches] = await connection.execute('SELECT id FROM notes WHERE user_id = ? AND origin_key = ? ORDER BY id FOR UPDATE', [userId, note.origin_key]);
      existing = matches.find(row => !reservedIds.has(row.id) && !claimed.has(row.id))?.id;
    }
    const id = chooseTargetId(note.id, existing, conflictMode);
    if (claimed.has(id)) throw new Error('Backup notes cannot share a restore target.');
    idMap.set(note.id, id); claimed.add(id);
    if (existing && conflictMode === 'keep_existing') { kept.add(note.id); continue; }
    if (existing && conflictMode === 'replace') {
      // Preserve old bytes for any in-flight export snapshot. Metadata is replaced
      // atomically with its note; rollback can never delete a referenced file.
      for (const table of ['note_revisions', 'note_attachments', 'note_links']) await connection.execute(`DELETE FROM ${table} WHERE note_id = ? AND user_id = ?`, [id, userId]);
    }
    await write('notes', { ...note, id, user_id: userId });
  }
  for (const table of ['note_revisions', 'note_attachments', 'note_links']) for (const source of data[table] || []) {
    await checkCancelled();
    if (kept.has(source.note_id)) continue;
    const note_id = idMap.get(source.note_id);
    if (!note_id) throw new Error('Backup note child has no restored parent.');
    const row = { ...source, user_id: userId, note_id };
    if (table !== 'note_links') row.id = crypto.randomUUID();
    if (table === 'note_attachments') {
      row.storage_path = restoredPaths.get(`note_attachment:${source.id}`);
      if (!row.storage_path) throw new Error('Backup note attachment has no restored file.');
    }
    if (table === 'note_links') {
      row.linked_note_id = idMap.get(source.linked_note_id);
      if (!row.linked_note_id) throw new Error('Backup note link has no restored target.');
    }
    await write(table, row);
  }
  return idMap;
}
module.exports = { validateNotesData, restoreNotes };
