import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { ScheduledSend } from '../contracts/mail';

import crypto from 'crypto';
import { db } from '../state';
import { ApiError, badRequest, conflict, notFound } from '../http/errors';
import { log } from '../log';
import { blockedBackgroundModulesByUser, canRunModule } from './access-policy';
import { isSectionRestoreActive } from './restore-locks';
import { withTransaction } from './transactions';
import { isDraftSendRunning, loadDraftEmail, lockDraftForSend, sendStoredDraft, trackDraftSend } from './mail-drafts';
// Through the facade, as the draft routes did, so their tests can stub sending.
import { sendOnce } from './mail';
import { getReceipt } from './mail-engine/repository';

// Scheduled send (0.24): a stored draft sends itself at a chosen time, once.
// Each schedule has its own send-once key (client_key, mail_command_receipts),
// so a crash, a restart or a second worker pass never sends it twice: a send
// whose outcome is not known stays 'unknown' and is not tried again. The
// draft can be edited or the schedule cancelled until the send starts
// ('sending'). The schedule is installation-local work: a restore brings the
// draft back unscheduled and waits for running sends (trackDraftSend).
//
// The same row reserves a draft that is sent by hand (origin 'send_now'), so a
// send by hand, a schedule, an edit and a delete of one draft never overlap.
// Every writer locks the draft first, then this row (lockDraftForSend).
//
// status: scheduled -> sending -> (row removed with the sent draft) | sent
//         (draft kept) | failed (refused before the message left) | unknown
const MIN_LEAD_MS = 60 * 1000;
const MAX_LEAD_MS = 366 * 24 * 60 * 60 * 1000;
// A send claimed this long ago without an outcome belongs to a process that
// stopped; its key decides what happened (sendOnce answers from the receipt).
const STALE_SENDING_SECONDS = 600;
const BATCH = 20;
const UNKNOWN_TEXT = 'The connection to the mail server was lost after the message was handed over. Check Sent before sending it again.';

