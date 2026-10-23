import type { RowDataPacket } from 'mysql2/promise';
import type { MailListRow, MailThreadListResponse, MailThreadResponse, MailThreadSummary } from '../contracts/mail-threads';

import { db } from '../state';
import { FILING_ACCOUNT_SQL } from './mail-folder-reconciliation';
import { folderMembershipSql, pendingMoveSql, pendingFlagSql, EFFECTIVE_READ_SQL, EFFECTIVE_STAR_SQL } from './mail-folder-view';
import { presentMailFiling } from './mail-filing';
import { toBooleanFlag } from './mail-host-policy';
import { escapeLike } from './sql';
import { EMAIL_TASK_COUNT_SQL } from './email-tasks';
import { isModuleEnabled } from './module-settings';
import { badRequest, notFound } from '../http/errors';
import { NOT_SNOOZED_SQL, SNOOZED_SQL } from './mail-snooze';

// The mail list's view (folder, account, read/star and search filters) and
// row shape, shared by the message list (GET /api/mail/emails) and the
// conversation list (GET /api/mail/threads), so both show the same messages.

// Enough for five preview lines on a wide list (Settings, Mail: preview lines).
const MAIL_LIST_PREVIEW_LENGTH = 700;
const MAIL_THREAD_MAX_MESSAGES = 200;
const PARTICIPANTS_PER_THREAD = 5;

type SqlParam = string | number | Date | null;
interface MailListView {
  /** Conditions on the `emails` table, unqualified or qualified as `emails.`. */
  whereSql: string;
  params: SqlParam[];
  folder: string | null;
  accountId: string | null;
  hasFolderFilter: boolean;
  hasAccountFilter: boolean;
  includeCount: boolean;
  limit: number;
  offset: number;
  page: number;
}

