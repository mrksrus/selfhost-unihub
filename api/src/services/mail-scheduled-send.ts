import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { ScheduledSend } from '../contracts/mail';

import crypto from 'crypto';
import { db } from '../state';
import { ApiError, badRequest, conflict, notFound } from '../http/errors';
import { log } from '../log';
import { blockedBackgroundModulesByUser, canRunModule } from './access-policy';
import { withTransaction } from './transactions';
import { loadDraftEmail, sendStoredDraft } from './mail-drafts';
import { sendOnce } from './mail-send';

// Scheduled send (0.24): a stored draft sends itself at a chosen time, once.
// Each schedule has its own send-once key (client_key, mail_command_receipts),
// so a crash, a restart or a second worker pass never sends it twice: a send
// whose outcome is not known stays 'unknown' and is not tried again. The
// draft can be edited or the schedule cancelled until the send starts
// ('sending'); sending the draft by hand cancels the schedule. The schedule is
// installation-local work: a restore brings the draft back unscheduled.
//
// status: scheduled -> sending -> (row removed with the sent draft) | sent
//         (draft kept) | failed (refused before the message left) | unknown
const MIN_LEAD_MS = 60 * 1000;
const MAX_LEAD_MS = 366 * 24 * 60 * 60 * 1000;
// A send claimed this long ago without an outcome belongs to a process that
// stopped; its key decides what happened (sendOnce answers from the receipt).
const STALE_SENDING_SECONDS = 600;
const BATCH = 20;

interface ScheduleRow extends RowDataPacket {
  id: string; user_id: string; email_id: string; send_at: Date | string; status: ScheduledSend['status']; client_key: string; last_error: string | null;
}

const present = (row: ScheduleRow): ScheduledSend => ({
  email_id: row.email_id, send_at: new Date(row.send_at).toISOString(), status: row.status, last_error: row.last_error,
});

function parseSendAt(value: unknown, now = Date.now()) {
  const sendAt = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : null;
  if (!sendAt || Number.isNaN(sendAt.getTime())) throw badRequest('SCHEDULE_TIME_INVALID', 'Choose when the message should be sent');
  if (sendAt.getTime() < now + MIN_LEAD_MS) throw badRequest('SCHEDULE_TIME_PAST', 'Choose a time at least a minute from now');
  if (sendAt.getTime() > now + MAX_LEAD_MS) throw badRequest('SCHEDULE_TIME_FAR', 'Choose a time within a year');
  return new Date(Math.floor(sendAt.getTime() / 1000) * 1000);
}

const inProgress = () => conflict('SCHEDULED_SEND_IN_PROGRESS', 'This message is being sent now.');

/** Schedules one of the user's drafts, or moves its time. A draft whose earlier send failed or is unknown gets a new key. */
async function scheduleDraft(userId: string, draftId: string, input: unknown): Promise<ScheduledSend> {
  const sendAt = parseSendAt((input as { send_at?: unknown } | null)?.send_at);
  const draft = await loadDraftEmail(userId, draftId);
  if (!draft) throw notFound('DRAFT_NOT_FOUND', 'Draft not found');
  if (![draft.to_addresses, draft.cc_addresses, draft.bcc_addresses].some(list => list.length)) {
    throw badRequest('DRAFT_RECIPIENTS_MISSING', 'Add at least one recipient before scheduling the message');
  }
  return withTransaction(async connection => {
    const [rows] = await connection.execute<ScheduleRow[]>('SELECT * FROM mail_scheduled_sends WHERE email_id = ? AND user_id = ? FOR UPDATE', [draftId, userId]);
    const current = rows[0];
    if (current?.status === 'sending') throw inProgress();
    if (current) {
      const newKey = current.status !== 'scheduled';
      await connection.execute(`UPDATE mail_scheduled_sends SET send_at = ?, status = 'scheduled', attempts = 0, last_error = NULL,
        mail_account_id = ?${newKey ? ', client_key = ?' : ''} WHERE id = ? AND user_id = ?`,
      [sendAt, draft.mail_account_id, ...(newKey ? [`scheduled-${crypto.randomUUID()}`] : []), current.id, userId]);
    } else {
      await connection.execute(`INSERT INTO mail_scheduled_sends (id, user_id, email_id, mail_account_id, send_at, client_key)
        VALUES (?, ?, ?, ?, ?, ?)`, [crypto.randomUUID(), userId, draftId, draft.mail_account_id, sendAt, `scheduled-${crypto.randomUUID()}`]);
    }
    const [[saved]] = await connection.execute<ScheduleRow[]>('SELECT * FROM mail_scheduled_sends WHERE email_id = ? AND user_id = ?', [draftId, userId]);
    return present(saved);
  });
}

async function scheduleOf(userId: string, draftId: string, executor: SqlExecutor = db) {
  const [rows] = await executor.execute<ScheduleRow[]>('SELECT * FROM mail_scheduled_sends WHERE email_id = ? AND user_id = ?', [draftId, userId]);
  return rows[0] ?? null;
}

