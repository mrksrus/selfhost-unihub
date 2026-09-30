const crypto = require('node:crypto');

const { TABLE_POLICIES } = require('./backup-catalog');
const TABLE_KEYS = Object.fromEntries(Object.entries(TABLE_POLICIES).filter(([, policy]) => policy.ownership === 'user_id').map(([table, policy]) => [table, policy.keyColumns]));

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
  for (const account of Array.isArray(data?.mail_accounts) ? data.mail_accounts : []) {
    if (account?.sync_mode !== undefined && !['download', 'sync'].includes(account.sync_mode)) errors.push('Backup has an invalid mail account mode');
  }
  for (const email of Array.isArray(data?.emails) ? data.emails : []) {
    if (email?.remote_missing !== undefined && ![true, false, 0, 1].includes(email.remote_missing)) errors.push('Backup has an invalid remote message state');
  }
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
  for (const row of Array.isArray(data?.recording_transcription_jobs) ? data.recording_transcription_jobs : []) {
    if (row?.status !== 'completed' || row?.transcript_text !== null && typeof row?.transcript_text !== 'string') {
      errors.push('Only completed recording transcripts can be restored');
    }
  }
  for (const row of Array.isArray(data?.tetris_scores) ? data.tetris_scores : []) {
    if (!row || !['score', 'lines', 'level'].every(key => Number.isSafeInteger(row[key]) && row[key] >= (key === 'level' ? 1 : 0) && row[key] <= 4294967295)) {
      errors.push('Backup has an invalid tetris_scores row');
    }
  }
  if (Array.isArray(data?.tetris_scores) && data.tetris_scores.length > 1) errors.push('Backup has duplicate tetris_scores rows');
  for (const table of ['mail_folder_reconciliations', 'mail_folder_recovery_items', 'mail_folder_rule_overrides']) {
    if (data?.[table] === undefined) continue;
    if (!Array.isArray(data[table])) { errors.push(`Backup ${table} must be an array`); continue; }
    const keys = TABLE_POLICIES[table].keyColumns;
    const seen = new Set();
    for (const row of data[table]) {
      if (!row || typeof row !== 'object' || !keys.every(key => typeof row[key] === 'string' && row[key].length > 0 && row[key].length <= 36)) {
        errors.push(`Backup has an invalid ${table} row`); continue;
      }
      const key = JSON.stringify(keys.map(column => row[column]));
      if (seen.has(key)) errors.push(`Backup has duplicate ${table} rows`);
      seen.add(key);
      if (table === 'mail_folder_reconciliations') {
        for (const field of ['inventory', 'previous_mappings']) {
          let value = row[field];
          if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
          if (!Array.isArray(value) || field === 'inventory' && value.some(item => typeof item !== 'string')
            || field === 'previous_mappings' && value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
            errors.push(`Backup has an invalid reconciliation ${field}`);
          }
        }
      }
      if (table === 'mail_folder_recovery_items' && (!row.original_folder || !row.target_folder || !row.action)) errors.push('Backup has an invalid recovery journal row');
      if (table === 'mail_folder_rule_overrides' && (typeof row.target_folder !== 'string' || !row.target_folder || row.target_folder.length > 64)) errors.push('Backup has an invalid rule override destination');
    }
  }
  if (data?.mail_folder_remote_boxes !== undefined) {
    if (!Array.isArray(data.mail_folder_remote_boxes)) {
      errors.push('Backup mail_folder_remote_boxes must be an array');
    } else {
      const pairs = new Set();
      const names = new Set();
      for (const row of data.mail_folder_remote_boxes) {
        if (!row || typeof row !== 'object' || Array.isArray(row)
          || ![row.folder_id, row.mail_account_id].every(id => typeof id === 'string' && id.length > 0 && id.length <= 36)
          || typeof row.remote_name !== 'string' || !row.remote_name.trim() || row.remote_name.length > 255
          || /[\u0000\r\n]/.test(row.remote_name)) {
          errors.push('Backup has an invalid mail_folder_remote_boxes row');
          continue;
        }
        const pair = JSON.stringify([row.folder_id, row.mail_account_id]);
        const name = JSON.stringify([row.mail_account_id, row.remote_name]);
        if (pairs.has(pair) || names.has(name)) errors.push('Backup has duplicate mail folder remote mappings');
        pairs.add(pair);
        names.add(name);
      }
    }
  }
  return errors;
}

module.exports = { chooseTargetId, writeOwnedRow, resolveOwnedReference, assertOwnedRelationship, validateRestoreRows };
