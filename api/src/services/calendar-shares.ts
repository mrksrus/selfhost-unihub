import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { CalendarAccessFields, CalendarPermission, CalendarShare, CalendarView, CalendarShareCandidatesResponse, PersonRef, SharedCalendarSummary } from '../contracts/calendar-shares';
import type { CalendarEvent } from '../types/calendar';
import type { Principal } from '../contracts/organisation';

import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, forbidden, notFound } from '../http/errors';
import { can as roleCan } from '../security/permissions';
import { withTransaction } from './transactions';
import { accessLevel, assertCan, assertReach, lockGrant, namedGrants, reachCandidates, setGrant, shareCounts, visible } from './access';
import { presentEvents, seriesKeySql } from './calendar';
import { sourceEmailPresentSql } from './email-tasks';
import { groupExists, groupNames, membershipOf } from './groups';

// Shared, group and organisation calendars (F4): shares at five levels, a
// person's own view of a calendar they reach, and the calendars no person
// owns. Who may do what is the access service's answer, asked before a
// change and again inside its transaction after the calendar's row is
// locked. A calendar synced from a provider is never shared. The events stay
// in the calendar tables; a calendar no person owns has rows without user_id.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
const LEVELS: readonly CalendarPermission[] = ['freebusy', 'read', 'contribute', 'edit', 'manage'];

