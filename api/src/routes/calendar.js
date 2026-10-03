const crypto = require('crypto');
const { db } = require('../state');
const {
  CALENDAR_MULTI_ENABLED,
} = require('../config');
const {
  CALENDAR_PROVIDER_DEFAULT_CAPABILITIES,
  normalizeCalendarAccountProvider,
  toMysqlDatetime,
  serializeCalendarAccount,
  getCalendarAccountIdFromReq,
  getCalendarCalendarIdFromReq,
  serializeCalendarCalendar,
  ensureDefaultLocalCalendarForUser,
  formatProviderDateRange,
  getCalendarSubtasksForEvents,
  getCalendarAttendeesForEvents,
  serializeCalendarEvent,
  parseDatetimeToMillis,
  replaceEventAttendees,
  getCalendarEventWithSubtasks,
  getCalendarEventIdFromReq,
  normalizeResponseStatus,
  loadCalendarWithAccount,
  getCalendarSubtaskIdFromReq,
  serializeCalendarSubtask,
} = require('../services/calendar');
const calendarSync = require('../services/calendar-sync');
const calendarAccounts = require('../services/calendar-accounts');

const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key);

async function loadCalendarAccountRow(userId, calendarId) {
  const [rows] = await db.execute(
    `SELECT c.id, c.read_only, a.provider, a.is_active FROM calendar_calendars c
     JOIN calendar_accounts a ON a.id = c.account_id WHERE c.id = ? AND c.user_id = ? LIMIT 1`,
    [calendarId, userId]
  );
  return rows[0] || null;
}

function isRemoteProvider(provider) {
  return calendarSync.REMOTE_PROVIDERS.has(provider);
}

// Write an event change to its calendar server before it is saved locally.
// body says which fields changed; values holds them normalized.
async function pushEventChanges(userId, event, body, values) {
  const changes = {};
  for (const key of ['title', 'description', 'start_time', 'end_time', 'all_day', 'location', 'reminders', 'reminder_minutes']) {
    if (has(body, key)) changes[key] = values[key];
  }
  try {
    const moving = has(body, 'calendar_id') && body.calendar_id && body.calendar_id !== event.calendar_id;
    if (moving) {
      const target = await loadCalendarAccountRow(userId, body.calendar_id);
      if (target && isRemoteProvider(target.provider) && (body.is_todo_only ?? event.is_todo_only)) {
        return { error: 'ToDos without a date cannot be saved to a server calendar.', status: 400 };
      }
      return (await calendarSync.pushEventMove({ userId, event, targetCalendarId: body.calendar_id, changes })) || {};
    }
    if (body.is_todo_only === true && event.calendar_id_remote) {
      return { error: 'ToDos without a date cannot be saved to a server calendar.', status: 400 };
    }
    if (!Object.keys(changes).length) return {};
    const scope = body.scope === 'series' ? 'series' : 'occurrence';
    return (await calendarSync.pushEventUpdate({ userId, event, changes, scope })) || {};
  } catch (error) {
    return calendarSync.calendarErrorResponse(error, 'Could not save the change to the calendar server');
  }
}


