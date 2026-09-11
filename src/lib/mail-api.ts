import type { QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface MailAccount {
  id: string;
  email_address: string;
  display_name: string | null;
  provider: string;
  username?: string | null;
  imap_host?: string | null;
  imap_port?: number | null;
  smtp_host?: string | null;
  smtp_port?: number | null;
  is_active: boolean;
  last_synced_at: string | null;
  sync_fetch_limit?: string;
  delete_emails_on_server?: boolean;
  server_delete_enabled_at?: string | null;
  server_delete_grace_until?: string | null;
  server_delete_last_run_at?: string | null;
  server_delete_running?: boolean;
  server_delete_counts?: {
    pending: number;
    failed: number;
    deleted: number;
    missing: number;
    skipped: number;
  };
  unread_count?: number;
}


export interface EmailAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}


export interface Email {
  id: string;
  mail_account_id: string;
  subject: string | null;
  from_address: string;
  from_name: string | null;
  to_addresses: string[];
  body_text: string | null;
  body_html: string | null;
  folder: string;
  is_read: boolean;
  is_starred: boolean;
  is_draft?: boolean;
  received_at: string;
  has_attachments?: boolean;
  attachments?: EmailAttachment[];
}


export interface MailUnreadCountsResponse {
  unreadByFolder?: Record<string, number>;
  unreadByFolderAccount?: Record<string, Record<string, number>>;
}


export interface MailFolder {
  mail_account_id?: string | null;
  special_use?: string | null;
  id: string;
  slug: string;
  display_name: string;
  is_system: boolean;
  position: number;
  total_count?: number;
  unread_count?: number;
}


export interface MailContact {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  email2: string | null;
  email3: string | null;
}


export const mailQueryKeys = {
  all: ['emails'] as const,
  accounts: ['mail-accounts'] as const,
  folders: ['mail-folders'] as const,
  unread: (account: string | null) => ['mail-unread-counts', account] as const,
  dashboardUnread: ['dashboard-unread-mail'] as const,
  list: (filters: MailListFilters) => ['emails', filters.account, filters.folder, filters.page, filters.search, filters.unreadOnly] as const,
};

const MAIL_QUERY_ROOTS = new Set(['emails', 'mail-unread-counts', 'mail-accounts', 'mail-accounts-count', 'mail-folders', 'email-count', 'stats', 'dashboard-unread-mail']);
export function invalidateMailQueries(client: QueryClient) {
  return client.invalidateQueries({ predicate: (query) => MAIL_QUERY_ROOTS.has(String(query.queryKey[0])) });
}

export interface MailListFilters {
  account: string | null;
  folder: string;
  page: number;
  search: string;
  unreadOnly: boolean;
}
export interface MailListResponse {
  emails: Email[];
  pagination?: { total: number; limit: number; offset: number; page: number; totalPages: number };
}
export async function fetchMailList(filters: MailListFilters, signal?: AbortSignal): Promise<MailListResponse> {
  const params = new URLSearchParams({ limit: '50', offset: String((filters.page - 1) * 50) });
  if (filters.account && filters.account !== 'all') params.set('account_id', filters.account);
  if (filters.folder !== 'all') params.set('folder', filters.folder);
  if (filters.folder === 'starred') params.set('is_starred', 'true');
  if (filters.unreadOnly) params.set('is_read', 'false');
  if (filters.search) params.set('search', filters.search);
  const response = await api.get<MailListResponse>(`/mail/emails?${params}`, { signal });
  if (response.error) throw new Error(response.error);
  if (!Array.isArray(response.data?.emails)) throw new Error('Invalid mail list response');
  return response.data;
}
