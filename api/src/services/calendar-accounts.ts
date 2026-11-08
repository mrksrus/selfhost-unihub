// Connecting server calendars: CalDAV accounts found from a mail login (or a
// CalDAV address), and read-only iCalendar subscriptions. A calendar account
// connected from a mail account stays linked to it (mail_account_id): it has
// no password of its own but uses the mail login (see calendar-sync
// resolveLogin), so it waits while the mail account is disconnected, and it is
// removed when the mail account is purged.
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { ApiError, MailAccountIdentity, SqlExecutor, StoredFlag } from '../types';
import type { CalendarAccount } from '../types/calendar';
import type { PolicyActor } from './settings';
import type { PolicyKey } from '../contracts/policies';
import crypto from 'crypto';
import { db } from '../state';
import { encrypt, decrypt } from '../security/encryption';
import { isModuleEnabled } from './module-settings';
import { isSectionRestoreActive } from './restore-locks';
import { publishCalendarChanged } from './realtime';
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
import { withTransaction } from './transactions';
import { assertFinalStep } from './final-step';
import { accountSnapshot, assertUnchanged, lockUnchanged } from './account-identity';
import type { AccountSnapshot } from './account-identity';

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
// account stores no password. Written on the change's connection
// (commitAccount); its calendar list is read after the commit.
async function writeCalDavAccount(cx: SqlExecutor, { userId, emailAddress, displayName, username, password, mailAccountId, timeZone, found, existing = null }: ConnectInput & { found: Awaited<ReturnType<typeof caldav.findCalDavServer>>; existing?: AccountRow | null }) {
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
    await cx.execute(
      `UPDATE calendar_accounts SET account_email = ?, username = ?, encrypted_password = ?, discovery_url = ?, base_url = ?, provider_config = ?,
         is_active = TRUE, sync_status = 'pending', sync_error = NULL, mail_account_id = ?, next_sync_at = NULL
       WHERE id = ? AND user_id = ?`,
      [emailAddress || null, (username || emailAddress || '').slice(0, 255) || null, storedPassword, found.server.url, found.discovery.baseUrl,
        JSON.stringify(providerConfig), mailAccountId || null, accountId, userId]
    );
  } else {
    await cx.execute(
      `INSERT INTO calendar_accounts
        (id, user_id, provider, account_email, display_name, username, encrypted_password, discovery_url, base_url,
         provider_config, capabilities, is_active, sync_status, sync_error, mail_account_id, next_sync_at)
       VALUES (?, ?, 'caldav', ?, ?, ?, ?, ?, ?, ?, ?, TRUE, 'pending', NULL, ?, NULL)`,
      [accountId, userId, emailAddress || null, (displayName || emailAddress || found.server.label || 'Calendar').slice(0, 255),
        (username || emailAddress || '').slice(0, 255) || null, storedPassword, found.server.url, found.discovery.baseUrl,
        JSON.stringify(providerConfig), JSON.stringify(CALENDAR_PROVIDER_DEFAULT_CAPABILITIES.caldav), mailAccountId || null]
    );
  }
  return accountId;
}

// How a connection is admitted: the policies it needs, asked again in its
// transaction (an administrator's actor passes them); for a mail account's
// calendar, that mail account and the accounts linked to it as the change
// saw them (`linked`; omitted for a new mail account, whose other links a
// sync may have made and which are undone); and the account it replaces.
// Each account a change chose is carried as its snapshot (account-identity.ts):
// the mail account whose login discovery used, and the one whose login
// matched an account taken over from another mail account.
interface Admission {
  actor?: PolicyActor;
  policies?: readonly PolicyKey[];
  mail?: { id: string; linked?: readonly string[]; snapshot?: AccountSnapshot };
  replaces?: AccountSnapshot | null;
}

const changedMeanwhile = () => fail('The calendar of this mail account changed meanwhile. Try again.', 409, 'MAIL_CALENDAR_CHANGED');

/**
 * Writes a new or taken-over calendar account in one transaction. Locked
 * first, shared, the mail accounts whose login the change used (so they are
 * neither purged nor changed meanwhile), then the accounts linked to its
 * mail account, then the account taken over (`existing`) and the one
 * replaced, by id. Each must still be as the change saw it: the linked set
 * (or 409 MAIL_CALENDAR_CHANGED), and every snapshot, mail accounts
 * included (or 409 ACCOUNT_CHANGED, account-identity.ts); a missing row is
 * drift too. Then the final check (final-step.ts: the policies, Calendar on
 * and not being restored), the write, the replaced account's removal, and
 * any other account linked to the mail account unlinked. A refusal changes
 * nothing.
 */
