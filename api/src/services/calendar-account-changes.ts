import type { ExecuteValues, RowDataPacket } from 'mysql2/promise';
import type { ApiError, SqlExecutor } from '../types';
import type { PolicyActor } from './settings';
import type { CalendarAccount } from '../types/calendar';
import crypto from 'crypto';
import { db } from '../state';
import { CALENDAR_MULTI_ENABLED } from '../config';
import { CALENDAR_PROVIDER_DEFAULT_CAPABILITIES, normalizeCalendarAccountProvider, serializeCalendarAccount } from './calendar';
import * as calendarAccounts from './calendar-accounts';
import * as calendarSync from './calendar-sync';
import { withTransaction } from './transactions';
import { assertFinalStep } from './final-step';
import { accountSnapshot, lockUnchanged, storedAccountId } from './account-identity';
import { withPersonLock } from './person-lock';

// Adding, changing and removing a calendar account: POST, PUT and DELETE
// /api/calendar/accounts[/:id] (routes/calendar.ts) and the administrator's
// path for a person (routes/admin-people.ts) run these same steps, with the
// person's id. The answers are the routes' (a refusal with its status, or
// the account); a thrown error is the route's to answer. Only UniHub's copy
// goes when an account is removed; the provider keeps its calendars.
// accounts.add and accounts.remove are declared on the person's routes
// (legacy-spec.ts), which the administrator's path does not pass (F13).

type AccountRow = RowDataPacket & CalendarAccount;
type CountRow = RowDataPacket & { count: number };
interface Input extends Record<string, unknown> {
  provider?: string;
  password?: unknown;
  username?: unknown;
  account_email?: string;
  display_name?: string;
  url?: unknown;
  time_zone?: unknown;
  is_active?: unknown;
  default_calendar_name?: string;
  default_calendar_color?: string;
}

const has = (body: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(body, key);
const isRemoteProvider = (provider: string | undefined) => calendarSync.REMOTE_PROVIDERS.has(provider!);
const disabled = () => ({ error: 'Calendar multi-account feature disabled', status: 503 });

// Each under the person's lock (person-lock.ts), from the first read through
// discovery to the commit; the administrator's path takes the person's lock.
async function createCalendarAccount(userId: string, body: Input, actor: PolicyActor = {}) {
  return withPersonLock(userId, () => createNow(userId, body, actor));
}

async function updateCalendarAccount(userId: string, id: string, body: Input) {
  return withPersonLock(userId, async () => updateNow(userId, await storedAccountId('calendar', userId, id), body));
}

async function deleteCalendarAccount(userId: string, id: string, options: { actor?: PolicyActor; record?: (connection: SqlExecutor) => Promise<unknown> } = {}) {
  return withPersonLock(userId, async () => deleteNow(userId, await storedAccountId('calendar', userId, id), options));
}

// The mail account a linked calendar account takes its login from, as read now.
async function linkedMail(userId: string, account: AccountRow) {
  if (!account.mail_account_id) return null;
  const [[mail]] = await db.execute<(RowDataPacket & { id: string })[]>('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?', [account.mail_account_id, userId]);
  return mail ? accountSnapshot('mail', mail) : null;
}

async function createNow(userId: string, body: Input, actor: PolicyActor) {
  if (!CALENDAR_MULTI_ENABLED) return disabled();
  // A remote account is added after discovery: accounts.add is asked again at its commit.
  const admission = { actor, policies: ['accounts.add' as const] };
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
    }, admission);
  }
  if (provider === 'ics') {
    return await calendarAccounts.connectIcsSubscription({
      userId, url: body.url ? String(body.url).trim() : '', displayName: body.display_name?.trim() || null, timeZone: body.time_zone,
    }, admission);
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

  const [rows] = await db.execute<AccountRow[]>('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ? LIMIT 1', [accountId, userId]);
  const created = rows[0];
  const account = serializeCalendarAccount(created);
  return { account };
}

