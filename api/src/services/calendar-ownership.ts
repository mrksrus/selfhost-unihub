import type { RowDataPacket } from 'mysql2/promise';
import type { AuthRequest, SqlExecutor } from '../types';
import type { CalendarOffer, SharedCalendarSummary } from '../contracts/calendar-shares';
import type { CalendarOwnershipNotice, SharedCalendarRef } from '../contracts/calendar-ownership';

import { db } from '../state';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { log } from '../log';
import { withTransaction } from './transactions';
import { accessLevel, assertReach, grantsOn, setGrant, shareCounts } from './access';
import { membershipOf } from './groups';
import { isModuleEnabled } from './module-settings';
import { lockedRestoreSections } from './restore-locks';
import { recordAudit } from './audit';
import { assertCaller } from './caller-proof';
import { assertMayChangeAdmin } from './invites';
import { movePending } from './calendar-move-state';
import { ensureDefaultLocalCalendarForUser } from './calendar';
import { moveCalendarSettings } from './settings';
import { hintCalendarReach, peopleReaching, summary } from './calendar-shares';

// A calendar's change of owner (F4): an offer the recipient accepts or
// declines, a group manager's hand-over at once, and an administrator's
// hand-over, archive and binning (also the deprovision transfer). Every
// row of a calendar carries its owner's user_id, so a hand-over rewrites
// them in one transaction under the calendar's row lock, which every event
// write takes first (calendar-shares.ts calendarWrite).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEVELS = ['freebusy', 'read', 'contribute', 'edit', 'manage'];
const calendar = (id: string) => ({ kind: 'calendar' as const, id });
const hidden = () => notFound('CALENDAR_NOT_FOUND', 'Calendar not found');
const refused = (message = 'You cannot change this calendar.') => forbidden('CALENDAR_FORBIDDEN', message);
const invalid = (message: string) => badRequest('OFFER_INVALID', message);
const noOffer = () => notFound('OFFER_NOT_FOUND', 'There is no offer for this calendar.');

interface Row { id: string; name: string; userId: string | null; groupId: string | null; local: boolean; archived: boolean; deleted: boolean; offerTo: string | null; offerBy: string | null }

async function lockCalendar(cx: SqlExecutor, calendarId: string): Promise<Row | null> {
  if (!UUID.test(calendarId)) return null;
  const [[row]] = await cx.execute<RowDataPacket[]>(`SELECT c.id, c.name, c.user_id, c.group_id, c.archived_at, c.deleted_at, c.offer_to, c.offer_by,
      (c.user_id IS NULL OR a.provider = 'local') AS local
    FROM calendar_calendars c LEFT JOIN calendar_accounts a ON a.id = c.account_id WHERE c.id = ? FOR UPDATE`, [calendarId]);
  const id = (value: unknown) => value == null ? null : String(value);
  return row ? { id: String(row.id), name: String(row.name), userId: id(row.user_id), groupId: id(row.group_id), local: !!Number(row.local),
    archived: row.archived_at != null, deleted: row.deleted_at != null, offerTo: id(row.offer_to), offerBy: id(row.offer_by) } : null;
}

// A recipient: active, with the Calendar module, not the calendar's owner.
async function assertRecipient(cx: SqlExecutor, row: Row, to: string) {
  const [[person]] = await cx.execute<RowDataPacket[]>('SELECT id FROM users WHERE id = ? AND is_active = TRUE', [to]);
  if (!person) throw invalid('A calendar goes to an active person.');
  if (to === row.userId) throw invalid('This person owns the calendar already.');
  if (!await isModuleEnabled(to, 'calendar', cx)) throw invalid('This person does not use Calendar.');
}

const roleOf = async (cx: SqlExecutor, userId: string) =>
  String((await cx.execute<RowDataPacket[]>('SELECT role FROM users WHERE id = ?', [userId]))[0][0]?.role ?? '');

/**
 * A group manager's right to hand `row` to `to`: a group they manage holds
 * read or more on it and `to` is a member, and the owner is no administrator.
 */
