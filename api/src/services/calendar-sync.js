// Two-way calendar sync for CalDAV accounts and read-only iCalendar
// subscriptions.
//
// The server copy of every calendar object (one UID with its exceptions) is
// kept in calendar_remote_objects. Local calendar_events rows are derived from
// it: one row per occurrence inside the sync window, keyed by
// "<remote object id>|<recurrence id>". Local-only fields (ToDo status,
// subtasks) survive re-expansion because rows are updated in place.
//
// Edits made in UniHub are written to the server first (with If-Match); the
// local rows are then rebuilt from the new server copy, so the server stays
// the authority and a conflicting edit elsewhere is never overwritten.
const crypto = require('crypto');
const { db } = require('../state');
const { decrypt } = require('../security/encryption');
const { isModuleEnabled, isModuleBackgroundEnabled } = require('./module-settings');
const { isSectionRestoreActive } = require('./restore-locks');
const { publishCalendarChanged } = require('./server-events');
const caldav = require('./caldav');
const ical = require('./calendar-ical');
const { toMysqlDatetime, parseDatetimeToMillis, MAIL_DISCONNECTED_MESSAGE, MAIL_CONNECTED_SQL, wasMailCalendar } = require('./calendar');

const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const ERROR_RETRY_MS = 30 * 60 * 1000;
const AUTH_ERROR_RETRY_MS = 6 * 60 * 60 * 1000;
const WINDOW_PAST_MS = 365 * 86400000;
const WINDOW_FUTURE_MS = 730 * 86400000;
const MAX_NEW_EVENT_NOTIFICATIONS = 3;
const ACCOUNTS_PER_PASS = 20;
const REMOTE_PROVIDERS = new Set(['caldav', 'ics']);
const CALENDAR_COLORS = ['#22c55e', '#3b82f6', '#f97316', '#a855f7', '#ef4444', '#14b8a6', '#eab308', '#ec4899'];

const inFlight = new Map();
const followUps = new Set();
let passRunning = false;