async function updateNow(userId: string, id: string, body: Input) {
  if (!CALENDAR_MULTI_ENABLED) return disabled();
  if (!id) return { error: 'Invalid account id', status: 400 };
  const [existing] = await db.execute<AccountRow[]>('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?', [id, userId]);
  if (existing.length === 0) return { error: 'Calendar account not found', status: 404 };

  const updates: string[] = [];
  const params: ExecuteValues[] = [];
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
    params.push((require('../security/encryption') as typeof import('../security/encryption')).encrypt(String(body.password)));
    if (has(body, 'username') && String(body.username || '').trim()) {
      updates.push('username = ?');
      params.push(String(body.username).trim().slice(0, 255));
    }
    resume = true;
  }
  if (has(body, 'is_active')) {
    // Resumed only with a login: its own password, or a connected mail account.
    // Asked without writing: a refusal leaves a restored calendar unlinked
    // with its password; the sync links it once resumed.
    if (body.is_active !== false && account.provider === 'caldav' && !resume) {
      const missing = await calendarSync.resolveLogin(account, false, { write: false }).then(() => null, (error: ApiError) => error);
      if (missing?.code === 'CALDAV_NO_PASSWORD') return { error: 'Enter the password again to resume sync.', status: 409, code: 'CALDAV_NO_PASSWORD' };
      if (missing) return calendarSync.calendarErrorResponse(missing, 'Could not resume sync');
    }
    updates.push('is_active = ?');
    params.push(body.is_active === false ? 0 : 1);
    // Cleared: a user's pause is never resumed by a mail reconnect.
    if (body.is_active === false && remote) updates.push("sync_status = 'paused'", 'sync_error = NULL');
    if (body.is_active !== false) resume = true;
  }
  resume = resume && remote && body.is_active !== false;
  if (resume) updates.push("sync_status = 'pending'", 'sync_error = NULL', 'next_sync_at = NULL', 'is_active = TRUE');
  if (updates.length === 0) return { error: 'No fields to update', status: 400 };

  params.push(id, userId);
  // Under the account's row, still the account read above (its password and
  // resume were decided from it; account-identity.ts), and Calendar's final
  // check (final-step.ts): on and not being restored, as committed now.
  const seen = accountSnapshot('calendar', account);
  const mailSeen = await linkedMail(userId, account);
  await withTransaction(async cx => {
    // A linked account's login, and so its resume, came from its mail account: that one too, first.
    if (mailSeen) await lockUnchanged(cx, userId, mailSeen, { lock: 'share' });
    await lockUnchanged(cx, userId, seen);
    await assertFinalStep(cx, { userId, modules: ['calendar'] });
    await cx.execute(`UPDATE calendar_accounts SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
  });
  if (resume) calendarSync.syncCalendarAccountInBackground(id, { userId, reason: 'manual' });
  // Paused: a sync or change under way stops now and writes nothing more.
  if (body.is_active === false && remote) calendarSync.stopCalendarAccountWork(id, 'paused');
  const [rows] = await db.execute<AccountRow[]>('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ? LIMIT 1', [id, userId]);
  return { account: serializeCalendarAccount(rows[0]) };
}

// actor and record: an administrator's (routes/admin-people.ts), who passes
// accounts.remove, and their entry, written with the deletion.
async function deleteNow(userId: string, id: string, { actor = {}, record }: { actor?: PolicyActor; record?: (connection: SqlExecutor) => Promise<unknown> }) {
  if (!CALENDAR_MULTI_ENABLED) return disabled();
  if (!id) return { error: 'Invalid account id', status: 400 };
  const [accounts] = await db.execute<AccountRow[]>('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?', [id, userId]);
  if (accounts.length === 0) return { error: 'Calendar account not found', status: 404 };

  const account = accounts[0];
  if (account.provider === 'local') {
    const [localCountRows] = await db.execute<CountRow[]>(
      `SELECT COUNT(*) AS count FROM calendar_accounts WHERE user_id = ? AND provider = 'local'`,
      [userId]
    );
    if (Number(localCountRows[0]?.count || 0) <= 1) {
      return { error: 'Cannot delete the last local calendar account', status: 400 };
    }
  }

  // Only the copies in UniHub are removed; the server keeps its calendars.
  // The account read above, unless it changed meanwhile (account-identity.ts).
  await calendarAccounts.removeCalendarAccount(userId, id, { actor, record, snapshot: accountSnapshot('calendar', account), mail: await linkedMail(userId, account) });
  return { message: 'Calendar account deleted' };
}

export { createCalendarAccount, updateCalendarAccount, deleteCalendarAccount };
export type { Input as CalendarAccountInput };