async function managerMay(cx: SqlExecutor, managerId: string, row: Row, to: string) {
  if (!row.userId || ['owner', 'admin'].includes(await roleOf(cx, row.userId))) return false;
  for (const { principal, permission } of await grantsOn(calendar(row.id), cx)) {
    if (principal.kind !== 'group' || LEVELS.indexOf(permission) < LEVELS.indexOf('read')) continue;
    if (await membershipOf(principal.id, managerId, cx) === 'manager' && await membershipOf(principal.id, to, cx)) return true;
  }
  return false;
}

// The offerer's right to offer to `to`, asked again at an accept.
async function assertOfferer(cx: SqlExecutor, offererId: string, row: Row, to: string) {
  if (offererId === row.userId) return assertReach(cx, offererId, { kind: 'user', id: to }, 'calendars.manage');
  if (!await managerMay(cx, offererId, row, to)) throw forbidden('SHARE_OUT_OF_REACH', 'This calendar is not shared with a group of yours that the person is in.');
}

async function assertNoRestore(cx: SqlExecutor, person: string | null) {
  if (person && (await lockedRestoreSections(person, cx)).has('calendar')) throw conflict('RESTORE_IN_PROGRESS', 'Restore in progress for calendar. Try again when it has finished.');
}

/**
 * Moves the calendar and every row that carries its owner to `to` (null:
 * the organisation), under the calendar's lock. The new owner's share goes,
 * the old owner keeps edit and the events' reminders as their own, and the
 * pending offer ends.
 */
async function handOver(cx: SqlExecutor, row: Row, to: string | null, actorId: string, accountId: string | null) {
  for (const person of [row.userId, to]) await assertNoRestore(cx, person);
  const [moving] = await cx.execute<RowDataPacket[]>('SELECT 1 FROM calendar_event_moves WHERE source_calendar_id = ? OR target_calendar_id = ? LIMIT 1', [row.id, row.id]);
  if (moving.length) throw movePending();
  const from = row.userId;
  await cx.execute(`UPDATE calendar_calendars SET user_id = ?, account_id = ?, external_id = NULL, group_id = NULL, is_primary = FALSE, offer_to = NULL, offer_by = NULL
    WHERE id = ?`, [to, accountId, row.id]);
  if (from) {
    // A person's own row wins over the event's, so their own reminders are kept.
    await cx.execute(`INSERT INTO calendar_reminders (id, user_id, event_id, reminders)
      SELECT UUID(), ?, e.id, IF(JSON_LENGTH(e.reminders) > 0, e.reminders, JSON_ARRAY(e.reminder_minutes)) FROM calendar_events e
      WHERE e.calendar_id = ? AND (JSON_LENGTH(e.reminders) > 0 OR e.reminder_minutes IS NOT NULL)
      ON DUPLICATE KEY UPDATE reminders = calendar_reminders.reminders`, [from, row.id]);
  }
  await cx.execute('UPDATE calendar_event_subtasks s JOIN calendar_events e ON e.id = s.event_id SET s.user_id = ? WHERE e.calendar_id = ?', [to, row.id]);
  await cx.execute('UPDATE calendar_event_attendees t JOIN calendar_events e ON e.id = t.event_id SET t.user_id = ? WHERE e.calendar_id = ?', [to, row.id]);
  await cx.execute('UPDATE calendar_events SET user_id = ? WHERE calendar_id = ?', [to, row.id]);
  await cx.execute('UPDATE bin_items SET user_id = ? WHERE calendar_id = ?', [to, row.id]);
  await moveCalendarSettings(cx, row.id, to);
  if (to) await setGrant(cx, calendar(row.id), { kind: 'user', id: to }, null, actorId);
  if (from) await setGrant(cx, calendar(row.id), { kind: 'user', id: from }, 'edit', actorId);
  await cx.execute('UPDATE notification_config SET reminder_revision = reminder_revision + 1 WHERE id = 1');
}

