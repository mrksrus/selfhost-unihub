// UniHub's state on synced tasks in a backup: ToDo state, done time, source
// email and subtasks, which the provider does not hold (backup-classes.ts).
// A restore applies an overlay to the live task it names, or keeps it in
// calendar_overlay_restores until the sync that brings the task back takes
// it (calendar-sync.ts). A UID overlay waits while its calendar exists; a
// shape overlay (archives before schema 7, matched by title and start)
// expires after OVERLAY_SHAPE_DAYS.
import type { RowDataPacket } from 'mysql2/promise';
import type { BackupRow, SqlExecutor } from '../types';
import { OVERLAY_SHAPE_DAYS, TODO_STATUSES } from './backup-classes';
import { normalizeMysqlDateTime } from './backup-common';
import { UID_EXACT, applyOverlaysToLiveRows, insertOverlays, parseOverlayState } from './calendar-overlays';
import type { PendingOverlay } from './calendar-overlays';


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

/**
 * Restores the archive's overlays onto the restored synced calendars through
 * the overlay owner (calendar-overlays.ts): each waits in
 * calendar_overlay_restores, and those whose task is here already are
 * applied at once, Replace taking the archive's state and the other modes
 * filling in only what the task has none of (Keep both cannot copy a synced
 * task). Outside Replace, an overlay already waiting for the same item stays.
 * Runs after mail is restored, so a source email follows to its restored id;
 * one that is not the person's own is dropped, its snapshot kept.
 */
async function restoreOverlays(connection: SqlExecutor, userId: string, rows: readonly BackupRow[], { calendarIds, emailIds, conflictMode, checkCancelled, now = new Date() }: {
  calendarIds: ReadonlyMap<string, string>; emailIds: ReadonlyMap<string, string>; conflictMode: string; checkCancelled?: () => Promise<unknown>; now?: Date;
}) {
  const result = { applied: 0, waiting: 0, unplaced: 0 };
  const pending: PendingOverlay[] = [];
  const targets = new Set<string>();
  for (const row of rows) {
    if (checkCancelled) await checkCancelled();
    const calendarId = calendarIds.get(String(row.calendar_id));
    // Validation refused any other payload; a row this restore cannot place is counted for its note, never dropped silently.
    if (!calendarId || !parseOverlayPayload(row.payload)) { result.unplaced += 1; continue; }
    const state = parseOverlayState(row.payload);
    if (!state) continue; // nothing UniHub keeps
    // Only a synced calendar receives overlays; the restore never writes one onto a local list.
    const [[calendar]] = await connection.execute<RowDataPacket[]>(`SELECT a.provider FROM calendar_calendars c JOIN calendar_accounts a ON a.id = c.account_id AND a.user_id = c.user_id
      WHERE c.id = ? AND c.user_id = ?`, [calendarId, userId]);
    if (!calendar || calendar.provider === 'local') { result.unplaced += 1; continue; }
    const recurrenceId = String(row.recurrence_id ?? '');
    const shape = row.match_kind === 'shape' ? { title: String(row.shape_title ?? ''), start: String(normalizeMysqlDateTime(row.shape_start as string) ?? '') } : undefined;
    if (conflictMode !== 'replace') {
      const [waiting] = shape
        ? await connection.execute<RowDataPacket[]>(`SELECT id FROM calendar_overlay_restores WHERE user_id = ? AND calendar_id = ? AND match_kind = 'shape' AND shape_title = ? ${UID_EXACT} AND shape_start = ? LIMIT 1`,
          [userId, calendarId, shape.title, shape.start])
        : await connection.execute<RowDataPacket[]>(`SELECT id FROM calendar_overlay_restores WHERE user_id = ? AND calendar_id = ? AND match_kind = 'uid' AND uid = ? ${UID_EXACT} AND recurrence_id = ? ${UID_EXACT} LIMIT 1`,
          [userId, calendarId, String(row.uid), recurrenceId]);
      if (waiting.length) { targets.add(calendarId); continue; }
    }
    if (state.source_email_id) state.source_email_id = emailIds.get(state.source_email_id) ?? state.source_email_id;
    pending.push({ userId, calendarId, uid: String(row.uid ?? ''), recurrenceId, state, accountIdentity: String(row.account_identity ?? ''), matchKind: shape ? 'shape' : 'uid', shape,
      expiresAt: shape ? normalizeMysqlDateTime(row.expires_at as string | null) ?? normalizeMysqlDateTime(new Date(now.getTime() + OVERLAY_SHAPE_DAYS * 86400000).toISOString()) : null });
    targets.add(calendarId);
  }
  const stored = await insertOverlays(connection, pending);
  result.unplaced += pending.length - stored;
  if (!targets.size) return result;
  result.applied = await applyOverlaysToLiveRows(connection, userId, { calendarIds: [...targets], mode: conflictMode === 'replace' ? 'replace' : 'fill' });
  const [[left]] = await connection.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM calendar_overlay_restores WHERE user_id = ? AND calendar_id IN (${[...targets].map(() => '?').join(', ')})`,
    [userId, ...targets]);
  result.waiting = Number(left.n) || 0;
  return result;
}

export { parseOverlayPayload, validateOverlayRows, restoreOverlays };
export type { OverlayState };