function syncError(message, status = 400, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function jsonValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function dateValue(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function hrefHash(href) {
  return crypto.createHash('sha256').update(String(href)).digest('hex');
}

const NO_PASSWORD_MESSAGE = 'No password is saved for this calendar account. Enter it again to resume sync.';
const MAIL_CALENDAR_UNLINKED_MESSAGE = 'This calendar belongs to a mail account it is not linked to. Add that mail account in Mail to resume sync, or remove this calendar.';
const MAIL_HAS_OTHER_CALENDAR_MESSAGE = 'The mail account with this address uses another calendar. Remove this calendar, or turn that mail account\'s calendar off to use this one.';

async function mailAccountWithAddress(account) {
  if (!account.account_email) return false;
  const [rows] = await db.execute('SELECT id FROM mail_accounts WHERE user_id = ? AND LOWER(email_address) = LOWER(?) LIMIT 1', [account.user_id, account.account_email]);
  return rows.length > 0;
}

// A calendar connected from a mail account has no password of its own: every
// sync and change reads the mail login as stored at that moment, through the
// calendar's current link, and finds none while the mail account is
// disconnected. One that is not linked (a restored one: backups keep only its
// mark; one connected before 0.17; one whose mail account was deleted) finds
// its mail account by address first. A mail calendar never uses a copy of the
// mail password while a mail account with its address exists, and a marked
// one never: it waits. Only an unmarked one from before 0.17 whose mail
// account is gone keeps using its password, as its own.
async function resolveLogin(account, relinked = false) {
  const [[link]] = await db.execute(`SELECT ca.provider, ca.provider_config, ca.account_email, ca.username, ca.encrypted_password, ca.mail_account_id,
      m.id AS mail_id, COALESCE(NULLIF(m.username, ''), m.email_address) AS mail_username, m.encrypted_password AS mail_password,
      (${MAIL_CONNECTED_SQL}) AS mail_connected
    FROM calendar_accounts ca LEFT JOIN mail_accounts m ON m.id = ca.mail_account_id AND m.user_id = ca.user_id
    WHERE ca.id = ? AND ca.user_id = ?`, [account.id, account.user_id]);
  if (!link) throw syncError('Calendar account not found', 404, 'CALENDAR_ACCOUNT_NOT_FOUND');
  const current = { ...account, provider: link.provider, provider_config: link.provider_config, account_email: link.account_email,
    username: link.username, encrypted_password: link.encrypted_password, mail_account_id: link.mail_account_id };
  if (current.mail_account_id && !link.mail_id) {
    // Its mail account was deleted: the link goes, and it looks for a mail
    // account with its address again.
    await db.execute('UPDATE calendar_accounts SET mail_account_id = NULL WHERE id = ? AND mail_account_id = ?', [account.id, current.mail_account_id]);
    current.mail_account_id = null;
  }
  if (!current.mail_account_id) {
    const mailCalendar = wasMailCalendar(current);
    if (mailCalendar && !relinked && await require('./calendar-accounts').relinkRestoredCalendar(current)) return resolveLogin(account, true);
    const marked = (jsonValue(current.provider_config, {}) || {}).mailLinked === true;
    const mailExists = mailCalendar && await mailAccountWithAddress(current);
    if (mailExists) throw syncError(MAIL_HAS_OTHER_CALENDAR_MESSAGE, 409, 'MAIL_CALENDAR_UNLINKED');
    if (marked) throw syncError(MAIL_CALENDAR_UNLINKED_MESSAGE, 409, 'MAIL_CALENDAR_UNLINKED');
    if (!current.encrypted_password) throw syncError(NO_PASSWORD_MESSAGE, 409, 'CALDAV_NO_PASSWORD');
    return { username: current.username || current.account_email, encryptedPassword: current.encrypted_password };
  }
  if (!Number(link.mail_connected)) throw syncError(MAIL_DISCONNECTED_MESSAGE, 409, 'MAIL_ACCOUNT_DISCONNECTED');
  return { username: link.mail_username, encryptedPassword: link.mail_password };
}

async function accountLogin(account, signal) {
  const { username, encryptedPassword } = await resolveLogin(account);
  return {
    username,
    password: decrypt(encryptedPassword),
    credentialScope: account.base_url ? caldav.accountCredentialScope(account) : null,
    signal,
  };
}

// One stop switch per calendar account. Sync runs and writebacks take the
// current signal before they read the login and pass it to every CalDAV
// request. A mail disconnect commits first and then stops the switch: work
// that started earlier sends no further request and its reads are aborted
// mid-request (a write already sent is let finish, so its result is
// recorded), work that starts later finds no login.
// Each entry is counted by the work using it and removed when the last one
// ends, so the map holds only accounts with work running.
const accountWork = new Map();
function beginAccountWork(accountId) {
  let entry = accountWork.get(accountId);
  if (!entry) accountWork.set(accountId, entry = { controller: new AbortController(), users: 0 });
  entry.users += 1;
  let released = false;
  return {
    signal: entry.controller.signal,
    release() {
      if (released) return;
      released = true;
      entry.users -= 1;
      if (!entry.users && accountWork.get(accountId) === entry) accountWork.delete(accountId);
    },
  };
}
// The reason is noted on the account by a stopped sync, and returned by a
// stopped change: its mail account was disconnected, it was unlinked (its
// mail account deleted), or its mail account took another calendar.
const STOP_REASONS = {
  disconnected: () => syncError(MAIL_DISCONNECTED_MESSAGE, 409, 'MAIL_ACCOUNT_DISCONNECTED'),
  unlinked: () => syncError(MAIL_CALENDAR_UNLINKED_MESSAGE, 409, 'MAIL_CALENDAR_UNLINKED'),
  replaced: () => syncError(MAIL_HAS_OTHER_CALENDAR_MESSAGE, 409, 'MAIL_CALENDAR_UNLINKED'),
};
function stopCalendarAccountWork(accountId, reason = 'disconnected') {
  const entry = accountWork.get(accountId);
  accountWork.delete(accountId);
  entry?.controller.abort((STOP_REASONS[reason] || STOP_REASONS.disconnected)());
}
// For tests: accounts with work running.
const runningCalendarWorkCount = () => accountWork.size;
// After a mail disconnect committed: its calendars are read again, so one a
// sync linked meanwhile is stopped too, and open views show the new status.
async function stopLinkedCalendarWork(userId, mailAccountId) {
  // Only CalDAV accounts use the mail login; a subscription is not stopped.
  const [rows] = await db.execute("SELECT id FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ? AND provider = 'caldav'", [userId, mailAccountId]);
  for (const row of rows) {
    stopCalendarAccountWork(row.id);
    publishCalendarChanged(userId, row.id, 'status');
  }
}

async function resolveTimeZone(account) {
  const [rows] = await db.execute('SELECT timezone FROM users WHERE id = ?', [account.user_id]);
  const config = jsonValue(account.provider_config, {}) || {};
  return ical.resolveUserTimeZone(ical.isValidTimeZone(rows[0]?.timezone) ? rows[0].timezone : config.timeZone);
}

// Stored hrefs are decoded paths (see canonicalHref); encode them again.
function hrefUrl(href, base) {
  return new URL(encodeURI(href).replace(/[?#]/g, encodeURIComponent), base).toString();
}

function calendarUrl(account, calendar) {
  return hrefUrl(calendar.external_id, account.base_url);
}

function objectUrl(account, object) {
  return hrefUrl(object.href, account.base_url);
}

async function loadAccount(accountId, userId) {
  const [rows] = await db.execute(
    `SELECT * FROM calendar_accounts WHERE id = ? ${userId ? 'AND user_id = ?' : ''} LIMIT 1`,
    userId ? [accountId, userId] : [accountId]
  );
  return rows[0] || null;
}

// Removes calendars and every event in them. Events reference calendars with
// ON DELETE SET NULL, so they are deleted first.
async function deleteCalendarsWithEvents(connection, userId, calendarIds) {
  if (!calendarIds.length) return;
  const placeholders = calendarIds.map(() => '?').join(', ');
  await connection.execute(`DELETE FROM calendar_events WHERE user_id = ? AND calendar_id IN (${placeholders})`, [userId, ...calendarIds]);
  await connection.execute(`DELETE FROM calendar_calendars WHERE user_id = ? AND id IN (${placeholders})`, [userId, ...calendarIds]);
}

async function deleteCalendarAccount(userId, accountId) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [calendars] = await connection.execute('SELECT id FROM calendar_calendars WHERE account_id = ? AND user_id = ?', [accountId, userId]);
    await deleteCalendarsWithEvents(connection, userId, calendars.map(row => row.id));
    await connection.execute('DELETE FROM calendar_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  publishCalendarChanged(userId, accountId, 'sync');
}

// --- Calendar list ----------------------------------------------------------

async function reconcileCalendarList(account, remoteCalendars) {
  const [rows] = await db.execute('SELECT * FROM calendar_calendars WHERE account_id = ? AND user_id = ? ORDER BY created_at ASC', [account.id, account.user_id]);
  const byHref = new Map();
  for (const row of rows) {
    if (!row.external_id) continue;
    try { byHref.set(caldav.canonicalHref(row.external_id, account.base_url), row); } catch { /* unusable legacy id */ }
  }
  const matched = new Set();
  const result = [];
  for (const [index, remote] of remoteCalendars.entries()) {
    const existing = byHref.get(remote.href);
    if (existing) {
      matched.add(existing.id);
      await db.execute('UPDATE calendar_calendars SET name = ?, read_only = ?, external_id = ? WHERE id = ?',
        [remote.displayName, remote.readOnly ? 1 : 0, remote.href, existing.id]);
      result.push({ calendar: { ...existing, name: remote.displayName, read_only: remote.readOnly ? 1 : 0, external_id: remote.href }, remote, isNew: false });
      continue;
    }
    const id = crypto.randomUUID();
    const isPrimary = rows.length === 0 && index === 0;
    const color = remote.color || CALENDAR_COLORS[(rows.length + index) % CALENDAR_COLORS.length];
    // New server calendars do not create ToDos until the user opts in.
    await db.execute(
      `INSERT INTO calendar_calendars
        (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, TRUE, FALSE, ?, ?)`,
      [id, account.user_id, account.id, remote.displayName, remote.href, color, remote.readOnly ? 1 : 0, isPrimary ? 1 : 0]
    );
    result.push({ calendar: { id, user_id: account.user_id, account_id: account.id, name: remote.displayName, external_id: remote.href, color,
      read_only: remote.readOnly ? 1 : 0, remote_ctag: null, remote_expanded_on: null }, remote, isNew: true });
  }
  const vanished = rows.filter(row => !matched.has(row.id)).map(row => row.id);
  if (vanished.length) {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      await deleteCalendarsWithEvents(connection, account.user_id, vanished);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  return result;
}

// --- Objects to events ------------------------------------------------------

function externalEventId(objectId, recurrenceId) {
  return `${objectId}|${recurrenceId || ''}`;
}

// Occurrences of one server object inside the sync window, or null when the
// object cannot be read.
function expandObject(ctx, ics) {
  try {
    return ical.expandCalendarObject(ics, {
      windowStartMs: ctx.windowStartMs, windowEndMs: ctx.windowEndMs, userTimeZone: ctx.timeZone,
    });
  } catch {
    return null;
  }
}

// Rebuild the event rows of one server object. Returns the ids and start
// times of rows that did not exist before. An object that cannot be read
// keeps its last rows (and their ToDo state); the sync reports it instead.
async function applyObject(ctx, calendar, object, expanded = expandObject(ctx, object.ics)) {
  if (!expanded) {
    ctx.stats.unreadable += 1;
    return [];
  }
  const created = [];
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [refs] = await connection.execute(
      'SELECT event_id, external_event_id FROM calendar_event_external_refs WHERE account_id = ? AND remote_object_id = ?',
      [ctx.account.id, object.id]
    );
    const existing = new Map(refs.map(ref => [ref.external_event_id, ref.event_id]));
    const keep = new Set();
    for (const occurrence of expanded.occurrences) {
      const key = externalEventId(object.id, occurrence.recurrenceId);
      if (keep.has(key)) continue;
      keep.add(key);
      const values = [
        calendar.id,
        occurrence.title,
        occurrence.description,
        toMysqlDatetime(new Date(occurrence.startMs).toISOString()),
        toMysqlDatetime(new Date(occurrence.endMs).toISOString()),
        occurrence.allDay ? 1 : 0,
        occurrence.location,
        calendar.color || '#2563eb',
        occurrence.reminders.length ? JSON.stringify(occurrence.reminders) : null,
        expanded.rrule ? expanded.rrule.slice(0, 100) : null,
      ];
      const eventId = existing.get(key);
      if (eventId) {
        await connection.execute(
          `UPDATE calendar_events SET calendar_id = ?, title = ?, description = ?, start_time = ?, end_time = ?, all_day = ?,
             location = ?, color = ?, reminders = ?, recurrence = ? WHERE id = ? AND user_id = ?`,
          [...values, eventId, ctx.account.user_id]
        );
        await connection.execute(
          `UPDATE calendar_event_external_refs SET calendar_id = ?, external_etag = ?, recurrence_id = ?, last_synced_at = UTC_TIMESTAMP()
           WHERE account_id = ? AND external_event_id = ?`,
          [calendar.id, object.etag || null, occurrence.recurrenceId || null, ctx.account.id, key]
        );
        continue;
      }
      const id = crypto.randomUUID();
      await connection.execute(
        `INSERT INTO calendar_events (id, user_id, calendar_id, title, description, start_time, end_time, all_day, location, color, reminders, recurrence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, ctx.account.user_id, ...values]
      );
      await connection.execute(
        `INSERT INTO calendar_event_external_refs
          (id, user_id, event_id, calendar_id, account_id, provider, external_event_id, external_etag, remote_object_id, recurrence_id, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
        [crypto.randomUUID(), ctx.account.user_id, id, calendar.id, ctx.account.id, ctx.account.provider, key, object.etag || null, object.id, occurrence.recurrenceId || null]
      );
      created.push({ id, startMs: occurrence.startMs });
    }
    const stale = refs.filter(ref => !keep.has(ref.external_event_id)).map(ref => ref.event_id);
    if (stale.length) {
      await connection.execute(`DELETE FROM calendar_events WHERE user_id = ? AND id IN (${stale.map(() => '?').join(', ')})`, [ctx.account.user_id, ...stale]);
    }
    await connection.commit();
    ctx.stats.events += expanded.occurrences.length;
    ctx.stats.removedEvents += stale.length;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return created;
}

async function removeObjects(ctx, objectIds) {
  if (!objectIds.length) return;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    for (let index = 0; index < objectIds.length; index += 200) {
      const chunk = objectIds.slice(index, index + 200);
      const placeholders = chunk.map(() => '?').join(', ');
      const [refs] = await connection.execute(
        `SELECT event_id FROM calendar_event_external_refs WHERE account_id = ? AND remote_object_id IN (${placeholders})`,
        [ctx.account.id, ...chunk]
      );
      const eventIds = refs.map(ref => ref.event_id);
      if (eventIds.length) {
        await connection.execute(`DELETE FROM calendar_events WHERE user_id = ? AND id IN (${eventIds.map(() => '?').join(', ')})`, [ctx.account.user_id, ...eventIds]);
      }
      await connection.execute(`DELETE FROM calendar_remote_objects WHERE account_id = ? AND id IN (${placeholders})`, [ctx.account.id, ...chunk]);
      ctx.stats.removedEvents += eventIds.length;
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function storeObject(account, calendar, { id, href, etag, ics }) {
  const objectId = id || crypto.randomUUID();
  const uid = (ical.objectUid(ics) || '').slice(0, 500) || null;
  await db.execute(
    `INSERT INTO calendar_remote_objects (id, user_id, account_id, calendar_id, href, href_hash, etag, uid, ics)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE etag = VALUES(etag), uid = VALUES(uid), ics = VALUES(ics), href = VALUES(href)`,
    [objectId, account.user_id, account.id, calendar.id, href, hrefHash(href), etag || null, uid, ics]
  );
  const [rows] = await db.execute('SELECT id, href, etag, ics FROM calendar_remote_objects WHERE calendar_id = ? AND href_hash = ?', [calendar.id, hrefHash(href)]);
  return rows[0];
}

// Bring one calendar up to date from a listing of { href, url, etag }.
// fetchObjects downloads the listed objects whose ETag changed. Returns the
// number of objects that could not be read; their last readable copy and its
// ETag are kept, so the next sync downloads them again.
async function syncCalendarObjects(ctx, calendar, listing, fetchObjects, { expandAll }) {
  const unreadableBefore = ctx.stats.unreadable;
  const [stored] = await db.execute('SELECT id, href, href_hash, etag FROM calendar_remote_objects WHERE calendar_id = ?', [calendar.id]);
  const storedByHash = new Map(stored.map(row => [row.href_hash, row]));
  const listed = new Set();
  const changed = [];
  for (const item of listing) {
    const hash = hrefHash(item.href);
    if (listed.has(hash)) continue;
    listed.add(hash);
    const known = storedByHash.get(hash);
    if (!known || !item.etag || known.etag !== item.etag) changed.push(item);
  }
  const removed = stored.filter(row => !listed.has(row.href_hash)).map(row => row.id);
  await removeObjects(ctx, removed);
  ctx.stats.removedObjects += removed.length;

  const fetched = changed.length ? await fetchObjects(changed) : [];
  const applied = new Set();
  for (const item of fetched) {
    const known = storedByHash.get(hrefHash(item.href));
    const expanded = expandObject(ctx, item.ics);
    if (!expanded) {
      ctx.stats.unreadable += 1;
      continue;
    }
    const object = await storeObject(ctx.account, calendar, { id: known?.id, href: item.href, etag: item.etag, ics: item.ics });
    applied.add(object.id);
    const created = await applyObject(ctx, calendar, object, expanded).catch(async error => {
      // Without its ETag the object is downloaded and applied again next time.
      await db.execute('UPDATE calendar_remote_objects SET etag = NULL WHERE id = ?', [object.id]).catch(() => {});
      throw error;
    });
    ctx.stats.changedObjects += 1;
    if (ctx.notify && !known) {
      const upcoming = created.filter(event => event.startMs > Date.now()).sort((a, b) => a.startMs - b.startMs)[0];
      if (upcoming) ctx.newEvents.push(upcoming.id);
    }
  }
  if (expandAll) {
    // Recurring series move forward with the window once a day; legacy rows
    // without a server object link are replaced at the same time.
    const remaining = stored.filter(row => listed.has(row.href_hash) && !applied.has(row.id)).map(row => row.id);
    for (let index = 0; index < remaining.length; index += 100) {
      const chunk = remaining.slice(index, index + 100);
      const [objects] = await db.execute(`SELECT id, href, etag, ics FROM calendar_remote_objects WHERE id IN (${chunk.map(() => '?').join(', ')})`, chunk);
      for (const object of objects) {
        const expanded = expandObject(ctx, object.ics);
        // 0.17.0 stored copies before reading them. Without its ETag an
        // unreadable one is downloaded again on the next sync.
        if (!expanded) await db.execute('UPDATE calendar_remote_objects SET etag = NULL WHERE id = ?', [object.id]);
        await applyObject(ctx, calendar, object, expanded);
      }
    }
  }
  const unreadable = ctx.stats.unreadable - unreadableBefore;
  if (expandAll && !unreadable) {
    // Rows from before 0.17 are only dropped once every object was read, as
    // an unreadable one may be what replaces them.
    const [orphans] = await db.execute(
      `SELECT r.event_id FROM calendar_event_external_refs r
       LEFT JOIN calendar_remote_objects o ON o.id = r.remote_object_id
       WHERE r.account_id = ? AND r.calendar_id = ? AND o.id IS NULL`,
      [ctx.account.id, calendar.id]
    );
    if (orphans.length) {
      const ids = orphans.map(row => row.event_id);
      for (let index = 0; index < ids.length; index += 200) {
        const chunk = ids.slice(index, index + 200);
        await db.execute(`DELETE FROM calendar_events WHERE user_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`, [ctx.account.user_id, ...chunk]);
      }
      ctx.stats.removedEvents += ids.length;
    }
  }
  return unreadable;
}

async function syncCalDavAccount(ctx, { full }) {
  const { account, login } = ctx;
  if (!login.password) throw syncError('The calendar has no saved password. Reconnect the account.', 422, 'CALDAV_NO_PASSWORD');
  const remoteCalendars = await caldav.listCalendars({ homeUrl: account.base_url, ...login });
  const calendars = await reconcileCalendarList(account, remoteCalendars);
  const today = todayUtc();
  for (const { calendar, remote, isNew } of calendars) {
    const expandAll = full || dateValue(calendar.remote_expanded_on) !== today;
    if (!expandAll && remote.ctag && calendar.remote_ctag === remote.ctag) continue;
    const calendarCtx = { ...ctx, notify: ctx.notify && !isNew && !!calendar.remote_ctag };
    const listing = await caldav.listCalendarObjects({
      calendarUrl: remote.url, ...login, windowStartMs: ctx.windowStartMs, windowEndMs: ctx.windowEndMs,
    });
    const unreadable = await syncCalendarObjects(calendarCtx, calendar, listing,
      objects => caldav.fetchCalendarObjects({ calendarUrl: remote.url, objects, ...login }), { expandAll });
    ctx.newEvents = calendarCtx.newEvents;
    // Without the ctag the next sync lists the calendar again and retries
    // the objects it could not read.
    await db.execute('UPDATE calendar_calendars SET remote_ctag = ?, remote_expanded_on = ? WHERE id = ?',
      [unreadable ? null : remote.ctag || null, today, calendar.id]);
    ctx.stats.calendars += 1;
  }
}

async function ensureIcsCalendar(account) {
  const [rows] = await db.execute('SELECT * FROM calendar_calendars WHERE account_id = ? AND user_id = ? ORDER BY created_at ASC', [account.id, account.user_id]);
  if (rows.length) return { calendar: rows[0], isNew: false };
  const calendar = {
    id: crypto.randomUUID(), user_id: account.user_id, account_id: account.id, name: account.display_name || 'Subscription',
    external_id: 'ics', color: CALENDAR_COLORS[3], read_only: 1, remote_ctag: null, remote_expanded_on: null,
  };
  await db.execute(
    `INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary)
     VALUES (?, ?, ?, ?, 'ics', ?, TRUE, FALSE, TRUE, TRUE)`,
    [calendar.id, account.user_id, account.id, calendar.name, calendar.color]
  );
  return { calendar, isNew: true };
}

async function syncIcsAccount(ctx, { full }) {
  const { account } = ctx;
  const feedUrl = account.encrypted_password ? decrypt(account.encrypted_password) : null;
  if (!feedUrl) throw syncError('The subscription address is missing. Add the subscription again.', 422, 'ICS_URL_MISSING');
  const { calendar, isNew } = await ensureIcsCalendar(account);
  const today = todayUtc();
  const expandAll = full || dateValue(calendar.remote_expanded_on) !== today;
  const feed = await caldav.fetchIcsFeed({ url: feedUrl, etag: expandAll ? null : calendar.remote_ctag });
  if (feed.notModified) return;
  const { objects } = ical.splitIcsFeed(feed.text);
  const listing = objects.map(object => ({ href: `#${object.uid}`, etag: object.etag, ics: object.ics }));
  const calendarCtx = { ...ctx, notify: ctx.notify && !isNew && !!calendar.remote_expanded_on };
  const unreadable = await syncCalendarObjects(calendarCtx, calendar, listing, async changed => changed, { expandAll });
  ctx.newEvents = calendarCtx.newEvents;
  await db.execute('UPDATE calendar_calendars SET remote_ctag = ?, remote_expanded_on = ? WHERE id = ?', [unreadable ? null : feed.etag, today, calendar.id]);
  ctx.stats.calendars += 1;
}

function unreadableMessage(count) {
  return count === 1
    ? '1 calendar entry could not be read. Its last readable version is kept.'
    : `${count} calendar entries could not be read. Their last readable versions are kept.`;
}

function userFacingError(error) {
  if (error?.status === 401 || error?.status === 403) return 'The calendar server rejected the login. Update the password of this account.';
  const message = String(error?.message || 'Calendar sync failed').slice(0, 500);
  return message;
}

async function withAccountLock(accountId, fn) {
  const connection = await db.getConnection();
  const lockName = "SHA2(CONCAT(DATABASE(), ':calendar-sync:', ?), 256)";
  let locked = false;
  try {
    const [rows] = await connection.execute(`SELECT GET_LOCK(${lockName}, 0) AS acquired`, [accountId]);
    locked = Number(rows[0]?.acquired) === 1;
    if (!locked) return { skipped: true, reason: 'busy' };
    return await fn();
  } finally {
    if (locked) await connection.execute(`SELECT RELEASE_LOCK(${lockName})`, [accountId]).catch(() => {});
    connection.release();
  }
}

// After a mail reconnect or login change the linked calendars sync now
// instead of at their next turn.
// A run already going may have read the old login (or none): the calendar
// syncs again once it has ended.
async function syncLinkedCalendars(userId, mailAccountId) {
  const [rows] = await db.execute(`SELECT id FROM calendar_accounts
    WHERE user_id = ? AND mail_account_id = ? AND provider = 'caldav' AND is_active = TRUE`, [userId, mailAccountId]);
  for (const row of rows) {
    if (inFlight.has(row.id)) followUps.add(row.id);
    else syncCalendarAccountInBackground(row.id, { userId, reason: 'credentials' });
  }
}

async function runAccountSync(accountId, { userId, reason, full }) {
  const account = await loadAccount(accountId, userId);
  if (!account || !REMOTE_PROVIDERS.has(account.provider)) throw syncError('Calendar account not found', 404, 'CALENDAR_ACCOUNT_NOT_FOUND');
  // A first sync never attempted (connected or restored, or interrupted by a
  // restart) is owed like the connect itself: it needs only the module, not
  // background sync, so it also runs after Calendar is turned on or a restart.
  const firstSyncOwed = !account.last_synced_at && account.sync_status === 'pending';
  const background = reason === 'scheduled' && !firstSyncOwed;
  const allowed = background
    ? await isModuleBackgroundEnabled(account.user_id, 'calendar')
    : await isModuleEnabled(account.user_id, 'calendar');
  if (!allowed || await isSectionRestoreActive(account.user_id, 'calendar')) return { skipped: true, reason: 'paused' };
  if (!account.is_active) return { skipped: true, reason: 'inactive' };

  return withAccountLock(accountId, async () => {
    const work = beginAccountWork(accountId);
    try { return await syncLocked(accountId, { userId, full }, work.signal); } finally { work.release(); }
  });
}

// No login (mail disconnected, or no password saved): the account waits, and
// is tried again at its next turn. Conditional: a user's pause keeps its
// status, and a mail account connected again meanwhile is not noted as
// disconnected. Its reconnect may have joined this run instead of starting
// one, so the calendar syncs again right after it.
async function noteMissingLogin(account, message) {
  const [noted] = await db.execute(`UPDATE calendar_accounts ca
    LEFT JOIN mail_accounts m ON m.id = ca.mail_account_id AND m.user_id = ca.user_id
    SET ca.sync_status = 'paused', ca.sync_error = ?, ca.next_sync_at = UTC_TIMESTAMP() + INTERVAL ? SECOND
    WHERE ca.id = ? AND ca.is_active = TRUE AND (ca.mail_account_id IS NULL OR m.id IS NULL OR NOT (${MAIL_CONNECTED_SQL}))`,
  [message, Math.round(SYNC_INTERVAL_MS / 1000), account.id]);
  if (!noted.affectedRows) {
    const current = await loadAccount(account.id, account.user_id);
    if (current?.is_active && current.mail_account_id) {
      await db.execute("UPDATE calendar_accounts SET sync_status = 'pending', next_sync_at = NULL WHERE id = ? AND is_active = TRUE", [account.id]);
      followUps.add(account.id);
    }
  }
  publishCalendarChanged(account.user_id, account.id, 'status');
}

const MISSING_LOGIN = new Map([['MAIL_ACCOUNT_DISCONNECTED', 'mail-disconnected'], ['CALDAV_NO_PASSWORD', 'no-password'], ['MAIL_CALENDAR_UNLINKED', 'mail-unlinked']]);

async function syncLocked(accountId, { userId, full }, signal) {
  // Reloaded under the lock: a change while the lock was awaited counts.
  const account = await loadAccount(accountId, userId);
  if (!account || !account.is_active) return { skipped: true, reason: 'inactive' };
  let login = null;
  if (account.provider === 'caldav') {
    try { login = await accountLogin(account, signal); } catch (error) {
      if (!MISSING_LOGIN.has(error.code)) throw error;
      await noteMissingLogin(account, error.message);
      return { skipped: true, reason: MISSING_LOGIN.get(error.code) };
    }
  }
  await db.execute("UPDATE calendar_accounts SET sync_status = 'syncing' WHERE id = ?", [account.id]);
  publishCalendarChanged(account.user_id, account.id, 'status');
  const now = Date.now();
  const ctx = {
    account,
    login,
    timeZone: await resolveTimeZone(account),
    windowStartMs: now - WINDOW_PAST_MS,
    windowEndMs: now + WINDOW_FUTURE_MS,
    // The first sync imports history; only later additions are announced.
    notify: !!account.last_synced_at && !full,
    newEvents: [],
    stats: { calendars: 0, changedObjects: 0, removedObjects: 0, events: 0, removedEvents: 0, unreadable: 0 },
  };
  try {
    if (account.provider === 'ics') await syncIcsAccount(ctx, { full });
    else await syncCalDavAccount(ctx, { full });
    // Everything readable is up to date; unreadable entries are reported
    // and downloaded again by the next sync.
    const unreadable = ctx.stats.unreadable;
    if (signal.aborted) throw signal.reason;
    // Conditional: a pause after the last server response keeps its status.
    await db.execute(
      `UPDATE calendar_accounts SET sync_status = ?, sync_error = ?, last_synced_at = UTC_TIMESTAMP(),
         next_sync_at = UTC_TIMESTAMP() + INTERVAL ? SECOND WHERE id = ? AND is_active = TRUE`,
      [unreadable ? 'error' : 'ok', unreadable ? unreadableMessage(unreadable) : null, Math.round(SYNC_INTERVAL_MS / 1000), account.id]
    );
  } catch (error) {
    if (signal.aborted) {
      // Stopped by a mail disconnect or an unlink (CalDAV accounts only).
      if (account.provider === 'caldav') await noteMissingLogin(account, signal.reason?.message || MAIL_DISCONNECTED_MESSAGE).catch(() => {});
      throw signal.reason;
    }
    const retryMs = error?.status === 401 || error?.status === 403 ? AUTH_ERROR_RETRY_MS : ERROR_RETRY_MS;
    await db.execute(
      `UPDATE calendar_accounts SET sync_status = 'error', sync_error = ?, next_sync_at = UTC_TIMESTAMP() + INTERVAL ? SECOND
       WHERE id = ? AND is_active = TRUE`,
      [userFacingError(error), Math.round(retryMs / 1000), account.id]
    ).catch(() => {});
    publishCalendarChanged(account.user_id, account.id, 'sync');
    throw error;
  }
  const { enqueueCalendarNotification } = require('./notifications');
  for (const eventId of ctx.newEvents.slice(0, MAX_NEW_EVENT_NOTIFICATIONS)) {
    await enqueueCalendarNotification({ userId: account.user_id, eventId }).catch(error =>
      console.warn('[CALENDAR] New event notification failed:', error.message));
  }
  publishCalendarChanged(account.user_id, account.id, 'sync');
  return { ok: true, ...ctx.stats };
}

// Concurrent requests for the same account share one run. A run that found
// the mail account connected again only after it gave up asks for a new one
// (followUps), started once it has ended.
function syncCalendarAccount(accountId, { userId = null, reason = 'manual', full = false } = {}) {
  if (inFlight.has(accountId)) return inFlight.get(accountId);
  const run = runAccountSync(accountId, { userId, reason, full }).finally(() => {
    inFlight.delete(accountId);
    if (followUps.delete(accountId)) syncCalendarAccountInBackground(accountId, { userId, reason: 'credentials' });
  });
  inFlight.set(accountId, run);
  return run;
}

function syncCalendarAccountInBackground(accountId, options) {
  syncCalendarAccount(accountId, options).catch(error => {
    console.warn(`[CALENDAR] Sync of account ${accountId} failed:`, error.message);
  });
}

async function runCalendarSyncPass() {
  if (passRunning) return { skipped: true };
  passRunning = true;
  let synced = 0;
  try {
    const [rows] = await db.execute(
      `SELECT id, user_id FROM calendar_accounts
       WHERE provider IN ('caldav', 'ics') AND is_active = TRUE AND (next_sync_at IS NULL OR next_sync_at <= UTC_TIMESTAMP())
       ORDER BY next_sync_at IS NOT NULL, next_sync_at ASC LIMIT ${ACCOUNTS_PER_PASS}`
    );
    for (const row of rows) {
      try {
        const result = await syncCalendarAccount(row.id, { userId: row.user_id, reason: 'scheduled' });
        if (result?.ok) synced += 1;
      } catch (error) {
        console.warn(`[CALENDAR] Scheduled sync of account ${row.id} failed:`, error.message);
      }
    }
    return { synced };
  } finally {
    passRunning = false;
  }
}

// --- Writeback --------------------------------------------------------------

async function loadCalendarContext(userId, calendarId) {
  if (!calendarId) return null;
  const [rows] = await db.execute(
    `SELECT c.id AS calendar_row_id, c.*, a.id AS account_row_id
     FROM calendar_calendars c JOIN calendar_accounts a ON a.id = c.account_id
     WHERE c.id = ? AND c.user_id = ? LIMIT 1`,
    [calendarId, userId]
  );
  if (!rows[0]) return null;
  const account = await loadAccount(rows[0].account_id, userId);
  if (!account || !REMOTE_PROVIDERS.has(account.provider)) return null;
  const calendar = { ...rows[0], id: rows[0].calendar_row_id };
  return { account, calendar };
}

function assertWritable({ account, calendar }) {
  if (account.provider === 'ics') throw syncError('Calendar subscriptions are read-only. Change this event in the original calendar.', 403, 'CALENDAR_READ_ONLY');
  if (calendar.read_only) throw syncError('This calendar is read-only on the calendar server.', 403, 'CALENDAR_READ_ONLY');
  if (!account.is_active) throw syncError('Sync is paused for this calendar account, so changes cannot be saved to it.', 409, 'CALENDAR_SYNC_PAUSED');
}

// Every writeback reads its login here, for a linked calendar from its mail
// account, so a disconnected mail account's login is never used.
async function withWriteContext(base, write) {
  const work = beginAccountWork(base.account.id);
  try {
    return await write({ ...base, login: await accountLogin(base.account, work.signal), timeZone: await resolveTimeZone(base.account) });
  } finally { work.release(); }
}

function rebuildContext(ctx) {
  const now = Date.now();
  return {
    account: ctx.account, timeZone: ctx.timeZone, notify: false, newEvents: [],
    windowStartMs: now - WINDOW_PAST_MS, windowEndMs: now + WINDOW_FUTURE_MS,
    stats: { calendars: 0, changedObjects: 0, removedObjects: 0, events: 0, removedEvents: 0, unreadable: 0 },
  };
}

async function loadEventLink(userId, eventId) {
  const [rows] = await db.execute(
    `SELECT r.external_event_id, r.recurrence_id, o.id AS object_id, o.href, o.etag, o.ics, o.calendar_id AS object_calendar_id
     FROM calendar_event_external_refs r JOIN calendar_remote_objects o ON o.id = r.remote_object_id
     WHERE r.event_id = ? AND r.user_id = ? LIMIT 1`,
    [eventId, userId]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return { recurrenceId: row.recurrence_id || '', object: { id: row.object_id, href: row.href, etag: row.etag, ics: row.ics } };
}

// An event imported before 0.17 has a server reference but no server copy
// yet; the next sync replaces it. A change made now would be undone by that
// sync, so it is refused until then.
async function assertNotPendingLink(ctx, userId, eventId) {
  const [legacy] = await db.execute('SELECT id FROM calendar_event_external_refs WHERE event_id = ? AND user_id = ? LIMIT 1', [eventId, userId]);
  if (!legacy.length) return;
  assertWritable(ctx);
  throw syncError('This event is still being synced. Try again in a moment.', 409, 'CALENDAR_SYNC_PENDING');
}

function isRecurringIcs(ics) {
  return /^(RRULE|RDATE)[:;]/im.test(String(ics || ''));
}

function eventFields(event) {
  const reminders = jsonValue(event.reminders, null);
  return {
    title: event.title,
    description: event.description || null,
    location: event.location || null,
    allDay: !!event.all_day,
    startMs: parseDatetimeToMillis(event.start_time),
    endMs: parseDatetimeToMillis(event.end_time),
    reminders: Array.isArray(reminders) ? reminders : (event.reminder_minutes != null ? [event.reminder_minutes] : []),
  };
}

function handleConflict(ctx, error) {
  if (error?.code === 'CALDAV_CONFLICT') syncCalendarAccountInBackground(ctx.account.id, { userId: ctx.account.user_id, reason: 'conflict' });
  throw error;
}

// Describes what writing an event to its calendar will involve, for routes
// that must reject a change before touching local data.
async function describeEventWrite(userId, event) {
  const ctx = await loadCalendarContext(userId, event.calendar_id);
  if (!ctx) return { remote: false };
  const link = await loadEventLink(userId, event.id);
  return { remote: true, ctx, link, recurring: !!link && isRecurringIcs(link.object.ics), readOnly: ctx.account.provider === 'ics' || !!ctx.calendar.read_only };
}

// Create a new server object for an existing local event row and link it.
async function pushCreatedEvent({ userId, event, calendarId = event.calendar_id }) {
  const base = await loadCalendarContext(userId, calendarId);
  if (!base) return null;
  if (event.is_todo_only) throw syncError('ToDos without a date cannot be saved to a server calendar.', 400, 'CALENDAR_TODO_REMOTE');
  assertWritable(base);
  return withWriteContext(base, async ctx => {
    const { uid, ics } = ical.createEventIcs(eventFields(event), { userTimeZone: ctx.timeZone });
    const collection = calendarUrl(ctx.account, ctx.calendar);
    const url = new URL(`${encodeURIComponent(uid)}.ics`, collection.endsWith('/') ? collection : `${collection}/`).toString();
    const { etag } = await caldav.putCalendarObject({ url, ics, etag: null, ...ctx.login }).catch(error => handleConflict(ctx, error));
    const object = await storeObject(ctx.account, ctx.calendar, { href: caldav.canonicalHref(url), etag, ics });
    await db.execute(
      `INSERT INTO calendar_event_external_refs
        (id, user_id, event_id, calendar_id, account_id, provider, external_event_id, external_etag, remote_object_id, recurrence_id, last_synced_at)
       VALUES (?, ?, ?, ?, ?, 'caldav', ?, ?, ?, NULL, UTC_TIMESTAMP())`,
      [crypto.randomUUID(), userId, event.id, ctx.calendar.id, ctx.account.id, externalEventId(object.id, ''), etag || null, object.id]
    );
    publishCalendarChanged(userId, ctx.account.id, 'local');
    return { objectId: object.id };
  });
}

// Write changed fields of an event to the server. scope applies to recurring
// events: 'occurrence' changes only this date, 'series' all of them.
async function pushEventUpdate({ userId, event, changes, scope }) {
  const base = await loadCalendarContext(userId, event.calendar_id);
  if (!base) return null;
  assertWritable(base);
  const link = await loadEventLink(userId, event.id);
  if (!link) {
    await assertNotPendingLink(base, userId, event.id);
    return pushCreatedEvent({ userId, event: { ...event, ...changes } });
  }
  return withWriteContext(base, async ctx => {
    const merged = eventFields({ ...event, ...changes });
    const fields = {};
    if ('title' in changes) fields.title = merged.title;
    if ('description' in changes) fields.description = merged.description;
    if ('location' in changes) fields.location = merged.location;
    if ('reminders' in changes || 'reminder_minutes' in changes) fields.reminders = merged.reminders;
    if ('start_time' in changes || 'end_time' in changes || 'all_day' in changes) {
      Object.assign(fields, { startMs: merged.startMs, endMs: merged.endMs, allDay: merged.allDay });
    }
    if (!Object.keys(fields).length) return { unchanged: true };
    const recurring = isRecurringIcs(link.object.ics);
    const effectiveScope = recurring ? (scope === 'series' || !link.recurrenceId ? 'series' : 'occurrence') : 'series';
    const ics = ical.updateEventIcs(link.object.ics, fields, {
      recurrenceId: link.recurrenceId, scope: effectiveScope, previousStartMs: parseDatetimeToMillis(event.start_time), userTimeZone: ctx.timeZone,
    });
    const { etag } = await caldav.putCalendarObject({ url: objectUrl(ctx.account, link.object), ics, etag: link.object.etag, ...ctx.login })
      .catch(error => handleConflict(ctx, error));
    const object = await storeObject(ctx.account, ctx.calendar, { id: link.object.id, href: link.object.href, etag, ics });
    await applyObject(rebuildContext(ctx), ctx.calendar, object);
    publishCalendarChanged(userId, ctx.account.id, 'local');
    return { scope: effectiveScope };
  });
}

// Remove an event from the server. For a recurring event, scope 'occurrence'
// removes only this date. Local rows are rebuilt or removed accordingly.
async function pushEventDelete({ userId, event, scope }) {
  const base = await loadCalendarContext(userId, event.calendar_id);
  if (!base) return null;
  const link = await loadEventLink(userId, event.id);
  if (!link) {
    await assertNotPendingLink(base, userId, event.id);
    return { localOnly: true };
  }
  assertWritable(base);
  return withWriteContext(base, async ctx => {
    const url = objectUrl(ctx.account, link.object);
    const recurring = isRecurringIcs(link.object.ics);
    if (recurring && link.recurrenceId && scope !== 'series') {
      const ics = ical.removeOccurrenceIcs(link.object.ics, link.recurrenceId, { userTimeZone: ctx.timeZone });
      if (ics) {
        const { etag } = await caldav.putCalendarObject({ url, ics, etag: link.object.etag, ...ctx.login }).catch(error => handleConflict(ctx, error));
        const object = await storeObject(ctx.account, ctx.calendar, { id: link.object.id, href: link.object.href, etag, ics });
        await applyObject(rebuildContext(ctx), ctx.calendar, object);
        publishCalendarChanged(userId, ctx.account.id, 'local');
        return { scope: 'occurrence' };
      }
    }
    await caldav.deleteCalendarObject({ url, etag: link.object.etag, ...ctx.login }).catch(error => handleConflict(ctx, error));
    await removeObjects(rebuildContext(ctx), [link.object.id]);
    publishCalendarChanged(userId, ctx.account.id, 'local');
    return { scope: 'series' };
  });
}

// Moving a single event to another calendar: create it in the target first,
// then remove it from the source, so a failure never loses the event.
async function pushEventMove({ userId, event, targetCalendarId, changes }) {
  const source = await describeEventWrite(userId, event);
  const target = await loadCalendarContext(userId, targetCalendarId);
  if (!source.remote && !target) return null;
  if (source.recurring) throw syncError('Recurring events cannot be moved to another calendar.', 400, 'CALENDAR_RECURRING_MOVE');
  if (source.remote && source.link) assertWritable(source.ctx);
  else if (source.remote) await assertNotPendingLink(source.ctx, userId, event.id);
  // The source login is needed to remove the old object; check it before the
  // target is created, so a refusal cannot leave a copy on both sides.
  if (source.remote && source.link) await resolveLogin(source.ctx.account);
  if (target) {
    // Create the copy before unlinking the old one so a failure leaves it as it was.
    const moved = { ...event, ...changes, calendar_id: targetCalendarId };
    const sourceLink = source.link;
    if (sourceLink) await db.execute('DELETE FROM calendar_event_external_refs WHERE event_id = ? AND user_id = ?', [event.id, userId]);
    try {
      await pushCreatedEvent({ userId, event: moved, calendarId: targetCalendarId });
    } catch (error) {
      if (sourceLink) {
        await db.execute(
          `INSERT INTO calendar_event_external_refs
            (id, user_id, event_id, calendar_id, account_id, provider, external_event_id, external_etag, remote_object_id, recurrence_id, last_synced_at)
           VALUES (?, ?, ?, ?, ?, 'caldav', ?, ?, ?, NULL, UTC_TIMESTAMP())`,
          [crypto.randomUUID(), userId, event.id, source.ctx.calendar.id, source.ctx.account.id, externalEventId(sourceLink.object.id, ''), sourceLink.object.etag, sourceLink.object.id]
        ).catch(() => {});
      }
      throw error;
    }
    if (sourceLink) await removeSourceObject(userId, source, sourceLink);
    return { moved: true };
  }
  if (source.link) {
    await db.execute('DELETE FROM calendar_event_external_refs WHERE event_id = ? AND user_id = ?', [event.id, userId]);
    await removeSourceObject(userId, source, source.link);
  }
  return { moved: true };
}

async function removeSourceObject(userId, source, link) {
  const accountId = source.ctx.account.id;
  try {
    // Inside the try: a mail disconnect during the move refuses the source
    // login, and the move still completes with the target copy.
    await withWriteContext(source.ctx, async ctx => {
      await caldav.deleteCalendarObject({ url: objectUrl(ctx.account, link.object), etag: link.object.etag, ...ctx.login });
      await db.execute('DELETE FROM calendar_remote_objects WHERE id = ? AND account_id = ?', [link.object.id, accountId]);
    });
  } catch (error) {
    // The copy in the target calendar exists; the next sync shows the old one again.
    console.warn('[CALENDAR] Could not remove moved event from its old calendar:', error.message);
    syncCalendarAccountInBackground(accountId, { userId, reason: 'conflict' });
  }
  publishCalendarChanged(userId, accountId, 'local');
}

// Route response for a failed sync or writeback. Raw server statuses must not
// reach the browser as-is: a 401 there would look like an expired session.
function calendarErrorResponse(error, fallback) {
  if (error?.code && error.status) return { error: error.message, status: error.status, code: error.code };
  if (error?.status === 401) return { error: 'The calendar server rejected the login. Update the password of this account.', status: 422, code: 'CALDAV_AUTH_FAILED' };
  if (error?.status === 403) return { error: 'The calendar server refused this change.', status: 422, code: 'CALDAV_FORBIDDEN' };
  if (error?.status) return { error: `The calendar server could not complete the request (${error.status}).`, status: 502, code: 'CALDAV_SERVER_ERROR' };
  console.error('[CALENDAR]', fallback, error);
  return { error: error?.message ? `${fallback}: ${error.message}` : fallback, status: 502, code: 'CALDAV_UNREACHABLE' };
}

module.exports = {
  MAIL_DISCONNECTED_MESSAGE,
  runningCalendarWorkCount,
  syncLinkedCalendars,
  resolveLogin,
  stopCalendarAccountWork,
  stopLinkedCalendarWork,
  SYNC_INTERVAL_MS,
  calendarErrorResponse,
  REMOTE_PROVIDERS,
  syncCalendarAccount,
  syncCalendarAccountInBackground,
  runCalendarSyncPass,
  deleteCalendarAccount,
  deleteCalendarsWithEvents,
  reconcileCalendarList,
  describeEventWrite,
  pushCreatedEvent,
  pushEventUpdate,
  pushEventDelete,
  pushEventMove,
};