// The recipient's local account, made when they have none yet.
const localAccount = async (to: string | null) => to ? (await ensureDefaultLocalCalendarForUser(to)).accountId : null;

/** After the change committed: the notice, when someone else acted on the person's calendar. Failures only lose the notice. */
async function tell(userId: string | null, actorId: string, calendarId: string, notice: CalendarOwnershipNotice, otherId: string | null) {
  if (!userId || userId === actorId) return;
  try {
    const { enqueueFromSource } = require('./notifications') as typeof import('./notifications');
    await withTransaction(cx => enqueueFromSource({ kind: 'calendar-ownership', userId, sourceId: calendarId, url: '/calendar',
      dedupeKey: `calendar-ownership:${calendarId}:${notice}:${Date.now()}`, data: { notice, otherId } }, cx));
  } catch (error) {
    log.error('calendar', 'Calendar ownership notice failed', error);
  }
}

async function offerOf(row: { offerTo: string | null; offerBy: string | null }): Promise<CalendarOffer | null> {
  if (!row.offerTo) return null;
  const person = async (id: string) => {
    const [[user]] = await db.execute<RowDataPacket[]>('SELECT id, full_name, email FROM users WHERE id = ?', [id]);
    return user ? { id: String(user.id), full_name: user.full_name ?? null, email: String(user.email) } : null;
  };
  return { to: (await person(row.offerTo))!, by: row.offerBy ? await person(row.offerBy) : null };
}

function input(body: unknown) {
  const { to, now } = (body && typeof body === 'object' ? body : {}) as { to?: unknown; now?: unknown };
  if (typeof to !== 'string' || !UUID.test(to) || (now !== undefined && typeof now !== 'boolean')) throw invalid('Expected { to: a person\'s id, now?: boolean }.');
  return { to: to.toLowerCase(), now: now === true };
}

/**
 * POST /api/calendar/calendars/:id/hand-over: the owner offers their
 * calendar; a manager of a group holding read or more on it offers it, or
 * with `now` hands it over at once, to a member of that group.
 */
async function offerCalendar(userId: string, calendarId: string, body: unknown, req: AuthRequest | null = null): Promise<CalendarOffer | null> {
  const { to, now } = input(body);
  const accountId = now ? await localAccount(to) : null;
  const before = await peopleReaching(calendarId).catch(() => []);
  const row = await withTransaction(async cx => {
    const row = await lockCalendar(cx, calendarId);
    const level = row && !row.deleted ? await accessLevel(userId, calendar(row.id), cx) : null;
    if (!row || !level) throw hidden();
    if (!row.userId || !row.local || row.archived) throw refused();
    await assertRecipient(cx, row, to);
    if (!now && row.offerTo && row.offerTo !== to) throw conflict('OFFER_PENDING', 'Another offer for this calendar is pending. Withdraw it first.');
    const owner = row.userId === userId && !now;
    if (!owner && !await managerMay(cx, userId, row, to)) throw refused(now ? "Only a manager of a group the calendar is shared with hands it over at once." : undefined);
    if (owner) await assertReach(cx, userId, { kind: 'user', id: to }, 'calendars.manage');
    if (now) {
      await handOver(cx, row, to, userId, accountId);
      await recordAudit({ action: 'calendar.handed_over', actorId: userId, targetUserId: row.userId, req, details: { calendar: row.id, to } }, cx);
      return row;
    }
    await cx.execute('UPDATE calendar_calendars SET offer_to = ?, offer_by = ? WHERE id = ?', [to, userId, row.id]);
    return row;
  });
  if (now) {
    await hintCalendarReach(row.id, [...before, to]);
    await tell(row.userId, userId, row.id, 'handed_over', to);
    return null;
  }
  await hintCalendarReach(row.id, [to]);
  await tell(to, userId, row.id, 'offered', userId);
  return offerOf({ offerTo: to, offerBy: userId });
}

