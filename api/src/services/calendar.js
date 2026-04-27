const crypto = require('crypto');
const { db } = require('../state');
const { getCalendarEventIdFromPath, getCalendarSubtaskIdFromPath } = require('../../calendar-route-utils');

const CALENDAR_PROVIDER_DEFAULT_CAPABILITIES = {
  local: {
    sync: false,
    invites: false,
    rsvp: false,
    deletePropagation: false,
  },
};

function parseDatetimeToMillis(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.getTime();

  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const hasTimezone = /[zZ]$|[+-]\d{2}:\d{2}$/.test(normalized);
  const isoValue = hasTimezone ? normalized : `${normalized}Z`;
  const timestamp = new Date(isoValue).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function toMysqlDatetime(value) {
  const timestamp = parseDatetimeToMillis(value);
  if (timestamp === null) return null;
  return new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');
}

function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeCalendarAccountProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  return normalized === 'local' ? 'local' : null;
}

function serializeCalendarAccount(row) {
  const provider = normalizeCalendarAccountProvider(row.provider) || 'local';
  const capabilities = safeJsonParse(row.capabilities, null) || CALENDAR_PROVIDER_DEFAULT_CAPABILITIES.local;
  return {
    id: row.id,
    user_id: row.user_id,
    provider,
    account_email: row.account_email || null,
    display_name: row.display_name || null,
    token_expires_at: null,
    provider_config: {},
    capabilities,
    is_active: !!row.is_active,
    last_synced_at: null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function serializeCalendarCalendar(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    account_id: row.account_id,
    name: row.name,
    external_id: null,
    color: row.color || '#22c55e',
    is_visible: !!row.is_visible,
    auto_todo_enabled: !!row.auto_todo_enabled,
    read_only: false,
    is_primary: !!row.is_primary,
    sync_token: null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

async function ensureDefaultLocalCalendarForUser(userId, connection = db) {
  const [existingCalendars] = await connection.execute(
    `SELECT c.id AS calendar_id, a.id AS account_id
     FROM calendar_calendars c
     INNER JOIN calendar_accounts a ON a.id = c.account_id
     WHERE c.user_id = ? AND a.user_id = ? AND a.provider = 'local'
     ORDER BY c.created_at ASC
     LIMIT 1`,
    [userId, userId]
  );
  if (existingCalendars.length > 0) {
    return {
      accountId: existingCalendars[0].account_id,
      calendarId: existingCalendars[0].calendar_id,
    };
  }

  const accountId = crypto.randomUUID();
  await connection.execute(
    `INSERT INTO calendar_accounts
      (id, user_id, provider, account_email, display_name, capabilities, is_active)
     VALUES (?, ?, 'local', NULL, 'Local Calendar', ?, TRUE)`,
    [accountId, userId, JSON.stringify(CALENDAR_PROVIDER_DEFAULT_CAPABILITIES.local)]
  );

  const calendarId = crypto.randomUUID();
  await connection.execute(
    `INSERT INTO calendar_calendars
      (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary)
     VALUES (?, ?, ?, ?, ?, ?, TRUE, TRUE, FALSE, TRUE)`,
    [calendarId, userId, accountId, 'Default', 'local-default', '#22c55e']
  );

  return { accountId, calendarId };
}

async function backfillCalendarOwnership(connection = db) {
  const [users] = await connection.execute('SELECT id FROM users');
  for (const user of users) {
    const { calendarId } = await ensureDefaultLocalCalendarForUser(user.id, connection);
    await connection.execute(
      'UPDATE calendar_events SET calendar_id = ? WHERE user_id = ? AND calendar_id IS NULL',
      [calendarId, user.id]
    );
  }
}

function getCalendarEventIdFromReq(req) {
  return getCalendarEventIdFromPath(req.url, req.headers.host);
}

function getCalendarSubtaskIdFromReq(req) {
  return getCalendarSubtaskIdFromPath(req.url, req.headers.host);
}

function getCalendarAccountIdFromReq(req) {
  const parts = new URL(req.url, `http://${req.headers.host}`).pathname.split('/').filter(Boolean);
  const accountIdx = parts.indexOf('accounts');
  if (accountIdx === -1) return null;
  return parts[accountIdx + 1] || null;
}

function getCalendarCalendarIdFromReq(req) {
  const parts = new URL(req.url, `http://${req.headers.host}`).pathname.split('/').filter(Boolean);
  const calendarIdx = parts.indexOf('calendars');
  if (calendarIdx === -1) return null;
  return parts[calendarIdx + 1] || null;
}

function serializeCalendarSubtask(row) {
  return {
    ...row,
    is_done: !!row.is_done,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function serializeCalendarAttendee(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    event_id: row.event_id,
    email: row.email,
    display_name: row.display_name || null,
    response_status: row.response_status || 'needsAction',
    is_organizer: !!row.is_organizer,
    optional_attendee: !!row.optional_attendee,
    comment: row.comment || null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function serializeCalendarEvent(row, subtasks = [], attendees = []) {
  return {
    ...row,
    all_day: !!row.all_day,
    is_todo_only: !!row.is_todo_only,
    calendar_id: row.calendar_id || null,
    start_time: row.start_time instanceof Date ? row.start_time.toISOString() : row.start_time,
    end_time: row.end_time instanceof Date ? row.end_time.toISOString() : row.end_time,
    done_at: row.done_at instanceof Date ? row.done_at.toISOString() : (row.done_at || null),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    reminders: row.reminders ? (typeof row.reminders === 'string' ? JSON.parse(row.reminders) : row.reminders) : null,
    subtasks,
    attendees,
  };
}

async function getCalendarSubtasksForEvents(userId, eventIds) {
  if (!eventIds || eventIds.length === 0) return new Map();

  const placeholders = eventIds.map(() => '?').join(', ');
  const [rows] = await db.execute(
    `SELECT * FROM calendar_event_subtasks WHERE user_id = ? AND event_id IN (${placeholders}) ORDER BY position ASC, created_at ASC`,
    [userId, ...eventIds]
  );

  const grouped = new Map();
  rows.forEach((row) => {
    const eventSubtasks = grouped.get(row.event_id) || [];
    eventSubtasks.push(serializeCalendarSubtask(row));
    grouped.set(row.event_id, eventSubtasks);
  });
  return grouped;
}

async function getCalendarAttendeesForEvents(userId, eventIds) {
  if (!eventIds || eventIds.length === 0) return new Map();

  const placeholders = eventIds.map(() => '?').join(', ');
  const [rows] = await db.execute(
    `SELECT * FROM calendar_event_attendees WHERE user_id = ? AND event_id IN (${placeholders}) ORDER BY created_at ASC`,
    [userId, ...eventIds]
  );

  const grouped = new Map();
  rows.forEach((row) => {
    const eventAttendees = grouped.get(row.event_id) || [];
    eventAttendees.push(serializeCalendarAttendee(row));
    grouped.set(row.event_id, eventAttendees);
  });
  return grouped;
}

async function getCalendarEventWithSubtasks(userId, eventId) {
  const [events] = await db.execute('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [eventId, userId]);
  if (events.length === 0) return null;

  const [subtasks] = await db.execute(
    'SELECT * FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ? ORDER BY position ASC, created_at ASC',
    [eventId, userId]
  );
  const [attendees] = await db.execute(
    'SELECT * FROM calendar_event_attendees WHERE event_id = ? AND user_id = ? ORDER BY created_at ASC',
    [eventId, userId]
  );
  return serializeCalendarEvent(
    events[0],
    subtasks.map(serializeCalendarSubtask),
    attendees.map(serializeCalendarAttendee)
  );
}

function normalizeResponseStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['accepted', 'tentative', 'declined', 'needsaction'].includes(normalized)) {
    return normalized === 'needsaction' ? 'needsAction' : normalized;
  }
  return 'needsAction';
}

function normalizeAttendeesPayload(attendees) {
  if (!Array.isArray(attendees)) return [];
  const seen = new Set();
  const normalized = [];
  for (const attendee of attendees) {
    const email = String(attendee?.email || '').trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    normalized.push({
      email,
      display_name: attendee?.display_name ? String(attendee.display_name).trim() : null,
      response_status: normalizeResponseStatus(attendee?.response_status),
      is_organizer: !!attendee?.is_organizer,
      optional_attendee: !!attendee?.optional_attendee,
      comment: attendee?.comment ? String(attendee.comment) : null,
    });
  }
  return normalized;
}

async function replaceEventAttendees(userId, eventId, attendees, connection = db) {
  const normalized = normalizeAttendeesPayload(attendees);
  await connection.execute('DELETE FROM calendar_event_attendees WHERE user_id = ? AND event_id = ?', [userId, eventId]);
  for (const attendee of normalized) {
    await connection.execute(
      `INSERT INTO calendar_event_attendees
        (id, user_id, event_id, email, display_name, response_status, is_organizer, optional_attendee, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        userId,
        eventId,
        attendee.email,
        attendee.display_name,
        attendee.response_status,
        attendee.is_organizer,
        attendee.optional_attendee,
        attendee.comment,
      ]
    );
  }
}

async function loadCalendarWithAccount(userId, calendarId) {
  const [rows] = await db.execute(
    `SELECT c.*, a.provider, a.account_email, a.display_name AS account_display_name,
            a.capabilities, a.id AS account_id, a.is_active AS account_is_active
     FROM calendar_calendars c
     INNER JOIN calendar_accounts a ON a.id = c.account_id
     WHERE c.id = ? AND c.user_id = ? AND a.user_id = ?
     LIMIT 1`,
    [calendarId, userId, userId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    calendar: serializeCalendarCalendar(row),
    account: serializeCalendarAccount({
      id: row.account_id,
      user_id: row.user_id,
      provider: row.provider,
      account_email: row.account_email,
      display_name: row.account_display_name,
      capabilities: row.capabilities,
      is_active: row.account_is_active,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }),
    rawAccount: row,
  };
}

function formatProviderDateRange(value) {
  const parsed = parseDatetimeToMillis(value);
  if (parsed === null) return null;
  return new Date(parsed).toISOString();
}

module.exports = {
  CALENDAR_PROVIDER_DEFAULT_CAPABILITIES,
  parseDatetimeToMillis,
  toMysqlDatetime,
  safeJsonParse,
  normalizeCalendarAccountProvider,
  serializeCalendarAccount,
  serializeCalendarCalendar,
  ensureDefaultLocalCalendarForUser,
  backfillCalendarOwnership,
  getCalendarEventIdFromReq,
  getCalendarSubtaskIdFromReq,
  getCalendarAccountIdFromReq,
  getCalendarCalendarIdFromReq,
  serializeCalendarSubtask,
  serializeCalendarAttendee,
  serializeCalendarEvent,
  getCalendarSubtasksForEvents,
  getCalendarAttendeesForEvents,
  getCalendarEventWithSubtasks,
  normalizeResponseStatus,
  normalizeAttendeesPayload,
  replaceEventAttendees,
  loadCalendarWithAccount,
  formatProviderDateRange,
};
