// Connecting server calendars: CalDAV accounts found from a mail login (or a
// CalDAV address), and read-only iCalendar subscriptions. A calendar account
// connected from a mail account stays linked to it (mail_account_id): it has
// no password of its own but uses the mail login (see calendar-sync
// resolveLogin), so it waits while the mail account is disconnected, and it is
// removed when the mail account is purged.
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { ApiError, MailAccountIdentity, SqlExecutor, StoredFlag } from '../types';
import type { CalendarAccount } from '../types/calendar';
import crypto from 'crypto';
import { db } from '../state';
import { encrypt, decrypt } from '../security/encryption';
import { isModuleEnabled } from './module-settings';
import { isSectionRestoreActive } from './restore-locks';
import { publishCalendarChanged } from './server-events';
import * as caldav from './caldav';
import { isValidTimeZone } from './calendar-ical';
import {
  CALENDAR_PROVIDER_DEFAULT_CAPABILITIES,
  MAIL_DISCONNECTED_MESSAGE,
  MAIL_CONNECTED_SQL,
  serializeCalendarAccount,
  safeJsonParse,
  wasMailCalendar,
} from './calendar';
import * as calendarSync from './calendar-sync';

interface AccountRow extends CalendarAccount { provider: string; encrypted_password?: string | null }
interface MailRow extends MailAccountIdentity {
  id: string;
  user_id: string;
  email_address: string;
  display_name?: string | null;
  encrypted_password?: string | null;
  is_active?: StoredFlag;
  disconnected_at?: Date | string | null;
  connected?: number | string | null;
}
type MailAddress = Pick<MailRow, 'id' | 'email_address'>;
interface Config { timeZone?: unknown; mailLinked?: boolean; server?: { source?: string; url?: string } }
interface ConnectInput {
  userId: string;
  emailAddress?: string | null;
  displayName?: string | null;
  username?: string | null;
  password?: string | null;
  imapHost?: string | null;
  caldavUrl?: string | null;
  mailAccountId?: string | null;
  timeZone?: unknown;
}
interface IcsInput {
  userId: string;
  url: string;
  displayName?: string | null;
  mailAccountId?: string | null;
  emailAddress?: string | null;
  timeZone?: unknown;
}

function fail(message: string, status = 400, code?: string) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

async function assertCalendarAvailable(userId: string) {
  if (!await isModuleEnabled(userId, 'calendar')) throw fail('The Calendar module is turned off.', 409, 'CALENDAR_MODULE_DISABLED');
  if (await isSectionRestoreActive(userId, 'calendar')) throw fail('A calendar restore is in progress.', 409, 'CALENDAR_RESTORING');
}

function cleanTimeZone(value: unknown) {
  return isValidTimeZone(value) ? value : null;
}

// A pasted address is treated as a subscription when it clearly is one
// (webcal:, *.ics) or when the provider offers no CalDAV access.
function looksLikeIcsFeed(url: unknown, provider: ReturnType<typeof caldav.matchCalendarProvider>) {
  if (/^webcals?:/i.test(String(url).trim())) return true;
  if (provider?.unsupported) return true;
  try { return /\.ics$/i.test(new URL(String(url).trim()).pathname); } catch { return false; }
}

async function loadSerializedAccount(userId: string, accountId: string) {
  const [rows] = await db.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
  return rows[0] ? serializeCalendarAccount(rows[0]) : null;
}