/** POST /api/calendar/calendars/:id/hand-over/accept: the recipient takes the calendar; the offerer's reach, the recipient's activity and module are asked again. */
async function acceptOffer(userId: string, calendarId: string): Promise<{ calendar_id: string }> {
  const accountId = await localAccount(userId);
  const before = await peopleReaching(calendarId).catch(() => []);
  const row = await withTransaction(async cx => {
    const row = await lockCalendar(cx, calendarId);
    if (!row || row.deleted || row.offerTo !== userId || !row.userId) throw noOffer();
    if (row.archived) throw refused();
    await assertRecipient(cx, row, userId);
    await assertOfferer(cx, row.offerBy ?? row.userId, row, userId);
    await handOver(cx, row, userId, userId, accountId);
    return row;
  });
  await hintCalendarReach(row.id, before);
  await tell(row.userId, userId, row.id, 'handed_over', userId);
  return { calendar_id: row.id };
}

/** DELETE /api/calendar/calendars/:id/hand-over: the owner or the offerer withdraws, the recipient declines. */
async function withdrawOffer(userId: string, calendarId: string): Promise<{ withdrawn: true }> {
  const row = await withTransaction(async cx => {
    const row = await lockCalendar(cx, calendarId);
    if (!row?.offerTo || ![row.userId, row.offerTo, row.offerBy].includes(userId)) throw noOffer();
    await cx.execute('UPDATE calendar_calendars SET offer_to = NULL, offer_by = NULL WHERE id = ?', [row.id]);
    return row;
  });
  await hintCalendarReach(row.id, [row.offerTo!, row.offerBy ?? '']);
  return { withdrawn: true };
}

// --- Administrators --------------------------------------------------------------

/**
 * The calendar an administrator acts on: on Server › Calendars (no person's,
 * or a person's shared with someone) and, when it is an administrator's,
 * only for the installation owner.
 */
async function adminCalendar(cx: SqlExecutor, adminId: string, calendarId: string) {
  await assertCaller(cx);
  const row = await lockCalendar(cx, calendarId);
  if (!row || row.deleted || !row.local) throw hidden();
  if (row.userId && !(await shareCounts('calendar', [row.id], cx)).get(row.id)) throw hidden();
  if (row.userId) await assertMayChangeAdmin(cx, row.userId, adminId);
  return row;
}

/**
 * POST /api/admin/calendars/:id/hand-over (calendars.manage, after the
 * route checked the password): at once to a person, to the organisation,
 * or with its events into its owner's bin.
 */
async function adminHandOver(adminId: string, calendarId: string, body: unknown, req: AuthRequest | null = null): Promise<SharedCalendarSummary | null> {
  const { to } = (body && typeof body === 'object' ? body : {}) as { to?: unknown };
  if (to !== 'organisation' && to !== 'bin' && (typeof to !== 'string' || !UUID.test(to))) throw invalid('Expected { to: a person\'s id, "organisation" or "bin" }.');
  const target = to === 'organisation' || to === 'bin' ? null : to.toLowerCase();
  const accountId = await localAccount(target);
  const before = await peopleReaching(calendarId).catch(() => []);
  const row = await withTransaction(async cx => {
    const row = await adminCalendar(cx, adminId, calendarId);
    if (to === 'bin') {
      if (!row.userId) throw invalid('A calendar no person owns is deleted with Delete.');
      await assertNoRestore(cx, row.userId);
      return row;
    }
    if (target) await assertRecipient(cx, row, target);
    else if (!row.userId && !row.groupId) throw invalid('This is an organisation calendar already.');
    await handOver(cx, row, target, adminId, accountId);
    await recordAudit({ action: 'admin.calendar_handed_over', actorId: adminId, targetUserId: row.userId, req, details: { calendar: row.id, to: target ?? 'organisation' } }, cx);
    return row;
  });
  if (to === 'bin') {
    const { deleteCalendarToBin } = require('./bin-calendar') as typeof import('./bin-calendar');
    await deleteCalendarToBin(row.userId!, row.id);
    await recordAudit({ action: 'admin.calendar_binned', actorId: adminId, targetUserId: row.userId, req, details: { calendar: row.id } })
      .catch(error => log.error('AUDIT', 'Could not record an audit entry', error));
    await hintCalendarReach(row.id, before);
    return null;
  }
  await hintCalendarReach(row.id, [...before, target ?? '']);
  await tell(row.userId, adminId, row.id, 'handed_over', target);
  return summary(row.id);
}

