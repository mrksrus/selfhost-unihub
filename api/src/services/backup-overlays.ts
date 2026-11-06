// UniHub's state on synced tasks in a backup: ToDo state, done time, source
// email and subtasks, which the provider does not hold (backup-classes.ts).
// A restore applies an overlay to the live task it names, or keeps it in
// calendar_overlay_restores until the sync that brings the task back takes
// it (calendar-sync.ts). A UID overlay waits while its calendar exists; a
// shape overlay (archives before schema 7, matched by title and start)
// expires after OVERLAY_SHAPE_DAYS.
import type { RowDataPacket } from 'mysql2/promise';
import type { BackupRow, SqlExecutor } from '../types';
import { OVERLAY_SHAPE_DAYS } from './backup-classes';
import { normalizeMysqlDateTime } from './backup-common';
import { UID_EXACT, applyOverlaysToLiveRows, insertFailedOverlays, insertOverlays, overlayKeyProblem, overlayPayloadProblem, overlaySqlTime, parseOverlayState } from './calendar-overlays';
import type { FailedOverlay, PendingOverlay } from './calendar-overlays';

const storableTime = (value: unknown) => overlaySqlTime(value) !== null;
/** A failed overlay's payload as JSON text, kept as it was; null when it is not JSON. */
function failedPayload(value: unknown) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? JSON.stringify(value) : null;
  try { JSON.parse(value); return value; } catch { return null; }
}

/**
 * Validation of an archive's overlay rows: each names an archived calendar,
 * has a key its columns hold exactly, and carries a payload as UniHub writes
 * it whose values its tables hold (calendar-overlays.ts overlayPayloadProblem).
 * A value beyond them refuses the restore by name; it is never cut to fit.
 * An overlay the archive holds as failed (set aside on its installation) is
 * kept as it was, so only its key, its JSON and its failure are checked.
 */