module.exports = {
  // Calendar accounts + calendars + events
  'GET /api/calendar/accounts': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!CALENDAR_MULTI_ENABLED) return { error: 'Calendar multi-account feature disabled', status: 503 };
    try {
      await ensureDefaultLocalCalendarForUser(userId);
      const [rows] = await db.execute(
        'SELECT * FROM calendar_accounts WHERE user_id = ? ORDER BY created_at ASC',
        [userId]
      );
      return { accounts: rows.map((row) => serializeCalendarAccount(row)) };
    } catch (error) {
      console.error('Get calendar accounts error:', error);
      return { error: 'Failed to get calendar accounts', status: 500 };
    }
  },

  'POST /api/calendar/accounts': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!CALENDAR_MULTI_ENABLED) return { error: 'Calendar multi-account feature disabled', status: 503 };
    try {
      const provider = normalizeCalendarAccountProvider(body.provider || 'local');
      if (!provider) return { error: 'Unsupported calendar account type', status: 400 };
      if (provider === 'caldav') {
        if (!body.password) return { error: 'A password is needed to connect the calendar.', status: 400 };
        const login = String(body.username || body.account_email || '').trim();
        if (!login) return { error: 'Enter the user name or email address of the calendar account.', status: 400 };
        const email = String(body.account_email || (login.includes('@') ? login : '')).trim() || null;
        return await calendarAccounts.connectCalDavAccount({
          userId, emailAddress: email, displayName: body.display_name?.trim() || null, username: login,
          password: String(body.password), caldavUrl: body.url ? String(body.url).trim() : null, timeZone: body.time_zone,
        });
      }
      if (provider === 'ics') {
        return await calendarAccounts.connectIcsSubscription({
          userId, url: body.url ? String(body.url).trim() : '', displayName: body.display_name?.trim() || null, timeZone: body.time_zone,
        });
      }

      const accountId = crypto.randomUUID();
      const capabilities = CALENDAR_PROVIDER_DEFAULT_CAPABILITIES.local;

      await db.execute(
        `INSERT INTO calendar_accounts
          (id, user_id, provider, account_email, display_name, capabilities, is_active)
         VALUES (?, ?, 'local', ?, ?, ?, ?)`,
        [
          accountId,
          userId,
          body.account_email?.trim() || null,
          body.display_name?.trim() || null,
          JSON.stringify(capabilities),
          body.is_active === false ? 0 : 1,
        ]
      );

      await db.execute(
        `INSERT INTO calendar_calendars
          (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, TRUE, FALSE, TRUE)`,
        [
          crypto.randomUUID(),
          userId,
          accountId,
          body.default_calendar_name?.trim() || 'Default',
          'local-default',
          body.default_calendar_color || '#2563eb',
        ]
      );

      const [rows] = await db.execute('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ? LIMIT 1', [accountId, userId]);
      const created = rows[0];
      const account = serializeCalendarAccount(created);
      return { account };
    } catch (error) {
      return calendarSync.calendarErrorResponse(error, 'Failed to connect the calendar');
    }
  },

  'PUT /api/calendar/accounts/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!CALENDAR_MULTI_ENABLED) return { error: 'Calendar multi-account feature disabled', status: 503 };
    try {
      const id = getCalendarAccountIdFromReq(req);
      if (!id) return { error: 'Invalid account id', status: 400 };
      const [existing] = await db.execute('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?', [id, userId]);
      if (existing.length === 0) return { error: 'Calendar account not found', status: 404 };

      const updates = [];
      const params = [];
      if (Object.prototype.hasOwnProperty.call(body, 'account_email')) {
        updates.push('account_email = ?');
        params.push(body.account_email?.trim() || null);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'display_name')) {
        updates.push('display_name = ?');
        params.push(body.display_name?.trim() || null);
      }
      const account = existing[0];
      const remote = isRemoteProvider(account.provider);
      let resume = false;
      if (has(body, 'password') && body.password) {
        if (account.provider !== 'caldav') return { error: 'Only CalDAV accounts have a password', status: 400 };
        // A calendar connected from a mail account uses the mail password.
        if (account.mail_account_id) return { error: 'Change the password in the settings of the mail account.', status: 400 };
        updates.push('encrypted_password = ?');
        params.push(require('../security/encryption').encrypt(String(body.password)));
        if (has(body, 'username') && String(body.username || '').trim()) {
          updates.push('username = ?');
          params.push(String(body.username).trim().slice(0, 255));
        }
        resume = true;
      }
      if (has(body, 'is_active')) {
        if (body.is_active !== false && account.provider === 'caldav' && !account.encrypted_password && !resume) {
          return { error: 'Enter the password again to resume sync.', status: 409, code: 'CALDAV_NO_PASSWORD' };
        }
        updates.push('is_active = ?');
        params.push(body.is_active === false ? 0 : 1);
        if (body.is_active === false && remote) updates.push("sync_status = 'paused'");
        if (body.is_active !== false) resume = true;
      }
      resume = resume && remote && body.is_active !== false;
      if (resume) updates.push("sync_status = 'pending'", 'sync_error = NULL', 'next_sync_at = NULL', 'is_active = TRUE');
      if (updates.length === 0) return { error: 'No fields to update', status: 400 };

      params.push(id, userId);
      await db.execute(`UPDATE calendar_accounts SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
      if (resume) calendarSync.syncCalendarAccountInBackground(id, { userId, reason: 'manual' });
      const [rows] = await db.execute('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ? LIMIT 1', [id, userId]);
      return { account: serializeCalendarAccount(rows[0]) };
    } catch (error) {
      console.error('Update calendar account error:', error);
      return { error: error.message || 'Failed to update calendar account', status: 500 };
    }
  },

  'DELETE /api/calendar/accounts/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!CALENDAR_MULTI_ENABLED) return { error: 'Calendar multi-account feature disabled', status: 503 };
    try {
      const id = getCalendarAccountIdFromReq(req);
      if (!id) return { error: 'Invalid account id', status: 400 };
      const [accounts] = await db.execute('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?', [id, userId]);
      if (accounts.length === 0) return { error: 'Calendar account not found', status: 404 };

      const account = accounts[0];
      if (account.provider === 'local') {
        const [localCountRows] = await db.execute(
          `SELECT COUNT(*) AS count FROM calendar_accounts WHERE user_id = ? AND provider = 'local'`,
          [userId]
        );
        if (Number(localCountRows[0]?.count || 0) <= 1) {
          return { error: 'Cannot delete the last local calendar account', status: 400 };
        }
      }

      // Only the copies in UniHub are removed; the server keeps its calendars.
      await calendarAccounts.removeCalendarAccount(userId, id);
      return { message: 'Calendar account deleted' };
    } catch (error) {
      console.error('Delete calendar account error:', error);
      return { error: error.message || 'Failed to delete calendar account', status: 500 };
    }
  },

  'POST /api/calendar/accounts/:id/sync': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const id = getCalendarAccountIdFromReq(req);
      if (!id) return { error: 'Invalid account id', status: 400 };
      const [rows] = await db.execute('SELECT provider, is_active FROM calendar_accounts WHERE id = ? AND user_id = ?', [id, userId]);
      if (!rows.length) return { error: 'Calendar account not found', status: 404 };
      if (!isRemoteProvider(rows[0].provider)) return { error: 'Local calendars do not sync', status: 400 };
      if (!rows[0].is_active) return { error: 'Sync is paused for this account.', status: 409, code: 'CALENDAR_SYNC_PAUSED' };
      let result;
      try {
        result = await calendarSync.syncCalendarAccount(id, { userId, reason: 'manual', full: body?.full === true });
      } catch (error) {
        // The failure is stored on the account and shown with it.
        result = { ok: false, ...calendarSync.calendarErrorResponse(error, 'Calendar sync failed') };
        delete result.status;
      }
      const [account] = await db.execute('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?', [id, userId]);
      return { result, account: account[0] ? serializeCalendarAccount(account[0]) : null };
    } catch (error) {
      return calendarSync.calendarErrorResponse(error, 'Calendar sync failed');
    }
  },

  'GET /api/calendar/calendars': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!CALENDAR_MULTI_ENABLED) return { error: 'Calendar multi-account feature disabled', status: 503 };
    try {
      await ensureDefaultLocalCalendarForUser(userId);
      const [rows] = await db.execute(
        `SELECT c.*, a.provider, a.display_name AS account_display_name, a.account_email
         FROM calendar_calendars c
         INNER JOIN calendar_accounts a ON a.id = c.account_id
         WHERE c.user_id = ? AND a.user_id = ?
         ORDER BY a.created_at ASC, c.created_at ASC`,
        [userId, userId]
      );
      const calendars = rows.map((row) => ({
        ...serializeCalendarCalendar(row),
        account_provider: row.provider,
        account_display_name: row.account_display_name || null,
        account_email: row.account_email || null,
      }));
      return { calendars };
    } catch (error) {
      console.error('Get calendars error:', error);
      return { error: error.message || 'Failed to get calendars', status: 500 };
    }
  },

  'POST /api/calendar/calendars': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!CALENDAR_MULTI_ENABLED) return { error: 'Calendar multi-account feature disabled', status: 503 };
    try {
      const accountId = body.account_id;
      if (!accountId) return { error: 'account_id is required', status: 400 };
      if (!body.name?.trim()) return { error: 'name is required', status: 400 };
      const [accounts] = await db.execute('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
      if (accounts.length === 0) return { error: 'Calendar account not found', status: 404 };
      const account = accounts[0];
      if (isRemoteProvider(account.provider)) {
        return { error: 'Calendars of this account come from its server. Create the calendar there; it appears after the next sync.', status: 400 };
      }

      const calendarId = crypto.randomUUID();
      await db.execute(
        `INSERT INTO calendar_calendars
          (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          calendarId,
          userId,
          accountId,
          body.name.trim(),
          body.external_id || null,
          body.color || '#2563eb',
          body.is_visible === false ? 0 : 1,
          body.auto_todo_enabled === false ? 0 : 1,
          0,
          !!body.is_primary,
        ]
      );
      const [rows] = await db.execute('SELECT * FROM calendar_calendars WHERE id = ? AND user_id = ? LIMIT 1', [calendarId, userId]);
      return { calendar: serializeCalendarCalendar(rows[0]) };
    } catch (error) {
      console.error('Create calendar error:', error);
      return { error: error.message || 'Failed to create calendar', status: 500 };
    }
  },

  'PUT /api/calendar/calendars/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!CALENDAR_MULTI_ENABLED) return { error: 'Calendar multi-account feature disabled', status: 503 };
    try {
      const id = getCalendarCalendarIdFromReq(req);
      if (!id) return { error: 'Invalid calendar id', status: 400 };
      const [existingRows] = await db.execute('SELECT * FROM calendar_calendars WHERE id = ? AND user_id = ?', [id, userId]);
      if (existingRows.length === 0) return { error: 'Calendar not found', status: 404 };
      const existing = existingRows[0];
      const [[owner]] = await db.execute('SELECT provider FROM calendar_accounts WHERE id = ?', [existing.account_id]);
      const remote = isRemoteProvider(owner?.provider);
      if (remote && has(body, 'name') && body.name?.trim() !== existing.name) {
        return { error: 'Rename this calendar on its server; the new name appears after the next sync.', status: 400 };
      }

      const updates = [];
      const params = [];
      if (!remote && Object.prototype.hasOwnProperty.call(body, 'name')) {
        if (!body.name?.trim()) return { error: 'name cannot be empty', status: 400 };
        updates.push('name = ?');
        params.push(body.name.trim());
      }
      if (Object.prototype.hasOwnProperty.call(body, 'color')) {
        updates.push('color = ?');
        params.push(body.color || '#2563eb');
      }
      if (Object.prototype.hasOwnProperty.call(body, 'is_visible')) {
        updates.push('is_visible = ?');
        params.push(body.is_visible === false ? 0 : 1);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'auto_todo_enabled')) {
        updates.push('auto_todo_enabled = ?');
        params.push(body.auto_todo_enabled === false ? 0 : 1);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'is_primary')) {
        updates.push('is_primary = ?');
        params.push(body.is_primary === true ? 1 : 0);
      }
      if (updates.length === 0) return { error: 'No fields to update', status: 400 };

      // Keep only one primary calendar per account when requested.
      if (body.is_primary === true) {
        await db.execute('UPDATE calendar_calendars SET is_primary = FALSE WHERE account_id = ? AND user_id = ?', [existing.account_id, userId]);
      }

      params.push(id, userId);
      await db.execute(`UPDATE calendar_calendars SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
      if (Object.prototype.hasOwnProperty.call(body, 'is_visible')) {
        await db.execute('UPDATE notification_config SET reminder_revision = reminder_revision + 1 WHERE id = 1');
      }
      // Synced events take their calendar's color.
      if (remote && has(body, 'color')) {
        await db.execute('UPDATE calendar_events SET color = ? WHERE calendar_id = ? AND user_id = ?', [body.color || '#2563eb', id, userId]);
      }
      const [rows] = await db.execute('SELECT * FROM calendar_calendars WHERE id = ? AND user_id = ? LIMIT 1', [id, userId]);
      return { calendar: serializeCalendarCalendar(rows[0]) };
    } catch (error) {
      console.error('Update calendar error:', error);
      return { error: error.message || 'Failed to update calendar', status: 500 };
    }
  },

  'DELETE /api/calendar/calendars/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!CALENDAR_MULTI_ENABLED) return { error: 'Calendar multi-account feature disabled', status: 503 };
    try {
      const id = getCalendarCalendarIdFromReq(req);
      if (!id) return { error: 'Invalid calendar id', status: 400 };

      const [rows] = await db.execute(
        'SELECT * FROM calendar_calendars WHERE id = ? AND user_id = ? LIMIT 1',
        [id, userId]
      );
      if (rows.length === 0) return { error: 'Calendar not found', status: 404 };
      const calendar = rows[0];
      const [[owner]] = await db.execute('SELECT provider FROM calendar_accounts WHERE id = ?', [calendar.account_id]);
      if (isRemoteProvider(owner?.provider)) {
        return { error: 'Calendars of this account come from its server. Delete the calendar there, or remove the whole account here.', status: 400 };
      }

      const [accountCalendarCountRows] = await db.execute(
        'SELECT COUNT(*) AS count FROM calendar_calendars WHERE account_id = ? AND user_id = ?',
        [calendar.account_id, userId]
      );
      const accountCalendarCount = Number(accountCalendarCountRows[0]?.count || 0);
      if (accountCalendarCount <= 1) {
        return { error: 'Cannot delete the last calendar in this account. Delete the account instead.', status: 400 };
      }

      const [eventsCountRows] = await db.execute(
        'SELECT COUNT(*) AS count FROM calendar_events WHERE user_id = ? AND calendar_id = ?',
        [userId, id]
      );
      const eventsCount = Number(eventsCountRows[0]?.count || 0);
      // Events reference their calendar with ON DELETE SET NULL; remove them first.
      await db.execute('DELETE FROM calendar_events WHERE calendar_id = ? AND user_id = ?', [id, userId]);
      await db.execute('DELETE FROM calendar_calendars WHERE id = ? AND user_id = ?', [id, userId]);

      return {
        message: `Calendar deleted. ${eventsCount} linked event(s) were removed.`,
        deleted_events: eventsCount,
      };
    } catch (error) {
      console.error('Delete calendar error:', error);
      return { error: error.message || 'Failed to delete calendar', status: 500 };
    }
  },

  'GET /api/calendar/events': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      await ensureDefaultLocalCalendarForUser(userId);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const includeTodos = url.searchParams.get('include_todos') === 'true';
      const includeDoneParam = url.searchParams.get('include_done');
      const includeDone = includeDoneParam === null ? true : includeDoneParam === 'true';
      const respectAutoTodo = url.searchParams.get('respect_auto_todo') === 'true';
      const visibleOnly = url.searchParams.get('visible_only') === 'true';
      const rangeStart = formatProviderDateRange(url.searchParams.get('range_start'));
      const rangeEnd = formatProviderDateRange(url.searchParams.get('range_end'));
      const calendarIds = (url.searchParams.get('calendar_ids') || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      let query = `
        SELECT e.*, c.auto_todo_enabled, c.is_visible
        FROM calendar_events e
        LEFT JOIN calendar_calendars c ON c.id = e.calendar_id
        WHERE e.user_id = ?`;
      const params = [userId];

      if (!includeTodos) {
        query += ' AND e.is_todo_only = FALSE';
      }
      if (!includeDone) {
        query += ` AND (e.todo_status IS NULL OR e.todo_status NOT IN ('done', 'cancelled'))`;
      }
      if (respectAutoTodo) {
        query += ' AND (c.auto_todo_enabled = TRUE OR c.auto_todo_enabled IS NULL)';
      }
      if (visibleOnly) {
        query += ' AND (c.is_visible = TRUE OR c.is_visible IS NULL)';
      }
      if (rangeStart) {
        query += ' AND e.end_time >= ?';
        params.push(toMysqlDatetime(rangeStart));
      }
      if (rangeEnd) {
        query += ' AND e.start_time <= ?';
        params.push(toMysqlDatetime(rangeEnd));
      }
      if (calendarIds.length > 0) {
        const placeholders = calendarIds.map(() => '?').join(', ');
        query += ` AND e.calendar_id IN (${placeholders})`;
        params.push(...calendarIds);
      }
      query += ' ORDER BY e.start_time ASC';

      const [rows] = await db.execute(query, params);
      const eventIds = rows.map((row) => row.id);
      const subtasksByEventId = await getCalendarSubtasksForEvents(userId, eventIds);
      const attendeesByEventId = await getCalendarAttendeesForEvents(userId, eventIds);
      const events = rows.map((row) => serializeCalendarEvent(
        row,
        subtasksByEventId.get(row.id) || [],
        attendeesByEventId.get(row.id) || []
      ));
      return { events };
    } catch (error) {
      console.error('Get events error:', error);
      return { error: 'Failed to get events', status: 500 };
    }
  },

  'POST /api/calendar/events': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!body.title?.trim()) return { error: 'Title is required', status: 400 };

    try {
      const { title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes, reminders, is_todo_only } = body;
      let start = toMysqlDatetime(start_time);
      let end = toMysqlDatetime(end_time);

      if (!!is_todo_only && (!start || !end)) {
        const now = Date.now();
        start = toMysqlDatetime(new Date(now).toISOString());
        end = toMysqlDatetime(new Date(now + 30 * 60 * 1000).toISOString());
      }
      if (!start || !end) return { error: 'Valid start and end time are required', status: 400 };
      if (parseDatetimeToMillis(end) < parseDatetimeToMillis(start)) {
        return { error: 'End time must be after start time', status: 400 };
      }

      let calendarId = body.calendar_id || null;
      let remoteTarget = null;
      if (calendarId) {
        remoteTarget = await loadCalendarAccountRow(userId, calendarId);
        if (!remoteTarget) return { error: 'Invalid calendar_id', status: 400 };
        if (!isRemoteProvider(remoteTarget.provider)) remoteTarget = null;
        else if (is_todo_only) return { error: 'ToDos without a date cannot be saved to a server calendar.', status: 400 };
        else if (remoteTarget.provider === 'ics' || remoteTarget.read_only) return { error: 'This calendar is read-only.', status: 403, code: 'CALENDAR_READ_ONLY' };
        else if (!remoteTarget.is_active) return { error: 'Sync is paused for this calendar account, so events cannot be added to it.', status: 409, code: 'CALENDAR_SYNC_PAUSED' };
      } else {
        const ensured = await ensureDefaultLocalCalendarForUser(userId);
        calendarId = ensured.calendarId;
      }

      const eventId = crypto.randomUUID();
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `INSERT INTO calendar_events
            (id, user_id, calendar_id, title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes, reminders, is_todo_only)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            eventId,
            userId,
            calendarId,
            title.trim(),
            description || null,
            start,
            end,
            !!all_day,
            location?.trim() || null,
            color || '#2563eb',
            recurrence || null,
            reminder_minutes ?? null,
            reminders ? JSON.stringify(reminders) : null,
            !!is_todo_only,
          ]
        );
        if (Array.isArray(body.attendees)) {
          await replaceEventAttendees(userId, eventId, body.attendees, connection);
        }

        await require('../services/notifications').enqueueCalendarNotification({ userId, eventId }, connection);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      if (remoteTarget) {
        const [created] = await db.execute('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [eventId, userId]);
        try {
          await calendarSync.pushCreatedEvent({ userId, event: created[0] });
        } catch (error) {
          // Nothing is kept that the server did not accept.
          await db.execute('DELETE FROM calendar_events WHERE id = ? AND user_id = ?', [eventId, userId]);
          return calendarSync.calendarErrorResponse(error, 'Could not save the event to the calendar server');
        }
      }
      const event = await getCalendarEventWithSubtasks(userId, eventId);
      return { event };
    } catch (error) {
      console.error('Create event error:', error);
      return { error: error.message || 'Failed to create event', status: 500 };
    }
  },

  'GET /api/calendar/events/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const id = getCalendarEventIdFromReq(req);
    if (!id) return { error: 'Invalid event id', status: 400 };
    try {
      const event = await getCalendarEventWithSubtasks(userId, id);
      return event ? { event } : { error: 'Event not found', status: 404 };
    } catch (error) {
      console.error('Get calendar event error:', error);
      return { error: 'Failed to get calendar event', status: 500 };
    }
  },

  'PUT /api/calendar/events/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const id = getCalendarEventIdFromReq(req);
      if (!id) return { error: 'Invalid event id', status: 400 };

      const [events] = await db.execute('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [id, userId]);
      if (events.length === 0) return { error: 'Event not found', status: 404 };
      const currentEvent = events[0];
      const currentCalendar = currentEvent.calendar_id ? await loadCalendarAccountRow(userId, currentEvent.calendar_id) : null;
      currentEvent.calendar_id_remote = isRemoteProvider(currentCalendar?.provider);
      const updates = [];
      const params = [];

      if (Object.prototype.hasOwnProperty.call(body, 'title')) {
        if (!body.title?.trim()) return { error: 'Title is required', status: 400 };
        updates.push('title = ?');
        params.push(body.title.trim());
      }
      if (Object.prototype.hasOwnProperty.call(body, 'description')) {
        updates.push('description = ?');
        params.push(body.description || null);
      }

      const startProvided = Object.prototype.hasOwnProperty.call(body, 'start_time');
      const endProvided = Object.prototype.hasOwnProperty.call(body, 'end_time');
      const resolvedStart = startProvided ? toMysqlDatetime(body.start_time) : toMysqlDatetime(currentEvent.start_time);
      const resolvedEnd = endProvided ? toMysqlDatetime(body.end_time) : toMysqlDatetime(currentEvent.end_time);
      if (startProvided && !resolvedStart) return { error: 'Valid start time is required', status: 400 };
      if (endProvided && !resolvedEnd) return { error: 'Valid end time is required', status: 400 };
      if (!resolvedStart || !resolvedEnd) return { error: 'Valid start and end time are required', status: 400 };
      if (parseDatetimeToMillis(resolvedEnd) < parseDatetimeToMillis(resolvedStart)) {
        return { error: 'End time must be after start time', status: 400 };
      }
      if (startProvided) {
        updates.push('start_time = ?');
        params.push(resolvedStart);
      }
      if (endProvided) {
        updates.push('end_time = ?');
        params.push(resolvedEnd);
      }

      if (Object.prototype.hasOwnProperty.call(body, 'all_day')) {
        updates.push('all_day = ?');
        params.push(!!body.all_day);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'location')) {
        updates.push('location = ?');
        params.push(body.location?.trim() || null);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'color')) {
        updates.push('color = ?');
        params.push(body.color || '#2563eb');
      }
      if (Object.prototype.hasOwnProperty.call(body, 'recurrence') && !currentEvent.calendar_id_remote) {
        updates.push('recurrence = ?');
        params.push(body.recurrence || null);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'reminder_minutes')) {
        updates.push('reminder_minutes = ?');
        params.push(body.reminder_minutes ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'reminders')) {
        if (body.reminders !== null && body.reminders !== undefined && !Array.isArray(body.reminders)) {
          return { error: 'Reminders must be an array or null', status: 400 };
        }
        updates.push('reminders = ?');
        params.push(body.reminders ? JSON.stringify(body.reminders) : null);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'is_todo_only')) {
        updates.push('is_todo_only = ?');
        params.push(!!body.is_todo_only);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'calendar_id')) {
        if (!body.calendar_id) {
          updates.push('calendar_id = NULL');
        } else {
          const [calRows] = await db.execute('SELECT id FROM calendar_calendars WHERE id = ? AND user_id = ?', [body.calendar_id, userId]);
          if (calRows.length === 0) return { error: 'Invalid calendar_id', status: 400 };
          updates.push('calendar_id = ?');
          params.push(body.calendar_id);
        }
      }

      const writeback = await pushEventChanges(userId, currentEvent, body, {
        title: body.title?.trim(),
        description: body.description || null,
        start_time: resolvedStart,
        end_time: resolvedEnd,
        all_day: !!body.all_day,
        location: body.location?.trim() || null,
        reminders: Array.isArray(body.reminders) ? body.reminders : null,
        reminder_minutes: body.reminder_minutes ?? null,
      });
      if (writeback.error) return writeback;

      if (updates.length > 0) {
        params.push(id, userId);
        await db.execute(`UPDATE calendar_events SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
      }
      if (Array.isArray(body.attendees)) {
        await replaceEventAttendees(userId, id, body.attendees);
      }

      const updatedEvent = await getCalendarEventWithSubtasks(userId, id);
      // Changing the time of a whole series replaces its occurrences.
      return { event: updatedEvent, ...(updatedEvent ? {} : { replaced: true }), ...(writeback.scope ? { scope: writeback.scope } : {}) };
    } catch (error) {
      console.error('Update event error:', error);
      return { error: error.message || 'Failed to update event', status: 500 };
    }
  },

  'PUT /api/calendar/events/:id/todo-status': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const id = getCalendarEventIdFromReq(req);
      if (!id) return { error: 'Invalid event id', status: 400 };

      if (!Object.prototype.hasOwnProperty.call(body, 'todo_status')) {
        return { error: 'todo_status is required', status: 400 };
      }

      const { todo_status, start_time, end_time } = body;
      if (!['done', 'changed', 'time_moved', 'cancelled', null].includes(todo_status)) {
        return { error: 'Invalid todo_status', status: 400 };
      }

      const [currentEvents] = await db.execute(
        'SELECT start_time, end_time FROM calendar_events WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      if (currentEvents.length === 0) return { error: 'Event not found', status: 404 };

      const updates = ['todo_status = ?'];
      const params = [todo_status || null];

      if (todo_status === 'done') {
        updates.push('done_at = NOW()');
      } else {
        updates.push('done_at = NULL');
      }

      if (todo_status === 'time_moved' && (start_time || end_time)) {
        const currentStartMs = parseDatetimeToMillis(currentEvents[0].start_time);
        const currentEndMs = parseDatetimeToMillis(currentEvents[0].end_time);
        const durationMs = currentStartMs !== null && currentEndMs !== null ? Math.max(0, currentEndMs - currentStartMs) : 0;

        const parsedStart = start_time ? toMysqlDatetime(start_time) : null;
        const parsedEnd = end_time ? toMysqlDatetime(end_time) : null;
        if (start_time && !parsedStart) return { error: 'Invalid start_time for time move', status: 400 };
        if (end_time && !parsedEnd) return { error: 'Invalid end_time for time move', status: 400 };

        let movedStart = parsedStart;
        let movedEnd = parsedEnd;

        if (movedStart && !movedEnd) {
          const computedEndMs = (parseDatetimeToMillis(movedStart) || 0) + durationMs;
          movedEnd = toMysqlDatetime(new Date(computedEndMs).toISOString());
        } else if (!movedStart && movedEnd) {
          const computedStartMs = (parseDatetimeToMillis(movedEnd) || 0) - durationMs;
          movedStart = toMysqlDatetime(new Date(computedStartMs).toISOString());
        }

        if (movedStart && movedEnd && parseDatetimeToMillis(movedEnd) < parseDatetimeToMillis(movedStart)) {
          return { error: 'End time must be after start time', status: 400 };
        }

        if (movedStart && movedEnd) {
          const [[current]] = await db.execute('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [id, userId]);
          const writeback = await pushEventChanges(userId, current, { start_time: movedStart, end_time: movedEnd },
            { start_time: movedStart, end_time: movedEnd });
          if (writeback.error) return writeback;
          updates.push('start_time = ?', 'end_time = ?');
          params.push(movedStart, movedEnd);
        }
      }

      const updateQuery = `UPDATE calendar_events SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`;
      params.push(id, userId);
      await db.execute(updateQuery, params);

      const updatedEvent = await getCalendarEventWithSubtasks(userId, id);
      return { event: updatedEvent };
    } catch (error) {
      console.error('Update todo status error:', error);
      return { error: error.message || 'Failed to update todo status', status: 500 };
    }
  },

  'PUT /api/calendar/events/:id/rsvp': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const id = getCalendarEventIdFromReq(req);
      if (!id) return { error: 'Invalid event id', status: 400 };
      const responseStatus = normalizeResponseStatus(body?.response_status);
      const attendeeEmail = body?.email ? String(body.email).trim().toLowerCase() : null;

      const event = await getCalendarEventWithSubtasks(userId, id);
      if (!event) return { error: 'Event not found', status: 404 };
      const context = event.calendar_id ? await loadCalendarWithAccount(userId, event.calendar_id) : null;
      const accountEmail = context?.account?.account_email?.toLowerCase() || null;
      const effectiveEmail = attendeeEmail || accountEmail;
      if (!effectiveEmail) {
        return { error: 'No attendee email available for RSVP update', status: 400 };
      }

      const nextAttendees = [...(event.attendees || [])];
      const existingIdx = nextAttendees.findIndex((attendee) => attendee.email === effectiveEmail);
      if (existingIdx >= 0) {
        nextAttendees[existingIdx] = {
          ...nextAttendees[existingIdx],
          response_status: responseStatus,
        };
      } else {
        nextAttendees.push({
          email: effectiveEmail,
          display_name: null,
          response_status: responseStatus,
          optional_attendee: false,
          is_organizer: false,
          comment: null,
        });
      }
      await replaceEventAttendees(userId, id, nextAttendees);
      const updated = await getCalendarEventWithSubtasks(userId, id);
      return { event: updated };
    } catch (error) {
      console.error('RSVP update error:', error);
      return { error: error.message || 'Failed to update RSVP', status: 500 };
    }
  },

  'GET /api/calendar/events/:id/subtasks': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const eventId = getCalendarEventIdFromReq(req);
      if (!eventId) return { error: 'Invalid event id', status: 400 };

      const [events] = await db.execute('SELECT id FROM calendar_events WHERE id = ? AND user_id = ?', [eventId, userId]);
      if (events.length === 0) return { error: 'Event not found', status: 404 };

      const [subtasks] = await db.execute(
        'SELECT * FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ? ORDER BY position ASC, created_at ASC',
        [eventId, userId]
      );
      return { subtasks: subtasks.map(serializeCalendarSubtask) };
    } catch (error) {
      console.error('Get subtasks error:', error);
      return { error: error.message || 'Failed to fetch subtasks', status: 500 };
    }
  },

  'POST /api/calendar/events/:id/subtasks': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!body.title?.trim()) return { error: 'Subtask title is required', status: 400 };

    try {
      const eventId = getCalendarEventIdFromReq(req);
      if (!eventId) return { error: 'Invalid event id', status: 400 };

      const [events] = await db.execute('SELECT id FROM calendar_events WHERE id = ? AND user_id = ?', [eventId, userId]);
      if (events.length === 0) return { error: 'Event not found', status: 404 };

      let position = Number.isInteger(body.position) && body.position >= 0 ? body.position : null;
      if (position === null) {
        const [maxRows] = await db.execute(
          'SELECT COALESCE(MAX(position), -1) AS max_position FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ?',
          [eventId, userId]
        );
        position = Number(maxRows[0]?.max_position ?? -1) + 1;
      } else {
        await db.execute(
          'UPDATE calendar_event_subtasks SET position = position + 1 WHERE event_id = ? AND user_id = ? AND position >= ?',
          [eventId, userId, position]
        );
      }

      const subtaskId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position) VALUES (?, ?, ?, ?, ?, ?)',
        [subtaskId, eventId, userId, body.title.trim(), !!body.is_done, position]
      );

      const [subtasks] = await db.execute(
        'SELECT * FROM calendar_event_subtasks WHERE id = ? AND event_id = ? AND user_id = ?',
        [subtaskId, eventId, userId]
      );
      return { subtask: subtasks[0] ? serializeCalendarSubtask(subtasks[0]) : null };
    } catch (error) {
      console.error('Create subtask error:', error);
      return { error: error.message || 'Failed to create subtask', status: 500 };
    }
  },

  'PUT /api/calendar/events/:id/subtasks/:subtaskId': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const eventId = getCalendarEventIdFromReq(req);
      const subtaskId = getCalendarSubtaskIdFromReq(req);
      if (!eventId || !subtaskId) return { error: 'Invalid subtask route', status: 400 };

      const [existing] = await db.execute(
        'SELECT * FROM calendar_event_subtasks WHERE id = ? AND event_id = ? AND user_id = ?',
        [subtaskId, eventId, userId]
      );
      if (existing.length === 0) return { error: 'Subtask not found', status: 404 };

      const updates = [];
      const params = [];

      if (Object.prototype.hasOwnProperty.call(body, 'title')) {
        if (!body.title?.trim()) return { error: 'Subtask title is required', status: 400 };
        updates.push('title = ?');
        params.push(body.title.trim());
      }

      if (Object.prototype.hasOwnProperty.call(body, 'is_done')) {
        updates.push('is_done = ?');
        params.push(!!body.is_done);
      }

      if (Object.prototype.hasOwnProperty.call(body, 'position')) {
        if (!Number.isInteger(body.position) || body.position < 0) {
          return { error: 'position must be a non-negative integer', status: 400 };
        }
        updates.push('position = ?');
        params.push(body.position);
      }

      if (updates.length > 0) {
        params.push(subtaskId, eventId, userId);
        await db.execute(
          `UPDATE calendar_event_subtasks SET ${updates.join(', ')} WHERE id = ? AND event_id = ? AND user_id = ?`,
          params
        );
      }

      const [subtasks] = await db.execute(
        'SELECT * FROM calendar_event_subtasks WHERE id = ? AND event_id = ? AND user_id = ?',
        [subtaskId, eventId, userId]
      );
      return { subtask: subtasks[0] ? serializeCalendarSubtask(subtasks[0]) : null };
    } catch (error) {
      console.error('Update subtask error:', error);
      return { error: error.message || 'Failed to update subtask', status: 500 };
    }
  },

  'DELETE /api/calendar/events/:id/subtasks/:subtaskId': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const eventId = getCalendarEventIdFromReq(req);
      const subtaskId = getCalendarSubtaskIdFromReq(req);
      if (!eventId || !subtaskId) return { error: 'Invalid subtask route', status: 400 };

      const [result] = await db.execute(
        'DELETE FROM calendar_event_subtasks WHERE id = ? AND event_id = ? AND user_id = ?',
        [subtaskId, eventId, userId]
      );
      if (result.affectedRows === 0) return { error: 'Subtask not found', status: 404 };

      return { message: 'Subtask deleted' };
    } catch (error) {
      console.error('Delete subtask error:', error);
      return { error: error.message || 'Failed to delete subtask', status: 500 };
    }
  },

  'POST /api/calendar/events/:id/subtasks/reorder': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const eventId = getCalendarEventIdFromReq(req);
      if (!eventId) return { error: 'Invalid event id', status: 400 };

      const subtaskIds = Array.isArray(body.subtask_ids) ? body.subtask_ids : null;
      if (!subtaskIds || subtaskIds.length === 0) {
        return { error: 'subtask_ids must be a non-empty array', status: 400 };
      }

      const [existingRows] = await db.execute(
        'SELECT id FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ?',
        [eventId, userId]
      );
      const existingIds = new Set(existingRows.map((row) => row.id));
      if (existingIds.size !== subtaskIds.length || subtaskIds.some((id) => !existingIds.has(id))) {
        return { error: 'subtask_ids must include all subtasks for the event', status: 400 };
      }

      for (let index = 0; index < subtaskIds.length; index += 1) {
        await db.execute(
          'UPDATE calendar_event_subtasks SET position = ? WHERE id = ? AND event_id = ? AND user_id = ?',
          [index, subtaskIds[index], eventId, userId]
        );
      }

      const [subtasks] = await db.execute(
        'SELECT * FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ? ORDER BY position ASC, created_at ASC',
        [eventId, userId]
      );
      return { subtasks: subtasks.map(serializeCalendarSubtask) };
    } catch (error) {
      console.error('Reorder subtasks error:', error);
      return { error: error.message || 'Failed to reorder subtasks', status: 500 };
    }
  },
  
  'DELETE /api/calendar/events/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const id = getCalendarEventIdFromReq(req);
      if (!id) return { error: 'Invalid event id', status: 400 };
      const [events] = await db.execute('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [id, userId]);
      if (!events.length) return { message: 'Event deleted' };
      const scope = new URL(req.url, 'http://localhost').searchParams.get('scope');
      try {
        await calendarSync.pushEventDelete({ userId, event: events[0], scope: scope === 'series' ? 'series' : 'occurrence' });
      } catch (error) {
        return calendarSync.calendarErrorResponse(error, 'Could not delete the event on the calendar server');
      }
      await db.execute('DELETE FROM calendar_events WHERE id = ? AND user_id = ?', [id, userId]);
      return { message: 'Event deleted' };
    } catch (error) {
      console.error('Delete event error:', error);
      return { error: 'Failed to delete event', status: 500 };
    }
  },
};