const calendar = (id: string) => ({ kind: 'calendar' as const, id });
const iso = (value: unknown) => value == null ? null : (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString();

/** 404 for an id that is no calendar the person can see, 403 for less than `permission`; answers their level. */
async function assertCalendar(userId: string, calendarId: string, permission: CalendarPermission, executor: SqlExecutor = db): Promise<CalendarPermission> {
  if (!UUID.test(calendarId)) throw notFound('CALENDAR_NOT_FOUND', 'Calendar not found');
  return assertCan(userId, calendar(calendarId), permission, executor);
}

async function calendarRow(calendarId: string, executor: SqlExecutor) {
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT c.user_id, c.group_id, (c.user_id IS NULL OR a.provider = 'local') AS shareable
    FROM calendar_calendars c LEFT JOIN calendar_accounts a ON a.id = c.account_id WHERE c.id = ?`, [calendarId]);
  return { userId: row.user_id == null ? null : String(row.user_id), groupId: row.group_id == null ? null : String(row.group_id), shareable: !!Number(row.shareable) };
}

// The manager's check for the share routes: a synced calendar is shared at its provider.
async function assertShareable(userId: string, calendarId: string, executor: SqlExecutor = db) {
  await assertCalendar(userId, calendarId, 'manage', executor);
  const row = await calendarRow(calendarId, executor);
  if (!row.shareable) throw badRequest('CALENDAR_NOT_SHAREABLE', 'A calendar synced from a provider is shared at that provider.');
  return row;
}

// --- Shares ----------------------------------------------------------------------

/** GET /api/calendar/calendars/:id/shares (manage). */
async function calendarShares(userId: string, calendarId: string, executor: SqlExecutor = db): Promise<CalendarShare[]> {
  await assertShareable(userId, calendarId, executor);
  return (await namedGrants(calendar(calendarId), executor)).map(share => ({ ...share, permission: share.permission as CalendarPermission }));
}

function shareInput(input: unknown): { principal: Principal; permission: CalendarPermission | null } {
  const body = (input && typeof input === 'object' ? input : {}) as { principal?: { kind?: unknown; id?: unknown }; permission?: unknown };
  const { kind, id } = body.principal && typeof body.principal === 'object' ? body.principal : { kind: undefined, id: undefined };
  const permission = body.permission === null ? null : LEVELS.includes(body.permission as CalendarPermission) ? body.permission as CalendarPermission : undefined;
  if (permission === undefined) throw badRequest('SHARE_INVALID', 'A share is freebusy, read, contribute, edit, manage or null to remove it.');
  if (kind === 'everyone') return { principal: { kind }, permission };
  if ((kind === 'user' || kind === 'group') && typeof id === 'string' && UUID.test(id)) return { principal: { kind, id: id.toLowerCase() }, permission };
  throw badRequest('SHARE_INVALID', 'Expected { principal: { kind: user | group | everyone, id }, permission }.');
}

/** PUT /api/calendar/calendars/:id/shares (manage): gives, changes or removes one share; giving or raising one is checked against the caller's reach. */
async function setCalendarShare(userId: string, calendarId: string, input: unknown): Promise<CalendarShare[]> {
  const { principal, permission } = shareInput(input);
  await assertShareable(userId, calendarId);
  return withTransaction(async cx => {
    await cx.execute('SELECT id FROM calendar_calendars WHERE id = ? FOR UPDATE', [calendarId]);
    const row = await assertShareable(userId, calendarId, cx);
    if (principal.kind === 'user' && principal.id === row.userId) throw badRequest('SHARE_IS_OWNER', 'The owner manages their calendar; that stays as it is.');
    const current = await lockGrant(cx, calendar(calendarId), principal);
    const raised = permission !== null && (current === null || LEVELS.indexOf(permission) > LEVELS.indexOf(current as CalendarPermission));
    if (raised) await assertReach(cx, userId, principal, 'calendars.manage');
    if (current !== permission) await setGrant(cx, calendar(calendarId), principal, permission, userId);
    return calendarShares(userId, calendarId, cx);
  });
}

/** GET /api/calendar/calendars/:id/share-candidates?q= (manage): people and groups within the caller's reach. */
async function calendarShareCandidates(userId: string, calendarId: string, query: string): Promise<CalendarShareCandidatesResponse> {
  await assertShareable(userId, calendarId);
  return reachCandidates(userId, query, 'calendars.manage');
}

// --- A person's view -------------------------------------------------------------

/**
 * The person's own view of each calendar: an owner's on/off and colour are
 * the calendar row's, anyone else's their stored view or the defaults.
 */
async function viewsOf(userId: string, calendars: readonly { id: string; user_id: string | null; is_visible: unknown; color: string | null }[], executor: SqlExecutor = db) {
  const ids = calendars.map(row => row.id);
  const [rows] = ids.length ? await executor.execute<RowDataPacket[]>(`SELECT calendar_id, is_visible, color, notify_changes FROM calendar_views
    WHERE user_id = ? AND calendar_id IN (${ids.map(() => '?').join(', ')})`, [userId, ...ids]) : [[]];
  const stored = new Map(rows.map(row => [String(row.calendar_id), row]));
  return new Map(calendars.map(row => {
    const view = stored.get(row.id);
    const own = row.user_id === userId;
    return [row.id, {
      is_visible: own ? !!Number(row.is_visible) : view ? !!Number(view.is_visible) : true,
      color: (!own && view?.color) || row.color || '#2563eb',
      notify_changes: !!Number(view?.notify_changes ?? 0),
    } satisfies CalendarView];
  }));
}

/** The person's view of each of these calendars. */
async function viewsOfCalendars(userId: string, ids: readonly string[], executor: SqlExecutor = db) {
  const [rows] = ids.length ? await executor.execute<RowDataPacket[]>(`SELECT id, user_id, is_visible, color FROM calendar_calendars
    WHERE id IN (${ids.map(() => '?').join(', ')})`, [...ids]) : [[]];
  return viewsOf(userId, rows.map(row => ({ id: String(row.id), user_id: row.user_id ?? null, is_visible: row.is_visible, color: row.color })), executor);
}

/** PUT /api/calendar/calendars/:id/view (any level): the caller's on/off, colour and change notifications; an owner's on/off and colour stay the calendar's. */
async function setCalendarView(userId: string, calendarId: string, input: unknown): Promise<CalendarView> {
  const body = (input && typeof input === 'object' ? input : {}) as { is_visible?: unknown; color?: unknown; notify_changes?: unknown };
  const flag = (value: unknown) => value === undefined ? undefined : typeof value === 'boolean' ? value : null;
  const [visible, notify] = [flag(body.is_visible), flag(body.notify_changes)];
  if (visible === null || notify === null || (body.color !== undefined && body.color !== null && (typeof body.color !== 'string' || !COLOR.test(body.color)))) {
    throw badRequest('INVALID_INPUT', 'Expected { is_visible?: boolean, color?: "#rrggbb" | null, notify_changes?: boolean }.');
  }
  await assertCalendar(userId, calendarId, 'freebusy');
  const row = await calendarRow(calendarId, db);
  const own = row.userId === userId;
  if (own && (visible !== undefined || body.color !== undefined)) {
    throw badRequest('INVALID_INPUT', "Change your own calendar's colour and visibility in its settings.");
  }
  const color = body.color === undefined ? undefined : (body.color as string | null);
  await db.execute(`INSERT INTO calendar_views (calendar_id, user_id, is_visible, color, notify_changes) VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE is_visible = IF(?, VALUES(is_visible), is_visible), color = IF(?, VALUES(color), color), notify_changes = IF(?, VALUES(notify_changes), notify_changes)`,
  [calendarId, userId, visible ?? true, color ?? null, notify ?? false, visible !== undefined, color !== undefined, notify !== undefined]);
  // Reminders follow what a person has on.
  if (visible !== undefined) await db.execute('UPDATE notification_config SET reminder_revision = reminder_revision + 1 WHERE id = 1');
  return (await viewsOfCalendars(userId, [calendarId])).get(calendarId)!;
}

// --- Reading ----------------------------------------------------------------------

/** The calendars beyond the person's own that they reach, with their level. */
async function reachedCalendars(userId: string, executor: SqlExecutor = db): Promise<Map<string, CalendarPermission>> {
  const levels = new Map<string, CalendarPermission>();
  for (const id of await visible(userId, 'calendar', executor)) {
    const level = await accessLevel(userId, calendar(id), executor);
    if (level) levels.set(id, level);
  }
  return levels;
}

async function people(ids: readonly (string | null)[], executor: SqlExecutor = db): Promise<Map<string, PersonRef>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  const [rows] = wanted.length ? await executor.execute<RowDataPacket[]>(`SELECT id, full_name, email FROM users WHERE id IN (${wanted.map(() => '?').join(', ')})`, wanted) : [[]];
  return new Map(rows.map(row => [String(row.id), { id: String(row.id), full_name: row.full_name ?? null, email: String(row.email) }]));
}

/**
 * GET /api/calendar/calendars: the caller's own calendar rows and those
 * others share with them (c.* with the account's provider), each with what
 * the caller may do and their view of it.
 */
async function calendarsWithAccess(userId: string, own: readonly RowDataPacket[]) {
  const levels = await reachedCalendars(userId);
  const ids = [...levels.keys()];
  const [reached] = ids.length ? await db.execute<RowDataPacket[]>(`SELECT c.*, a.provider FROM calendar_calendars c LEFT JOIN calendar_accounts a ON a.id = c.account_id
    WHERE c.id IN (${ids.map(() => '?').join(', ')}) ORDER BY c.name, c.id`, ids) : [[]];
  const rows = [...own, ...reached];
  const persons = await people(rows.flatMap(row => [row.user_id, row.offer_to, row.offer_by]));
  const groups = await groupNames(rows.flatMap(row => row.group_id == null ? [] : [String(row.group_id)]));
  const views = await viewsOf(userId, rows.map(row => ({ id: String(row.id), user_id: row.user_id ?? null, is_visible: row.is_visible, color: row.color })));
  return rows.map(row => {
    const mine = row.user_id === userId;
    const offer = row.offer_to != null && [row.user_id, row.offer_to, row.offer_by].includes(userId)
      ? { to: persons.get(String(row.offer_to))!, by: row.offer_by == null ? null : persons.get(String(row.offer_by)) ?? null } : null;
    const access: CalendarAccessFields = {
      permission: mine ? (row.archived_at ? 'read' : 'manage') : levels.get(String(row.id))!,
      owner_kind: row.user_id != null ? 'user' : row.group_id != null ? 'group' : 'organisation',
      owner: mine || row.user_id == null ? null : persons.get(String(row.user_id)) ?? null,
      group: row.group_id == null ? null : { id: String(row.group_id), name: groups.get(String(row.group_id)) ?? '' },
      archived: row.archived_at != null, view: views.get(String(row.id))!, offer,
    };
    return { row, mine, access };
  });
}

const BUSY_KEEP = new Set(['id', 'calendar_id', 'start_time', 'end_time', 'all_day', 'color']);
/** What a free/busy holder sees of an event: its times as "Busy", every other field empty. */
function busy<T extends object>(event: T): T {
  return Object.fromEntries(Object.entries(event).map(([key, value]) => [key,
    key === 'title' ? 'Busy' : BUSY_KEEP.has(key) ? value : Array.isArray(value) ? [] : typeof value === 'boolean' ? false : null])) as T;
}

/** Events of calendars others share with the person, at their level: free/busy ones redacted and without tasks that have no date. */
async function presentReached(userId: string, rows: readonly CalendarEvent[], levels: ReadonlyMap<string, CalendarPermission>) {
  const shown = rows.filter(row => !(levels.get(String(row.calendar_id)) === 'freebusy' && row.is_todo_only));
  return (await presentEvents(userId, shown)).map(event => levels.get(String(event.calendar_id)) === 'freebusy' ? busy(event) : event);
}

/** GET /api/calendar/events/:id of an event in a calendar another person or nobody owns; null when the person cannot read it. */
async function reachedEvent(userId: string, eventId: string) {
  const [[row]] = await db.execute<(RowDataPacket & CalendarEvent)[]>(`SELECT e.*, ${sourceEmailPresentSql('e')} AS source_email_present, ${seriesKeySql('e')} AS series_key
    FROM calendar_events e WHERE e.id = ? AND e.calendar_id IS NOT NULL AND NOT (e.user_id <=> ?)`, [eventId, userId]);
  const level = row ? await accessLevel(userId, calendar(String(row.calendar_id))) : null;
  if (!row || !level) return null;
  return (await presentReached(userId, [row], new Map([[String(row.calendar_id), level]])))[0] ?? null;
}

// --- Group and organisation calendars ---------------------------------------------

function calendarInput(input: unknown, { partial = false } = {}) {
  const body = (input && typeof input === 'object' ? input : {}) as { name?: unknown; color?: unknown; group_id?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim() : undefined;
  if ((!partial || body.name !== undefined) && (!name || name.length > 255)) throw badRequest('CALENDAR_NAME_INVALID', 'A calendar needs a name of at most 255 characters.');
  if (body.color !== undefined && (typeof body.color !== 'string' || !COLOR.test(body.color))) throw badRequest('CALENDAR_COLOR_INVALID', 'A colour is written #rrggbb.');
  if (body.group_id != null && (typeof body.group_id !== 'string' || !UUID.test(body.group_id))) throw notFound('GROUP_NOT_FOUND', 'Group not found');
  return { name, color: body.color as string | undefined, groupId: (body.group_id as string | null | undefined) ?? null };
}

/** The calendars by name and counts, never their content; with `ids`, only those. */
async function summaries(where: string, params: string[], executor: SqlExecutor = db): Promise<SharedCalendarSummary[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT c.id, c.name, c.color, c.user_id, c.group_id, c.archived_at, c.deleted_at, c.created_at, u.full_name, u.email,
      (SELECT COUNT(*) FROM calendar_events e WHERE e.calendar_id = c.id) AS event_count
    FROM calendar_calendars c LEFT JOIN users u ON u.id = c.user_id WHERE ${where} ORDER BY c.name, c.id`, params);
  const counts = await shareCounts('calendar', rows.map(row => String(row.id)), executor);
  const groups = await groupNames(rows.flatMap(row => row.group_id == null ? [] : [String(row.group_id)]), executor);
  return rows.map(row => ({
    id: String(row.id), name: String(row.name), color: String(row.color || '#2563eb'),
    owner_kind: row.user_id != null ? 'user' : row.group_id != null ? 'group' : 'organisation',
    owner: row.user_id == null ? null : { id: String(row.user_id), full_name: row.full_name ?? null, email: String(row.email) },
    group: row.group_id == null ? null : { id: String(row.group_id), name: groups.get(String(row.group_id)) ?? '' },
    share_count: counts.get(String(row.id)) ?? 0, event_count: Number(row.event_count),
    archived_at: iso(row.archived_at), deleted_at: iso(row.deleted_at), created_at: iso(row.created_at)!,
  }));
}
const summary = async (calendarId: string, executor: SqlExecutor = db) => (await summaries('c.id = ?', [calendarId], executor))[0];

