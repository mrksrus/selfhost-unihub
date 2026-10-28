import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';

import { db } from '../state';
import { badRequest, notFound } from '../http/errors';
import { log } from '../log';
import { isModuleBackgroundEnabled } from './module-settings';
import { blockedBackgroundModulesByUser } from './access-policy';
import { withTransaction } from './transactions';
import { settingValues } from './settings';

// Snooze (0.24): a message leaves the mail lists until a chosen time, then
// comes back with a notification (F6, kind 'snooze'). It is UniHub's own
// state: nothing changes at the provider, and the message keeps its folder.
// By default the lists and their counts leave out snoozed messages
// (mail-list.ts, mail-folder-view.ts); search still finds them, and the
// Snoozed view lists them. With the user setting snoozed_messages = 'keep'
// (0.25) they stay in every list, marked, and come back the same way. It is
// a view rule: changing it applies at once to every snoozed message.
const MIN_SNOOZE_MS = 60 * 1000;
const MAX_SNOOZE_MS = 366 * 24 * 60 * 60 * 1000;
const RETURN_BATCH = 200;

/** Shown in the lists: not snoozed, or due to come back (the worker returns it within a minute). */
const NOT_SNOOZED_SQL = '(snoozed_until IS NULL OR snoozed_until <= UTC_TIMESTAMP())';
const SNOOZED_SQL = 'snoozed_until > UTC_TIMESTAMP()';

/** Whether the user's lists keep snoozed messages (Settings, Mail: Snoozed messages). */
async function keepsSnoozedInLists(userId: string, executor: SqlExecutor = db) {
  return (await settingValues('user', userId, userId, executor)).snoozed_messages === 'keep';
}

function parseUntil(value: unknown, now = Date.now()) {
  const until = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : null;
  if (!until || Number.isNaN(until.getTime())) throw badRequest('SNOOZE_TIME_INVALID', 'Choose when the message should come back');
  if (until.getTime() < now + MIN_SNOOZE_MS) throw badRequest('SNOOZE_TIME_PAST', 'Choose a time at least a minute from now');
  if (until.getTime() > now + MAX_SNOOZE_MS) throw badRequest('SNOOZE_TIME_FAR', 'Choose a time within a year');
  return until;
}

/** Snoozes one of the user's messages (not a draft) until the given time; snoozing again moves the time. */
async function snoozeEmail(userId: string, emailId: string, input: unknown) {
  const until = parseUntil((input as { until?: unknown } | null)?.until);
  const [result] = await db.execute<ResultSetHeader>(`UPDATE emails SET snoozed_until = ?, snooze_returned_at = NULL
    WHERE id = ? AND user_id = ? AND is_draft = FALSE`, [until, emailId, userId]);
  if (!result.affectedRows) throw notFound('EMAIL_NOT_FOUND', 'Message not found');
  return { id: emailId, snoozed_until: until.toISOString() };
}

/** Brings a snoozed message back at once, without a notification. */
async function unsnoozeEmail(userId: string, emailId: string) {
  const [rows] = await db.execute<RowDataPacket[]>('SELECT id FROM emails WHERE id = ? AND user_id = ? AND is_draft = FALSE', [emailId, userId]);
  if (!rows.length) throw notFound('EMAIL_NOT_FOUND', 'Message not found');
  await db.execute('UPDATE emails SET snoozed_until = NULL WHERE id = ? AND user_id = ?', [emailId, userId]);
  return { id: emailId, snoozed_until: null };
}

// Messages whose time has come, in batches. Each comes back in its own
// transaction together with its notification, so a crash between the two
// neither loses the notification nor repeats it (its key names the return).
// Users whose Mail module is off, paused or being restored wait.
async function returnDueSnoozes(now = new Date()) {
  const blocked = await blockedBackgroundModulesByUser(db);
  const skipped = [...blocked].filter(([, modules]) => modules.has('mail')).map(([userId]) => userId);
  const [due] = await db.execute<RowDataPacket[]>(`SELECT id, user_id FROM emails
    WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?
    ${skipped.length ? `AND user_id NOT IN (${skipped.map(() => '?').join(', ')})` : ''}
    ORDER BY snoozed_until LIMIT ${RETURN_BATCH}`, [now, ...skipped]);
  const { enqueueSnoozeReturn } = require('./notifications') as typeof import('./notifications');
  let returned = 0;
  for (const row of due) {
    if (!await isModuleBackgroundEnabled(row.user_id, 'mail')) continue;
    try {
      await withTransaction(async (connection: SqlExecutor) => {
        const returnedAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
        const [result] = await connection.execute<ResultSetHeader>(`UPDATE emails SET snoozed_until = NULL, snooze_returned_at = ?
          WHERE id = ? AND user_id = ? AND snoozed_until IS NOT NULL AND snoozed_until <= ?`, [returnedAt, row.id, row.user_id, now]);
        if (!result.affectedRows) return;
        returned += 1;
        await enqueueSnoozeReturn({ userId: row.user_id, emailId: row.id, returnedAt: returnedAt.toISOString().replace(/\.\d{3}Z$/, 'Z') }, connection);
      });
    } catch (error) {
      log.error('mail', 'a snoozed message could not come back', error, { userId: row.user_id });
    }
  }
  return { returned };
}

export { snoozeEmail, unsnoozeEmail, returnDueSnoozes, keepsSnoozedInLists, NOT_SNOOZED_SQL, SNOOZED_SQL };
