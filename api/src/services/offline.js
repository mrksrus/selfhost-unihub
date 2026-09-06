const { db } = require('../state');
const { serializeCalendarEvent, serializeCalendarAccount, serializeCalendarCalendar,
  serializeCalendarSubtask, serializeCalendarAttendee, safeJsonParse } = require('./calendar');

const OFFLINE_MAIL_LIMIT = 100;
const OFFLINE_MAX_BYTES = 32 * 1024 * 1024;
// Explicit projections keep provider credentials, sync tokens, raw paths and
// future backend-only columns out of the device snapshot.
const SECTIONS = {
  contacts: { table: 'contacts', columns: 'id user_id first_name last_name email email2 email3 phone phone2 phone3 company job_title notes avatar_url is_favorite', order: 'is_favorite DESC, first_name, last_name, id' },
  events: { table: 'calendar_events', columns: 'id user_id calendar_id title description start_time end_time all_day location color recurrence reminder_minutes reminders todo_status is_todo_only done_at created_at updated_at', order: 'start_time, id' },
  subtasks: { table: 'calendar_event_subtasks', columns: 'id event_id user_id title is_done position created_at updated_at', order: 'position, created_at, id' },
  attendees: { table: 'calendar_event_attendees', columns: 'id user_id event_id email display_name response_status is_organizer optional_attendee comment created_at updated_at', order: 'created_at, id' },
  calendars: { table: 'calendar_calendars', columns: 'id user_id account_id name color is_visible auto_todo_enabled read_only is_primary created_at updated_at', order: 'created_at, id' },
  calendarAccounts: { table: 'calendar_accounts', columns: 'id user_id provider account_email display_name is_active capabilities created_at updated_at', order: 'created_at, id' },
  mailAccounts: { table: 'mail_accounts', columns: 'id user_id email_address display_name is_active last_synced_at created_at', order: 'created_at, id' },
  folders: { table: 'mail_folders', columns: 'id user_id slug display_name is_system position', order: 'position, slug' },
  emails: { table: 'emails', columns: 'id user_id mail_account_id message_id subject from_address from_name to_addresses cc_addresses bcc_addresses body_text body_html folder is_read is_starred is_draft has_attachments received_at created_at',
    filter: ' AND is_draft = FALSE', order: 'received_at DESC, id DESC', limit: OFFLINE_MAIL_LIMIT },
};
const groupByEvent = rows => {
  const grouped = new Map();
  for (const row of rows) { const values = grouped.get(row.event_id) || []; values.push(row); grouped.set(row.event_id, values); }
  return grouped;
};
const budgetError = () => Object.assign(new Error('Contacts, events and the latest 100 messages exceed the 32 MiB offline storage budget. The previous snapshot was kept.'), { status: 413 });
const fieldsFor = section => section.columns.split(' ');
function selectSql(section) {
  return `SELECT ${fieldsFor(section).join(', ')} FROM ${section.table} WHERE user_id = ?${section.filter || ''} ORDER BY ${section.order}${section.limit ? ` LIMIT ${section.limit}` : ''}`;
}
function projectRows(rows, section) {
  return rows.map(row => Object.fromEntries(fieldsFor(section).map(key => [key, row[key]])));
}
async function preflightSection(connection, section, userId) {
  const objectFields = fieldsFor(section).map(column => `'${column}', \`${column}\``).join(', ');
  const [[size]] = await connection.execute(
    `SELECT COALESCE(SUM(OCTET_LENGTH(JSON_OBJECT(${objectFields}))), 0) AS estimated_bytes FROM (${selectSql(section)}) offline_rows`, [userId]
  );
  return Number(size.estimated_bytes) || 0;
}
function parseRecipients(value) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

