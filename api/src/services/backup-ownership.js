const crypto = require('node:crypto');

const TABLE_KEYS = {
  user_settings: ['user_id', 'setting_key'],
  contacts: ['id'], mail_folders: ['id'], mail_accounts: ['id'], mail_sender_rules: ['id'],
  emails: ['id'], email_attachments: ['id'], mail_email_scores: ['id'],
  calendar_accounts: ['id'], calendar_calendars: ['id'], calendar_events: ['id'],
  calendar_event_subtasks: ['id'], calendar_event_attendees: ['id'], calendar_event_external_refs: ['id'],
  recordings: ['id'], recording_tags: ['id'], recording_tag_links: ['recording_id', 'tag_id'],
};

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Invalid restore SQL identifier');
  return '`' + value + '`';
}

function chooseTargetId(_originalId, existingId, conflictMode, { canKeepBoth = true } = {}) {
  if (existingId && !(conflictMode === 'keep_both' && canKeepBoth)) return existingId;
  // Backup IDs are untrusted and may already belong to another account.
  return crypto.randomUUID();
}

async function writeOwnedRow(connection, userId, table, columns, values, updateColumns) {
  const keys = TABLE_KEYS[table];
  if (!keys || columns.length !== values.length || values[columns.indexOf('user_id')] !== userId) {
    throw new Error('Invalid owned restore write');
  }
  const keyValues = keys.map(key => values[columns.indexOf(key)]);
  const where = keys.map(key => `${identifier(key)} = ?`).join(' AND ') + ' AND user_id = ?';
  const [existing] = await connection.execute(
    `SELECT ${identifier(keys[0])} FROM ${identifier(table)} WHERE ${where} FOR UPDATE`, [...keyValues, userId]
  );
  if (existing.length) {
    const updates = updateColumns.filter(column => column !== 'user_id' && !keys.includes(column));
    if (!updates.length) return;
    await connection.execute(
      `UPDATE ${identifier(table)} SET ${updates.map(column => `${identifier(column)} = ?`).join(', ')} WHERE ${where}`,
      [...updates.map(column => values[columns.indexOf(column)]), ...keyValues, userId]
    );
  } else {
    // Plain INSERT deliberately fails on any unexpected global/unique collision.
    // It can never fall through to an unscoped update of somebody else's row.
    await connection.execute(
      `INSERT INTO ${table} (${columns.map(identifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, values
    );
  }
}

async function resolveOwnedReference(connection, userId, table, sourceId, remapping, { nullable = false } = {}) {
  if (sourceId == null || sourceId === '') {
    if (nullable) return null;
    throw new Error(`Backup has a missing ${table} reference`);
  }
  if (remapping.has(sourceId)) return remapping.get(sourceId);
  const [rows] = await connection.execute(
    `SELECT id FROM ${identifier(table)} WHERE id = ? AND user_id = ? FOR UPDATE`, [sourceId, userId]
  );
  if (!rows.length) throw new Error(`Backup references an unavailable ${table} record`);
  return rows[0].id;
}

async function assertOwnedRelationship(connection, userId, table, id, column, parentId) {
  const [rows] = await connection.execute(
    `SELECT id FROM ${identifier(table)} WHERE id = ? AND user_id = ? AND ${identifier(column)} <=> ? FOR UPDATE`,
    [id, userId, parentId]
  );
  if (!rows.length) throw new Error(`Backup has an inconsistent ${table} relationship`);
}

function validateRestoreRows(data) {
  const errors = [];
  for (const [table, keys] of Object.entries(TABLE_KEYS)) {
    if (data?.[table] === undefined) continue;
    if (!Array.isArray(data[table])) { errors.push(`Backup ${table} must be an array`); continue; }
    const ids = new Set();
    for (const row of data[table]) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) { errors.push(`Invalid backup ${table} row`); continue; }
      if (keys[0] !== 'id') continue;
      if (typeof row.id !== 'string' || !row.id || row.id.length > 36 || ids.has(row.id)) {
        errors.push(`Backup ${table} has an invalid or duplicate ID`);
      }
      ids.add(row.id);
    }
  }
  return errors;
}

module.exports = { chooseTargetId, writeOwnedRow, resolveOwnedReference, assertOwnedRelationship, validateRestoreRows };