function mailListView(searchParams: URLSearchParams, userId: string): MailListView {
  const folder = searchParams.get('folder');
  const accountId = searchParams.get('account_id');
  const hasFolderFilter = !!folder && folder !== 'all';
  const hasAccountFilter = !!accountId && accountId !== 'all';
  const isReadParam = searchParams.get('is_read');
  const isStarredParam = searchParams.get('is_starred');
  const searchParam = (searchParams.get('search') || '').trim();
  const where = ['user_id = ?'];
  const params: SqlParam[] = [userId];

  if (folder === 'starred') {
    where.push(`${EFFECTIVE_STAR_SQL} = 1`);
  } else if (folder === 'snoozed') {
    where.push(SNOOZED_SQL);
  } else if (hasFolderFilter) {
    where.push(folderMembershipSql);
    params.push(folder, folder, folder);
  }
  if (hasAccountFilter) {
    where.push(accountId === 'legacy' ? 'is_legacy = TRUE' : `is_legacy = FALSE AND ${FILING_ACCOUNT_SQL} = ?`);
    if (accountId !== 'legacy') params.push(accountId);
  }
  if (isReadParam === 'true' || isReadParam === 'false') {
    where.push(`${EFFECTIVE_READ_SQL} = ?`);
    params.push(isReadParam === 'true' ? 1 : 0);
  }
  if (isStarredParam === 'true' || isStarredParam === 'false') {
    where.push(`${EFFECTIVE_STAR_SQL} = ?`);
    params.push(isStarredParam === 'true' ? 1 : 0);
  }
  // Snoozed messages leave the lists until they come back; search finds them.
  if (folder !== 'snoozed' && !searchParam) where.push(NOT_SNOOZED_SQL);
  if (searchParam) {
    const searchValue = `%${escapeLike(searchParam.toLowerCase())}%`;
    where.push(`(
          LOWER(COALESCE(subject, '')) LIKE ? OR
          LOWER(COALESCE(from_name, '')) LIKE ? OR
          LOWER(COALESCE(from_address, '')) LIKE ? OR
          LOWER(COALESCE(body_text, '')) LIKE ?
        )`);
    params.push(searchValue, searchValue, searchValue, searchValue);
  }

  const requestedLimit = parseInt(searchParams.get('limit') || '50', 10);
  const requestedOffset = parseInt(searchParams.get('offset') || '0', 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
  return { whereSql: where.join(' AND '), params, folder, accountId, hasFolderFilter, hasAccountFilter,
    includeCount: searchParams.get('include_count') !== 'false', limit, offset, page: Math.max(1, Math.floor(offset / limit) + 1) };
}

// A draft's scheduled send, if any (mail-scheduled-send.ts).
const SCHEDULED_SEND_SQL = `(SELECT s.send_at FROM mail_scheduled_sends s WHERE s.email_id = emails.id AND s.user_id = emails.user_id) AS scheduled_send_at,
          (SELECT s.status FROM mail_scheduled_sends s WHERE s.email_id = emails.id AND s.user_id = emails.user_id) AS scheduled_send_status`;

// Task counts are Calendar data: none while that module is off.
async function mailListColumns(userId: string) {
  const taskCountSql = await isModuleEnabled(userId, 'calendar') ? EMAIL_TASK_COUNT_SQL : '0';
  return `
          id,
          user_id,
          mail_account_id, filing_account_id, is_legacy, remote_missing,
          message_id,
          subject,
          from_address,
          from_name,
          to_addresses,
          CASE
            WHEN body_text IS NULL THEN NULL
            WHEN CHAR_LENGTH(body_text) > ${MAIL_LIST_PREVIEW_LENGTH}
              THEN CONCAT(LEFT(body_text, ${MAIL_LIST_PREVIEW_LENGTH}), '...')
            ELSE body_text
          END AS body_text,
          NULL AS body_html,
          COALESCE(${pendingMoveSql}, folder) AS folder,
          source_folder,
          imap_uid,
          imap_uidvalidity,
          raw_storage_path,
          raw_sha256,
          ${EFFECTIVE_READ_SQL} AS is_read,
          ${EFFECTIVE_STAR_SQL} AS is_starred,
          ${pendingFlagSql('read')} AS read_sync_pending,
          ${pendingFlagSql('star')} AS star_sync_pending,
          is_draft,
          has_attachments,
          received_at,
          created_at,
          thread_key,
          snoozed_until,
          snooze_returned_at,
          ${SCHEDULED_SEND_SQL},
          ${taskCountSql} AS task_count`;
}

function presentMailListRow(email: RowDataPacket, view?: Pick<MailListView, 'folder' | 'hasFolderFilter'>) {
  return {
    ...presentMailFiling(email),
    ...(view?.hasFolderFilter && view.folder !== 'starred' && view.folder !== 'snoozed' ? { folder: view.folder } : {}),
    to_addresses: typeof email.to_addresses === 'string' ? JSON.parse(email.to_addresses || '[]') : email.to_addresses,
    is_read: toBooleanFlag(email.is_read),
    is_starred: toBooleanFlag(email.is_starred),
    read_sync_pending: !!email.read_sync_pending,
    star_sync_pending: !!email.star_sync_pending,
    is_draft: !!email.is_draft,
    task_count: Number(email.task_count) || 0,
  };
}

// A page boundary of the conversation list: the received time and id of the
// last conversation's newest message. Mail that arrives meanwhile moves its
// conversation to the top without shifting the next page.
const CURSOR = /^([0-9]{1,15})\.([A-Za-z0-9-]{1,64})$/;
function parseCursor(value: string | null) {
  if (value === null || value === '') return null;
  const match = CURSOR.exec(value);
  if (!match) throw badRequest('INVALID_CURSOR', 'Invalid cursor');
  return { receivedAt: new Date(Number(match[1])), id: match[2] };
}
const cursorOf = (row: RowDataPacket) => `${new Date(row.received_at).getTime()}.${row.id}`;
const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(', ');

/**
 * One row per conversation in the view, newest first: the conversation's
 * newest message in the view, with counts and senders. A message counts for
 * the view when it matches the same filters as the message list; its
 * conversation is listed once, at the place of its newest such message.
 */
async function listMailThreads(userId: string, searchParams: URLSearchParams): Promise<MailThreadListResponse> {
  const view = mailListView(searchParams, userId);
  const cursor = parseCursor(searchParams.get('cursor'));
  const columns = await mailListColumns(userId);
  // The newest message in the view of its conversation: no message of the
  // same conversation that comes before it in the list is in the view. The
  // innermost query re-applies the view's conditions to that message under
  // the table's own name, so the same SQL fragments serve both. A message
  // without a key is a conversation of its own.
  // The list order (received_at DESC, id ASC) is the order of
  // idx_emails_user_date, so the scan walks the index and stops after one
  // page; with id DESC the database sorted the whole view first, running the
  // check for every message of it (seconds at 100k messages instead of ms).
  const newestInView = `(emails.thread_key IS NULL OR NOT EXISTS (
      SELECT 1 FROM emails AS later WHERE later.user_id = emails.user_id AND later.thread_key = emails.thread_key
        AND (later.received_at > emails.received_at OR (later.received_at = emails.received_at AND later.id < emails.id))
        AND EXISTS (SELECT 1 FROM emails WHERE emails.id = later.id AND ${view.whereSql})))`;
  const cursorSql = cursor ? ' AND (emails.received_at < ? OR (emails.received_at = ? AND emails.id > ?))' : '';
  const offset = cursor ? 0 : view.offset;
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT ${columns} FROM emails
    WHERE ${view.whereSql}${cursorSql} AND ${newestInView}
    ORDER BY received_at DESC, id ASC LIMIT ${view.limit + 1} OFFSET ${offset}`,
  [...view.params, ...(cursor ? [cursor.receivedAt, cursor.receivedAt, cursor.id] : []), ...view.params]);
  const hasMore = rows.length > view.limit;
  const page = rows.slice(0, view.limit);

  // Counting the view's conversations reads all of it (about 0.6 s for an
  // inbox of 100k messages), so it runs only when asked for.
  let total: number | null = null;
  if (searchParams.get('include_count') === 'true') {
    const [[count]] = await db.execute<RowDataPacket[]>(`SELECT COUNT(DISTINCT COALESCE(thread_key, id)) AS total FROM emails WHERE ${view.whereSql}`, view.params);
    total = Number(count?.total) || 0;
  }

  const keys = [...new Set(page.map(row => row.thread_key).filter((key): key is string => typeof key === 'string'))];
  // A conversation's size and senders leave out its snoozed messages, except
  // where the view shows them (the Snoozed view and search).
  const snoozedSql = view.folder === 'snoozed' || (searchParams.get('search') || '').trim() ? '' : ` AND ${NOT_SNOOZED_SQL}`;
  const inView = new Map<string, RowDataPacket>(), totals = new Map<string, number>(), senders = new Map<string, RowDataPacket[]>();
  if (keys.length) {
    const [counted] = await db.execute<RowDataPacket[]>(`SELECT thread_key, COUNT(*) AS message_count,
        SUM(CASE WHEN ${EFFECTIVE_READ_SQL} = 0 THEN 1 ELSE 0 END) AS unread_count,
        MAX(has_attachments) AS has_attachments, MAX(${EFFECTIVE_STAR_SQL}) AS is_starred
      FROM emails WHERE ${view.whereSql} AND thread_key IN (${placeholders(keys)}) GROUP BY thread_key`, [...view.params, ...keys]);
    for (const row of counted) inView.set(row.thread_key, row);
    const [whole] = await db.execute<RowDataPacket[]>(`SELECT thread_key, COUNT(*) AS total_count FROM emails
      WHERE user_id = ? AND thread_key IN (${placeholders(keys)}) AND NOT COALESCE(is_draft, FALSE)${snoozedSql} GROUP BY thread_key`, [userId, ...keys]);
    for (const row of whole) totals.set(row.thread_key, Number(row.total_count) || 0);
    const [people] = await db.execute<RowDataPacket[]>(`SELECT thread_key, from_address, MAX(from_name) AS from_name, MAX(received_at) AS last_at FROM emails
      WHERE user_id = ? AND thread_key IN (${placeholders(keys)}) AND NOT COALESCE(is_draft, FALSE) AND from_address <> 'unknown'${snoozedSql}
      GROUP BY thread_key, from_address`, [userId, ...keys]);
    for (const row of people) senders.set(row.thread_key, [...(senders.get(row.thread_key) || []), row]);
  }

  const threads = page.map((row): MailThreadSummary => {
    const latest = presentMailListRow(row, view) as unknown as MailListRow;
    const counts = row.thread_key ? inView.get(row.thread_key) : undefined;
    const people = row.thread_key ? (senders.get(row.thread_key) || [])
      .sort((a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime()) : [];
    return {
      thread_key: row.thread_key ?? null,
      latest,
      message_count: counts ? Number(counts.message_count) || 1 : 1,
      unread_count: counts ? Number(counts.unread_count) || 0 : (latest.is_read ? 0 : 1),
      total_count: row.thread_key ? Math.max(totals.get(row.thread_key) || 0, 1) : 1,
      has_attachments: counts ? toBooleanFlag(counts.has_attachments) : !!row.has_attachments,
      is_starred: counts ? toBooleanFlag(counts.is_starred) : latest.is_starred,
      participants: (people.length ? people : [row]).slice(0, PARTICIPANTS_PER_THREAD)
        .map(person => ({ address: String(person.from_address), name: person.from_name ?? null })),
    };
  });
  return {
    threads,
    pagination: { total, limit: view.limit, offset, page: cursor ? 1 : view.page,
      totalPages: total === null ? null : Math.ceil(total / view.limit), hasMore,
      next_cursor: hasMore && page.length ? cursorOf(page[page.length - 1]) : null },
  };
}

/** Every message of the conversation the user's message belongs to, oldest first, for the reader; its other snoozed messages stay hidden. */
async function mailThreadMessages(userId: string, emailId: string): Promise<MailThreadResponse> {
  const [[anchor]] = await db.execute<RowDataPacket[]>('SELECT thread_key FROM emails WHERE id = ? AND user_id = ?', [emailId, userId]);
  if (!anchor) throw notFound('EMAIL_NOT_FOUND', 'Email not found');
  const columns = await mailListColumns(userId);
  const [rows] = anchor.thread_key
    ? await db.execute<RowDataPacket[]>(`SELECT ${columns} FROM emails WHERE user_id = ? AND thread_key = ? AND (id = ? OR ${NOT_SNOOZED_SQL})
        ORDER BY received_at DESC, id DESC LIMIT ${MAIL_THREAD_MAX_MESSAGES + 1}`, [userId, anchor.thread_key, emailId])
    : await db.execute<RowDataPacket[]>(`SELECT ${columns} FROM emails WHERE user_id = ? AND id = ?`, [userId, emailId]);
  const truncated = rows.length > MAIL_THREAD_MAX_MESSAGES;
  return {
    thread_key: anchor.thread_key ?? null,
    messages: rows.slice(0, MAIL_THREAD_MAX_MESSAGES).reverse().map(row => presentMailListRow(row) as unknown as MailListRow),
    truncated,
  };
}

export { MAIL_LIST_PREVIEW_LENGTH, MAIL_THREAD_MAX_MESSAGES, mailListView, mailListColumns, presentMailListRow, listMailThreads, mailThreadMessages };
export type { MailListView };
