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
//
// Objects of ICS subscriptions go through the pass as well, on purpose: a
// feed sync stores each object's UID as its ICS has it, like a CalDAV sync
// (calendar-sync.ts storeObject), so it would make the same change itself on
// the next sync of the feed. The feed's rows keep their done state and
// subtasks through the pass and that sync (the bin test covers it).
//
// The work is linear: one read of every object (in pages), then per calendar
// with a change one read of its UIDs through the (calendar_id, href_hash)
// index to decide which keys are shared, and its hand ranks and moves read
// once; every write goes by key (an object by id, its event rows through
// their refs' remote_object_id index, ranks and moves by primary key).
// Everything is decided from that snapshot before anything is written, and
// written in one transaction, so a run after an interrupted one decides
// from the same state.

const EXACT = 'COLLATE utf8mb4_nopad_bin';
const BATCH = 500;
const UID_PAGE = 5000;

interface Change { id: string; userId: string; calendarId: string; trimmed: string; raw: string }

async function adoptRawCalendarUids(connection: PoolConnection) {
  const { objectUid } = require('./calendar-ical') as typeof import('./calendar-ical');
  const { itemKey } = require('./task-order') as typeof import('./task-order');
  const byCalendar = new Map<string, Change[]>();
  for (let after = '';;) {
    const [objects] = await connection.execute<RowDataPacket[]>(
      `SELECT id, user_id, calendar_id, uid, ics FROM calendar_remote_objects WHERE id > ? AND uid IS NOT NULL ORDER BY id LIMIT ${BATCH}`, [after]);
    if (!objects.length) break;
    after = String(objects[objects.length - 1].id);
    for (const object of objects) {
      // As the sync stores it (calendar-sync.ts storeObject).
      const raw = (objectUid(object.ics) || '').slice(0, 500);
      const trimmed = String(object.uid);
      if (!raw || raw === trimmed || raw.trim() !== trimmed) continue;
      const calendarId = String(object.calendar_id);
      const list = byCalendar.get(calendarId) || [];
      list.push({ id: String(object.id), userId: String(object.user_id), calendarId, trimmed, raw });
      byCalendar.set(calendarId, list);
    }
  }
  if (!byCalendar.size) return;
  await connection.beginTransaction();
  try {
    for (const [calendarId, changes] of byCalendar) {
      // How many of the calendar's objects hold each UID that matters here,
      // before any change: a change's own object holds its trimmed UID once.
      const owners = new Map<string, number>(changes.flatMap(change => [[change.trimmed, 0], [change.raw, 0]]));
      for (let after = '';;) {
        const [page] = await connection.execute<RowDataPacket[]>(
          `SELECT href_hash, uid FROM calendar_remote_objects WHERE calendar_id = ? AND href_hash > ? ORDER BY href_hash LIMIT ${UID_PAGE}`, [calendarId, after]);
        if (!page.length) break;
        after = String(page[page.length - 1].href_hash);
        for (const row of page) {
          const uid = row.uid == null ? null : String(row.uid);
          if (uid !== null && owners.has(uid)) owners.set(uid, owners.get(uid)! + 1);
        }
      }
      const shared = (change: Change) => owners.get(change.trimmed)! + (change.raw === change.trimmed ? 0 : owners.get(change.raw)!) > 1;
      // The calendar's hand ranks and moves once, by (person, UID).
      const keyed = (rows: RowDataPacket[], uid: string) => {
        const map = new Map<string, RowDataPacket[]>();
        for (const row of rows) {
          const key = `${row.user_id}\n${row[uid]}`;
          const group = map.get(key);
          if (group) group.push(row); else map.set(key, [row]);
        }
        return map;
      };
      const [rankRows] = await connection.execute<RowDataPacket[]>('SELECT user_id, item_key, remote_uid, recurrence_id FROM task_order WHERE calendar_id = ? AND remote_uid IS NOT NULL', [calendarId]);
      const [moveRows] = await connection.execute<RowDataPacket[]>('SELECT id, user_id, target_uid FROM calendar_event_moves WHERE target_calendar_id = ?', [calendarId]);
      const ranks = keyed(rankRows, 'remote_uid');
      const moves = keyed(moveRows, 'target_uid');
      for (const change of changes) {
        const { id, userId, trimmed, raw } = change;
        await connection.execute(`UPDATE calendar_events e JOIN calendar_event_external_refs r ON r.event_id = e.id AND r.user_id = e.user_id
          SET e.uid = ?, e.updated_at = e.updated_at WHERE r.remote_object_id = ? AND e.user_id = ? AND e.uid ${EXACT} = ?`, [raw, id, userId, trimmed]);
        await connection.execute(`UPDATE calendar_remote_objects SET uid = ?, updated_at = updated_at WHERE id = ? AND uid ${EXACT} = ?`, [raw, id, trimmed]);
        if (shared(change)) continue;
        for (const rank of ranks.get(`${userId}\n${trimmed}`) || []) {
          // A rank the raw UID has already (made after the upgrade) stays; the old one is left beside it.
          await connection.execute('UPDATE IGNORE task_order SET item_key = ?, remote_uid = ?, updated_at = updated_at WHERE user_id = ? AND item_key = ?',
            [itemKey({ calendar_id: calendarId, remote_uid: raw, recurrence_id: rank.recurrence_id }), raw, userId, rank.item_key]);
        }
        if (raw.length > 255) continue;
        for (const move of moves.get(`${userId}\n${trimmed}`) || []) {
          await connection.execute('UPDATE calendar_event_moves SET target_uid = ?, updated_at = updated_at WHERE id = ?', [raw, move.id]);
        }
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  }
}

export { adoptRawCalendarUids };