// existing: an account with the same login that is taken over in place, so
// its calendars, events and their ToDo state are kept. One linked to a mail
// account stores no password.
async function saveCalDavAccount({ userId, emailAddress, displayName, username, password, mailAccountId, timeZone, found, existing = null }: ConnectInput & { found: Awaited<ReturnType<typeof caldav.findCalDavServer>>; existing?: AccountRow | null }) {
  const accountId = existing?.id || crypto.randomUUID();
  // findCalDavServer has rejected a missing password for an unlinked account.
  const storedPassword = mailAccountId ? null : encrypt(password!);
  const previous = (safeJsonParse(existing?.provider_config, {}) || {}) as Config;
  const providerConfig = {
    principalHref: found.discovery.principalHref || null,
    credentialScope: found.credentialScope,
    server: found.server,
    hint: found.hint || null,
    timeZone: cleanTimeZone(timeZone) || cleanTimeZone(previous.timeZone),
    ...(mailAccountId ? { mailLinked: true } : {}),
  };
  if (existing) {
    await db.execute(
      `UPDATE calendar_accounts SET account_email = ?, username = ?, encrypted_password = ?, discovery_url = ?, base_url = ?, provider_config = ?,
         is_active = TRUE, sync_status = 'pending', sync_error = NULL, mail_account_id = ?, next_sync_at = NULL
       WHERE id = ? AND user_id = ?`,
      [emailAddress || null, (username || emailAddress || '').slice(0, 255) || null, storedPassword, found.server.url, found.discovery.baseUrl,
        JSON.stringify(providerConfig), mailAccountId || null, accountId, userId]
    );
  } else {
    await db.execute(
      `INSERT INTO calendar_accounts
        (id, user_id, provider, account_email, display_name, username, encrypted_password, discovery_url, base_url,
         provider_config, capabilities, is_active, sync_status, sync_error, mail_account_id, next_sync_at)
       VALUES (?, ?, 'caldav', ?, ?, ?, ?, ?, ?, ?, ?, TRUE, 'pending', NULL, ?, NULL)`,
      [accountId, userId, emailAddress || null, (displayName || emailAddress || found.server.label || 'Calendar').slice(0, 255),
        (username || emailAddress || '').slice(0, 255) || null, storedPassword, found.server.url, found.discovery.baseUrl,
        JSON.stringify(providerConfig), JSON.stringify(CALENDAR_PROVIDER_DEFAULT_CAPABILITIES.caldav), mailAccountId || null]
    );
  }
  const [rows] = await db.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM calendar_accounts WHERE id = ?', [accountId]);
  const calendars = await calendarSync.reconcileCalendarList(rows[0], found.discovery.calendars);
  return { account: rows[0], calendars: calendars.map(item => item.calendar) };
}

async function insertIcsAccount({ userId, url, displayName, feedName, mailAccountId, emailAddress, timeZone }: IcsInput & { feedName?: string | null }) {
  const accountId = crypto.randomUUID();
  const origin = new URL(url).origin;
  await db.execute(
    `INSERT INTO calendar_accounts
      (id, user_id, provider, account_email, display_name, username, encrypted_password, discovery_url, base_url,
       provider_config, capabilities, is_active, sync_status, sync_error, mail_account_id, next_sync_at)
     VALUES (?, ?, 'ics', ?, ?, NULL, ?, ?, NULL, ?, ?, TRUE, 'pending', NULL, ?, NULL)`,
    // The full address is a secret (it grants read access); only its origin is shown.
    [accountId, userId, emailAddress || null, (displayName || feedName || new URL(url).host).slice(0, 255), encrypt(url), origin,
      JSON.stringify({
        server: { url: origin, source: 'subscription', label: new URL(url).host },
        timeZone: cleanTimeZone(timeZone),
        ...(mailAccountId ? { mailLinked: true } : {}),
      }),
      JSON.stringify(CALENDAR_PROVIDER_DEFAULT_CAPABILITIES.ics), mailAccountId || null]
  );
  const [rows] = await db.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM calendar_accounts WHERE id = ?', [accountId]);
  return { account: rows[0], calendars: [] };
}