interface ScheduleRow extends RowDataPacket {
  id: string; user_id: string; email_id: string; send_at: Date | string; status: ScheduledSend['status'];
  origin: 'schedule' | 'send_now'; client_key: string; last_error: string | null;
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
const restoring = () => conflict('RESTORE_IN_PROGRESS', 'Restore in progress for mail. This section is temporarily read-only.');

/** Schedules one of the user's drafts, or moves its time. A draft whose earlier send failed, is unknown or was by hand gets a new key. */
async function scheduleDraft(userId: string, draftId: string, input: unknown): Promise<ScheduledSend> {
  const sendAt = parseSendAt((input as { send_at?: unknown } | null)?.send_at);
  const draft = await loadDraftEmail(userId, draftId);
  if (!draft) throw notFound('DRAFT_NOT_FOUND', 'Draft not found');
  if (![draft.to_addresses, draft.cc_addresses, draft.bcc_addresses].some(list => list.length)) {
    throw badRequest('DRAFT_RECIPIENTS_MISSING', 'Add at least one recipient before scheduling the message');
  }
  return withTransaction(async connection => {
    const locked = await lockDraftForSend(connection, userId, draftId);
    if (!locked) throw notFound('DRAFT_NOT_FOUND', 'Draft not found');
    const current = locked.send;
    if (current?.status === 'sending') throw inProgress();
    if (current) {
      const newKey = current.status !== 'scheduled' || current.origin !== 'schedule';
      await connection.execute(`UPDATE mail_scheduled_sends SET send_at = ?, status = 'scheduled', origin = 'schedule', attempts = 0, last_error = NULL,
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

/** A draft can be edited or deleted unless it is being sent. The save itself checks again under the lock. */
async function assertDraftEditable(userId: string, draftId: string) {
  if ((await scheduleOf(userId, draftId))?.status === 'sending') throw inProgress();
}

/**
 * Sends one of the user's drafts by hand. It reserves the draft first (its
 * schedule, if any, is replaced; refused while another send of it runs), so
 * no schedule, edit or delete can overlap the send. A repeat of the same
 * request (same key) is answered by sendOnce. `send` is the draft sender (tests replace it).
 */
async function sendDraftNow(userId: string, draftId: string, clientKey: string | undefined, replyTo: unknown,
  send: typeof sendStoredDraft = sendStoredDraft): Promise<Record<string, unknown>> {
  return trackDraftSend(async () => {
    if (await isSectionRestoreActive(userId, 'mail')) throw restoring();
    const reservationKey = clientKey ?? `send-now-${crypto.randomUUID()}`;
    const reserved = await withTransaction(async connection => {
      const locked = await lockDraftForSend(connection, userId, draftId);
      // Gone: a repeat after it was sent gets the first result from its key.
      if (!locked) return false;
      if (locked.send?.status === 'sending') {
        if (locked.send.origin === 'send_now' && clientKey && locked.send.client_key === clientKey) return false;
        throw inProgress();
      }
      await connection.execute(`INSERT INTO mail_scheduled_sends (id, user_id, email_id, mail_account_id, send_at, status, origin, client_key, attempts)
        SELECT ?, user_id, id, mail_account_id, UTC_TIMESTAMP(), 'sending', 'send_now', ?, 1 FROM emails WHERE id = ? AND user_id = ? AND is_draft = TRUE
        ON DUPLICATE KEY UPDATE send_at = VALUES(send_at), status = 'sending', origin = 'send_now', client_key = VALUES(client_key),
          attempts = 1, last_error = NULL, updated_at = UTC_TIMESTAMP()`, [crypto.randomUUID(), reservationKey, draftId, userId]);
      return true;
    });
    const mine = "WHERE email_id = ? AND user_id = ? AND origin = 'send_now' AND client_key = ?";
    const settleMine = (sql: string, values: string[] = []) => reserved ? db.execute(`${sql} ${mine}`, [...values, draftId, userId, reservationKey])
      .catch((error: unknown) => log.warn('mail', 'could not settle the reservation of a draft sent by hand', { userId }, error)) : undefined;
    let result: Record<string, unknown>;
    try {
      result = await sendOnce({ userId, clientKey, request: { draftId, replyTo } }, () => send(userId, draftId, replyTo));
    } catch (error) {
      const code = (error as ApiError)?.code;
      if (code === 'SEND_OUTCOME_UNKNOWN') await settleMine("UPDATE mail_scheduled_sends SET status = 'unknown', last_error = ?", [UNKNOWN_TEXT]);
      else if (code !== 'SEND_IN_PROGRESS') await settleMine('DELETE FROM mail_scheduled_sends');
      throw error;
    }
    // Refused before it left: the draft is free again. Sent: the draft took
    // its reservation with it; one that could not be removed keeps a 'sent' mark.
    if (result.error) await settleMine('DELETE FROM mail_scheduled_sends');
    else await settleMine("UPDATE mail_scheduled_sends SET status = 'sent', last_error = NULL");
    return result;
  }, { userId, draftId });
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

// A send by hand whose process stopped (a live one in this process is skipped
// above): never sent again from here, the person decides. Its receipt says whether it went out; without one (no key,
// or refused) the draft is simply free again.
async function settleStoppedSendNow(row: ScheduleRow) {
  const receipt = await getReceipt({ userId: row.user_id, clientKey: row.client_key }).catch(() => null);
  const response = receipt ? (typeof receipt.response_json === 'string' ? JSON.parse(receipt.response_json) : receipt.response_json) as Record<string, unknown> | null : null;
  if (!response) await db.execute("DELETE FROM mail_scheduled_sends WHERE id = ? AND user_id = ? AND status = 'sending'", [row.id, row.user_id]);
  else if (response.send_pending || response.send_unknown) await db.execute("UPDATE mail_scheduled_sends SET status = 'unknown', last_error = ? WHERE id = ? AND user_id = ?", [UNKNOWN_TEXT, row.id, row.user_id]);
  else await db.execute("UPDATE mail_scheduled_sends SET status = 'sent', last_error = NULL WHERE id = ? AND user_id = ?", [row.id, row.user_id]);
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
    // A claim older than the stale window whose send still runs here (a slow
    // server) is alive: neither resumed nor settled as stopped.
    if (isDraftSendRunning(row.user_id, row.email_id)) continue;
    // Registered before the check: a restore that starts later waits for this send.
    await trackDraftSend(async () => {
      if (!await canRunModule(row.user_id, 'mail', { background: true })) return;
      const [claim] = await db.execute<ResultSetHeader>(`UPDATE mail_scheduled_sends SET status = 'sending', attempts = attempts + 1, updated_at = UTC_TIMESTAMP()
        WHERE id = ? AND user_id = ? AND ((status = 'scheduled' AND send_at <= ?) OR (status = 'sending' AND updated_at < UTC_TIMESTAMP() - INTERVAL ? SECOND))`,
      [row.id, row.user_id, now, STALE_SENDING_SECONDS]);
      if (!claim.affectedRows) return;
      if (row.origin === 'send_now') { await settleStoppedSendNow(row); return; }
      let result: Record<string, unknown>;
      try {
        result = await sendOnce({ userId: row.user_id, clientKey: row.client_key, request: { draftId: row.email_id, scheduled: true } },
          () => send(row.user_id, row.email_id));
      } catch (error) {
        const code = (error as ApiError)?.code;
        // Still running elsewhere (a stale claim of a live send): the claim was renewed, so it is looked at again later.
        if (code === 'SEND_IN_PROGRESS') return;
        if (code === 'SEND_OUTCOME_UNKNOWN') await settle(row, 'unknown', UNKNOWN_TEXT);
        else await settle(row, 'failed', failureText(error));
        return;
      }
      if (result.error) { await settle(row, 'failed', failureText(Object.assign(new Error(String(result.error)), { status: Number(result.status) || 400 }))); return; }
      sent += 1;
      // The sent draft took its schedule with it; one that could not be removed keeps a 'sent' mark.
      await db.execute("UPDATE mail_scheduled_sends SET status = 'sent', last_error = NULL WHERE id = ? AND user_id = ?", [row.id, row.user_id]);
    }, { userId: row.user_id, draftId: row.email_id });
  }
  return { sent };
}

export { scheduleDraft, cancelSchedule, sendDraftNow, assertDraftEditable, runDueScheduledSends, STALE_SENDING_SECONDS };
