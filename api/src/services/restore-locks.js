const { db } = require('../state');

const { normalizeBackupSections } = require('./backup-catalog');

function normalizeSections(value) {
  let source = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { /* Section names can also be plain text. */ }
  }
  return new Set(normalizeBackupSections(source));
}

async function getActiveRestoreSections(userId) {
  const [rows] = await db.execute(
    `SELECT requested_sections
     FROM backup_restore_jobs
     WHERE user_id = ? AND status IN ('queued', 'running', 'cancelling')
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId]
  );
  return rows.length ? normalizeSections(rows[0].requested_sections) : new Set();
}

async function isSectionRestoreActive(userId, section) {
  const sections = await getActiveRestoreSections(userId);
  return sections.has(section);
}

async function getActiveRestoreSectionsByUser(connection = db) {
  const [rows] = await connection.execute(
    `SELECT user_id, requested_sections FROM backup_restore_jobs
     WHERE status IN ('queued', 'running', 'cancelling')`
  );
  const active = new Map();
  for (const row of rows) {
    const sections = active.get(row.user_id) || new Set();
    for (const section of normalizeSections(row.requested_sections)) sections.add(section);
    active.set(row.user_id, sections);
  }
  return active;
}

module.exports = {
  getActiveRestoreSections,
  isSectionRestoreActive,
  getActiveRestoreSectionsByUser,
};