function validateOverlayRows(data: Record<string, unknown> | undefined): string[] {
  const rows = data?.calendar_overlay_restores;
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) return ['Backup calendar_overlay_restores must be an array'];
  const calendars = new Set((Array.isArray(data?.calendar_calendars) ? data.calendar_calendars as BackupRow[] : []).map(row => row?.id));
  const errors = new Set<string>();
  for (const row of rows as BackupRow[]) {
    if (!row || typeof row !== 'object' || !calendars.has(row.calendar_id as string)) { errors.add('Backup has a synced-task state that names no calendar of this backup'); continue; }
    const keyed = (row.match_kind === 'uid' ? typeof row.uid === 'string' && row.uid !== ''
        : row.match_kind === 'shape' && typeof row.shape_title === 'string' && storableTime(row.shape_start))
      && (row.recurrence_id == null || typeof row.recurrence_id === 'string')
      && (row.account_identity == null || typeof row.account_identity === 'string')
      && (row.expires_at == null || storableTime(row.expires_at));
    const failed = row.failed_at != null;
    const problem = failed
      ? (storableTime(row.failed_at) && typeof row.failure === 'string' && Array.from(row.failure).length <= 255 && failedPayload(row.payload) !== null ? null : { kind: 'form', problem: '' })
      : overlayPayloadProblem(row.payload);
    const keyProblem = overlayKeyProblem({ uid: row.uid, recurrenceId: row.recurrence_id, accountIdentity: row.account_identity, shapeTitle: row.shape_title });
    if (!keyed || problem?.kind === 'form') errors.add('Backup has a synced-task state in a form UniHub does not write');
    else if (keyProblem || problem) errors.add(`Backup has a synced-task state UniHub cannot store: ${keyProblem ?? problem!.problem}`);
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
 * one that is not the person's own is dropped, its snapshot kept. Overlays
 * the archive holds as failed are kept as failed, as they were, in every
 * mode, and never replace or are replaced by a waiting one.
 */
async function restoreOverlays(connection: SqlExecutor, userId: string, rows: readonly BackupRow[], { calendarIds, emailIds, conflictMode, checkCancelled, now = new Date() }: {
  calendarIds: ReadonlyMap<string, string>; emailIds: ReadonlyMap<string, string>; conflictMode: string; checkCancelled?: () => Promise<unknown>; now?: Date;
}) {
  const result = { applied: 0, waiting: 0, unplaced: 0, failed: 0 };
  const pending: PendingOverlay[] = [];
  const failed: FailedOverlay[] = [];
  const targets = new Set<string>();
  for (const row of rows) {
    if (checkCancelled) await checkCancelled();
    const calendarId = calendarIds.get(String(row.calendar_id));
    const setAside = row.failed_at != null;
    // Validation refused any other payload; a row this restore cannot place is counted for its note, never dropped silently.
    if (!calendarId || (setAside ? failedPayload(row.payload) === null : overlayPayloadProblem(row.payload))) { result.unplaced += 1; continue; }
    const state = setAside ? null : parseOverlayState(row.payload);
    if (!setAside && !state) continue; // nothing UniHub keeps
    // Only a synced calendar receives overlays; the restore never writes one onto a local list.
    const [[calendar]] = await connection.execute<RowDataPacket[]>(`SELECT a.provider FROM calendar_calendars c JOIN calendar_accounts a ON a.id = c.account_id AND a.user_id = c.user_id
      WHERE c.id = ? AND c.user_id = ?`, [calendarId, userId]);
    if (!calendar || calendar.provider === 'local') { result.unplaced += 1; continue; }
    const recurrenceId = String(row.recurrence_id ?? '');
    const shape = row.match_kind === 'shape' ? { title: String(row.shape_title ?? ''), start: String(overlaySqlTime(row.shape_start) ?? '') } : undefined;
    if (setAside) {
      failed.push({ userId, calendarId, uid: String(row.uid ?? ''), recurrenceId, accountIdentity: String(row.account_identity ?? ''), matchKind: shape ? 'shape' : 'uid', shape,
        expiresAt: overlaySqlTime(row.expires_at), payload: failedPayload(row.payload)!, failedAt: overlaySqlTime(row.failed_at)!, failure: String(row.failure) });
      continue;
    }
    if (!state) continue;
    if (conflictMode !== 'replace') {
      const [waiting] = shape
        ? await connection.execute<RowDataPacket[]>(`SELECT id FROM calendar_overlay_restores WHERE user_id = ? AND calendar_id = ? AND match_kind = 'shape' AND shape_title = ? ${UID_EXACT} AND shape_start = ? AND failed_at IS NULL LIMIT 1`,
          [userId, calendarId, shape.title, shape.start])
        : await connection.execute<RowDataPacket[]>(`SELECT id FROM calendar_overlay_restores WHERE user_id = ? AND calendar_id = ? AND match_kind = 'uid' AND uid = ? ${UID_EXACT} AND recurrence_id = ? ${UID_EXACT} AND failed_at IS NULL LIMIT 1`,
          [userId, calendarId, String(row.uid), recurrenceId]);
      if (waiting.length) { targets.add(calendarId); continue; }
    }
    if (state.source_email_id) state.source_email_id = emailIds.get(state.source_email_id) ?? state.source_email_id;
    pending.push({ userId, calendarId, uid: String(row.uid ?? ''), recurrenceId, state, accountIdentity: String(row.account_identity ?? ''), matchKind: shape ? 'shape' : 'uid', shape,
      expiresAt: shape ? overlaySqlTime(row.expires_at) ?? normalizeMysqlDateTime(new Date(now.getTime() + OVERLAY_SHAPE_DAYS * 86400000).toISOString()) : null });
    targets.add(calendarId);
  }
  const stored = await insertOverlays(connection, pending);
  result.unplaced += pending.length - stored;
  result.failed = await insertFailedOverlays(connection, failed);
  result.unplaced += failed.length - result.failed;
  if (!targets.size) return result;
  result.applied = await applyOverlaysToLiveRows(connection, userId, { calendarIds: [...targets], mode: conflictMode === 'replace' ? 'replace' : 'fill' });
  const [[left]] = await connection.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM calendar_overlay_restores WHERE user_id = ? AND failed_at IS NULL AND calendar_id IN (${[...targets].map(() => '?').join(', ')})`,
    [userId, ...targets]);
  result.waiting = Number(left.n) || 0;
  return result;
}

export { validateOverlayRows, restoreOverlays };
