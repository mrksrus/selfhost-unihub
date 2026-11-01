// Request and response shapes of the administrator's path for one person
// (F13, accounts.admin_manage; F11). A policy that forbids a person an
// action never makes it impossible: an administrator with users.manage does
// it for them, after entering their own password, and the activity log
// records it. Each route calls the same service as the person's own route,
// and checks the person's module switch and restore lock. The frontend
// imports these as types only.
import type { BackupJob } from './backup';
import type { BinModule } from './bin';

/** Every change through this path carries the administrator's password. */
export interface AdminReauthentication { current_password: string }

export type MailSyncMode = 'download' | 'sync';

export interface AdminMailAccount {
  id: string;
  email_address: string;
  display_name: string | null;
  provider: string;
  sync_mode: MailSyncMode;
  delete_emails_on_server: boolean;
  is_active: boolean;
  sync_status: string | null;
  last_synced_at: string | null;
  /** Set while the account is disconnected and UniHub's copy of its mail is kept. */
  disconnected_at: string | null;
}

export interface AdminCalendarAccount {
  id: string;
  provider: 'local' | 'caldav' | 'ics';
  account_email: string | null;
  display_name: string | null;
  is_active: boolean;
  sync_status: string | null;
  last_synced_at: string | null;
  /** The mail account whose server also serves this calendar, if any. */
  mail_account_id: string | null;
}

/** GET /api/admin/users/:id/accounts */
export interface AdminUserAccountsResponse {
  user_id: string;
  mail_accounts: AdminMailAccount[];
  calendar_accounts: AdminCalendarAccount[];
}

/**
 * POST /api/admin/users/:id/mail-accounts: the fields of the person's own
 * POST /api/mail/accounts, with the same provider and network checks.
 */
export interface AdminMailAccountCreateRequest extends AdminReauthentication {
  email_address: string;
  display_name?: string;
  provider?: string;
  username?: string;
  /** The password (the field's historical name); stored encrypted. */
  encrypted_password: string;
  imap_host?: string;
  imap_port?: number;
  smtp_host?: string;
  smtp_port?: number;
  sync_mode?: MailSyncMode;
  delete_emails_on_server?: boolean;
  sync_fetch_limit?: string;
  sync_window_days?: number | null;
  trash_window_days?: number | null;
  /** Trusts a self-signed server whose certificate fingerprints follow, as the administrator confirmed them. */
  accept_host_trust?: boolean;
  trusted_imap_fingerprint256?: string;
  trusted_smtp_fingerprint256?: string;
  try_calendar_sync?: boolean;
  caldav_url?: string;
}

/** PUT /api/admin/users/:id/mail-accounts/:accountId: settings, mode or password; only the given fields change. */
export type AdminMailAccountUpdateRequest = AdminReauthentication & Partial<Omit<AdminMailAccountCreateRequest, 'current_password'>>;

/** POST /api/admin/users/:id/calendar-accounts: the fields of the person's own POST /api/calendar/accounts. */
export interface AdminCalendarAccountCreateRequest extends AdminReauthentication {
  provider: 'caldav' | 'ics';
  url: string;
  account_email?: string;
  display_name?: string;
  username?: string;
  password?: string;
  time_zone?: string;
}

/** PUT /api/admin/users/:id/calendar-accounts/:accountId */
export type AdminCalendarAccountUpdateRequest = AdminReauthentication & Partial<Omit<AdminCalendarAccountCreateRequest, 'current_password' | 'provider'>>;

/**
 * DELETE /api/admin/users/:id/mail-accounts/:accountId[?purge=true] and
 * DELETE /api/admin/users/:id/calendar-accounts/:accountId, and the other
 * deleting routes of this path: DELETE has its password in the body too.
 */
export type AdminDeleteRequest = AdminReauthentication;

export interface AdminAccountResponse<T> { account: T }

/** GET /api/admin/users/:id/backups */
export interface AdminUserBackupsResponse { jobs: BackupJob[] }

/** POST /api/admin/users/:id/bin/empty */
export interface AdminBinEmptyRequest extends AdminReauthentication { module?: BinModule }

/** POST /api/admin/users/:id/clear/:module: Settings → Delete data for that person. */
export type AdminClearModule = 'contacts' | 'calendar' | 'mail-accounts' | 'recordings';

/** The answer of the deleting routes of this path. */
export interface AdminDeleteResponse { deleted: number }
