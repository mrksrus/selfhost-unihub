import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import imported1 = require('../state');
const { db } = imported1;

import imported2 = require('./backup-catalog');
const { normalizeBackupSections } = imported2;

function normalizeSections(value: unknown) {
  let source = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { /* Section names can also be plain text. */ }
  }
  return new Set(normalizeBackupSections(source));
}

async function getActiveRestoreSections(userId: string) {
  const [rows] = await db.execute<(RowDataPacket & { requested_sections: unknown })[]>(
    `SELECT requested_sections
     FROM backup_restore_jobs
     WHERE user_id = ? AND status IN ('queued', 'running', 'cancelling')
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId]
  );
  return rows.length ? normalizeSections(rows[0].requested_sections) : new Set<string>();
}

async function isSectionRestoreActive(userId: string, section: string) {
  const sections = await getActiveRestoreSections(userId);
  return sections.has(section);
}

async function getActiveRestoreSectionsByUser(connection: SqlExecutor = db, userId: string | null = null) {
  const [rows] = await connection.execute<(RowDataPacket & { user_id: string; requested_sections: unknown })[]>(
    `SELECT user_id, requested_sections FROM backup_restore_jobs
     WHERE status IN ('queued', 'running', 'cancelling')${userId ? ' AND user_id = ?' : ''}`,
    userId ? [userId] : []
  );
  const active = new Map<string, Set<string>>();
  for (const row of rows) {
    const sections = active.get(row.user_id) || new Set<string>();
    for (const section of normalizeSections(row.requested_sections)) sections.add(section);
    active.set(row.user_id, sections);
  }
  return active;
}

export = {
  getActiveRestoreSections,
  isSectionRestoreActive,
  getActiveRestoreSectionsByUser,
};