// A linked account is compared by its mail account's current login (its own
// username is the one it was connected with).
async function findDuplicate(userId: string, provider: string, baseUrl: string, username?: string | null) {
  const [rows] = await db.execute<(RowDataPacket & AccountRow)[]>(
    `SELECT ca.id, ca.display_name, ca.mail_account_id, ca.provider_config FROM calendar_accounts ca
     LEFT JOIN mail_accounts m ON m.id = ca.mail_account_id AND m.user_id = ca.user_id
     WHERE ca.user_id = ? AND ca.provider = ? AND ca.base_url = ?
       AND COALESCE(IF(m.id IS NULL, NULL, COALESCE(NULLIF(m.username, ''), m.email_address)), ca.username, '') = ?
     ORDER BY ca.created_at ASC LIMIT 1`,
    [userId, provider, baseUrl, username || '']
  );
  return rows[0] || null;
}

function startFirstSync(account: AccountRow) {
  setImmediate(() => calendarSync.syncCalendarAccountInBackground(account.id, { userId: account.user_id, reason: 'connect' }));
  publishCalendarChanged(account.user_id, account.id, 'status');
}

// Validate a subscription address by downloading it once.
async function probeIcsFeed(rawUrl: unknown) {
  const url = caldav.normalizeIcsFeedUrl(rawUrl);
  const policy = await caldav.validateDavUrlPolicy(url);
  if (policy.error) throw fail(policy.error, 422, 'OUTBOUND_HOST_BLOCKED');
  const feed = await caldav.fetchIcsFeed({ url }).catch((error: ApiError) => {
    if (error.code === 'ICS_INVALID') throw error;
    throw fail(error.status === 404 || error.status === 401 || error.status === 403
      ? 'The calendar address was not accepted. Copy the private or public iCal address again.'
      : `The calendar address could not be read: ${error.message}`, 422, 'ICS_UNREACHABLE');
  });
  const name = (/^X-WR-CALNAME:(.*)$/im.exec(feed.notModified ? '' : feed.text)?.[1] || '').trim().slice(0, 255) || null;
  return { url, name };
}

async function connectIcsSubscription({ userId, url: rawUrl, displayName, mailAccountId = null, emailAddress = null, timeZone }: IcsInput) {
  await assertCalendarAvailable(userId);
  if (!rawUrl) throw fail('Enter the address of the calendar.', 400);
  const { url, name } = await probeIcsFeed(rawUrl);
  const { account } = await insertIcsAccount({ userId, url, displayName, feedName: name, mailAccountId, emailAddress, timeZone });
  startFirstSync(account);
  return { account: serializeCalendarAccount(account), calendars: [] };
}

// Find the calendar server for a login and connect it. caldavUrl is optional:
// without it the server is found from the address and mail server.
// An iCalendar subscription has no calendars yet, and no server or hint.
interface ConnectedCalendar {
  account: ReturnType<typeof serializeCalendarAccount>;
  calendars: Awaited<ReturnType<typeof saveCalDavAccount>>['calendars'];
  server?: Awaited<ReturnType<typeof caldav.findCalDavServer>>['server'];
  hint?: string | null;
}