async function commitAccount(userId: string, existing: { snapshot: AccountSnapshot; mail: AccountSnapshot | null } | null, admission: Admission, write: (cx: SqlExecutor) => Promise<string>) {
  return withTransaction(async cx => {
    const mails = new Map<string, AccountSnapshot | null>();
    if (admission.mail) mails.set(admission.mail.id, admission.mail.snapshot ?? null);
    if (existing?.mail && !mails.get(existing.mail.id)) mails.set(existing.mail.id, existing.mail);
    for (const id of [...mails.keys()].sort()) {
      const snapshot = mails.get(id);
      if (snapshot) await lockUnchanged(cx, userId, snapshot, { lock: 'share' });
      else {
        const [[mailRow]] = await cx.execute<RowDataPacket[]>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? LOCK IN SHARE MODE', [id, userId]);
        if (!mailRow) throw fail('Account not found', 404);
      }
    }
    let linkedNow: (RowDataPacket & { id: string; provider: string })[] = [];
    if (admission.mail) {
      [linkedNow] = await cx.execute<(RowDataPacket & { id: string; provider: string })[]>(
        'SELECT id, provider FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ? ORDER BY id FOR UPDATE', [userId, admission.mail.id]);
      const expected = admission.mail.linked;
      if (expected && [...expected].sort().join() !== linkedNow.map(row => row.id).join()) throw changedMeanwhile();
    }
    const ids = [...new Set([existing?.snapshot.id, admission.replaces?.id].filter((id): id is string => Boolean(id)))].sort();
    const locked = new Map<string, AccountRow>();
    for (const id of ids) {
      const [[row]] = await cx.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ? FOR UPDATE', [id, userId]);
      if (row) locked.set(id, row);
    }
    if (existing) assertUnchanged(locked.get(existing.snapshot.id), existing.snapshot);
    if (admission.replaces) assertUnchanged(locked.get(admission.replaces.id), admission.replaces);
    await assertFinalStep(cx, { userId, policies: admission.policies ?? [], actor: admission.actor, modules: ['calendar'] });
    const accountId = await write(cx);
    const replaced = admission.replaces && admission.replaces.id !== accountId ? admission.replaces.id : null;
    if (replaced) {
      const [calendars] = await cx.execute<(RowDataPacket & { id: string })[]>('SELECT id FROM calendar_calendars WHERE account_id = ? AND user_id = ?', [replaced, userId]);
      await calendarSync.deleteCalendarsWithEvents(cx, userId, calendars.map(row => row.id));
      await cx.execute('DELETE FROM calendar_accounts WHERE id = ? AND user_id = ?', [replaced, userId]);
    }
    // The mail account's calendar is the one just written: another linked
    // to it (one a sync linked by address meanwhile) waits again, unlinked.
    const unlinked = linkedNow.filter(row => row.id !== accountId && row.id !== replaced);
    for (const other of unlinked) await cx.execute('UPDATE calendar_accounts SET mail_account_id = NULL WHERE id = ? AND user_id = ?', [other.id, userId]);
    return { accountId, replaced, unlinked };
  });
}

async function committedAccount(userId: string, { accountId, replaced, unlinked }: Awaited<ReturnType<typeof commitAccount>>) {
  if (replaced) publishCalendarChanged(userId, replaced, 'sync');
  // The running work of an unlinked CalDAV one read the mail login; a subscription uses none.
  for (const other of unlinked) {
    if (other.provider === 'caldav') calendarSync.stopCalendarAccountWork(other.id, 'replaced');
    publishCalendarChanged(userId, other.id, 'status');
  }
  const [rows] = await db.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM calendar_accounts WHERE id = ?', [accountId]);
  return rows[0];
}