/**
 * POST /api/calendar/shared-calendars: an organisation calendar
 * (calendars.manage), or a group calendar (calendars.manage or a manager of
 * the group), which every member of the group reaches at contribute.
 */
async function createSharedCalendar(userId: string, input: unknown): Promise<SharedCalendarSummary> {
  const { name, color, groupId } = calendarInput(input);
  const id = crypto.randomUUID();
  await withTransaction(async cx => {
    const [[caller]] = await cx.execute<RowDataPacket[]>('SELECT role FROM users WHERE id = ? AND is_active = TRUE', [userId]);
    const admin = roleCan(caller?.role, 'calendars.manage');
    if (groupId && !await groupExists(groupId, cx)) throw notFound('GROUP_NOT_FOUND', 'Group not found');
    if (!admin && !(groupId && await membershipOf(groupId, userId, cx) === 'manager')) {
      throw forbidden('CALENDAR_FORBIDDEN', groupId ? "Only the group's managers and administrators create its calendars." : 'Only administrators create organisation calendars.');
    }
    await cx.execute(`INSERT INTO calendar_calendars (id, user_id, account_id, group_id, name, color, is_visible, auto_todo_enabled, read_only, is_primary)
      VALUES (?, NULL, NULL, ?, ?, ?, TRUE, TRUE, FALSE, FALSE)`, [id, groupId, name!, color ?? '#2563eb']);
    if (groupId) await setGrant(cx, calendar(id), { kind: 'group', id: groupId }, 'contribute', userId);
  });
  return summary(id);
}

