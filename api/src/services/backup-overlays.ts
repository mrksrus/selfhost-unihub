// UniHub's state on synced tasks in a backup: ToDo state, done time, source
// email and subtasks, which the provider does not hold (backup-classes.ts).
// A restore applies an overlay to the live task it names, or keeps it in
// calendar_overlay_restores until the sync that brings the task back takes
// it (calendar-sync.ts). A UID overlay waits while its calendar exists; a
// shape overlay (archives before schema 7, matched by title and start)
// expires after OVERLAY_SHAPE_DAYS.
import type { RowDataPacket } from 'mysql2/promise';
import type { BackupRow, SqlExecutor } from '../types';
import crypto from 'node:crypto';
import { localEventSql, OVERLAY_SHAPE_DAYS, TODO_STATUSES } from './backup-classes';
import { normalizeMysqlDateTime } from './backup-common';


interface OverlayState {
  todo_status: string | null;
  done_at: string | null;
  source_email_id: string | null;
  source_email_json: string | null;
  subtasks: { title: string; is_done: boolean; position: number }[];
}

// The payload as UniHub wrote it, or null for anything else. A task may
// have any number of subtasks (the app sets no limit); the archive's size
// limit for data/backup.json bounds them.
function parseOverlayPayload(value: unknown): OverlayState | null {
  let raw: unknown = value;
  if (typeof value === 'string') { try { raw = JSON.parse(value); } catch { return null; } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (input.todo_status != null && !TODO_STATUSES.has(String(input.todo_status))) return null;
  if (input.source_email_id != null && !/^[0-9a-f-]{36}$/i.test(String(input.source_email_id))) return null;
  if (input.subtasks !== undefined && !Array.isArray(input.subtasks)) return null;
  let sourceEmail: string | null = null;
  if (input.source_email_json != null) {
    try { sourceEmail = JSON.stringify(typeof input.source_email_json === 'string' ? JSON.parse(input.source_email_json) : input.source_email_json); } catch { return null; }
  }
  const subtasks = ((input.subtasks ?? []) as unknown[]).map((item, index) => {
    const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return { title: String(entry.title ?? '').slice(0, 255), is_done: !!entry.is_done, position: Number.isSafeInteger(entry.position) ? Number(entry.position) : index };
  });
  return { todo_status: input.todo_status == null ? null : String(input.todo_status), done_at: normalizeMysqlDateTime(input.done_at as string | undefined),
    source_email_id: input.source_email_id == null ? null : String(input.source_email_id), source_email_json: sourceEmail, subtasks };
}

/** Validation of an archive's overlay rows: each names an archived calendar and carries a payload UniHub wrote. */
function validateOverlayRows(data: Record<string, unknown> | undefined): string[] {
  const rows = data?.calendar_overlay_restores;
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) return ['Backup calendar_overlay_restores must be an array'];
  const calendars = new Set((Array.isArray(data?.calendar_calendars) ? data.calendar_calendars as BackupRow[] : []).map(row => row?.id));
  const errors = new Set<string>();
  for (const row of rows as BackupRow[]) {
    if (!row || typeof row !== 'object' || !calendars.has(row.calendar_id as string)) { errors.add('Backup has a synced-task state that names no calendar of this backup'); continue; }
    const valid = (row.match_kind === 'uid' ? typeof row.uid === 'string' && row.uid !== '' && row.uid.length <= 500
        : row.match_kind === 'shape' && typeof row.shape_title === 'string' && row.shape_title.length <= 255 && typeof row.shape_start === 'string')
      && (row.recurrence_id == null || (typeof row.recurrence_id === 'string' && row.recurrence_id.length <= 64))
      && parseOverlayPayload(row.payload) !== null;
    if (!valid) errors.add('Backup has a synced-task state in a form UniHub does not write');
  }
  return [...errors];
}

