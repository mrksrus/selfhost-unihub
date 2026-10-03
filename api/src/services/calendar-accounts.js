// Connecting server calendars: CalDAV accounts found from a mail login (or a
// CalDAV address), and read-only iCalendar subscriptions. A calendar account
// connected from a mail account stays linked to it (mail_account_id): it
// shares the mail password, pauses when the mail account is disconnected and
// is removed when the mail account is purged.
const crypto = require('crypto');
const { db } = require('../state');
const { encrypt, decrypt } = require('../security/encryption');
const { isModuleEnabled } = require('./module-settings');
const { isSectionRestoreActive } = require('./restore-locks');
const { publishCalendarChanged } = require('./server-events');
const caldav = require('./caldav');
const { isValidTimeZone } = require('./calendar-ical');
const { CALENDAR_PROVIDER_DEFAULT_CAPABILITIES, serializeCalendarAccount, safeJsonParse } = require('./calendar');
const calendarSync = require('./calendar-sync');

const MAIL_DISCONNECTED_MESSAGE = 'The mail account is disconnected. Reconnect it to resume calendar sync.';

function fail(message, status = 400, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

async function assertCalendarAvailable(userId) {
  if (!await isModuleEnabled(userId, 'calendar')) throw fail('The Calendar module is turned off.', 409, 'CALENDAR_MODULE_DISABLED');
  if (await isSectionRestoreActive(userId, 'calendar')) throw fail('A calendar restore is in progress.', 409, 'CALENDAR_RESTORING');
}

function cleanTimeZone(value) {
  return isValidTimeZone(value) ? value : null;
}

// A pasted address is treated as a subscription when it clearly is one
// (webcal:, *.ics) or when the provider offers no CalDAV access.
function looksLikeIcsFeed(url, provider) {
  if (/^webcals?:/i.test(String(url).trim())) return true;
  if (provider?.unsupported) return true;
  try { return /\.ics$/i.test(new URL(String(url).trim()).pathname); } catch { return false; }
}

async function loadSerializedAccount(userId, accountId) {
  const [rows] = await db.execute('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
  return rows[0] ? serializeCalendarAccount(rows[0]) : null;
}

async function insertCalDavAccount({ userId, emailAddress, displayName, username, password, mailAccountId, timeZone, found }) {
  const accountId = crypto.randomUUID();
  const providerConfig = {
    principalHref: found.discovery.principalHref || null,
    credentialScope: found.credentialScope,
    server: found.server,
    hint: found.hint || null,
    timeZone: cleanTimeZone(timeZone),
  };
  await db.execute(
    `INSERT INTO calendar_accounts
      (id, user_id, provider, account_email, display_name, username, encrypted_password, discovery_url, base_url,
       provider_config, capabilities, is_active, sync_status, sync_error, mail_account_id, next_sync_at)
     VALUES (?, ?, 'caldav', ?, ?, ?, ?, ?, ?, ?, ?, TRUE, 'pending', NULL, ?, NULL)`,
    [accountId, userId, emailAddress || null, (displayName || emailAddress || found.server.label || 'Calendar').slice(0, 255),
      (username || emailAddress || '').slice(0, 255) || null, encrypt(password), found.server.url, found.discovery.baseUrl,
      JSON.stringify(providerConfig), JSON.stringify(CALENDAR_PROVIDER_DEFAULT_CAPABILITIES.caldav), mailAccountId || null]
  );
  const [rows] = await db.execute('SELECT * FROM calendar_accounts WHERE id = ?', [accountId]);
  const calendars = await calendarSync.reconcileCalendarList(rows[0], found.discovery.calendars);
  return { account: rows[0], calendars: calendars.map(item => item.calendar) };
}

async function insertIcsAccount({ userId, url, displayName, feedName, mailAccountId, emailAddress, timeZone }) {
  const accountId = crypto.randomUUID();
  const origin = new URL(url).origin;
  await db.execute(
    `INSERT INTO calendar_accounts
      (id, user_id, provider, account_email, display_name, username, encrypted_password, discovery_url, base_url,
       provider_config, capabilities, is_active, sync_status, sync_error, mail_account_id, next_sync_at)
     VALUES (?, ?, 'ics', ?, ?, NULL, ?, ?, NULL, ?, ?, TRUE, 'pending', NULL, ?, NULL)`,
    // The full address is a secret (it grants read access); only its origin is shown.
    [accountId, userId, emailAddress || null, (displayName || feedName || new URL(url).host).slice(0, 255), encrypt(url), origin,
      JSON.stringify({ server: { url: origin, source: 'subscription', label: new URL(url).host }, timeZone: cleanTimeZone(timeZone) }),
      JSON.stringify(CALENDAR_PROVIDER_DEFAULT_CAPABILITIES.ics), mailAccountId || null]
  );
  const [rows] = await db.execute('SELECT * FROM calendar_accounts WHERE id = ?', [accountId]);
  return { account: rows[0], calendars: [] };
}

async function findDuplicate(userId, provider, baseUrl, username) {
  const [rows] = await db.execute(
    `SELECT id, display_name FROM calendar_accounts WHERE user_id = ? AND provider = ? AND base_url = ? AND COALESCE(username, '') = ? LIMIT 1`,
    [userId, provider, baseUrl, username || '']
  );
  return rows[0] || null;
}

function startFirstSync(account) {
  setImmediate(() => calendarSync.syncCalendarAccountInBackground(account.id, { userId: account.user_id, reason: 'connect' }));
  publishCalendarChanged(account.user_id, account.id, 'status');
}

// Validate a subscription address by downloading it once.
async function probeIcsFeed(rawUrl) {
  const url = caldav.normalizeIcsFeedUrl(rawUrl);
  const policy = await caldav.validateDavUrlPolicy(url);
  if (policy.error) throw fail(policy.error, 422, 'OUTBOUND_HOST_BLOCKED');
  const feed = await caldav.fetchIcsFeed({ url }).catch(error => {
    if (error.code === 'ICS_INVALID') throw error;
    throw fail(error.status === 404 || error.status === 401 || error.status === 403
      ? 'The calendar address was not accepted. Copy the private or public iCal address again.'
      : `The calendar address could not be read: ${error.message}`, 422, 'ICS_UNREACHABLE');
  });
  const name = (/^X-WR-CALNAME:(.*)$/im.exec(feed.text)?.[1] || '').trim().slice(0, 255) || null;
  return { url, name };
}

async function connectIcsSubscription({ userId, url: rawUrl, displayName, mailAccountId = null, emailAddress = null, timeZone }) {
  await assertCalendarAvailable(userId);
  if (!rawUrl) throw fail('Enter the address of the calendar.', 400);
  const { url, name } = await probeIcsFeed(rawUrl);
  const { account } = await insertIcsAccount({ userId, url, displayName, feedName: name, mailAccountId, emailAddress, timeZone });
  startFirstSync(account);
  return { account: serializeCalendarAccount(account), calendars: [] };
}

// Find the calendar server for a login and connect it. caldavUrl is optional:
// without it the server is found from the address and mail server.
async function connectCalDavAccount({ userId, emailAddress, displayName, username, password, imapHost, caldavUrl, mailAccountId = null, timeZone }) {
  await assertCalendarAvailable(userId);
  const provider = caldav.matchCalendarProvider({ emailAddress, imapHost });
  if (caldavUrl && looksLikeIcsFeed(caldavUrl, provider)) {
    return connectIcsSubscription({ userId, url: caldavUrl, displayName, mailAccountId, emailAddress, timeZone });
  }
  let found;
  try {
    found = await caldav.findCalDavServer({ emailAddress, imapHost, username, password, explicitUrl: caldavUrl || null });
  } catch (error) {
    // A pasted public calendar address that is not a CalDAV server.
    if (caldavUrl && ['CALDAV_NOT_FOUND', 'CALDAV_NO_CALENDAR_HOME'].includes(error.code)) {
      return connectIcsSubscription({ userId, url: caldavUrl, displayName, mailAccountId, emailAddress, timeZone }).catch(() => { throw error; });
    }
    throw error;
  }
  const login = username || emailAddress;
  const duplicate = await findDuplicate(userId, 'caldav', found.discovery.baseUrl, login);
  if (duplicate && !mailAccountId) {
    throw fail(`These calendars are already connected as "${duplicate.display_name || 'Calendar'}".`, 409, 'CALENDAR_ALREADY_CONNECTED');
  }
  if (duplicate) await calendarSync.deleteCalendarAccount(userId, duplicate.id);
  const { account, calendars } = await insertCalDavAccount({ userId, emailAddress, displayName, username: login, password, mailAccountId, timeZone, found });
  startFirstSync(account);
  return { account: serializeCalendarAccount(account), calendars, server: found.server, hint: found.hint || null };
}

async function removeCalendarAccount(userId, accountId) {
  await calendarSync.deleteCalendarAccount(userId, accountId);
}

// --- Mail account link ------------------------------------------------------

async function loadMailAccount(userId, mailAccountId) {
  const [rows] = await db.execute(
    'SELECT id, user_id, email_address, display_name, username, imap_host, encrypted_password, is_active, disconnected_at FROM mail_accounts WHERE id = ? AND user_id = ?',
    [mailAccountId, userId]
  );
  if (!rows[0]) throw fail('Account not found', 404);
  return rows[0];
}

async function linkedCalendarAccount(userId, mail) {
  const [linked] = await db.execute('SELECT * FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ? ORDER BY created_at ASC LIMIT 1', [userId, mail.id]);
  if (linked[0]) return linked[0];
  // Accounts connected before 0.17 (or restored from a backup) carry only the
  // address; the first look links them.
  const [unlinked] = await db.execute(
    `SELECT * FROM calendar_accounts WHERE user_id = ? AND provider = 'caldav' AND mail_account_id IS NULL AND LOWER(account_email) = LOWER(?)
     ORDER BY created_at ASC LIMIT 1`,
    [userId, mail.email_address]
  );
  if (!unlinked[0]) return null;
  await db.execute('UPDATE calendar_accounts SET mail_account_id = ? WHERE id = ? AND mail_account_id IS NULL', [mail.id, unlinked[0].id]);
  return { ...unlinked[0], mail_account_id: mail.id };
}

async function describeLink(userId, mail, account) {
  const provider = caldav.matchCalendarProvider({ emailAddress: mail.email_address, imapHost: mail.imap_host });
  const base = {
    enabled: false,
    account: null,
    calendars: [],
    event_count: 0,
    provider: provider ? { id: provider.id, label: provider.label, supported: !provider.unsupported, hint: provider.hint || null } : null,
  };
  if (!account) return base;
  const [calendars] = await db.execute('SELECT id, name, color, read_only, is_visible FROM calendar_calendars WHERE account_id = ? AND user_id = ? ORDER BY is_primary DESC, name ASC', [account.id, userId]);
  const [[count]] = await db.execute(
    'SELECT COUNT(*) AS n FROM calendar_events e JOIN calendar_calendars c ON c.id = e.calendar_id WHERE c.account_id = ? AND e.user_id = ?',
    [account.id, userId]
  );
  return {
    ...base,
    enabled: true,
    account: serializeCalendarAccount(account),
    calendars: calendars.map(row => ({ id: row.id, name: row.name, color: row.color, read_only: !!row.read_only, is_visible: !!row.is_visible })),
    event_count: Number(count.n) || 0,
  };
}

async function getMailCalendarLink(userId, mailAccountId) {
  const mail = await loadMailAccount(userId, mailAccountId);
  return describeLink(userId, mail, await linkedCalendarAccount(userId, mail));
}

function currentManualUrl(account) {
  const config = safeJsonParse(account?.provider_config, {}) || {};
  return config.server?.source === 'manual' ? config.server.url : '';
}

// Turn the calendar of a mail account on or off, or change its address.
// caldav_url: undefined keeps the current address, '' finds it automatically.
async function setMailCalendar(userId, mailAccountId, { enabled, caldav_url: caldavUrl, time_zone: timeZone } = {}) {
  if (typeof enabled !== 'boolean') throw fail('enabled must be true or false', 400);
  if (caldavUrl !== undefined && caldavUrl !== null && typeof caldavUrl !== 'string') throw fail('Calendar address must be text', 400);
  const requestedUrl = caldavUrl == null ? undefined : caldavUrl.trim();
  if (requestedUrl && requestedUrl.length > 2000) throw fail('Calendar address is too long', 400);
  const mail = await loadMailAccount(userId, mailAccountId);
  const existing = await linkedCalendarAccount(userId, mail);

  if (!enabled) {
    if (existing) await removeCalendarAccount(userId, existing.id);
    return describeLink(userId, mail, null);
  }
  await assertCalendarAvailable(userId);

  const existingUrl = existing?.provider === 'ics' ? null : currentManualUrl(existing);
  const addressChanged = requestedUrl !== undefined && (existing?.provider === 'ics' ? !!requestedUrl : requestedUrl !== existingUrl);
  if (existing && !addressChanged) {
    if (existing.provider === 'caldav' && !existing.is_active) {
      if (!mail.is_active || !mail.encrypted_password) throw fail(MAIL_DISCONNECTED_MESSAGE, 409, 'MAIL_ACCOUNT_DISCONNECTED');
      await db.execute(
        "UPDATE calendar_accounts SET is_active = TRUE, encrypted_password = ?, username = ?, sync_status = 'pending', sync_error = NULL, next_sync_at = NULL WHERE id = ?",
        [mail.encrypted_password, mail.username || mail.email_address, existing.id]
      );
    } else {
      await db.execute('UPDATE calendar_accounts SET next_sync_at = NULL WHERE id = ?', [existing.id]);
    }
    calendarSync.syncCalendarAccountInBackground(existing.id, { userId, reason: 'manual' });
    return describeLink(userId, mail, (await db.execute('SELECT * FROM calendar_accounts WHERE id = ?', [existing.id]))[0][0]);
  }

  const password = mail.encrypted_password ? decrypt(mail.encrypted_password) : null;
  const manualUrl = requestedUrl !== undefined ? requestedUrl : existingUrl;
  const subscription = manualUrl && looksLikeIcsFeed(manualUrl, caldav.matchCalendarProvider({ emailAddress: mail.email_address, imapHost: mail.imap_host }));
  if (!subscription && (!mail.is_active || !password)) throw fail(MAIL_DISCONNECTED_MESSAGE, 409, 'MAIL_ACCOUNT_DISCONNECTED');
  // Connect the new address first; the old calendars are only replaced once
  // it works.
  const connected = await connectCalDavAccount({
    userId,
    emailAddress: mail.email_address,
    displayName: mail.display_name || mail.email_address,
    username: mail.username || mail.email_address,
    password,
    imapHost: mail.imap_host,
    caldavUrl: manualUrl || null,
    mailAccountId: mail.id,
    timeZone,
  });
  if (existing && existing.id !== connected.account.id) {
    const [still] = await db.execute('SELECT id FROM calendar_accounts WHERE id = ?', [existing.id]);
    if (still.length) await removeCalendarAccount(userId, existing.id);
  }
  const [rows] = await db.execute('SELECT * FROM calendar_accounts WHERE id = ?', [connected.account.id]);
  return { ...await describeLink(userId, mail, rows[0]), server: connected.server || null, hint: connected.hint || null };
}

// The mail password or login changed: the linked CalDAV account uses it too.
async function updateLinkedCalendarCredentials(userId, mailAccountId) {
  const [mails] = await db.execute('SELECT id, email_address, username, encrypted_password, is_active FROM mail_accounts WHERE id = ? AND user_id = ?', [mailAccountId, userId]);
  const mail = mails[0];
  if (!mail || !mail.encrypted_password || !mail.is_active) return;
  const [rows] = await db.execute("SELECT id FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ? AND provider = 'caldav'", [userId, mailAccountId]);
  for (const row of rows) {
    await db.execute(
      "UPDATE calendar_accounts SET username = ?, encrypted_password = ?, is_active = TRUE, sync_status = 'pending', sync_error = NULL, next_sync_at = NULL WHERE id = ?",
      [mail.username || mail.email_address, mail.encrypted_password, row.id]
    );
    calendarSync.syncCalendarAccountInBackground(row.id, { userId, reason: 'credentials' });
  }
}

// Disconnecting mail removes its stored password; the calendar pauses with it
// and keeps its events until the account is reconnected or removed.
async function pauseLinkedCalendar(userId, mailAccountId) {
  const [rows] = await db.execute("SELECT id FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ? AND provider = 'caldav'", [userId, mailAccountId]);
  for (const row of rows) {
    await db.execute(
      "UPDATE calendar_accounts SET is_active = FALSE, encrypted_password = NULL, sync_status = 'paused', sync_error = ? WHERE id = ?",
      [MAIL_DISCONNECTED_MESSAGE, row.id]
    );
    publishCalendarChanged(userId, row.id, 'status');
  }
}

async function removeLinkedCalendars(userId, mailAccountId) {
  const [rows] = await db.execute('SELECT id FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ?', [userId, mailAccountId]);
  for (const row of rows) await removeCalendarAccount(userId, row.id);
}

module.exports = {
  connectCalDavAccount,
  connectIcsSubscription,
  removeCalendarAccount,
  getMailCalendarLink,
  setMailCalendar,
  updateLinkedCalendarCredentials,
  pauseLinkedCalendar,
  removeLinkedCalendars,
  loadSerializedAccount,
};