async function connectCalDavAccount({ userId, emailAddress, displayName, username, password, imapHost, caldavUrl, mailAccountId = null, timeZone }: ConnectInput): Promise<ConnectedCalendar> {
  await assertCalendarAvailable(userId);
  const provider = caldav.matchCalendarProvider({ emailAddress, imapHost });
  if (caldavUrl && looksLikeIcsFeed(caldavUrl, provider)) {
    return connectIcsSubscription({ userId, url: caldavUrl, displayName, mailAccountId, emailAddress, timeZone });
  }
  let found;
  try {
    found = await caldav.findCalDavServer({ emailAddress, imapHost, username: username as string | undefined, password: password as string | undefined, explicitUrl: caldavUrl || null });
  } catch (error) {
    // A pasted public calendar address that is not a CalDAV server.
    if (caldavUrl && ['CALDAV_NOT_FOUND', 'CALDAV_NO_CALENDAR_HOME'].includes((error as ApiError).code!)) {
      return connectIcsSubscription({ userId, url: caldavUrl, displayName, mailAccountId, emailAddress, timeZone }).catch(() => { throw error; });
    }
    throw error;
  }
  const login = username || emailAddress;
  let duplicate: AccountRow | null = await findDuplicate(userId, 'caldav', found.discovery.baseUrl, login);
  // A mail calendar not linked (restored, or its mail accounts were cleared)
  // keeps the login it was connected with, which a later mail login change
  // does not update: it is found by its address and server instead.
  if (!duplicate && mailAccountId) {
    const [unlinked] = await db.execute<(RowDataPacket & AccountRow)[]>(`SELECT * FROM calendar_accounts WHERE user_id = ? AND provider = 'caldav' AND mail_account_id IS NULL
        AND LOWER(account_email) = LOWER(?) AND base_url = ? ORDER BY created_at ASC`, [userId, emailAddress ?? null, found.discovery.baseUrl]);
    duplicate = unlinked.find(wasMailCalendar) || null;
  }
  if (duplicate && !mailAccountId) {
    throw fail(`These calendars are already connected as "${duplicate.display_name || 'Calendar'}".`, 409, 'CALENDAR_ALREADY_CONNECTED');
  }
  // Turning on a mail account's calendar takes over an unlinked account with
  // the same login (one restored from a 0.17.0 backup has no link). One that
  // belongs to another mail account is replaced.
  const existing = duplicate && ([null, mailAccountId] as (string | null | undefined)[]).includes(duplicate.mail_account_id) ? duplicate : null;
  if (duplicate && !existing) await calendarSync.deleteCalendarAccount(userId, duplicate.id);
  const { account, calendars } = await saveCalDavAccount({ userId, emailAddress, displayName, username: login, password, mailAccountId, timeZone, found, existing });
  startFirstSync(account);
  return { account: serializeCalendarAccount(account), calendars, server: found.server, hint: found.hint || null };
}

async function removeCalendarAccount(userId: string, accountId: string) {
  await calendarSync.deleteCalendarAccount(userId, accountId);
}

// --- Mail account link ------------------------------------------------------

async function loadMailAccount(userId: string, mailAccountId: string) {
  const [rows] = await db.execute<(RowDataPacket & MailRow)[]>(
    `SELECT m.id, m.user_id, m.email_address, m.display_name, m.username, m.imap_host, m.encrypted_password, m.is_active, m.disconnected_at,
       (${MAIL_CONNECTED_SQL}) AS connected
     FROM mail_accounts m WHERE m.id = ? AND m.user_id = ?`,
    [mailAccountId, userId]
  );
  if (!rows[0]) throw fail('Account not found', 404);
  return rows[0];
}

// A restored calendar account this mail account takes over when its link is
// next read (no account is linked yet).
async function restoredMailCalendar(userId: string, mail: Pick<MailRow, 'email_address'>, executor: SqlExecutor = db) {
  const [unlinked] = await executor.execute<(RowDataPacket & AccountRow)[]>(
    `SELECT * FROM calendar_accounts WHERE user_id = ? AND provider IN ('caldav', 'ics') AND mail_account_id IS NULL AND LOWER(account_email) = LOWER(?)
     ORDER BY created_at ASC`,
    [userId, mail.email_address]
  );
  return unlinked.find(wasMailCalendar) || null;
}

async function linkedCalendarAccount(userId: string, mail: MailAddress): Promise<AccountRow | null> {
  const [linked] = await db.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ? ORDER BY created_at ASC LIMIT 1', [userId, mail.id]);
  if (linked[0]) return linked[0];
  const candidate = await restoredMailCalendar(userId, mail);
  if (!candidate) return null;
  // The link and its mark are written together: backups keep only the mark.
  // A CalDAV account drops a password restored with it: it uses the mail login.
  const config = { ...(safeJsonParse(candidate.provider_config, {}) || {}), mailLinked: true };
  const [result] = await db.execute<ResultSetHeader>(`UPDATE calendar_accounts SET mail_account_id = ?, provider_config = ?,
      encrypted_password = IF(provider = 'caldav', NULL, encrypted_password)
    WHERE id = ? AND mail_account_id IS NULL`, [mail.id, JSON.stringify(config), candidate.id]);
  if (!result.affectedRows) {
    // A concurrent request linked it first.
    const [again] = await db.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM calendar_accounts WHERE id = ? AND mail_account_id = ?', [candidate.id, mail.id]);
    return again[0] || null;
  }
  return { ...candidate, mail_account_id: mail.id, provider_config: JSON.stringify(config),
    encrypted_password: candidate.provider === 'caldav' ? null : candidate.encrypted_password };
}