// The live synced task an overlay names, if exactly one.
async function liveTask(connection: SqlExecutor, userId: string, calendarId: string, row: BackupRow, recurrenceId: string) {
  const [rows] = row.match_kind === 'uid'
    ? await connection.execute<RowDataPacket[]>(`SELECT e.id, e.todo_status, e.done_at, e.source_email_id, e.source_email_json FROM calendar_events e
        LEFT JOIN calendar_event_external_refs r ON r.event_id = e.id AND r.user_id = e.user_id
        WHERE e.user_id = ? AND e.calendar_id = ? AND e.uid = ? AND COALESCE(r.recurrence_id, '') = ? AND NOT ${localEventSql('e')} FOR UPDATE`,
    [userId, calendarId, String(row.uid), recurrenceId])
    : await connection.execute<RowDataPacket[]>(`SELECT e.id, e.todo_status, e.done_at, e.source_email_id, e.source_email_json FROM calendar_events e
        WHERE e.user_id = ? AND e.calendar_id = ? AND e.title = ? AND e.start_time = ? AND NOT ${localEventSql('e')} FOR UPDATE`,
    [userId, calendarId, String(row.shape_title), normalizeMysqlDateTime(row.shape_start as string)]);
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Applies the state to a live task: Replace takes the archive's; Keep
 * existing fills in only what the task has none of. Returns whether the
 * archive's source email was taken.
 */
async function applyOverlayState(connection: SqlExecutor, userId: string, task: RowDataPacket, state: OverlayState, replace: boolean) {
  const [[{ n: subtaskCount }]] = await connection.execute<RowDataPacket[]>('SELECT COUNT(*) AS n FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ?', [task.id, userId]);
  const takeState = replace || (task.todo_status == null && task.done_at == null);
  const takeEmail = replace || (task.source_email_id == null && task.source_email_json == null);
  if (takeState || takeEmail) {
    await connection.execute(`UPDATE calendar_events SET ${[takeState ? 'todo_status = ?, done_at = ?' : '', takeEmail ? 'source_email_id = ?, source_email_json = ?' : ''].filter(Boolean).join(', ')}
      WHERE id = ? AND user_id = ?`, [...(takeState ? [state.todo_status, state.done_at] : []), ...(takeEmail ? [state.source_email_id, state.source_email_json] : []), task.id, userId]);
  }
  if (replace || !Number(subtaskCount)) {
    if (replace) await connection.execute('DELETE FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ?', [task.id, userId]);
    for (const subtask of state.subtasks) {
      await connection.execute('INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position) VALUES (?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), task.id, userId, subtask.title, subtask.is_done ? 1 : 0, subtask.position]);
    }
  }
  return takeEmail;
}

/**
 * Restores the archive's overlays onto the restored synced calendars. With
 * a live task of that identity the state is applied now (Keep both cannot
 * copy a synced task, so it keeps the existing one's); otherwise it waits
 * for the sync. A waiting overlay of the same identity is replaced by
 * Replace and kept by the other modes. The result names the tasks and
 * waiting overlays that carry the archive's source email id, which the
 * restore follows to the email's new id once mail is restored.
 */
async function restoreOverlays(connection: SqlExecutor, userId: string, rows: readonly BackupRow[], { calendarIds, conflictMode, checkCancelled, now = new Date() }: {
  calendarIds: ReadonlyMap<string, string>; conflictMode: string; checkCancelled?: () => Promise<unknown>; now?: Date;
}) {
  const result = { applied: 0, waiting: 0, unplaced: 0, sourceEmails: { events: new Map<string, string>(), overlays: new Map<string, string>() } };
  for (const row of rows) {
    if (checkCancelled) await checkCancelled();
    const calendarId = calendarIds.get(String(row.calendar_id));
    const state = parseOverlayPayload(row.payload);
    // Validation refused any other payload; a row this restore cannot place is counted for its note, never dropped silently.
    if (!calendarId || !state) { result.unplaced += 1; continue; }
    // Only a synced calendar receives overlays; the restore never writes one onto a local list.
    const [[calendar]] = await connection.execute<RowDataPacket[]>(`SELECT a.provider FROM calendar_calendars c JOIN calendar_accounts a ON a.id = c.account_id AND a.user_id = c.user_id
      WHERE c.id = ? AND c.user_id = ?`, [calendarId, userId]);
    if (!calendar || calendar.provider === 'local') { result.unplaced += 1; continue; }
    const recurrenceId = String(row.recurrence_id ?? '');
    const task = await liveTask(connection, userId, calendarId, row, recurrenceId);
    if (task) {
      if (await applyOverlayState(connection, userId, task, state, conflictMode === 'replace') && state.source_email_id) result.sourceEmails.events.set(String(task.id), state.source_email_id);
      result.applied += 1;
      continue;
    }
    const sameIdentity = row.match_kind === 'uid'
      ? ['calendar_id = ? AND match_kind = \'uid\' AND uid = ? AND recurrence_id = ?', [calendarId, row.uid, recurrenceId]] as const
      : ['calendar_id = ? AND match_kind = \'shape\' AND shape_title = ? AND shape_start = ?', [calendarId, row.shape_title, normalizeMysqlDateTime(row.shape_start as string)]] as const;
    const [waiting] = await connection.execute<RowDataPacket[]>(`SELECT id FROM calendar_overlay_restores WHERE user_id = ? AND ${sameIdentity[0]}`, [userId, ...sameIdentity[1]] as (string | null)[]);
    if (waiting.length) {
      if (conflictMode !== 'replace') { result.waiting += 1; continue; }
      await connection.execute(`DELETE FROM calendar_overlay_restores WHERE user_id = ? AND ${sameIdentity[0]}`, [userId, ...sameIdentity[1]] as (string | null)[]);
    }
    const expires = row.match_kind === 'shape'
      ? normalizeMysqlDateTime(row.expires_at as string | null) ?? normalizeMysqlDateTime(new Date(now.getTime() + OVERLAY_SHAPE_DAYS * 86400000).toISOString())
      : null;
    const overlayId = crypto.randomUUID();
    if (state.source_email_id) result.sourceEmails.overlays.set(overlayId, state.source_email_id);
    await connection.execute(`INSERT INTO calendar_overlay_restores (id, user_id, calendar_id, account_identity, uid, recurrence_id, match_kind, shape_title, shape_start, payload, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [overlayId, userId, calendarId, String(row.account_identity ?? '').slice(0, 500),
      row.match_kind === 'uid' ? row.uid : null, recurrenceId, row.match_kind, row.match_kind === 'shape' ? row.shape_title : null,
      row.match_kind === 'shape' ? normalizeMysqlDateTime(row.shape_start as string) : null, JSON.stringify(state), expires] as (string | null)[]);
    result.waiting += 1;
  }
  return result;
}

export { parseOverlayPayload, validateOverlayRows, restoreOverlays };
export type { OverlayState };