async function insertIcsAccount(cx: SqlExecutor, { userId, url, displayName, feedName, mailAccountId, emailAddress, timeZone }: IcsInput & { feedName?: string | null }) {
  const accountId = crypto.randomUUID();
  const origin = new URL(url).origin;
  await cx.execute(
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
  return accountId;
}

// A linked account is compared by its mail account's current login (its own
// username is the one it was connected with).
async function findDuplicate(userId: string, provider: string, baseUrl: string, username?: string | null) {
  const [rows] = await db.execute<(RowDataPacket & AccountRow)[]>(
    `SELECT ca.* FROM calendar_accounts ca
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
    if (error.code === 'ICS_INVALID' || error.code === 'ICS_TOO_LARGE') throw error;
    throw fail(error.status === 404 || error.status === 401 || error.status === 403
      ? 'The calendar address was not accepted. Copy the private or public iCal address again.'
      : `The calendar address could not be read: ${error.message}`, 422, 'ICS_UNREACHABLE');
  });
  const name = (/^X-WR-CALNAME:(.*)$/im.exec(feed.notModified ? '' : feed.text)?.[1] || '').trim().slice(0, 255) || null;
  return { url, name };
}

async function connectIcsSubscription({ userId, url: rawUrl, displayName, mailAccountId = null, emailAddress = null, timeZone }: IcsInput, admission: Admission = {}) {
  await assertCalendarAvailable(userId);
  if (!rawUrl) throw fail('Enter the address of the calendar.', 400);
  const { url, name } = await probeIcsFeed(rawUrl);
  const account = await committedAccount(userId, await commitAccount(userId, null, admission,
    cx => insertIcsAccount(cx, { userId, url, displayName, feedName: name, mailAccountId, emailAddress, timeZone })));
  startFirstSync(account);
  return { account: serializeCalendarAccount(account), calendars: [] };
}

// Find the calendar server for a login and connect it. caldavUrl is optional:
// without it the server is found from the address and mail server.
// An iCalendar subscription has no calendars yet, and no server or hint.
interface ConnectedCalendar {
  account: ReturnType<typeof serializeCalendarAccount>;
  calendars: Awaited<ReturnType<typeof calendarSync.reconcileCalendarList>>[number]['calendar'][];
  server?: Awaited<ReturnType<typeof caldav.findCalDavServer>>['server'];
  hint?: string | null;
}

async function connectCalDavAccount({ userId, emailAddress, displayName, username, password, imapHost, caldavUrl, mailAccountId = null, timeZone }: ConnectInput, admission: Admission = {}): Promise<ConnectedCalendar> {
  await assertCalendarAvailable(userId);
  const provider = caldav.matchCalendarProvider({ emailAddress, imapHost });
  if (caldavUrl && looksLikeIcsFeed(caldavUrl, provider)) {
    return connectIcsSubscription({ userId, url: caldavUrl, displayName, mailAccountId, emailAddress, timeZone }, admission);
  }
  let found;
  try {
    found = await caldav.findCalDavServer({ emailAddress, imapHost, username, password, explicitUrl: caldavUrl || null });
  } catch (error) {
    // A pasted public calendar address that is not a CalDAV server.
    if (caldavUrl && ['CALDAV_NOT_FOUND', 'CALDAV_NO_CALENDAR_HOME'].includes((error as ApiError).code!)) {
      return connectIcsSubscription({ userId, url: caldavUrl, displayName, mailAccountId, emailAddress, timeZone }, admission).catch(() => { throw error; });
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
  // Turning on a mail account's calendar takes over an account with the same
  // login and server: an unlinked one (one restored from a 0.17.0 backup has
  // no link), or one another mail account had, which is moved to this one.
  // It is the same calendar data, so the account and its calendars stay with
  // all UniHub keeps on them (ToDo state, subtasks, replies, waiting and
  // failed overlays, hand order); only the link and the login change.
  // Discovery wrote nothing; the account is written, or taken over, only
  // once admitted, together with the removal of one it replaces.
  const existing = duplicate;
  // As found: the account, and the mail account whose login it matched by.
  let existingMail: AccountSnapshot | null = null;
  if (existing?.mail_account_id && existing.mail_account_id !== admission.mail?.id) {
    const [[owner]] = await db.execute<(RowDataPacket & { id: string })[]>('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?', [existing.mail_account_id, userId]);
    if (owner) existingMail = accountSnapshot('mail', owner);
  }
  const expected = existing ? { snapshot: accountSnapshot('calendar', existing), mail: existingMail } : null;
  const account = await committedAccount(userId, await commitAccount(userId, expected, admission,
    cx => writeCalDavAccount(cx, { userId, emailAddress, displayName, username: login, password, mailAccountId, timeZone, found, existing })));
  const calendars = (await calendarSync.reconcileCalendarList(account, found.discovery.calendars,
    { username: login, password, credentialScope: found.credentialScope })).map(item => item.calendar);
  startFirstSync(account);
  return { account: serializeCalendarAccount(account), calendars, server: found.server, hint: found.hint || null };
}

async function removeCalendarAccount(userId: string, accountId: string, options: Parameters<typeof calendarSync.deleteCalendarAccount>[2] = {}) {
  await calendarSync.deleteCalendarAccount(userId, accountId, options);
}

// --- Mail account link ------------------------------------------------------

async function loadMailAccount(userId: string, mailAccountId: string) {
  const [rows] = await db.execute<(RowDataPacket & MailRow)[]>(
    // The whole row: a change carries its snapshot (account-identity.ts).
    `SELECT m.*, (${MAIL_CONNECTED_SQL}) AS connected
     FROM mail_accounts m WHERE m.id = ? AND m.user_id = ?`,
    [mailAccountId, userId]
  );
  if (!rows[0]) throw fail('Account not found', 404);
  return rows[0];
}

// A restored calendar account this mail account takes over when its link is
// next read (no account is linked yet).
// `lock`: in a transaction that then changes the candidate (purging its mail
// account removes it): the rows are locked, so a link meanwhile waits.
async function restoredMailCalendar(userId: string, mail: Pick<MailRow, 'email_address'>, executor: SqlExecutor = db, { lock = false } = {}) {
  const [unlinked] = await executor.execute<(RowDataPacket & AccountRow)[]>(
    `SELECT * FROM calendar_accounts WHERE user_id = ? AND provider IN ('caldav', 'ics') AND mail_account_id IS NULL AND LOWER(account_email) = LOWER(?)
     ORDER BY created_at ASC${lock ? ' FOR UPDATE' : ''}`,
    [userId, mail.email_address]
  );
  return unlinked.find(wasMailCalendar) || null;
}

// The mail account's calendar, linking a restored one found by address
// (the sync's login, resolveLogin): only through linkExpectedCalendar, so
// under Calendar's final check; its refusal is thrown.
async function linkedCalendarAccount(userId: string, mail: MailAddress): Promise<AccountRow | null> {
  const [linked] = await db.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ? ORDER BY created_at ASC LIMIT 1', [userId, mail.id]);
  if (linked[0]) return linked[0];
  const candidate = await restoredMailCalendar(userId, mail);
  if (!candidate) return null;
  const account = await linkExpectedCalendar(userId, mail, accountSnapshot('calendar', candidate));
  if (account) return account;
  // Another request linked one, or took the candidate, meanwhile.
  const [again] = await db.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ? ORDER BY created_at ASC LIMIT 1', [userId, mail.id]);
  return again[0] || null;
}

// linkedCalendarAccount for one account decided on before (`expectedId`):
// its link, or, when it is a restored one still unlinked, linking it. In one
// transaction under the mail account's linked rows and that account's row,
// so it is checked as it is when written; null, with nothing written, when
// another account is linked or the expected one is gone, linked elsewhere or
// no longer this mail account's. Never another candidate. Linking drops a
// restored password and `then` may resume the account: both only while
// Calendar is on and not being restored, as committed now (final-step.ts).
async function linkExpectedCalendar(userId: string, mail: MailAddress, expected: AccountSnapshot, then?: (connection: SqlExecutor, account: AccountRow) => Promise<unknown>): Promise<AccountRow | null> {
  const expectedId = expected.id;
  return withTransaction(async connection => {
    const [linked] = await connection.execute<(RowDataPacket & AccountRow)[]>(
      'SELECT * FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ? ORDER BY created_at ASC FOR UPDATE', [userId, mail.id]);
    let account: AccountRow | null = null;
    if (linked[0]) {
      if (linked[0].id !== expectedId) return null;
      account = linked[0];
      assertUnchanged(account, expected, [expected.link, mail.id]);
      await assertFinalStep(connection, { userId, modules: ['calendar'] });
    } else {
      const [[candidate]] = await connection.execute<(RowDataPacket & AccountRow)[]>(
        'SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ? FOR UPDATE', [expectedId, userId]);
      if (!candidate || candidate.mail_account_id || !['caldav', 'ics'].includes(candidate.provider)
        || String(candidate.account_email || '').toLowerCase() !== String(mail.email_address || '').toLowerCase() || !wasMailCalendar(candidate)) return null;
      // Still the account as the caller saw it: a login or password saved meanwhile is not overwritten.
      assertUnchanged(candidate, expected);
      await assertFinalStep(connection, { userId, modules: ['calendar'] });
      // As linkedCalendarAccount writes it.
      const config = { ...(safeJsonParse(candidate.provider_config, {}) || {}), mailLinked: true };
      await connection.execute(`UPDATE calendar_accounts SET mail_account_id = ?, provider_config = ?,
          encrypted_password = IF(provider = 'caldav', NULL, encrypted_password)
        WHERE id = ? AND mail_account_id IS NULL`, [mail.id, JSON.stringify(config), candidate.id]);
      account = { ...candidate, mail_account_id: mail.id, provider_config: JSON.stringify(config),
        encrypted_password: candidate.provider === 'caldav' ? null : candidate.encrypted_password };
    }
    if (then) await then(connection, account);
    return account;
  });
}

// What linkedCalendarAccount answers, without linking a restored account:
// for deciding whether a change is allowed before anything is written.
async function peekLinkedCalendarAccount(userId: string, mail: MailAddress): Promise<AccountRow | null> {
  const [linked] = await db.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ? ORDER BY created_at ASC LIMIT 1', [userId, mail.id]);
  return linked[0] || await restoredMailCalendar(userId, mail);
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

// The mail account relinkRestoredCalendar would link a restored calendar to,
// without linking it.
async function restoredCalendarMail(account: AccountRow) {
  if (account.mail_account_id || !account.account_email || !wasMailCalendar(account)) return null;
  const [mails] = await db.execute<(RowDataPacket & MailAddress)[]>('SELECT id, email_address FROM mail_accounts WHERE user_id = ? AND LOWER(email_address) = LOWER(?) ORDER BY created_at ASC',
    [account.user_id, account.account_email]);
  for (const mail of mails) {
    if ((await peekLinkedCalendarAccount(account.user_id, mail))?.id === account.id) return mail.id;
  }
  return null;
}

async function describeLink(userId: string, mail: MailRow, account: AccountRow | null) {
  const provider = caldav.matchCalendarProvider({ emailAddress: mail.email_address, imapHost: mail.imap_host });
  const base = {
    enabled: false,
    account: null,
    calendars: [],
    event_count: 0,
    // A restored calendar of this address, not linked yet: it is linked on
    // the next change (setMailCalendar) or sync, never by reading.
    link_pending: false,
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
    link_pending: !account.mail_account_id,
  };
}

// Reading writes nothing: a restored calendar not linked yet is shown as
// such (link_pending), and is linked only by a guarded change.
async function getMailCalendarLink(userId: string, mailAccountId: string) {
  const mail = await loadMailAccount(userId, mailAccountId);
  await assertCalendarAvailable(userId);
  return describeLink(userId, mail, await peekLinkedCalendarAccount(userId, mail));
}

function currentManualUrl(account: AccountRow | null) {
  const config = (safeJsonParse(account?.provider_config, {}) || {}) as Config;
  return config.server?.source === 'manual' ? config.server.url : '';
}

// Turn the calendar of a mail account on or off, or change its address.
// caldav_url: undefined keeps the current address, '' finds it automatically.
// Turning a mail account's calendar on adds a calendar account, turning it
// off removes one: accounts.add and accounts.remove (F13), which depend on
// the body and so are checked here; an administrator's actor passes them.
// They and every other refusal (a disconnected mail account) are decided
// from reads that change nothing; a restored calendar is linked, dropping
// its own password, only once the change goes ahead, so a refused request
// leaves it unlinked with its password.
async function setMailCalendar(userId: string, mailAccountId: string, { enabled, caldav_url: caldavUrl, time_zone: timeZone }: { enabled?: unknown; caldav_url?: unknown; time_zone?: unknown } = {}, actor: PolicyActor = {}) {
  if (typeof enabled !== 'boolean') throw fail('enabled must be true or false', 400);
  if (caldavUrl !== undefined && caldavUrl !== null && typeof caldavUrl !== 'string') throw fail('Calendar address must be text', 400);
  const requestedUrl = caldavUrl == null ? undefined : caldavUrl.trim();
  if (requestedUrl && requestedUrl.length > 2000) throw fail('Calendar address is too long', 400);
  const mail = await loadMailAccount(userId, mailAccountId);
  // These routes are under /api/mail, so the request boundary checks only the
  // Mail module; turning the calendar off deletes calendar data.
  await assertCalendarAvailable(userId);
  const { assertAllowed } = require('./settings') as typeof import('./settings');
  const change = (account: AccountRow | null) => {
    const url = account?.provider === 'ics' ? null : currentManualUrl(account);
    const addressChanged = requestedUrl !== undefined && (account?.provider === 'ics' ? !!requestedUrl : requestedUrl !== url);
    // Off removes the account; a new link adds one; a new address replaces the old one.
    const policies = !enabled ? (account ? ['accounts.remove' as const] : [])
      : account && !addressChanged ? [] : account ? ['accounts.add' as const, 'accounts.remove' as const] : ['accounts.add' as const];
    return { url, addressChanged, policies };
  };
  const seen = await peekLinkedCalendarAccount(userId, mail);
  const { url: seenUrl, addressChanged, policies } = change(seen);
  await assertAllowed(userId, policies, actor);

  if (!enabled) {
    // A restored one not linked yet goes as it is; one another connect took
    // over for another mail account meanwhile stays (409).
    if (seen) await removeCalendarAccount(userId, seen.id, { actor, expectMail: [seen.mail_account_id ?? null, mail.id], snapshot: accountSnapshot('calendar', seen) });
    return describeLink(userId, mail, null);
  }

  if (seen && !addressChanged) {
    const resumes = seen.provider === 'caldav' && !seen.is_active;
    if (resumes && !Number(mail.connected)) throw fail(MAIL_DISCONNECTED_MESSAGE, 409, 'MAIL_ACCOUNT_DISCONNECTED');
    // The account seen above, linked if it was a restored one, and resumed,
    // in one transaction; another request linked or removed one meanwhile
    // (this one wrote nothing then).
    const existing = await linkExpectedCalendar(userId, mail, accountSnapshot('calendar', seen), (cx, account) => cx.execute(resumes
      ? "UPDATE calendar_accounts SET is_active = TRUE, encrypted_password = NULL, sync_status = 'pending', sync_error = NULL, next_sync_at = NULL WHERE id = ?"
      : 'UPDATE calendar_accounts SET next_sync_at = NULL WHERE id = ?', [account.id]));
    if (!existing) throw fail('The calendar of this mail account changed meanwhile. Try again.', 409, 'MAIL_CALENDAR_CHANGED');
    calendarSync.syncCalendarAccountInBackground(existing.id, { userId, reason: 'manual' });
    return describeLink(userId, mail, (await db.execute<(RowDataPacket & AccountRow)[]>('SELECT * FROM calendar_accounts WHERE id = ?', [existing.id]))[0][0]);
  }

  const password = mail.encrypted_password ? decrypt(mail.encrypted_password) : null;
  const manualUrl = requestedUrl !== undefined ? requestedUrl : seenUrl;
  const subscription = manualUrl && looksLikeIcsFeed(manualUrl, caldav.matchCalendarProvider({ emailAddress: mail.email_address, imapHost: mail.imap_host }));
  if (!subscription && (!Number(mail.connected) || !password)) throw fail(MAIL_DISCONNECTED_MESSAGE, 409, 'MAIL_ACCOUNT_DISCONNECTED');
  // Find the new address first; the old calendars are only replaced once it
  // works. A restored CalDAV account of the address is taken over there. The
  // new or taken-over account and the old one's removal commit together,
  // after the policies and Calendar's gates are asked again: a refusal then
  // leaves both as they were.
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
  }, { actor, policies, mail: { id: mail.id, linked: seen?.mail_account_id === mail.id ? [seen.id] : [], snapshot: accountSnapshot('mail', mail) },
    replaces: seen ? accountSnapshot('calendar', seen) : null });
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
  restoredCalendarMail,
  restoredMailCalendar,
  loadSerializedAccount,
};