// The other way round, when a restored calendar is used before its mail
// account read the link: it finds that mail account by address. Returns the
// mail account id, or null when it belongs to none (or another account of
// that mail account was linked first).
async function relinkRestoredCalendar(account: AccountRow) {
  if (account.mail_account_id || !account.account_email || !wasMailCalendar(account)) return null;
  const [mails] = await db.execute<(RowDataPacket & MailAddress)[]>('SELECT id, email_address FROM mail_accounts WHERE user_id = ? AND LOWER(email_address) = LOWER(?) ORDER BY created_at ASC',
    [account.user_id, account.account_email]);
  for (const mail of mails) {
    if ((await linkedCalendarAccount(account.user_id, mail))?.id === account.id) return mail.id;
  }
  return null;
}

// A new mail account's calendar is the one just connected for it. A restored
// one that a calendar sync linked to it by address meanwhile is unlinked again
// (it then waits, like when the sync came later), and the running work of a
// CalDAV one, which read the mail login, is stopped: a disconnect would no
// longer find it.
async function keepMailCalendar(userId: string, mailAccountId: string, accountId: string) {
  const [others] = await db.execute<(RowDataPacket & { id: string; provider: string })[]>('SELECT id, provider FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ? AND id <> ?', [userId, mailAccountId, accountId]);
  for (const other of others) {
    await db.execute('UPDATE calendar_accounts SET mail_account_id = NULL WHERE id = ? AND mail_account_id = ?', [other.id, mailAccountId]);
    // A subscription uses no mail login and goes on.
    if (other.provider === 'caldav') calendarSync.stopCalendarAccountWork(other.id, 'replaced');
  }
}

async function describeLink(userId: string, mail: MailRow, account: AccountRow | null) {
  const provider = caldav.matchCalendarProvider({ emailAddress: mail.email_address, imapHost: mail.imap_host });
  const base = {
    enabled: false,
    account: null,
    calendars: [],
    event_count: 0,
    provider: provider ? { id: provider.id, label: provider.label, supported: !provider.unsupported, hint: provider.hint || null } : null,
  };
  if (!account) return base;
  const [calendars] = await db.execute<(RowDataPacket & { id: string; name: string; color: string | null; read_only: StoredFlag; is_visible: StoredFlag })[]>('SELECT id, name, color, read_only, is_visible FROM calendar_calendars WHERE account_id = ? AND user_id = ? ORDER BY is_primary DESC, name ASC', [account.id, userId]);
  const [[count]] = await db.execute<(RowDataPacket & { n: number | string })[]>(
    'SELECT COUNT(*) AS n FROM calendar_events e JOIN calendar_calendars c ON c.id = e.calendar_id WHERE c.account_id = ? AND e.user_id = ?',
    [account.id, userId]
  );
  return {
    ...base,
    enabled: true,
    account: serializeCalendarAccount({ ...account, mail_connected: mail.connected }),
    calendars: calendars.map(row => ({ id: row.id, name: row.name, color: row.color, read_only: !!row.read_only, is_visible: !!row.is_visible })),
    event_count: Number(count.n) || 0,
  };
}

async function getMailCalendarLink(userId: string, mailAccountId: string) {
  const mail = await loadMailAccount(userId, mailAccountId);
  await assertCalendarAvailable(userId);
  return describeLink(userId, mail, await linkedCalendarAccount(userId, mail));
}

