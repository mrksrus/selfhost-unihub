import type { ExecuteValues, RowDataPacket } from 'mysql2/promise';
import type { ApiError, SqlExecutor } from '../types';
import type { CalendarAccount } from '../types/calendar';
import crypto from 'crypto';
import { db } from '../state';
import { CALENDAR_MULTI_ENABLED } from '../config';
import { CALENDAR_PROVIDER_DEFAULT_CAPABILITIES, normalizeCalendarAccountProvider, serializeCalendarAccount } from './calendar';
import * as calendarAccounts from './calendar-accounts';
import * as calendarSync from './calendar-sync';

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

async function createCalendarAccount(userId: string, body: Input) {
  if (!CALENDAR_MULTI_ENABLED) return disabled();
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

  const [rows] = await db.execute<AccountRow[]>('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ? LIMIT 1', [accountId, userId]);
  const created = rows[0];
  const account = serializeCalendarAccount(created);
  return { account };
}

async function updateCalendarAccount(userId: string, id: string, body: Input) {
  if (!CALENDAR_MULTI_ENABLED) return disabled();
  if (!id) return { error: 'Invalid account id', status: 400 };
  const [existing] = await db.execute<AccountRow[]>('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ?', [id, userId]);
  if (existing.length === 0) return { error: 'Calendar account not found', status: 404 };

  const updates = [];
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
    if (body.is_active !== false && account.provider === 'caldav' && !resume) {
      const missing = await calendarSync.resolveLogin(account).then(() => null, (error: ApiError) => error);
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
  await db.execute(`UPDATE calendar_accounts SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
  if (resume) calendarSync.syncCalendarAccountInBackground(id, { userId, reason: 'manual' });
  const [rows] = await db.execute<AccountRow[]>('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ? LIMIT 1', [id, userId]);
  return { account: serializeCalendarAccount(rows[0]) };
}

// inTransaction: written with the deletion (routes/admin-people.ts, the administrator's entry).
async function deleteCalendarAccount(userId: string, id: string, { inTransaction }: { inTransaction?: (connection: SqlExecutor) => Promise<unknown> } = {}) {
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
  await calendarAccounts.removeCalendarAccount(userId, id, inTransaction);
  return { message: 'Calendar account deleted' };
}

export { createCalendarAccount, updateCalendarAccount, deleteCalendarAccount };
export type { Input as CalendarAccountInput };