/** Cancels the schedule of one of the user's drafts; the draft stays. Refused while it is being sent. */
async function cancelSchedule(userId: string, draftId: string) {
  const [result] = await db.execute<ResultSetHeader>("DELETE FROM mail_scheduled_sends WHERE email_id = ? AND user_id = ? AND status <> 'sending'", [draftId, userId]);
  if (!result.affectedRows) {
    if ((await scheduleOf(userId, draftId))?.status === 'sending') throw inProgress();
    throw notFound('SCHEDULE_NOT_FOUND', 'This message is not scheduled');
  }
  return { email_id: draftId, cancelled: true };
}

/** Before a draft is sent by hand: its schedule goes (refused while the scheduled send runs). */
async function cancelScheduleForSendNow(userId: string, draftId: string) {
  await db.execute("DELETE FROM mail_scheduled_sends WHERE email_id = ? AND user_id = ? AND status <> 'sending'", [draftId, userId]);
  if ((await scheduleOf(userId, draftId))?.status === 'sending') throw inProgress();
}

/** A draft can be edited or deleted unless its scheduled send is running. */
async function assertDraftEditable(userId: string, draftId: string) {
  if ((await scheduleOf(userId, draftId))?.status === 'sending') throw inProgress();
}

// What the person sees when a scheduled send did not go out. SMTP errors can
// name recipients, so only messages written for the client are kept.
function failureText(error: unknown) {
  if (error instanceof ApiError || (typeof (error as ApiError)?.status === 'number' && (error as ApiError).status! < 500)) return String((error as Error).message).slice(0, 255);
  const message = String((error as Error)?.message || '');
  if (/inactive or disconnected|No password configured|Mail module is disabled|Account not found/.test(message)) return message.slice(0, 255);
  return 'The mail server did not accept the message.';
}

async function settle(row: ScheduleRow, status: 'failed' | 'unknown' | 'sent', lastError: string | null) {
  await db.execute('UPDATE mail_scheduled_sends SET status = ?, last_error = ? WHERE id = ? AND user_id = ?', [status, lastError, row.id, row.user_id]);
  if (status === 'sent') return;
  const { enqueueScheduledSendProblem } = require('./notifications') as typeof import('./notifications');
  await enqueueScheduledSendProblem({ userId: row.user_id, emailId: row.email_id, scheduleId: row.id, sendKey: row.client_key, status })
    .catch((error: unknown) => log.warn('mail', 'could not announce a scheduled send that did not go out', { userId: row.user_id }, error));
}

/** Sends the scheduled drafts that are due, each at most once. `send` is the draft sender (tests replace it). */
async function runDueScheduledSends(now = new Date(), send: typeof sendStoredDraft = sendStoredDraft) {
  // Mail switched off, paused or being restored, or the person deactivated:
  // the schedule waits, and does not hold up anyone else's.
  const blocked = [...await blockedBackgroundModulesByUser(db)].filter(([, modules]) => modules.has('mail')).map(([userId]) => userId);
  const [due] = await db.execute<ScheduleRow[]>(`SELECT s.* FROM mail_scheduled_sends s JOIN users u ON u.id = s.user_id AND u.is_active = TRUE
    WHERE ((s.status = 'scheduled' AND s.send_at <= ?) OR (s.status = 'sending' AND s.updated_at < UTC_TIMESTAMP() - INTERVAL ? SECOND))
    ${blocked.length ? `AND s.user_id NOT IN (${blocked.map(() => '?').join(', ')})` : ''}
    ORDER BY s.send_at LIMIT ${BATCH}`, [now, STALE_SENDING_SECONDS, ...blocked]);
  let sent = 0;
  for (const row of due) {
    if (!await canRunModule(row.user_id, 'mail', { background: true })) continue;
    const [claim] = await db.execute<ResultSetHeader>(`UPDATE mail_scheduled_sends SET status = 'sending', attempts = attempts + 1, updated_at = UTC_TIMESTAMP()
      WHERE id = ? AND user_id = ? AND ((status = 'scheduled' AND send_at <= ?) OR (status = 'sending' AND updated_at < UTC_TIMESTAMP() - INTERVAL ? SECOND))`,
    [row.id, row.user_id, now, STALE_SENDING_SECONDS]);
    if (!claim.affectedRows) continue;
    let result: Record<string, unknown>;
    try {
      result = await sendOnce({ userId: row.user_id, clientKey: row.client_key, request: { draftId: row.email_id, scheduled: true } },
        () => send(row.user_id, row.email_id));
    } catch (error) {
      const code = (error as ApiError)?.code;
      // Still running elsewhere (a stale claim of a live send): the claim was renewed, so it is looked at again later.
      if (code === 'SEND_IN_PROGRESS') continue;
      if (code === 'SEND_OUTCOME_UNKNOWN') await settle(row, 'unknown', 'The connection to the mail server was lost after the message was handed over. Check Sent before sending it again.');
      else await settle(row, 'failed', failureText(error));
      continue;
    }
    if (result.error) { await settle(row, 'failed', failureText(Object.assign(new Error(String(result.error)), { status: Number(result.status) || 400 }))); continue; }
    sent += 1;
    // The sent draft took its schedule with it; one that could not be removed keeps a 'sent' mark.
    await db.execute("UPDATE mail_scheduled_sends SET status = 'sent', last_error = NULL WHERE id = ? AND user_id = ?", [row.id, row.user_id]);
  }
  return { sent };
}

export { scheduleDraft, cancelSchedule, cancelScheduleForSendNow, assertDraftEditable, runDueScheduledSends, STALE_SENDING_SECONDS };
