import type { RowDataPacket } from 'mysql2/promise';
import type { AdminCalendarAccount, AdminMailAccount, AdminUserAccountsResponse } from '../contracts/admin-accounts';
import { db } from '../state';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { isModuleEnabled } from './module-settings';
import { isSectionRestoreActive } from './restore-locks';

// The administrator's path for one person (F13, accounts.admin_manage): a
// policy that forbids the person an action never makes it impossible. Each
// route of routes/admin-people.ts calls the service the person's own route
// calls, with the person's id and the administrator as actor, so policies
// do not stop it and the activity log names the administrator. The request
// boundary checked the administrator's role, module switches and restore
// locks; the person's own are checked here, before any side effect.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The person's id as stored, from an address's `:id`: 400 unless it is a
 * UUID, 404 unless the person exists. The database matches ids without
 * case, so every change for the person, their lock (person-lock.ts) and
 * the rows it writes use this one spelling.
 */
async function personFromParam(id: unknown): Promise<string> {
  if (typeof id !== 'string' || !UUID.test(id)) throw badRequest('INVALID_USER_ID', 'Invalid user id');
  const [[row]] = await db.execute<(RowDataPacket & { id: string })[]>('SELECT id FROM users WHERE id = ?', [id]);
  if (!row) throw notFound('USER_NOT_FOUND', 'User not found');
  return row.id;
}

/** 404 unless the person exists. */
async function assertPerson(userId: string) {
  const [[row]] = await db.execute<RowDataPacket[]>('SELECT id FROM users WHERE id = ?', [userId]);
  if (!row) throw notFound('USER_NOT_FOUND', 'User not found');
}

/** The person exists, has the module on, and no restore of its section is running. */
async function assertPersonModule(userId: string, module: string, section = module) {
  await assertPerson(userId);
  if (!await isModuleEnabled(userId, module)) {
    throw forbidden('MODULE_DISABLED', 'This module is turned off for this person. They turn it on in their Settings.', { module });
  }
  if (await isSectionRestoreActive(userId, section)) {
    throw conflict('RESTORE_IN_PROGRESS', `A restore of this person's ${section} is running. Try again when it has finished.`);
  }
}

const iso = (value: unknown) => value == null ? null : (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString();

/** GET /api/admin/users/:id/accounts: the person's mail and calendar accounts, without credentials. */
async function personAccounts(userId: string): Promise<AdminUserAccountsResponse> {
  await assertPerson(userId);
  const [[mail], [calendar]] = await Promise.all([
    db.execute<RowDataPacket[]>(`SELECT id, email_address, display_name, provider, sync_mode, delete_emails_on_server, is_active, sync_status,
      last_synced_at, disconnected_at FROM mail_accounts WHERE user_id = ? ORDER BY created_at, id`, [userId]),
    db.execute<RowDataPacket[]>(`SELECT id, provider, account_email, display_name, is_active, sync_status, last_synced_at, mail_account_id
      FROM calendar_accounts WHERE user_id = ? ORDER BY created_at, id`, [userId]),
  ]);
  return {
    user_id: userId,
    mail_accounts: mail.map((row): AdminMailAccount => ({
      id: row.id, email_address: row.email_address, display_name: row.display_name ?? null, provider: row.provider,
      sync_mode: row.sync_mode === 'sync' ? 'sync' : 'download', delete_emails_on_server: !!Number(row.delete_emails_on_server),
      is_active: !!Number(row.is_active), sync_status: row.sync_status ?? null, last_synced_at: iso(row.last_synced_at), disconnected_at: iso(row.disconnected_at),
    })),
    calendar_accounts: calendar.map((row): AdminCalendarAccount => ({
      id: row.id, provider: row.provider, account_email: row.account_email ?? null, display_name: row.display_name ?? null,
      is_active: !!Number(row.is_active), sync_status: row.sync_status ?? null, last_synced_at: iso(row.last_synced_at), mail_account_id: row.mail_account_id ?? null,
    })),
  };
}

export { assertPerson, assertPersonModule, personAccounts, personFromParam };