/** PUT /api/calendar/shared-calendars/:id (manage): the name and default colour of a UniHub calendar. */
async function updateSharedCalendar(userId: string, calendarId: string, input: unknown): Promise<SharedCalendarSummary> {
  const { name, color } = calendarInput(input, { partial: true });
  await assertShareable(userId, calendarId);
  await withTransaction(async cx => {
    await cx.execute('SELECT id FROM calendar_calendars WHERE id = ? FOR UPDATE', [calendarId]);
    await assertShareable(userId, calendarId, cx);
    await cx.execute('UPDATE calendar_calendars SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?', [name ?? null, color ?? null, calendarId]);
  });
  return summary(calendarId);
}

// Deleting a calendar no person owns: a manager of its group, or an administrator.
async function assertMayDelete(cx: SqlExecutor, userId: string, calendarId: string) {
  await assertCalendar(userId, calendarId, 'manage', cx);
  const row = await calendarRow(calendarId, cx);
  if (row.userId !== null) throw badRequest('CALENDAR_HAS_OWNER', "A person's calendar is deleted by its owner, into their bin.");
  const [[caller]] = await cx.execute<RowDataPacket[]>('SELECT role FROM users WHERE id = ?', [userId]);
  if (roleCan(caller?.role, 'calendars.manage') || (row.groupId && await membershipOf(row.groupId, userId, cx) === 'manager')) return;
  throw forbidden('CALENDAR_FORBIDDEN', "Only the group's managers and administrators delete this calendar.");
}

