const crypto = require('crypto');
const { db } = require('../state');
const { decrypt } = require('../security/encryption');
const {
  CALENDAR_SYNC_ENABLED,
  CALENDAR_SYNC_PROVIDER_GOOGLE_ENABLED,
  CALENDAR_SYNC_PROVIDER_MICROSOFT_ENABLED,
  CALENDAR_SYNC_PROVIDER_ICLOUD_ENABLED,
} = require('../config');
const { getCalendarEventIdFromPath, getCalendarSubtaskIdFromPath } = require('../../calendar-route-utils');

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

const CALENDAR_PROVIDER_DEFAULT_CAPABILITIES = {
  local: {
    sync: false,
    invites: false,
    rsvp: false,
    deletePropagation: false,
  },
  google: {
    sync: true,
    invites: true,
    rsvp: true,
    deletePropagation: true,
  },
  microsoft: {
    sync: true,
    invites: true,
    rsvp: true,
    deletePropagation: true,
  },
  icloud: {
    sync: true,
    invites: 'limited',
    rsvp: 'limited',
    deletePropagation: true,
  },
  ical: {
    sync: true,
    invites: false,
    rsvp: false,
    deletePropagation: false,
  },
};

function normalizeCalendarAccountProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (!normalized) return null;
  if (['local', 'google', 'microsoft', 'icloud', 'ical'].includes(normalized)) return normalized;
  return null;
}