async function collectOfflineSnapshot(connection, userId) {
  if (!userId) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  let estimatedBytes = 0;
  // Size-check every selected section before transferring potentially large
  // notes/descriptions/mail bodies into Node. Reads share one repeatable snapshot.
  for (const section of Object.values(SECTIONS)) {
    estimatedBytes += await preflightSection(connection, section, userId);
    if (estimatedBytes > OFFLINE_MAX_BYTES) throw budgetError();
  }
  const data = {};
  for (const [key, section] of Object.entries(SECTIONS)) {
    const [rows] = await connection.execute(selectSql(section), [userId]);
    data[key] = projectRows(rows, section);
  }
  const subtasks = groupByEvent(data.subtasks.map(serializeCalendarSubtask));
  const attendees = groupByEvent(data.attendees.map(serializeCalendarAttendee));
  const events = data.events.map(row => serializeCalendarEvent(row, subtasks.get(row.id) || [], attendees.get(row.id) || []));
  let attachmentRows = [];
  if (data.emails.length) {
    const section = { columns: 'id email_id filename content_type size_bytes' };
    const placeholders = data.emails.map(() => '?').join(',');
    const params = [userId, ...data.emails.map(row => row.id)];
    const query = `SELECT ${fieldsFor(section).join(', ')} FROM email_attachments WHERE user_id = ? AND email_id IN (${placeholders})`;
    const objectFields = fieldsFor(section).map(column => `'${column}', \`${column}\``).join(', ');
    const [[size]] = await connection.execute(`SELECT COALESCE(SUM(OCTET_LENGTH(JSON_OBJECT(${objectFields}))), 0) AS estimated_bytes FROM (${query}) offline_rows`, params);
    if (estimatedBytes + (Number(size.estimated_bytes) || 0) > OFFLINE_MAX_BYTES) throw budgetError();
    const [rows] = await connection.execute(query, params);
    attachmentRows = projectRows(rows, section);
  }
  const attachmentsByEmail = new Map();
  for (const attachment of attachmentRows) {
    const list = attachmentsByEmail.get(attachment.email_id) || [];
    list.push({ ...attachment, offline_available: false });
    attachmentsByEmail.set(attachment.email_id, list);
  }
  const emails = data.emails.map(row => ({ ...row, to_addresses: parseRecipients(row.to_addresses),
    cc_addresses: parseRecipients(row.cc_addresses), bcc_addresses: parseRecipients(row.bcc_addresses),
    is_read: !!row.is_read, is_starred: !!row.is_starred, is_draft: false, has_attachments: !!row.has_attachments,
    attachments: attachmentsByEmail.get(row.id) || [] }));
  const snapshot = { version: 1, userId, savedAt: new Date().toISOString(),
    contacts: data.contacts.map(row => ({ ...row, is_favorite: !!row.is_favorite })), events,
    calendars: projectRows(data.calendars.map(serializeCalendarCalendar), SECTIONS.calendars),
    calendarAccounts: projectRows(data.calendarAccounts.map(serializeCalendarAccount), SECTIONS.calendarAccounts),
    mailAccounts: data.mailAccounts.map(row => ({ ...row, is_active: !!row.is_active })),
    folders: data.folders.map(row => ({ ...row, is_system: !!row.is_system })), emails,
    limits: { mail: OFFLINE_MAIL_LIMIT, bytes: OFFLINE_MAX_BYTES, attachments: false }, bytes: 0 };
  let measuredBytes;
  while ((measuredBytes = Buffer.byteLength(JSON.stringify(snapshot))) !== snapshot.bytes) snapshot.bytes = measuredBytes;
  if (snapshot.bytes > OFFLINE_MAX_BYTES) throw budgetError();
  return snapshot;
}

async function createOfflineSnapshot(userId) {
  if (!userId) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const connection = await db.getConnection();
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.beginTransaction();
    const snapshot = await collectOfflineSnapshot(connection, userId);
    await connection.commit();
    return snapshot;
  } catch (error) { await connection.rollback().catch(() => {}); throw error; }
  finally { connection.release(); }
}
module.exports = { createOfflineSnapshot, collectOfflineSnapshot, OFFLINE_MAX_BYTES, OFFLINE_MAIL_LIMIT };
