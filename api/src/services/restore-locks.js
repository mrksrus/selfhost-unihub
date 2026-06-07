const { db } = require('../state');

const RESTORE_SECTIONS = new Set(['settings', 'contacts', 'calendar', 'mail', 'recordings']);

function normalizeSections(value) {
  let source = value;
  if (Buffer.isBuffer(source)) source = source.toString('utf8');
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      source = source === 'full' ? Array.from(RESTORE_SECTIONS) : source.split(',');
    }
  }
  if (!Array.isArray(source)) source = Array.from(RESTORE_SECTIONS);
  const sections = new Set();
  for (const item of source) {
    const section = String(item || '').trim().toLowerCase();
    if (section === 'todo') sections.add('calendar');
    else if (RESTORE_SECTIONS.has(section)) sections.add(section);
  }
  return sections.size ? sections : new Set(RESTORE_SECTIONS);
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

module.exports = {
  getActiveRestoreSections,
  isSectionRestoreActive,
};