function currentManualUrl(account: AccountRow | null) {
  const config = (safeJsonParse(account?.provider_config, {}) || {}) as Config;
  return config.server?.source === 'manual' ? config.server.url : '';
}

// Turn the calendar of a mail account on or off, or change its address.
// caldav_url: undefined keeps the current address, '' finds it automatically.
async function setMailCalendar(userId: string, mailAccountId: string, { enabled, caldav_url: caldavUrl, time_zone: timeZone }: { enabled?: unknown; caldav_url?: unknown; time_zone?: unknown } = {}) {
  if (typeof enabled !== 'boolean') throw fail('enabled must be true or false', 400);
  if (caldavUrl !== undefined && caldavUrl !== null && typeof caldavUrl !== 'string') throw fail('Calendar address must be text', 400);
  const requestedUrl = caldavUrl == null ? undefined : caldavUrl.trim();
  if (requestedUrl && requestedUrl.length > 2000) throw fail('Calendar address is too long', 400);
  const mail = await loadMailAccount(userId, mailAccountId);
  // These routes are under /api/mail, so the request boundary checks only the
  // Mail module; turning the calendar off deletes calendar data.
  await assertCalendarAvailable(userId);
  const existing = await linkedCalendarAccount(userId, mail);

  if (!enabled) {
    if (existing) await removeCalendarAccount(userId, existing.id);
    return describeLink(userId, mail, null);
  }

  const existingUrl = existing?.provider === 'ics' ? null : currentManualUrl(existing);
  const addressChanged = requestedUrl !== undefined && (existing?.provider === 'ics' ? !!requestedUrl : requestedUrl !== existingUrl);
  if (existing && !addressChanged) {
    if (existing.provider === 'caldav' && !existing.is_active) {
      if (!Number(mail.connected)) throw fail(MAIL_DISCONNECTED_MESSAGE, 409, 'MAIL_ACCOUNT_DISCONNECTED');
      await db.execute(
        "UPDATE calendar_accounts SET is_active = TRUE, encrypted_password = NULL, sync_status = 'pending', sync_error = NULL, next_sync_at = NULL WHERE id = ?",
        [existing.id]
      );
    } else {
      await db.execute('UPDATE calendar_accounts SET next_sync_at = NULL WHERE id = ?', [existing.id]);
    }
    calendarSync.syncCalendarAccountInBackground(existing.id, { userId, reason: 'manual' });
    return describeLink(userId, mail, (await db.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM calendar_accounts WHERE id = ?', [existing.id]))[0][0]);
  }

  const password = mail.encrypted_password ? decrypt(mail.encrypted_password) : null;
  const manualUrl = requestedUrl !== undefined ? requestedUrl : existingUrl;
  const subscription = manualUrl && looksLikeIcsFeed(manualUrl, caldav.matchCalendarProvider({ emailAddress: mail.email_address, imapHost: mail.imap_host }));
  if (!subscription && (!Number(mail.connected) || !password)) throw fail(MAIL_DISCONNECTED_MESSAGE, 409, 'MAIL_ACCOUNT_DISCONNECTED');
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
    const [still] = await db.execute<RowDataPacket[]>('SELECT id FROM calendar_accounts WHERE id = ?', [existing.id]);
    if (still.length) await removeCalendarAccount(userId, existing.id);
  }
  const [rows] = await db.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM calendar_accounts WHERE id = ?', [connected.account.id]);
  return { ...await describeLink(userId, mail, rows[0]), server: connected.server || null, hint: connected.hint || null };
}

export {
  connectCalDavAccount,
  connectIcsSubscription,
  removeCalendarAccount,
  getMailCalendarLink,
  setMailCalendar,
  linkedCalendarAccount,
  relinkRestoredCalendar,
  keepMailCalendar,
  restoredMailCalendar,
  loadSerializedAccount,
};