/** PUT /api/admin/calendars/:id/archive (calendars.manage, after the password): read-only for everyone, or writable again; a pending offer ends. */
async function archiveCalendar(adminId: string, calendarId: string, body: unknown, req: AuthRequest | null = null): Promise<SharedCalendarSummary> {
  const { archived } = (body && typeof body === 'object' ? body : {}) as { archived?: unknown };
  if (typeof archived !== 'boolean') throw badRequest('INVALID_INPUT', 'Expected { archived: boolean }.');
  const row = await withTransaction(async cx => {
    const row = await adminCalendar(cx, adminId, calendarId);
    if (row.archived === archived) return row;
    await cx.execute('UPDATE calendar_calendars SET archived_at = IF(?, UTC_TIMESTAMP(), NULL), offer_to = NULL, offer_by = NULL WHERE id = ?', [archived, row.id]);
    await recordAudit({ action: archived ? 'admin.calendar_archived' : 'admin.calendar_unarchived', actorId: adminId, targetUserId: row.userId, req, details: { calendar: row.id } }, cx);
    return row;
  });
  if (row.archived !== archived) {
    await hintCalendarReach(row.id, [row.offerTo ?? '']);
    if (archived) await tell(row.userId, adminId, row.id, 'archived', adminId);
  }
  return summary(row.id);
}

// --- Deprovision -----------------------------------------------------------------

/** A person's calendars shared with someone, for the choice per calendar before Deactivate or Delete. */
async function sharedCalendarsOf(userId: string): Promise<SharedCalendarRef[]> {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT c.id, c.name, (SELECT COUNT(*) FROM calendar_events e WHERE e.calendar_id = c.id) AS event_count
    FROM calendar_calendars c WHERE c.user_id = ? ORDER BY c.name, c.id`, [userId]);
  const counts = await shareCounts('calendar', rows.map(row => String(row.id)));
  return rows.filter(row => counts.get(String(row.id))).map(row => ({
    id: String(row.id), name: String(row.name), share_count: counts.get(String(row.id))!, event_count: Number(row.event_count),
  }));
}

/** In the transaction that deactivates a person: the offers to them, by them and of their calendars end. */
async function withdrawOffersOf(cx: SqlExecutor, userId: string) {
  await cx.execute(`UPDATE calendar_calendars SET offer_to = NULL, offer_by = NULL
    WHERE offer_to IS NOT NULL AND (offer_to = ? OR offer_by = ? OR user_id = ?)`, [userId, userId, userId]);
}

/** The calendar-ownership notice as its recipient sees it now: an offer still pending to them, an archive still in place. */
async function ownershipNotice(userId: string, calendarId: string, connection: SqlExecutor, payload: Record<string, unknown>) {
  const [[row]] = await connection.execute<RowDataPacket[]>(`SELECT c.name, c.offer_to, c.archived_at, COALESCE(u.full_name, u.email) AS other
    FROM calendar_calendars c LEFT JOIN users u ON u.id = ? WHERE c.id = ?`, [typeof payload.otherId === 'string' ? payload.otherId : null, calendarId]);
  const notice = String(payload.notice) as CalendarOwnershipNotice;
  if (!row || (notice === 'offered' && row.offer_to !== userId) || (notice === 'archived' && row.archived_at == null)) return null;
  return { calendar_id: calendarId, name: String(row.name), other: row.other == null ? 'the organisation' : String(row.other), notice };
}

export { offerCalendar, acceptOffer, withdrawOffer, adminHandOver, archiveCalendar, sharedCalendarsOf, withdrawOffersOf, ownershipNotice };