/** DELETE /api/calendar/shared-calendars/:id: hidden at once; its events, shares and bin stay until an administrator restores it or the purge. */
async function deleteSharedCalendar(userId: string, calendarId: string): Promise<{ deleted: true }> {
  await assertMayDelete(db, userId, calendarId);
  await withTransaction(async cx => {
    await cx.execute('SELECT id FROM calendar_calendars WHERE id = ? FOR UPDATE', [calendarId]);
    await assertMayDelete(cx, userId, calendarId);
    await cx.execute('UPDATE calendar_calendars SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [calendarId]);
  });
  return { deleted: true };
}

/** GET /api/admin/calendars (calendars.manage, checked by the route): calendars no person owns, deleted ones too, and every person's calendar shared with someone. */
async function adminCalendars(): Promise<SharedCalendarSummary[]> {
  const shared = [...(await shareCounts('calendar', null)).keys()];
  return summaries(`c.user_id IS NULL${shared.length ? ` OR c.id IN (${shared.map(() => '?').join(', ')})` : ''}`, shared);
}

/** POST /api/admin/calendars/:id/restore (calendars.manage, checked by the route): a deleted group or organisation calendar back as it was. */
async function restoreSharedCalendar(calendarId: string): Promise<SharedCalendarSummary> {
  if (!UUID.test(calendarId)) throw notFound('CALENDAR_NOT_FOUND', 'Calendar not found');
  const [result] = await db.execute<ResultSetHeader>('UPDATE calendar_calendars SET deleted_at = NULL WHERE id = ? AND user_id IS NULL', [calendarId]);
  if (!result.affectedRows) throw notFound('CALENDAR_NOT_FOUND', 'Calendar not found');
  return summary(calendarId);
}

export {
  reachedCalendars, calendarsWithAccess, presentReached, reachedEvent, busy, viewsOfCalendars,
  assertCalendar, calendarShares, setCalendarShare, calendarShareCandidates, setCalendarView,
  createSharedCalendar, updateSharedCalendar, deleteSharedCalendar, adminCalendars, restoreSharedCalendar,
};