function serializeCalendarAccount(row) {
  const provider = normalizeCalendarAccountProvider(row.provider) || 'local';
  const capabilities = safeJsonParse(row.capabilities, null) || CALENDAR_PROVIDER_DEFAULT_CAPABILITIES[provider] || CALENDAR_PROVIDER_DEFAULT_CAPABILITIES.local;
  const providerConfig = safeJsonParse(row.provider_config, {});
  return {
    id: row.id,
    user_id: row.user_id,
    provider,
    account_email: row.account_email || null,
    display_name: row.display_name || null,
    token_expires_at: row.token_expires_at instanceof Date ? row.token_expires_at.toISOString() : (row.token_expires_at || null),
    provider_config: providerConfig || {},
    capabilities,
    is_active: !!row.is_active,
    last_synced_at: row.last_synced_at instanceof Date ? row.last_synced_at.toISOString() : (row.last_synced_at || null),
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
    external_id: row.external_id || null,
    color: row.color || '#22c55e',
    is_visible: !!row.is_visible,
    auto_todo_enabled: !!row.auto_todo_enabled,
    read_only: !!row.read_only,
    is_primary: !!row.is_primary,
    sync_token: row.sync_token || null,
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
    `SELECT c.*, a.provider, a.account_email, a.encrypted_access_token, a.encrypted_refresh_token,
            a.provider_config, a.capabilities, a.token_expires_at, a.id AS account_id, a.is_active AS account_is_active
     FROM calendar_calendars c
     INNER JOIN calendar_accounts a ON a.id = c.account_id
     WHERE c.id = ? AND c.user_id = ? AND a.user_id = ?
     LIMIT 1`,
    [calendarId, userId, userId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const accountRow = {
    ...row,
    id: row.account_id,
  };
  return {
    calendar: serializeCalendarCalendar(row),
    account: serializeCalendarAccount(accountRow),
    rawAccount: row,
  };
}

async function getExternalRefForEvent(userId, eventId, connection = db) {
  const [rows] = await connection.execute(
    'SELECT * FROM calendar_event_external_refs WHERE user_id = ? AND event_id = ? LIMIT 1',
    [userId, eventId]
  );
  return rows[0] || null;
}

async function upsertExternalRef(
  userId,
  eventId,
  calendarId,
  accountId,
  provider,
  externalEventId,
  externalEtag = null,
  externalUpdatedAt = null,
  connection = db
) {
  const [existingRows] = await connection.execute(
    'SELECT id FROM calendar_event_external_refs WHERE account_id = ? AND external_event_id = ? LIMIT 1',
    [accountId, externalEventId]
  );
  if (existingRows.length > 0) {
    await connection.execute(
      `UPDATE calendar_event_external_refs
       SET user_id = ?, event_id = ?, calendar_id = ?, provider = ?, external_etag = ?, external_updated_at = ?, last_synced_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [userId, eventId, calendarId, provider, externalEtag, externalUpdatedAt, existingRows[0].id]
    );
    return existingRows[0].id;
  }

  const refId = crypto.randomUUID();
  await connection.execute(
    `INSERT INTO calendar_event_external_refs
      (id, user_id, event_id, calendar_id, account_id, provider, external_event_id, external_etag, external_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [refId, userId, eventId, calendarId, accountId, provider, externalEventId, externalEtag, externalUpdatedAt]
  );
  return refId;
}

async function findCalendarByExternalId(accountId, externalId) {
  const [rows] = await db.execute(
    'SELECT * FROM calendar_calendars WHERE account_id = ? AND external_id = ? LIMIT 1',
    [accountId, externalId]
  );
  return rows[0] || null;
}

async function upsertCalendarFromProvider(userId, account, providerCalendar) {
  const externalId = String(providerCalendar.external_id || '').trim();
  if (!externalId) return null;
  const existing = await findCalendarByExternalId(account.id, externalId);
  if (existing) {
    await db.execute(
      `UPDATE calendar_calendars
       SET name = ?, color = ?, read_only = ?, is_primary = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [
        providerCalendar.name || existing.name,
        providerCalendar.color || existing.color || '#22c55e',
        !!providerCalendar.read_only,
        !!providerCalendar.is_primary,
        existing.id,
        userId,
      ]
    );
    const [rows] = await db.execute('SELECT * FROM calendar_calendars WHERE id = ? LIMIT 1', [existing.id]);
    return rows[0] || null;
  }

  const calendarId = crypto.randomUUID();
  await db.execute(
    `INSERT INTO calendar_calendars
      (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary)
     VALUES (?, ?, ?, ?, ?, ?, TRUE, TRUE, ?, ?)`,
    [
      calendarId,
      userId,
      account.id,
      providerCalendar.name || 'Imported Calendar',
      externalId,
      providerCalendar.color || '#22c55e',
      !!providerCalendar.read_only,
      !!providerCalendar.is_primary,
    ]
  );
  const [rows] = await db.execute('SELECT * FROM calendar_calendars WHERE id = ? LIMIT 1', [calendarId]);
  return rows[0] || null;
}

function providerSyncEnabled(provider) {
  if (!CALENDAR_SYNC_ENABLED) return false;
  if (provider === 'google') return CALENDAR_SYNC_PROVIDER_GOOGLE_ENABLED;
  if (provider === 'microsoft') return CALENDAR_SYNC_PROVIDER_MICROSOFT_ENABLED;
  if (provider === 'icloud') return CALENDAR_SYNC_PROVIDER_ICLOUD_ENABLED;
  if (provider === 'ical') return true; // no OAuth or env required
  return false;
}

function formatProviderDateRange(value) {
  const parsed = parseDatetimeToMillis(value);
  if (parsed === null) return null;
  return new Date(parsed).toISOString();
}

function eventTimeToProviderPayload(startTime, endTime, allDay) {
  if (allDay) {
    const startDate = formatEventDateOnly(startTime);
    const endDate = formatEventDateOnly(endTime);
    return {
      startDate,
      endDate,
    };
  }
  return {
    startDateTime: new Date(startTime).toISOString(),
    endDateTime: new Date(endTime).toISOString(),
  };
}

function formatEventDateOnly(isoOrDatetime) {
  const timestamp = parseDatetimeToMillis(isoOrDatetime);
  if (timestamp === null) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function parseGoogleEventDate(event, fieldName) {
  const dateValue = event?.[fieldName];
  if (!dateValue) return null;
  if (dateValue.dateTime) return toMysqlDatetime(dateValue.dateTime);
  if (dateValue.date) {
    return toMysqlDatetime(`${dateValue.date}T00:00:00Z`);
  }
  return null;
}

function parseMicrosoftEventDate(event, fieldName) {
  const dateValue = event?.[fieldName];
  if (!dateValue?.dateTime) return null;
  if (dateValue.timeZone && dateValue.timeZone.toUpperCase() !== 'UTC') {
    const maybeIso = `${dateValue.dateTime}${dateValue.dateTime.endsWith('Z') ? '' : 'Z'}`;
    return toMysqlDatetime(maybeIso);
  }
  return toMysqlDatetime(dateValue.dateTime);
}

function parseIcsDateValue(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  // YYYYMMDD
  if (/^\d{8}$/.test(value)) {
    const yyyy = value.slice(0, 4);
    const mm = value.slice(4, 6);
    const dd = value.slice(6, 8);
    return toMysqlDatetime(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  }
  // YYYYMMDDTHHmmssZ or without Z
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (match) {
    const [, y, m, d, hh, mm, ss, z] = match;
    return toMysqlDatetime(`${y}-${m}-${d}T${hh}:${mm}:${ss}${z || 'Z'}`);
  }
  return toMysqlDatetime(value);
}

function parseIcsEvents(icsText) {
  const blocks = String(icsText || '').split('BEGIN:VEVENT').slice(1).map((chunk) => chunk.split('END:VEVENT')[0]);
  const events = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const event = {
      uid: null,
      title: null,
      description: null,
      location: null,
      start: null,
      end: null,
      status: null,
      all_day: false,
      attendees: [],
    };
    for (const line of lines) {
      if (line.startsWith('UID:')) {
        event.uid = line.slice(4).trim();
      } else if (line.startsWith('SUMMARY:')) {
        event.title = line.slice(8).trim();
      } else if (line.startsWith('DESCRIPTION:')) {
        event.description = line.slice(12).trim();
      } else if (line.startsWith('LOCATION:')) {
        event.location = line.slice(9).trim();
      } else if (line.startsWith('STATUS:')) {
        event.status = line.slice(7).trim().toUpperCase();
      } else if (line.startsWith('DTSTART')) {
        const value = line.split(':').slice(1).join(':');
        event.start = parseIcsDateValue(value);
        event.all_day = /VALUE=DATE/.test(line);
      } else if (line.startsWith('DTEND')) {
        const value = line.split(':').slice(1).join(':');
        event.end = parseIcsDateValue(value);
      } else if (line.startsWith('ATTENDEE')) {
        const emailMatch = line.match(/mailto:([^;:\s]+)/i);
        if (emailMatch?.[1]) {
          event.attendees.push({
            email: emailMatch[1].trim().toLowerCase(),
            response_status: 'needsAction',
          });
        }
      }
    }
    if (!event.uid || !event.start) continue;
    if (!event.end) {
      const startMs = parseDatetimeToMillis(event.start);
      event.end = startMs ? toMysqlDatetime(new Date(startMs + 60 * 60 * 1000).toISOString()) : event.start;
    }
    events.push(event);
  }
  return events;
}

function googleAttendeesToLocal(attendees) {
  if (!Array.isArray(attendees)) return [];
  return attendees
    .filter((attendee) => attendee?.email)
    .map((attendee) => ({
      email: String(attendee.email).trim().toLowerCase(),
      display_name: attendee.displayName || null,
      response_status: normalizeResponseStatus(attendee.responseStatus),
      is_organizer: !!attendee.organizer,
      optional_attendee: !!attendee.optional,
    }));
}

function microsoftAttendeesToLocal(attendees) {
  if (!Array.isArray(attendees)) return [];
  return attendees
    .filter((attendee) => attendee?.emailAddress?.address)
    .map((attendee) => ({
      email: String(attendee.emailAddress.address).trim().toLowerCase(),
      display_name: attendee.emailAddress.name || null,
      response_status: normalizeResponseStatus(attendee?.status?.response),
      is_organizer: false,
      optional_attendee: attendee?.type === 'optional',
    }));
}

async function providerRequest(accountRow, options) {
  const provider = normalizeCalendarAccountProvider(accountRow.provider);
  if (!providerSyncEnabled(provider)) {
    return { ok: false, status: 503, error: `Calendar sync provider disabled: ${provider}` };
  }

  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };
  let body = options.body;

  if (provider === 'google' || provider === 'microsoft') {
    const accessToken = accountRow.encrypted_access_token ? decrypt(accountRow.encrypted_access_token) : null;
    if (!accessToken) {
      return { ok: false, status: 400, error: `Missing access token for ${provider} account` };
    }
    headers.Authorization = `Bearer ${accessToken}`;
  } else if (provider === 'icloud' || provider === 'ical') {
    const config = safeJsonParse(accountRow.provider_config, {}) || {};
    const username = config.username || accountRow.account_email || null;
    const password = accountRow.encrypted_access_token ? decrypt(accountRow.encrypted_access_token) : null;
    if (username && password) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }
  }

  if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof String)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = headers['Content-Type'].includes('application/json') ? JSON.stringify(body) : body;
  }

  const response = await fetch(options.url, {
    method: options.method || 'GET',
    headers,
    body,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: json?.error?.message || json?.error_description || json?.error || text || `HTTP ${response.status}`,
      data: json,
      text,
    };
  }
  return {
    ok: true,
    status: response.status,
    data: json,
    text,
  };
}

async function upsertProviderEventIntoLocal({
  userId,
  accountRow,
  calendarRow,
  providerEvent,
  provider,
}) {
  const externalEventId = String(providerEvent.external_event_id || '').trim();
  if (!externalEventId) return null;
  const deleted = !!providerEvent.deleted;

  const [existingRefRows] = await db.execute(
    'SELECT * FROM calendar_event_external_refs WHERE account_id = ? AND external_event_id = ? LIMIT 1',
    [accountRow.id, externalEventId]
  );
  const existingRef = existingRefRows[0] || null;

  if (deleted) {
    if (existingRef) {
      await db.execute('DELETE FROM calendar_events WHERE id = ? AND user_id = ?', [existingRef.event_id, userId]);
    }
    return null;
  }

  const title = providerEvent.title?.trim() || 'Untitled Event';
  const start = toMysqlDatetime(providerEvent.start_time);
  const end = toMysqlDatetime(providerEvent.end_time);
  if (!start || !end) return null;

  let eventId = existingRef?.event_id || null;
  if (eventId) {
    await db.execute(
      `UPDATE calendar_events
       SET calendar_id = ?, title = ?, description = ?, start_time = ?, end_time = ?, all_day = ?, location = ?, color = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [
        calendarRow.id,
        title,
        providerEvent.description || null,
        start,
        end,
        !!providerEvent.all_day,
        providerEvent.location || null,
        calendarRow.color || '#22c55e',
        eventId,
        userId,
      ]
    );
  } else {
    eventId = crypto.randomUUID();
    await db.execute(
      `INSERT INTO calendar_events
        (id, user_id, calendar_id, title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes, reminders, is_todo_only)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, FALSE)`,
      [
        eventId,
        userId,
        calendarRow.id,
        title,
        providerEvent.description || null,
        start,
        end,
        !!providerEvent.all_day,
        providerEvent.location || null,
        calendarRow.color || '#22c55e',
      ]
    );
  }

  await upsertExternalRef(
    userId,
    eventId,
    calendarRow.id,
    accountRow.id,
    provider,
    externalEventId,
    providerEvent.external_etag || null,
    providerEvent.external_updated_at ? toMysqlDatetime(providerEvent.external_updated_at) : null
  );
  await replaceEventAttendees(userId, eventId, providerEvent.attendees || []);
  return eventId;
}

function localEventToGooglePayload(event) {
  const attendees = (event.attendees || []).map((attendee) => ({
    email: attendee.email,
    displayName: attendee.display_name || undefined,
    responseStatus: attendee.response_status || 'needsAction',
    optional: !!attendee.optional_attendee,
  }));
  if (event.all_day) {
    return {
      summary: event.title,
      description: event.description || undefined,
      location: event.location || undefined,
      start: { date: formatEventDateOnly(event.start_time) },
      end: { date: formatEventDateOnly(event.end_time) },
      attendees,
    };
  }
  return {
    summary: event.title,
    description: event.description || undefined,
    location: event.location || undefined,
    start: { dateTime: new Date(event.start_time).toISOString() },
    end: { dateTime: new Date(event.end_time).toISOString() },
    attendees,
  };
}

function localEventToMicrosoftPayload(event) {
  const attendees = (event.attendees || []).map((attendee) => ({
    emailAddress: {
      address: attendee.email,
      name: attendee.display_name || attendee.email,
    },
    type: attendee.optional_attendee ? 'optional' : 'required',
  }));
  return {
    subject: event.title,
    body: {
      contentType: 'text',
      content: event.description || '',
    },
    start: {
      dateTime: new Date(event.start_time).toISOString(),
      timeZone: 'UTC',
    },
    end: {
      dateTime: new Date(event.end_time).toISOString(),
      timeZone: 'UTC',
    },
    location: event.location ? { displayName: event.location } : undefined,
    isAllDay: !!event.all_day,
    attendees,
  };
}

async function pushLocalEventToProvider(userId, eventId) {
  if (!CALENDAR_SYNC_ENABLED) return { skipped: true };
  const event = await getCalendarEventWithSubtasks(userId, eventId);
  if (!event?.calendar_id) return { skipped: true };
  const context = await loadCalendarWithAccount(userId, event.calendar_id);
  if (!context) return { skipped: true };
  const { calendar, account, rawAccount } = context;
  if (!providerSyncEnabled(account.provider) || account.provider === 'local') return { skipped: true };
  if (calendar.read_only) return { skipped: true, reason: 'calendar_read_only' };

  const existingRef = await getExternalRefForEvent(userId, eventId);
  if (account.provider === 'google') {
    const payload = localEventToGooglePayload(event);
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.external_id || 'primary')}/events`;
    const url = existingRef ? `${base}/${encodeURIComponent(existingRef.external_event_id)}?sendUpdates=all` : `${base}?sendUpdates=all`;
    const response = await providerRequest(rawAccount, {
      url,
      method: existingRef ? 'PATCH' : 'POST',
      body: payload,
    });
    if (!response.ok) return { error: response.error, status: response.status || 500 };
    const eventData = response.data || {};
    await upsertExternalRef(
      userId,
      eventId,
      calendar.id,
      account.id,
      account.provider,
      eventData.id,
      eventData.etag || null,
      eventData.updated || null
    );
    return { success: true };
  }

  if (account.provider === 'microsoft') {
    const payload = localEventToMicrosoftPayload(event);
    const base = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendar.external_id || '')}/events`;
    const url = existingRef ? `${base}/${encodeURIComponent(existingRef.external_event_id)}` : base;
    const response = await providerRequest(rawAccount, {
      url,
      method: existingRef ? 'PATCH' : 'POST',
      body: payload,
    });
    if (!response.ok) return { error: response.error, status: response.status || 500 };
    const eventData = response.data || {};
    const externalId = existingRef ? existingRef.external_event_id : eventData.id;
    await upsertExternalRef(
      userId,
      eventId,
      calendar.id,
      account.id,
      account.provider,
      externalId,
      eventData['@odata.etag'] || null,
      eventData.lastModifiedDateTime || null
    );
    return { success: true };
  }

  // Limited iCloud write support (requires explicit writable event URL template in provider_config).
  if (account.provider === 'icloud') {
    const config = safeJsonParse(rawAccount.provider_config, {}) || {};
    const eventBaseUrl = config?.caldav_event_base_url;
    if (!eventBaseUrl) return { skipped: true, reason: 'icloud_write_not_configured' };
    const refId = existingRef?.external_event_id || `${event.id}.ics`;
    const targetUrl = `${String(eventBaseUrl).replace(/\/$/, '')}/${encodeURIComponent(refId)}`;
    const icsBody = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//UniHub//Calendar//EN',
      'BEGIN:VEVENT',
      `UID:${existingRef?.external_event_id || event.id}`,
      `SUMMARY:${event.title || ''}`,
      event.description ? `DESCRIPTION:${event.description}` : '',
      event.location ? `LOCATION:${event.location}` : '',
      `DTSTART:${new Date(event.start_time).toISOString().replace(/[-:]/g, '').replace('.000', '')}`,
      `DTEND:${new Date(event.end_time).toISOString().replace(/[-:]/g, '').replace('.000', '')}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean).join('\r\n');
    const response = await providerRequest(rawAccount, {
      url: targetUrl,
      method: 'PUT',
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
      body: icsBody,
    });
    if (!response.ok) return { error: response.error, status: response.status || 500 };
    await upsertExternalRef(
      userId,
      eventId,
      calendar.id,
      account.id,
      account.provider,
      existingRef?.external_event_id || event.id
    );
    return { success: true, limited: true };
  }

  return { skipped: true };
}

async function deleteLocalEventOnProvider(userId, eventId) {
  if (!CALENDAR_SYNC_ENABLED) return { skipped: true };
  const ref = await getExternalRefForEvent(userId, eventId);
  if (!ref) return { skipped: true };
  const [rows] = await db.execute('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ? LIMIT 1', [ref.account_id, userId]);
  if (rows.length === 0) return { skipped: true };
  const accountRow = rows[0];
  const account = serializeCalendarAccount(accountRow);
  if (!providerSyncEnabled(account.provider) || account.provider === 'local') return { skipped: true };

  if (account.provider === 'google') {
    const [calRows] = await db.execute('SELECT external_id FROM calendar_calendars WHERE id = ? LIMIT 1', [ref.calendar_id]);
    const externalCalendarId = calRows[0]?.external_id || 'primary';
    const response = await providerRequest(accountRow, {
      url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(externalCalendarId)}/events/${encodeURIComponent(ref.external_event_id)}?sendUpdates=all`,
      method: 'DELETE',
    });
    if (!response.ok && response.status !== 404) return { error: response.error, status: response.status || 500 };
  } else if (account.provider === 'microsoft') {
    const [calRows] = await db.execute('SELECT external_id FROM calendar_calendars WHERE id = ? LIMIT 1', [ref.calendar_id]);
    const externalCalendarId = calRows[0]?.external_id;
    if (externalCalendarId) {
      const response = await providerRequest(accountRow, {
        url: `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(externalCalendarId)}/events/${encodeURIComponent(ref.external_event_id)}`,
        method: 'DELETE',
      });
      if (!response.ok && response.status !== 404) return { error: response.error, status: response.status || 500 };
    }
  } else if (account.provider === 'icloud') {
    const config = safeJsonParse(accountRow.provider_config, {}) || {};
    const eventBaseUrl = config?.caldav_event_base_url;
    if (eventBaseUrl) {
      const response = await providerRequest(accountRow, {
        url: `${String(eventBaseUrl).replace(/\/$/, '')}/${encodeURIComponent(ref.external_event_id)}`,
        method: 'DELETE',
      });
      if (!response.ok && response.status !== 404) return { error: response.error, status: response.status || 500 };
    }
  }

  return { success: true };
}

