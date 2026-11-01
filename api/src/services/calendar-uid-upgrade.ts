import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

// Upgrade step 25: the UIDs 0.27 kept trimmed take the calendar server's own.
//
// 0.27 stored a synced object's UID with its surrounding spaces cut
// (calendar_remote_objects.uid, and from it task_order.remote_uid and the
// move journal's target_uid; step 25 copies it into calendar_events.uid).
// 0.28 keeps a UID byte for byte (calendar-ical.ts rawUid) and compares it
// exactly, so an object whose ICS says "foo " would no longer match the rows
// keyed by "foo": a bin restore would leave its state in a pending overlay,
// and its hand rank would no longer show. The object's own ICS is the
// provenance: its record and its event rows take the raw UID. What is keyed
// by (calendar, UID) instead, the hand order and open moves, moves only when
// no other object of the calendar has the trimmed or the raw UID; where two
// items could own the key, it stays as it is. Overlays and bin items are new
// in this step, so none exist yet.

const EXACT = 'COLLATE utf8mb4_nopad_bin';
const BATCH = 500;

interface Change { id: string; userId: string; calendarId: string; trimmed: string; raw: string }

async function adoptRawCalendarUids(connection: PoolConnection) {
  const { objectUid } = require('./calendar-ical') as typeof import('./calendar-ical');
  const { itemKey } = require('./task-order') as typeof import('./task-order');
  const changes: Change[] = [];
  for (let after = '';;) {
    const [objects] = await connection.execute<RowDataPacket[]>(
      `SELECT id, user_id, calendar_id, uid, ics FROM calendar_remote_objects WHERE id > ? AND uid IS NOT NULL ORDER BY id LIMIT ${BATCH}`, [after]);
    if (!objects.length) break;
    after = String(objects[objects.length - 1].id);
    for (const object of objects) {
      // As the sync stores it (calendar-sync.ts storeObject).
      const raw = (objectUid(object.ics) || '').slice(0, 500);
      const trimmed = String(object.uid);
      if (raw && raw !== trimmed && raw.trim() === trimmed) changes.push({ id: String(object.id), userId: String(object.user_id), calendarId: String(object.calendar_id), trimmed, raw });
    }
  }
  if (!changes.length) return;
  // All at once, so a run after an interrupted one decides from the same state.
  await connection.beginTransaction();
  try {
    const shared = new Set<string>();
    for (const change of changes) {
      const [[other]] = await connection.execute<RowDataPacket[]>(
        `SELECT id FROM calendar_remote_objects WHERE calendar_id = ? AND id <> ? AND (uid ${EXACT} = ? OR uid ${EXACT} = ?) LIMIT 1`,
        [change.calendarId, change.id, change.trimmed, change.raw]);
      if (other) shared.add(change.id);
    }
    for (const change of changes) {
      const { id, userId, calendarId, trimmed, raw } = change;
      await connection.execute(`UPDATE calendar_events e JOIN calendar_event_external_refs r ON r.event_id = e.id AND r.user_id = e.user_id
        SET e.uid = ?, e.updated_at = e.updated_at WHERE r.remote_object_id = ? AND e.user_id = ? AND e.uid ${EXACT} = ?`, [raw, id, userId, trimmed]);
      await connection.execute(`UPDATE calendar_remote_objects SET uid = ?, updated_at = updated_at WHERE id = ? AND uid ${EXACT} = ?`, [raw, id, trimmed]);
      if (shared.has(id)) continue;
      const [ranks] = await connection.execute<RowDataPacket[]>(
        `SELECT item_key, recurrence_id FROM task_order WHERE user_id = ? AND calendar_id = ? AND remote_uid ${EXACT} = ?`, [userId, calendarId, trimmed]);
      for (const rank of ranks) {
        // A rank the raw UID has already (made after the upgrade) stays; the old one is left beside it.
        await connection.execute('UPDATE IGNORE task_order SET item_key = ?, remote_uid = ?, updated_at = updated_at WHERE user_id = ? AND item_key = ?',
          [itemKey({ calendar_id: calendarId, remote_uid: raw, recurrence_id: rank.recurrence_id }), raw, userId, rank.item_key]);
      }
      if (raw.length <= 255) {
        await connection.execute(`UPDATE calendar_event_moves SET target_uid = ?, updated_at = updated_at WHERE user_id = ? AND target_calendar_id = ? AND target_uid ${EXACT} = ?`,
          [raw, userId, calendarId, trimmed]);
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  }
}

export { adoptRawCalendarUids };
