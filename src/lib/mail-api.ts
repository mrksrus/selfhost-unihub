import type { QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { MailListRow, MailThreadListResponse, MailThreadResponse, MailThreadSummary } from '../../api/src/contracts/mail-threads';
export type { MailListRow, MailThreadListResponse, MailThreadParticipant, MailThreadResponse, MailThreadSummary } from '../../api/src/contracts/mail-threads';

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
  disconnected_at?: string | null;
  /** Whether UniHub still stores a password for it (Disconnect deletes it). */
  has_saved_password?: boolean;
  last_synced_at: string | null;
  sync_fetch_limit?: string;
  sync_mode?: 'download' | 'sync';
  sync_status?: string;
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
  /** The account's signature (Settings, Mail): rich text and its plain version; null without one. */
  signature_html?: string | null;
  signature_text?: string | null;
  /** Sync mode only: days of mail kept in UniHub; null keeps all mail. */
  sync_window_days?: MailWindowDays;
  /** Sync mode only: days of trash and spam kept in UniHub; null keeps all. */
  trash_window_days?: MailWindowDays;
  /** False until the owner accepts server-is-source-of-truth cleanup for an existing Sync account. */
  sync_policy_confirmed?: boolean;
  /** Local emails the first confirmed cleanup would remove; null while unknown. */
  sync_policy_pending_removals?: number | null;
  /** Provider setup problems the owner can fix; unknown codes are ignored. */
  sync_warnings?: string[];
}

const SYNC_WARNING_TEXT: Record<string, string> = {
  gmail_all_mail_hidden: 'Gmail’s “All Mail” is hidden from IMAP, so UniHub can’t tell archived mail from deleted mail and keeps it. In Gmail: Settings → Labels → All Mail → Show in IMAP.',
};
/** Readable text for the account's known sync warnings. */
export const mailSyncWarnings = (account: MailAccount) => (Array.isArray(account.sync_warnings) ? account.sync_warnings : [])
  .filter((code): code is string => typeof code === 'string' && Object.prototype.hasOwnProperty.call(SYNC_WARNING_TEXT, code))
  .map(code => ({ code, text: SYNC_WARNING_TEXT[code] }));

