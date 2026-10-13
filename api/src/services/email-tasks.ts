import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import { db } from '../state';
import { isModuleEnabled } from './module-settings';
import { isSectionRestoreActive } from './restore-locks';

/**
 * A task or event made from an email. The task keeps a snapshot of the email's
 * header (`calendar_events.source_email_json`) so it stays readable after the
 * email is removed, and the id (`source_email_id`) opens the email while it
 * exists.
 */
export interface SourceEmailSnapshot {
  subject: string | null;
  from_name: string | null;
  from_address: string;
  received_at: string | null;
  /** File names of the regular attachments, at most SNAPSHOT_ATTACHMENTS. */
  attachments: string[];
  account: string | null;
  /** The email is a draft the user is writing; `to` is its first recipient. */
  draft?: boolean;
  to?: string | null;
}
const SNAPSHOT_ATTACHMENTS = 8;

/** SQL saying whether the event's linked email still exists; `alias` names the calendar_events row. */
export const sourceEmailPresentSql = (alias = 'calendar_events') => `(${alias}.source_email_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM emails se WHERE se.id = ${alias}.source_email_id AND se.user_id = ${alias}.user_id))`;

/** SQL (alias emails) counting the tasks made from a message. */
export const EMAIL_TASK_COUNT_SQL = `(SELECT COUNT(t.id) FROM calendar_events t WHERE t.source_email_id = emails.id AND t.user_id = emails.user_id)`;

/**
 * Linking a task to an email reads Mail data from a Calendar route, so Mail
 * must be on and not being restored. Returns the refusal, or null to go on.
 */
export async function sourceEmailLinkRefusal(userId: string) {
  if (!await isModuleEnabled(userId, 'mail')) {
    return { error: 'Mail is turned off. Enable it in Settings to link an email.', code: 'MODULE_DISABLED', module: 'mail', status: 403 };
  }
  if (await isSectionRestoreActive(userId, 'mail')) {
    return { error: 'Mail is being restored. Link the email when the restore finishes.', code: 'RESTORE_IN_PROGRESS', status: 409 };
  }
  return null;
}

/** Reads the owned email that a new task points at, or null when it is not the user's. */
export async function snapshotSourceEmail(userId: string, emailId: unknown, cx: SqlExecutor = db): Promise<SourceEmailSnapshot | null> {
  if (typeof emailId !== 'string' || !/^[0-9a-f-]{36}$/i.test(emailId)) return null;
  const [[email]] = await cx.execute<RowDataPacket[]>(`SELECT e.subject, e.from_name, e.from_address, e.received_at, e.is_draft, e.to_addresses, a.email_address
    FROM emails e LEFT JOIN mail_accounts a ON a.id = COALESCE(e.filing_account_id, e.mail_account_id) AND a.user_id = e.user_id
    WHERE e.id = ? AND e.user_id = ?`, [emailId, userId]);
  if (!email) return null;
  const [files] = await cx.execute<RowDataPacket[]>(`SELECT filename FROM email_attachments WHERE email_id = ? AND user_id = ? AND content_id IS NULL
    ORDER BY filename LIMIT ${SNAPSHOT_ATTACHMENTS}`, [emailId, userId]);
  const snapshot: SourceEmailSnapshot = {
    subject: email.subject || null,
    from_name: email.from_name || null,
    from_address: String(email.from_address || ''),
    received_at: email.received_at instanceof Date ? email.received_at.toISOString() : email.received_at || null,
    attachments: files.map(file => String(file.filename || '')).filter(Boolean),
    account: email.email_address || null,
  };
  if (Number(email.is_draft)) {
    snapshot.draft = true;
    snapshot.to = firstRecipient(email.to_addresses);
  }
  return snapshot;
}

function firstRecipient(value: unknown): string | null {
  try {
    const list = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(list) && typeof list[0] === 'string' && list[0].trim() ? list[0].trim() : null;
  } catch { return null; }
}

/** The tasks made from one email, newest last, as the mail reader lists them. */
export async function tasksForEmail(userId: string, emailId: string, cx: SqlExecutor = db) {
  const [rows] = await cx.execute<RowDataPacket[]>(`SELECT e.id, e.title, e.todo_status, e.start_time, e.end_time, e.all_day, e.is_todo_only, e.calendar_id
    FROM calendar_events e WHERE e.user_id = ? AND e.source_email_id = ? ORDER BY e.created_at ASC, e.id ASC`, [userId, emailId]);
  return rows.map(row => ({
    id: row.id as string,
    title: row.title as string,
    todo_status: (row.todo_status as string | null) || null,
    start_time: row.start_time instanceof Date ? row.start_time.toISOString() : row.start_time,
    end_time: row.end_time instanceof Date ? row.end_time.toISOString() : row.end_time,
    all_day: !!row.all_day,
    is_todo_only: !!row.is_todo_only,
    calendar_id: (row.calendar_id as string | null) || null,
  }));
}

/** What the API shows for an event's source email: the snapshot plus whether the email still exists. */
export function presentSourceEmail(row: { source_email_id?: string | null; source_email_json?: unknown; source_email_present?: unknown }) {
  if (!row.source_email_id) return null;
  let snapshot: Partial<SourceEmailSnapshot> = {};
  try { snapshot = (typeof row.source_email_json === 'string' ? JSON.parse(row.source_email_json) : row.source_email_json) || {}; } catch { snapshot = {}; }
  return {
    email_id: row.source_email_id,
    subject: snapshot.subject ?? null,
    from_name: snapshot.from_name ?? null,
    from_address: snapshot.from_address ?? '',
    received_at: snapshot.received_at ?? null,
    attachments: Array.isArray(snapshot.attachments) ? snapshot.attachments : [],
    account: snapshot.account ?? null,
    draft: !!snapshot.draft,
    to: snapshot.to ?? null,
    available: !!Number(row.source_email_present ?? 0),
  };
}