async function syncGoogleCalendarAccount(userId, accountRow) {
  const account = serializeCalendarAccount(accountRow);
  const calendarListResponse = await providerRequest(accountRow, {
    url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList',
  });
  if (!calendarListResponse.ok) {
    return { success: false, error: calendarListResponse.error, status: calendarListResponse.status || 500 };
  }

  const calendars = Array.isArray(calendarListResponse.data?.items) ? calendarListResponse.data.items : [];
  let upsertedEvents = 0;
  for (const providerCalendar of calendars) {
    const localCalendar = await upsertCalendarFromProvider(userId, account, {
      external_id: providerCalendar.id,
      name: providerCalendar.summary || providerCalendar.id,
      color: providerCalendar.backgroundColor || '#22c55e',
      read_only: providerCalendar.accessRole === 'reader' || providerCalendar.accessRole === 'freeBusyReader',
      is_primary: !!providerCalendar.primary,
    });
    if (!localCalendar) continue;

    const eventListResponse = await providerRequest(accountRow, {
      url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(providerCalendar.id)}/events?singleEvents=true&showDeleted=true&maxResults=2500`,
    });
    if (!eventListResponse.ok) continue;
    const events = Array.isArray(eventListResponse.data?.items) ? eventListResponse.data.items : [];
    for (const providerEvent of events) {
      const start = parseGoogleEventDate(providerEvent, 'start');
      const end = parseGoogleEventDate(providerEvent, 'end') || start;
      await upsertProviderEventIntoLocal({
        userId,
        accountRow,
        calendarRow: localCalendar,
        provider: 'google',
        providerEvent: {
          external_event_id: providerEvent.id,
          external_etag: providerEvent.etag || null,
          external_updated_at: providerEvent.updated || null,
          title: providerEvent.summary || 'Untitled Event',
          description: providerEvent.description || null,
          location: providerEvent.location || null,
          start_time: start,
          end_time: end,
          all_day: !!providerEvent.start?.date && !providerEvent.start?.dateTime,
          attendees: googleAttendeesToLocal(providerEvent.attendees),
          deleted: providerEvent.status === 'cancelled',
        },
      });
      upsertedEvents += 1;
    }
  }
  await db.execute('UPDATE calendar_accounts SET last_synced_at = UTC_TIMESTAMP() WHERE id = ? AND user_id = ?', [account.id, userId]);
  return { success: true, provider: 'google', syncedEvents: upsertedEvents };
}

async function syncMicrosoftCalendarAccount(userId, accountRow) {
  const account = serializeCalendarAccount(accountRow);
  const calendarResponse = await providerRequest(accountRow, {
    url: 'https://graph.microsoft.com/v1.0/me/calendars?$top=200',
  });
  if (!calendarResponse.ok) {
    return { success: false, error: calendarResponse.error, status: calendarResponse.status || 500 };
  }
  const calendars = Array.isArray(calendarResponse.data?.value) ? calendarResponse.data.value : [];
  let upsertedEvents = 0;
  for (const providerCalendar of calendars) {
    const localCalendar = await upsertCalendarFromProvider(userId, account, {
      external_id: providerCalendar.id,
      name: providerCalendar.name || 'Calendar',
      color: providerCalendar.hexColor || '#22c55e',
      read_only: !providerCalendar.canEdit,
      is_primary: !!providerCalendar.isDefaultCalendar,
    });
    if (!localCalendar) continue;

    const eventsResponse = await providerRequest(accountRow, {
      url: `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(providerCalendar.id)}/events?$top=200`,
    });
    if (!eventsResponse.ok) continue;
    const events = Array.isArray(eventsResponse.data?.value) ? eventsResponse.data.value : [];
    for (const providerEvent of events) {
      const start = parseMicrosoftEventDate(providerEvent, 'start');
      const end = parseMicrosoftEventDate(providerEvent, 'end') || start;
      await upsertProviderEventIntoLocal({
        userId,
        accountRow,
        calendarRow: localCalendar,
        provider: 'microsoft',
        providerEvent: {
          external_event_id: providerEvent.id,
          external_etag: providerEvent['@odata.etag'] || null,
          external_updated_at: providerEvent.lastModifiedDateTime || null,
          title: providerEvent.subject || 'Untitled Event',
          description: providerEvent.bodyPreview || null,
          location: providerEvent.location?.displayName || null,
          start_time: start,
          end_time: end,
          all_day: !!providerEvent.isAllDay,
          attendees: microsoftAttendeesToLocal(providerEvent.attendees),
          deleted: !!providerEvent.isCancelled,
        },
      });
      upsertedEvents += 1;
    }
  }
  await db.execute('UPDATE calendar_accounts SET last_synced_at = UTC_TIMESTAMP() WHERE id = ? AND user_id = ?', [account.id, userId]);
  return { success: true, provider: 'microsoft', syncedEvents: upsertedEvents };
}

async function syncIcloudCalendarAccount(userId, accountRow) {
  const account = serializeCalendarAccount(accountRow);
  const config = safeJsonParse(accountRow.provider_config, {}) || {};
  const configuredCalendars = Array.isArray(config.calendars) ? config.calendars : [];
  const feeds = configuredCalendars.length > 0
    ? configuredCalendars
    : (config.ics_url ? [{
      external_id: config.external_id || 'icloud-default',
      name: config.calendar_name || 'iCloud',
      color: config.color || '#22c55e',
      ics_url: config.ics_url,
    }] : []);

  let upsertedEvents = 0;
  for (const feed of feeds) {
    if (!feed?.ics_url) continue;
    const localCalendar = await upsertCalendarFromProvider(userId, account, {
      external_id: feed.external_id || feed.ics_url,
      name: feed.name || 'iCloud',
      color: feed.color || '#22c55e',
      read_only: false,
      is_primary: !!feed.is_primary,
    });
    if (!localCalendar) continue;

    const response = await providerRequest(accountRow, {
      url: feed.ics_url,
      headers: { Accept: 'text/calendar' },
    });
    if (!response.ok) continue;
    const events = parseIcsEvents(response.text || '');
    for (const providerEvent of events) {
      await upsertProviderEventIntoLocal({
        userId,
        accountRow,
        calendarRow: localCalendar,
        provider: 'icloud',
        providerEvent: {
          external_event_id: providerEvent.uid,
          title: providerEvent.title || 'Untitled Event',
          description: providerEvent.description || null,
          location: providerEvent.location || null,
          start_time: providerEvent.start,
          end_time: providerEvent.end,
          all_day: !!providerEvent.all_day,
          attendees: providerEvent.attendees || [],
          deleted: providerEvent.status === 'CANCELLED',
        },
      });
      upsertedEvents += 1;
    }
  }
  await db.execute('UPDATE calendar_accounts SET last_synced_at = UTC_TIMESTAMP() WHERE id = ? AND user_id = ?', [account.id, userId]);
  return {
    success: true,
    provider: 'icloud',
    syncedEvents: upsertedEvents,
    note: 'iCloud invitation behavior is limited in V1 due CalDAV/provider constraints.',
  };
}

async function syncIcalCalendarAccount(userId, accountRow) {
  const account = serializeCalendarAccount(accountRow);
  const config = safeJsonParse(accountRow.provider_config, {}) || {};
  const configuredCalendars = Array.isArray(config.calendars) ? config.calendars : [];
  const feeds = configuredCalendars.length > 0
    ? configuredCalendars
    : (config.ics_url ? [{
      external_id: config.external_id || 'ical-default',
      name: config.calendar_name || 'Web calendar',
      color: config.color || '#22c55e',
      ics_url: config.ics_url,
    }] : []);

  let upsertedEvents = 0;
  for (const feed of feeds) {
    if (!feed?.ics_url) continue;
    const localCalendar = await upsertCalendarFromProvider(userId, account, {
      external_id: feed.external_id || feed.ics_url,
      name: feed.name || 'Web calendar',
      color: feed.color || '#22c55e',
      read_only: true,
      is_primary: !!feed.is_primary,
    });
    if (!localCalendar) continue;

    const response = await providerRequest(accountRow, {
      url: feed.ics_url,
      headers: { Accept: 'text/calendar' },
    });
    if (!response.ok) continue;
    const events = parseIcsEvents(response.text || '');
    for (const providerEvent of events) {
      await upsertProviderEventIntoLocal({
        userId,
        accountRow,
        calendarRow: localCalendar,
        provider: 'ical',
        providerEvent: {
          external_event_id: providerEvent.uid,
          title: providerEvent.title || 'Untitled Event',
          description: providerEvent.description || null,
          location: providerEvent.location || null,
          start_time: providerEvent.start,
          end_time: providerEvent.end,
          all_day: !!providerEvent.all_day,
          attendees: providerEvent.attendees || [],
          deleted: providerEvent.status === 'CANCELLED',
        },
      });
      upsertedEvents += 1;
    }
  }
  await db.execute('UPDATE calendar_accounts SET last_synced_at = UTC_TIMESTAMP() WHERE id = ? AND user_id = ?', [account.id, userId]);
  return { success: true, provider: 'ical', syncedEvents: upsertedEvents };
}

async function syncCalendarAccount(accountId, userId) {
  const [rows] = await db.execute(
    'SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ? AND is_active = TRUE LIMIT 1',
    [accountId, userId]
  );
  if (rows.length === 0) {
    return { success: false, status: 404, error: 'Calendar account not found' };
  }
  const accountRow = rows[0];
  const provider = normalizeCalendarAccountProvider(accountRow.provider);
  if (!provider || provider === 'local') {
    return { success: true, provider: 'local', syncedEvents: 0 };
  }
  if (!providerSyncEnabled(provider)) {
    return { success: false, status: 503, error: `Calendar sync provider disabled: ${provider}` };
  }

  try {
    if (provider === 'google') return await syncGoogleCalendarAccount(userId, accountRow);
    if (provider === 'microsoft') return await syncMicrosoftCalendarAccount(userId, accountRow);
    if (provider === 'icloud') return await syncIcloudCalendarAccount(userId, accountRow);
    if (provider === 'ical') return await syncIcalCalendarAccount(userId, accountRow);
  } catch (error) {
    console.error('[CALENDAR SYNC] Sync error:', error);
    return { success: false, status: 500, error: error.message || 'Calendar sync failed' };
  }
  return { success: false, status: 400, error: `Unsupported provider: ${provider}` };
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
  getExternalRefForEvent,
  upsertExternalRef,
  findCalendarByExternalId,
  upsertCalendarFromProvider,
  providerSyncEnabled,
  formatProviderDateRange,
  eventTimeToProviderPayload,
  formatEventDateOnly,
  parseGoogleEventDate,
  parseMicrosoftEventDate,
  parseIcsDateValue,
  parseIcsEvents,
  googleAttendeesToLocal,
  microsoftAttendeesToLocal,
  providerRequest,
  upsertProviderEventIntoLocal,
  localEventToGooglePayload,
  localEventToMicrosoftPayload,
  pushLocalEventToProvider,
  deleteLocalEventOnProvider,
  syncGoogleCalendarAccount,
  syncMicrosoftCalendarAccount,
  syncIcloudCalendarAccount,
  syncIcalCalendarAccount,
  syncCalendarAccount,
};