export type MailWindowDays = 14 | 30 | 90 | 180 | 365 | null;
export const MAIL_WINDOW_CHOICES: { value: MailWindowDays; label: string }[] = [
  { value: 14, label: '2 weeks' },
  { value: 30, label: '1 month' },
  { value: 90, label: '3 months' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year' },
  { value: null, label: 'All' },
];
export const DEFAULT_SYNC_WINDOW_DAYS: MailWindowDays = null;
export const DEFAULT_TRASH_WINDOW_DAYS: MailWindowDays = 30;
export const mailWindowKey = (value: MailWindowDays) => value === null ? 'all' : String(value);
export const parseMailWindow = (key: string): MailWindowDays => {
  const match = MAIL_WINDOW_CHOICES.find(choice => mailWindowKey(choice.value) === key);
  return match ? match.value : null;
};

/** What saving a mode/window change would remove from UniHub (never from the server). */
export interface MailModeImpact {
  mode: 'download' | 'sync';
  local_only: number;
  outside_window: number;
  outside_trash_window: number;
  gmail_duplicates: number;
  local_duplicates: number;
  total_removals: number;
  notes: string[];
}

export const emailCount = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'email' : 'emails'}`;
const sameAddress = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();
export const addressMatches = (typed: string, account: Pick<MailAccount, 'email_address'>) =>
  typed.trim() !== '' && sameAddress(typed, account.email_address);

/** Existing Sync accounts keep their local mail until the owner confirms the cleanup once. */
// Every unconfirmed Sync account needs the decision: until it is confirmed the
// backend never removes anything, including mail deleted on the server later.
export const needsSyncPolicyDecision = (account: MailAccount) => account.sync_mode === 'sync'
  && account.sync_policy_confirmed === false;

export async function fetchMailModeImpact(accountId: string, params: { mode: 'download' | 'sync'; syncWindow: MailWindowDays; trashWindow: MailWindowDays }, signal?: AbortSignal) {
  const search = new URLSearchParams({ mode: params.mode,
    sync_window_days: params.syncWindow === null ? '' : String(params.syncWindow),
    trash_window_days: params.trashWindow === null ? '' : String(params.trashWindow) });
  const response = await api.get<MailModeImpact>(`/mail/accounts/${encodeURIComponent(accountId)}/mode-impact?${search}`, { signal });
  if (response.error) throw new Error(response.error);
  const data = response.data;
  if (!data || typeof data.total_removals !== 'number') throw new Error('Invalid mode impact response');
  return { ...data, notes: Array.isArray(data.notes) ? data.notes : [] };
}

export async function confirmMailSyncPolicy(accountId: string, confirmAddress: string) {
  const response = await api.post<{ confirmed: boolean; queued: boolean }>(
    `/mail/accounts/${encodeURIComponent(accountId)}/confirm-sync-policy`, { confirm_address: confirmAddress.trim() });
  if (response.error) throw new Error(response.error);
  return response.data;
}


export interface EmailAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}


export interface Email {
  remote_missing?: boolean;
  is_legacy?: boolean;
  source_mail_account_id?: string | null;
  id: string;
  mail_account_id: string;
  subject: string | null;
  from_address: string;
  from_name: string | null;
  to_addresses: string[];
  /** Detail only. */
  cc_addresses?: string[];
  /** Detail only; set on your own sent copies and drafts. */
  bcc_addresses?: string[];
  body_text: string | null;
  body_html: string | null;
  folder: string;
  is_read: boolean;
  is_starred: boolean;
  read_sync_pending?: boolean;
  star_sync_pending?: boolean;
  is_draft?: boolean;
  received_at: string;
  has_attachments?: boolean;
  attachments?: EmailAttachment[];
  /** Tasks made from this email (detail only). */
  tasks?: import('@/lib/email-tasks').EmailTaskSummary[];
  /** How many tasks were made from this email (list rows). */
  task_count?: number;
  /** The conversation (list rows and the detail); null for mail not threaded yet. */
  thread_key?: string | null;
  /** List rows: snooze state and a draft's scheduled send (MailListRow in contracts/mail-threads.ts). */
  snoozed_until?: string | null;
  snooze_returned_at?: string | null;
  scheduled_send_at?: string | null;
  scheduled_send_status?: MailListRow['scheduled_send_status'];
}


export interface MailUnreadCountsResponse {
  unreadByFolder?: Record<string, number>;
  unreadByFolderAccount?: Record<string, Record<string, number>>;
}


export interface MailFolder {
  connected_account_ids?: string[];
  legacy_count?: number;
  mail_account_id?: string | null;
  special_use?: string | null;
  id: string;
  slug: string;
  display_name: string;
  is_system: boolean;
  position: number;
  total_count?: number;
  unread_count?: number;
  /** System roles (inbox, sent, drafts, junk, trash, archive) by slug and the server's special-use flag; notification filters match them as `role:<name>`. */
  roles?: string[];
}


export interface MailContact {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  email2: string | null;
  email3: string | null;
}

export interface MailWriteback {
  id: string;
  email_id: string;
  action: 'read' | 'star' | 'move';
  status: 'pending' | 'failed' | 'conflict' | 'done';
  state?: 'queued' | 'executing' | 'verifying' | 'reconciling' | 'retry_wait' | 'confirmed' | 'needs_attention' | 'rejected' | 'cancelled' | 'superseded';
  is_current?: boolean;
  can_retry?: boolean;
  can_cancel?: boolean;
  can_accept_server_state?: boolean;
  retry_action?: 'check_outcome' | 'retry' | null;
  /** UniHub's own reason for waiting or attention; provider text is never sent as one. */
  reason?: 'moved' | 'changed' | 'mailbox_reset' | null;
  attempts?: number;
  available_at?: string | null;
  error: string | null;
  created_at: string;
}

export const mailQueryKeys = {
  all: ['emails'] as const,
  accounts: ['mail-accounts'] as const,
  folders: ['mail-folders'] as const,
  writebacks: ['mail-writebacks'] as const,
  syncJobs: ['mail-sync-jobs'] as const,
  unread: (account: string | null) => ['mail-unread-counts', account] as const,
  dashboardUnread: ['dashboard-unread-mail'] as const,
  list: (filters: MailListFilters) => ['emails', filters.account, filters.folder, filters.page, filters.search, filters.unreadOnly] as const,
  // The conversation view of the same list (mail_threaded_view): same root
  // and positions, so the invalidations and flag refreshes of the message
  // list reach it; the cursor names the page.
  threads: (filters: MailListFilters, cursor: string | null) => ['emails', filters.account, filters.folder, filters.page, filters.search, filters.unreadOnly, 'threads', cursor] as const,
  // The messages of the conversation open in the reader.
  thread: (id: string) => ['mail-thread', id] as const,
  // One message outside the Mail page (the peek). Its own root: every entry
  // under 'emails' is a list, and the list cache patches rely on that shape.
  detail: (id: string) => ['mail-email', id] as const,
};

const MAIL_QUERY_ROOTS = new Set(['emails', 'mail-email', 'mail-thread', 'mail-unread-counts', 'mail-accounts', 'mail-accounts-count', 'mail-folders', 'email-count', 'stats', 'dashboard-unread-mail', 'mail-writebacks']);
export function invalidateMailQueries(client: QueryClient) {
  return client.invalidateQueries({ predicate: (query) => MAIL_QUERY_ROOTS.has(String(query.queryKey[0])) });
}

// Flag writes do not change folders or account settings. In particular, never
// invalidate writebacks from a writeback poll: that creates a second poll and
// can repeat the whole mail refetch cycle for every completed operation.
const MAIL_FLAG_COUNT_ROOTS = new Set(['mail-unread-counts', 'mail-accounts', 'mail-accounts-count', 'email-count', 'stats', 'dashboard-unread-mail']);

export function invalidateMailFlagViews(client: QueryClient) {
  return client.invalidateQueries({ predicate: query => query.queryKey[0] === 'emails' || query.queryKey[0] === 'mail-email' || query.queryKey[0] === 'mail-thread' || MAIL_FLAG_COUNT_ROOTS.has(String(query.queryKey[0])) });
}

const MAIL_COUNT_ROOTS = new Set(['mail-unread-counts', 'dashboard-unread-mail', 'email-count', 'stats']);

/**
 * After the server reported changed mail: the lists of those accounts ('*' for
 * every account; lists across all accounts always), every count and, when
 * folders changed, the folder list.
 */
export function invalidateChangedMail(client: QueryClient, accounts: ReadonlySet<string>, folders: boolean) {
  return client.invalidateQueries({ predicate: query => {
    const [root, account] = query.queryKey;
    if (MAIL_COUNT_ROOTS.has(String(root))) return true;
    if (folders && root === mailQueryKeys.folders[0]) return true;
    // The peek's key and the open conversation's carry no account, so they follow every change.
    if (root === 'mail-email' || root === 'mail-thread') return true;
    return root === mailQueryKeys.all[0] && (accounts.has('*') || account === 'all' || accounts.has(String(account)));
  } });
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
export type MailFlagKind = 'read' | 'star';
export type MailFlagPatch = Partial<Pick<Email, 'is_read' | 'is_starred' | 'read_sync_pending' | 'star_sync_pending'>>;
const flagEdits = new WeakMap<QueryClient, { revision: number; edits: Map<string, { revision: number; pending: boolean; patch: MailFlagPatch }> }>();
function editsFor(client: QueryClient) {
  let state = flagEdits.get(client);
  if (!state) {
    state = { revision: 0, edits: new Map() };
    flagEdits.set(client, state);
  }
  return state;
}

// Only bridge HTTP requests that overlap a local edit. New requests after an
// accepted write use the API's effective flags (including queued provider intent),
// never a permanent client override of provider/backend state.
export function captureMailFlagReconciler(client: QueryClient) {
  const state = editsFor(client);
  const revision = state.revision;
  return (email: Email): Email => {
    let result = email;
    for (const kind of ['read', 'star'] as const) {
      const edit = state.edits.get(`${kind}:${email.id}`);
      if (edit && (edit.pending || edit.revision > revision)) result = { ...result, ...edit.patch };
    }
    return result;
  };
}

export function recordMailFlagEdit(client: QueryClient, id: string, kind: MailFlagKind, patch: MailFlagPatch, pending: boolean) {
  const state = editsFor(client);
  state.edits.set(`${kind}:${id}`, { revision: ++state.revision, pending, patch });
  showRequestedFlagInMailLists(client, [id], patch);
}
export function mailFlagRevision(client: QueryClient, id: string, kind: MailFlagKind) {
  return editsFor(client).edits.get(`${kind}:${id}`)?.revision ?? 0;
}

export function showRequestedFlagInMailLists(client: QueryClient, ids: string[], patch: MailFlagPatch) {
  const selectedIds = new Set(ids);
  // Only list-shaped entries are patched (message lists and conversation
  // lists, whose rows are their latest messages); anything else under the
  // prefix is left alone.
  client.setQueriesData<MailListResponse | MailThreadListResponse>({ queryKey: mailQueryKeys.all }, current => {
    if (isMessageList(current)) return { ...current, emails: current.emails.map(email => selectedIds.has(email.id) ? { ...email, ...patch } : email) };
    if (isThreadList(current)) return { ...current, threads: current.threads.map(thread => selectedIds.has(thread.latest.id)
      ? { ...thread, latest: { ...thread.latest, ...patch }, ...(patch.is_starred === undefined ? {} : { is_starred: patch.is_starred }) } : thread) };
    return current;
  });
}
const isMessageList = (data: unknown): data is MailListResponse => Array.isArray((data as MailListResponse | undefined)?.emails);
const isThreadList = (data: unknown): data is MailThreadListResponse => Array.isArray((data as MailThreadListResponse | undefined)?.threads);
export function showRequestedReadInMailLists(client: QueryClient, ids: string[], isRead: boolean) {
  showRequestedFlagInMailLists(client, ids, { is_read: isRead });
}

export interface MailUnreadCountChange { folder: string; accountId: string; delta: number }

/** Moves cached unread counts with a requested change, so folder counts agree with the rows at once. */
export function adjustMailUnreadCounts(client: QueryClient, changes: MailUnreadCountChange[]) {
  for (const query of client.getQueryCache().findAll({ queryKey: ['mail-unread-counts'] })) {
    const scope = query.queryKey[1];
    client.setQueryData<MailUnreadCountsResponse>(query.queryKey, current => {
      if (!current) return current;
      const byFolder = { ...(current.unreadByFolder ?? {}) };
      const byAccount = current.unreadByFolderAccount ? { ...current.unreadByFolderAccount } : undefined;
      for (const change of changes) {
        if (scope !== 'all' && scope !== change.accountId) continue;
        byFolder[change.folder] = Math.max(0, (byFolder[change.folder] ?? 0) + change.delta);
        if (byAccount) {
          const row = { ...(byAccount[change.folder] ?? {}) };
          row[change.accountId] = Math.max(0, (row[change.accountId] ?? 0) + change.delta);
          byAccount[change.folder] = row;
        }
      }
      return { ...current, unreadByFolder: byFolder, ...(byAccount ? { unreadByFolderAccount: byAccount } : {}) };
    });
  }
}

export type MovedEmail = Pick<Email, 'id' | 'folder' | 'is_read' | 'mail_account_id'>;

/**
 * Shows a requested move (or trash) in every cached list and count before the
 * server answers: rows leave the lists of other folders, stay with the new
 * folder in All mail and Starred, and unread counts follow. Returns the undo
 * for a rejected request; flag edits made in between are kept.
 */
export function showRequestedMoveInMailCaches(client: QueryClient, moved: MovedEmail[], target: string) {
  const ids = new Set(moved.map(email => email.id));
  const reconcile = captureMailFlagReconciler(client);
  const previous: [readonly unknown[], MailListResponse | MailThreadListResponse][] = [];
  for (const query of client.getQueryCache().findAll({ queryKey: mailQueryKeys.all })) {
    const current = query.state.data as MailListResponse | MailThreadListResponse | undefined;
    const folder = query.queryKey[2];
    if (folder === target) continue;
    // Virtual views list by flag or snooze, not by folder: the row stays, with its new folder.
    const keepRows = folder === 'all' || folder === 'starred' || folder === 'snoozed';
    if (isThreadList(current)) {
      if (!current.threads.some(thread => ids.has(thread.latest.id))) continue;
      previous.push([query.queryKey, current]);
      const threads = keepRows ? current.threads.map(thread => ids.has(thread.latest.id) ? { ...thread, latest: { ...thread.latest, folder: target } } : thread)
        : current.threads.filter(thread => !ids.has(thread.latest.id));
      client.setQueryData<MailThreadListResponse>(query.queryKey, { ...current, threads });
      continue;
    }
    if (!isMessageList(current) || !current.emails.some(email => ids.has(email.id))) continue;
    previous.push([query.queryKey, current]);
    const emails = keepRows ? current.emails.map(email => ids.has(email.id) ? { ...email, folder: target } : email)
      : current.emails.filter(email => !ids.has(email.id));
    const removed = current.emails.length - emails.length;
    client.setQueryData<MailListResponse>(query.queryKey, {
      ...current, emails,
      ...(current.pagination && removed ? { pagination: { ...current.pagination, total: Math.max(0, current.pagination.total - removed) } } : {}),
    });
  }
  const counts = moved.filter(email => !email.is_read && email.folder !== target).flatMap(email => [
    { folder: email.folder, accountId: email.mail_account_id, delta: -1 },
    { folder: target, accountId: email.mail_account_id, delta: 1 },
  ]);
  adjustMailUnreadCounts(client, counts);
  return () => {
    for (const [key, data] of previous) client.setQueryData(key, restoreList(data, reconcile));
    adjustMailUnreadCounts(client, counts.map(change => ({ ...change, delta: -change.delta })));
  };
}
// A list put back from its snapshot keeps the flag edits made meanwhile.
const restoreList = (data: MailListResponse | MailThreadListResponse, reconcile: (email: Email) => Email) =>
  isThreadList(data) ? { ...data, threads: data.threads.map(thread => ({ ...thread, latest: reconcile(thread.latest) })) }
    : { ...data, emails: data.emails.map(reconcile) };

/**
 * Shows a requested snooze (or its end) before the server answers: a snoozed
 * message leaves every list but the Snoozed view and searches; one brought
 * back leaves the Snoozed view. Returns the undo for a rejected request.
 */
export function showRequestedSnoozeInMailCaches(client: QueryClient, ids: ReadonlySet<string>, snoozed: boolean) {
  const reconcile = captureMailFlagReconciler(client);
  // Only the rows this request took out, with their places: the undo puts
  // those back into each list as it is then, so other snoozes, moves and
  // flag changes made meanwhile stay.
  const removed: { key: readonly unknown[]; threads: boolean; rows: { index: number; item: Email | MailThreadSummary }[] }[] = [];
  for (const query of client.getQueryCache().findAll({ queryKey: mailQueryKeys.all })) {
    const current = query.state.data as MailListResponse | MailThreadListResponse | undefined;
    const [, , folder, , search] = query.queryKey;
    // A snoozed message stays visible in the Snoozed view and in search results; one that came back leaves the Snoozed view.
    if (snoozed ? folder === 'snoozed' || search : folder !== 'snoozed') continue;
    if (isThreadList(current)) {
      const rows = current.threads.flatMap((item, index) => ids.has(item.latest.id) ? [{ index, item }] : []);
      if (!rows.length) continue;
      removed.push({ key: query.queryKey, threads: true, rows });
      client.setQueryData<MailThreadListResponse>(query.queryKey, { ...current, threads: current.threads.filter(thread => !ids.has(thread.latest.id)) });
      continue;
    }
    if (!isMessageList(current)) continue;
    const rows = current.emails.flatMap((item, index) => ids.has(item.id) ? [{ index, item }] : []);
    if (!rows.length) continue;
    removed.push({ key: query.queryKey, threads: false, rows });
    const emails = current.emails.filter(email => !ids.has(email.id));
    client.setQueryData<MailListResponse>(query.queryKey, { ...current, emails,
      ...(current.pagination ? { pagination: { ...current.pagination, total: Math.max(0, current.pagination.total - rows.length) } } : {}) });
  }
  return () => {
    for (const { key, threads, rows } of removed) {
      const data = client.getQueryData<MailListResponse | MailThreadListResponse>(key);
      if (!data) continue;
      const idOf = (item: Email | MailThreadSummary) => 'latest' in item ? item.latest.id : item.id;
      const list: (Email | MailThreadSummary)[] = threads && isThreadList(data) ? [...data.threads] : isMessageList(data) ? [...data.emails] : [];
      const present = new Set(list.map(idOf));
      let added = 0;
      for (const { index, item } of rows) {
        if (present.has(idOf(item))) continue;
        list.splice(Math.min(index, list.length), 0, 'latest' in item
          ? { ...item, latest: reconcile(item.latest as unknown as Email) as unknown as MailListRow } : reconcile(item));
        added++;
      }
      if (!added) continue;
      if (threads && isThreadList(data)) client.setQueryData<MailThreadListResponse>(key, { ...data, threads: list as MailThreadSummary[] });
      else if (isMessageList(data)) client.setQueryData<MailListResponse>(key, { ...data, emails: list as Email[],
        ...(data.pagination ? { pagination: { ...data.pagination, total: data.pagination.total + added } } : {}) });
    }
  };
}

/** After a move or trash was accepted or rejected: the lists, folder counts and the server-change list. */
export function invalidateMailMoveViews(client: QueryClient) {
  return client.invalidateQueries({ predicate: query => ['emails', 'mail-folders', 'mail-unread-counts', 'mail-writebacks', 'dashboard-unread-mail'].includes(String(query.queryKey[0])) });
}

/** How long accepted flag changes are collected before one refresh of the affected views. */
export const MAIL_FLAG_REFRESH_MS = 400;
const flagRefreshes = new WeakMap<QueryClient, { timer?: ReturnType<typeof setTimeout>; read: boolean; star: boolean }>();

/**
 * Refreshes the views an accepted read/star change can still differ in, once
 * for a whole burst of changes (a bulk mark read is one refresh, not one per
 * message). Cached rows already show the accepted value; only lists filtered
 * by the changed flag (Starred, unread only) drop rows, counts are confirmed
 * and the server-change list picks up the queued provider change.
 */
export function scheduleMailFlagRefresh(client: QueryClient, kind: MailFlagKind) {
  let state = flagRefreshes.get(client);
  if (!state) {
    state = { read: false, star: false };
    flagRefreshes.set(client, state);
  }
  state[kind] = true;
  if (state.timer) return;
  state.timer = setTimeout(() => {
    const { read, star } = state;
    state.timer = undefined;
    state.read = state.star = false;
    void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'emails' &&
      ((star && query.queryKey[2] === 'starred') || (read && query.queryKey[5] === true)) });
    if (read) void client.invalidateQueries({ queryKey: ['mail-unread-counts'] });
    void client.invalidateQueries({ queryKey: mailQueryKeys.writebacks });
  }, MAIL_FLAG_REFRESH_MS);
}
function mailListParams(filters: MailListFilters) {
  const params = new URLSearchParams({ limit: '50', offset: String((filters.page - 1) * 50) });
  if (filters.account && filters.account !== 'all') params.set('account_id', filters.account);
  if (filters.folder !== 'all') params.set('folder', filters.folder);
  if (filters.folder === 'starred') params.set('is_starred', 'true');
  if (filters.unreadOnly) params.set('is_read', 'false');
  if (filters.search) params.set('search', filters.search);
  return params;
}
export async function fetchMailList(filters: MailListFilters, signal?: AbortSignal): Promise<MailListResponse> {
  const params = mailListParams(filters);
  const response = await api.get<MailListResponse>(`/mail/emails?${params}`, { signal });
  if (response.error) throw new Error(response.error);
  if (!Array.isArray(response.data?.emails)) throw new Error('Invalid mail list response');
  return response.data;
}

/**
 * The conversation view of a mail list (the user's mail_threaded_view): one row
 * per conversation, same filters and pages as fetchMailList. The offline
 * snapshot answers it from the saved messages. `cursor` is the previous page's
 * next_cursor; it keeps pages apart while new mail arrives.
 */
export async function fetchMailThreads(filters: MailListFilters, signal?: AbortSignal, cursor?: string | null): Promise<MailThreadListResponse> {
  const params = mailListParams(filters);
  if (cursor) { params.set('cursor', cursor); params.delete('offset'); }
  const response = await api.get<MailThreadListResponse>(`/mail/threads?${params}`, { signal });
  if (response.error) throw new Error(response.error);
  if (!Array.isArray(response.data?.threads)) throw new Error('Invalid conversation list response');
  return response.data;
}

/** One message in full (body, attachments, tasks), as the reader and the peek show it. */
export async function fetchMailDetail(emailId: string, signal?: AbortSignal): Promise<Email> {
  const response = await api.get<{ email: Email }>(`/mail/emails/${encodeURIComponent(emailId)}`, { signal });
  if (response.error || !response.data?.email) throw new Error(response.error || 'Could not load the message');
  return response.data.email;
}

/** Every message of the conversation the message belongs to, oldest first. */
export async function fetchMailThread(emailId: string, signal?: AbortSignal): Promise<MailThreadResponse> {
  const response = await api.get<MailThreadResponse>(`/mail/emails/${encodeURIComponent(emailId)}/thread`, { signal });
  if (response.error) throw new Error(response.error);
  if (!Array.isArray(response.data?.messages)) throw new Error('Invalid conversation response');
  return response.data;
}
