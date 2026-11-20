import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { AccessKind, AccessPermissions, Principal, Principals } from '../contracts/organisation';
import type { ShareCandidatesResponse } from '../contracts/address-books';
import type { Permission } from '../security/permissions';

import crypto from 'node:crypto';
import { db } from '../state';
import { forbidden, notFound } from '../http/errors';
import { can as roleCan } from '../security/permissions';
import { allGroupIds, groupExists, groupNames, groupsOf, listGroups, membershipOf, peopleMatching, shareAGroup } from './groups';

// The access service (F4): the one place that decides who may read or
// manage a resource beyond its owner. Routes and workers ask it before any
// side effect, and again inside the transaction that writes. Private tables
// keep their plain user_id rule; only resources that others can reach come
// here. A group is managed by its managers and by administrators with
// groups.manage. A shared address book is reached through grants to a
// person's principals (the person, their groups, everyone); administrators
// with contacts.books.manage manage every book without one. A calendar is
// managed by the person who owns it; one no person owns (an organisation's,
// or a group's) by administrators with calendars.manage and by the managers
// of its group; anyone else reaches a UniHub calendar through grants, never
// one synced from a provider. An archived calendar is read-only for
// everyone. A chat conversation is reached only by the people it has
// grants for (level member); no role reaches it. The grants table is this
// file's alone (a lint fence keeps its SQL here).

type Resource<K extends AccessKind = AccessKind> = { kind: K; id: string };

// Each kind's permissions from the least to the most; a higher one includes the lower.
const ORDER: { readonly [K in AccessKind]: readonly AccessPermissions[K][] } = {
  group: ['read', 'manage'],
  address_book: ['read', 'edit', 'manage'],
  calendar: ['freebusy', 'read', 'contribute', 'edit', 'manage'],
  conversation: ['member'],
};

const REFUSALS: { readonly [K in AccessKind]: { notFound: { code: string; message: string }; forbidden: { code: string; message: string } } } = {
  group: { notFound: { code: 'GROUP_NOT_FOUND', message: 'Group not found' }, forbidden: { code: 'GROUP_FORBIDDEN', message: 'You cannot manage this group.' } },
  address_book: { notFound: { code: 'BOOK_NOT_FOUND', message: 'Address book not found' }, forbidden: { code: 'BOOK_FORBIDDEN', message: 'You cannot change this address book.' } },
  calendar: { notFound: { code: 'CALENDAR_NOT_FOUND', message: 'Calendar not found' }, forbidden: { code: 'CALENDAR_FORBIDDEN', message: 'You cannot change this calendar.' } },
  conversation: { notFound: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' }, forbidden: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' } },
};

const highest = <K extends AccessKind>(kind: K, levels: readonly string[]): AccessPermissions[K] | null => {
  const order = ORDER[kind] as readonly string[];
  return levels.length ? levels.reduce((a, b) => (order.indexOf(a) >= order.indexOf(b) ? a : b)) as AccessPermissions[K] : null;
};

// The person's role while they are active; null for anyone else.
async function activeRole(userId: string, executor: SqlExecutor): Promise<string | null> {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT role FROM users WHERE id = ? AND is_active = TRUE', [userId]);
  return rows.length ? String(rows[0].role) : null;
}

/** Who the person is for access: themselves, their groups and everyone. */
async function principalsOf(userId: string, executor: SqlExecutor = db): Promise<Principals> {
  return { user: userId, groups: (await groupsOf(userId, executor)).map(group => group.id), everyone: true };
}

// The grants of a kind that reach the person's principals: [resource id, permission].
async function reachingGrants(userId: string, kind: AccessKind, resourceId: string | null, executor: SqlExecutor) {
  const { groups } = await principalsOf(userId, executor);
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT resource_id, permission FROM grants
    WHERE resource_kind = ?${resourceId === null ? '' : ' AND resource_id = ?'} AND ((principal_kind = 'user' AND principal_id = ?)
      OR principal_kind = 'everyone'${groups.length ? ` OR (principal_kind = 'group' AND principal_id IN (${groups.map(() => '?').join(', ')}))` : ''})`,
  [kind, ...(resourceId === null ? [] : [resourceId]), userId, ...groups]);
  return rows.map(row => [String(row.resource_id), String(row.permission)] as const);
}

async function bookLive(bookId: string, executor: SqlExecutor) {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT 1 FROM address_books WHERE id = ? AND deleted_at IS NULL', [bookId]);
  return rows.length > 0;
}

// A calendar as access sees it: its owner, group, state and whether grants may reach it.
async function calendarOf(calendarId: string, executor: SqlExecutor) {
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT c.user_id, c.group_id, c.deleted_at IS NOT NULL AS deleted, c.archived_at IS NOT NULL AS archived,
      (c.user_id IS NULL OR a.provider = 'local') AS shareable
    FROM calendar_calendars c LEFT JOIN calendar_accounts a ON a.id = c.account_id WHERE c.id = ?`, [calendarId]);
  return row ? { userId: row.user_id == null ? null : String(row.user_id), groupId: row.group_id == null ? null : String(row.group_id),
    deleted: !!Number(row.deleted), archived: !!Number(row.archived), shareable: !!Number(row.shareable) } : null;
}

async function calendarLevel(userId: string, role: string, calendarId: string, executor: SqlExecutor): Promise<AccessPermissions['calendar'] | null> {
  const calendar = await calendarOf(calendarId, executor);
  if (!calendar || calendar.deleted) return null;
  const levels: string[] = [];
  if (calendar.userId === userId) levels.push('manage');
  if (calendar.userId === null && roleCan(role, 'calendars.manage')) levels.push('manage');
  if (calendar.userId === null && calendar.groupId && await membershipOf(calendar.groupId, userId, executor) === 'manager') levels.push('manage');
  if (calendar.shareable) levels.push(...(await reachingGrants(userId, 'calendar', calendarId, executor)).map(([, permission]) => permission));
  const level = highest('calendar', levels);
  return calendar.archived && level && level !== 'freebusy' ? 'read' : level;
}

/** The most the person may do with the resource, or null when they cannot see it. */
async function accessLevel<K extends AccessKind>(userId: string, resource: Resource<K>, executor: SqlExecutor = db): Promise<AccessPermissions[K] | null> {
  const role = await activeRole(userId, executor);
  if (!role) return null;
  if (resource.kind === 'calendar') return calendarLevel(userId, role, resource.id, executor) as Promise<AccessPermissions[K] | null>;
  if (resource.kind === 'conversation') {
    const [live] = await executor.execute<RowDataPacket[]>('SELECT 1 FROM chat_conversations WHERE id = ?', [resource.id]);
    return (live.length && (await reachingGrants(userId, 'conversation', resource.id, executor)).length ? 'member' : null) as AccessPermissions[K] | null;
  }
  const levels: string[] = [];
  if (resource.kind === 'address_book') {
    if (!await bookLive(resource.id, executor)) return null;
    if (roleCan(role, 'contacts.books.manage')) levels.push('manage');
    levels.push(...(await reachingGrants(userId, 'address_book', resource.id, executor)).map(([, permission]) => permission));
    return highest(resource.kind, levels);
  }
  if (!await groupExists(resource.id, executor)) return null;
  if (roleCan(role, 'groups.manage')) levels.push('manage');
  else if (roleCan(role, 'users.read')) levels.push('read');
  const membership = await membershipOf(resource.id, userId, executor);
  if (membership) levels.push(membership === 'manager' ? 'manage' : 'read');
  return highest(resource.kind, levels);
}

/** Whether the person may do `permission` (or more) with the resource. */
async function can<K extends AccessKind>(userId: string, resource: Resource<K>, permission: AccessPermissions[K], executor: SqlExecutor = db): Promise<boolean> {
  const level = await accessLevel(userId, resource, executor);
  const order = ORDER[resource.kind] as readonly string[];
  return level !== null && order.indexOf(level) >= order.indexOf(permission);
}

/**
 * Throws 404 when the person cannot see the resource (so its existence is not
 * told), 403 when they see it but may not do `permission`. Answers their level.
 */
async function assertCan<K extends AccessKind>(userId: string, resource: Resource<K>, permission: AccessPermissions[K], executor: SqlExecutor = db): Promise<AccessPermissions[K]> {
  const level = await accessLevel(userId, resource, executor);
  const { notFound: hidden, forbidden: refused } = REFUSALS[resource.kind];
  if (level === null) throw notFound(hidden.code, hidden.message);
  const order = ORDER[resource.kind] as readonly string[];
  if (order.indexOf(level) < order.indexOf(permission)) throw forbidden(refused.code, refused.message);
  return level;
}

/**
 * The ids of the resources of a kind the person can see, for list queries.
 * A book shows only where a grant reaches the person: an administrator
 * finds the others under Server › Shared books. A calendar shows where a
 * grant reaches the person and for the managers of its group; never the
 * person's own (listed as theirs) and never for an administrator by
 * permission alone (Server › Calendars lists the others).
 */
async function visible(userId: string, kind: AccessKind, executor: SqlExecutor = db): Promise<string[]> {
  const role = await activeRole(userId, executor);
  if (!role) return [];
  if (kind === 'address_book') {
    const reached = [...new Set((await reachingGrants(userId, kind, null, executor)).map(([id]) => id))];
    if (!reached.length) return [];
    const [live] = await executor.execute<RowDataPacket[]>(`SELECT id FROM address_books WHERE deleted_at IS NULL AND id IN (${reached.map(() => '?').join(', ')})
      ORDER BY name, id`, reached);
    return live.map(row => String(row.id));
  }
  if (kind === 'conversation') return [...new Set((await reachingGrants(userId, kind, null, executor)).map(([id]) => id))];
  if (kind === 'calendar') {
    const reached = [...new Set((await reachingGrants(userId, kind, null, executor)).map(([id]) => id))];
    const managed = (await groupsOf(userId, executor)).filter(group => group.role === 'manager').map(group => group.id);
    if (!reached.length && !managed.length) return [];
    const list = (ids: readonly string[]) => ids.length ? ids.map(() => '?').join(', ') : 'NULL';
    const [live] = await executor.execute<RowDataPacket[]>(`SELECT c.id FROM calendar_calendars c LEFT JOIN calendar_accounts a ON a.id = c.account_id
      WHERE c.deleted_at IS NULL AND (c.user_id IS NULL OR (a.provider = 'local' AND c.user_id <> ?))
        AND (c.id IN (${list(reached)}) OR (c.user_id IS NULL AND c.group_id IN (${list(managed)})))
      ORDER BY c.name, c.id`, [userId, ...reached, ...managed]);
    return live.map(row => String(row.id));
  }
  if (roleCan(role, 'groups.manage') || roleCan(role, 'users.read')) return allGroupIds(executor);
  return (await groupsOf(userId, executor)).map(group => group.id);
}

// --- Grants ----------------------------------------------------------------------

const principalKey = (principal: Principal) => [principal.kind, principal.kind === 'everyone' ? '' : principal.id] as const;

interface Grant { principal: Principal; permission: string; granted_at: string }

/** A resource's grants, oldest first. */
async function grantsOn(resource: Resource, executor: SqlExecutor = db): Promise<Grant[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT principal_kind, principal_id, permission, granted_at FROM grants
    WHERE resource_kind = ? AND resource_id = ? ORDER BY granted_at, id`, [resource.kind, resource.id]);
  return rows.map(row => ({
    principal: (row.principal_kind === 'everyone' ? { kind: 'everyone' } : { kind: row.principal_kind, id: String(row.principal_id) }) as Principal,
    permission: String(row.permission),
    granted_at: row.granted_at instanceof Date ? row.granted_at.toISOString() : String(row.granted_at),
  }));
}

/** A resource's grants with each principal's name ("Everyone" for everyone) and a person's address. */
async function namedGrants(resource: Resource, executor: SqlExecutor = db) {
  const grants = await grantsOn(resource, executor);
  const userIds = grants.flatMap(grant => grant.principal.kind === 'user' ? [grant.principal.id] : []);
  const [people] = userIds.length ? await executor.execute<RowDataPacket[]>(`SELECT id, full_name, email FROM users WHERE id IN (${userIds.map(() => '?').join(', ')})`, userIds) : [[]];
  const byId = new Map(people.map(row => [String(row.id), row]));
  const groups = await groupNames(grants.flatMap(grant => grant.principal.kind === 'group' ? [grant.principal.id] : []), executor);
  return grants.map(({ principal, permission }) => {
    const person = principal.kind === 'user' ? byId.get(principal.id) : undefined;
    return {
      principal, permission, email: person ? String(person.email) : null,
      name: principal.kind === 'everyone' ? 'Everyone' : principal.kind === 'group' ? groups.get(principal.id) ?? '' : person?.full_name ?? String(person?.email ?? ''),
    };
  });
}

/** How many grants each resource of a kind has: of the given ids, or (null) of every resource that has one. */
async function shareCounts(kind: AccessKind, ids: readonly string[] | null, executor: SqlExecutor = db): Promise<Map<string, number>> {
  if (ids && !ids.length) return new Map();
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT resource_id, COUNT(*) AS shares FROM grants WHERE resource_kind = ?
    ${ids ? `AND resource_id IN (${ids.map(() => '?').join(', ')})` : ''} GROUP BY resource_id`, [kind, ...(ids ?? [])]);
  return new Map(rows.map(row => [String(row.resource_id), Number(row.shares)]));
}

/** The principal's grant on the resource, locked for the caller's transaction; null when none. */
async function lockGrant(cx: SqlExecutor, resource: Resource, principal: Principal): Promise<string | null> {
  const [rows] = await cx.execute<RowDataPacket[]>('SELECT permission FROM grants WHERE resource_kind = ? AND resource_id = ? AND principal_kind = ? AND principal_id = ? FOR UPDATE',
    [resource.kind, resource.id, ...principalKey(principal)]);
  return rows.length ? String(rows[0].permission) : null;
}

/** Gives, changes or (null) removes the principal's grant on the resource, in the caller's transaction. */
async function setGrant(cx: SqlExecutor, resource: Resource, principal: Principal, permission: string | null, grantedBy: string | null) {
  if (permission === null) {
    await cx.execute('DELETE FROM grants WHERE resource_kind = ? AND resource_id = ? AND principal_kind = ? AND principal_id = ?', [resource.kind, resource.id, ...principalKey(principal)]);
    return;
  }
  await cx.execute(`INSERT INTO grants (id, resource_kind, resource_id, principal_kind, principal_id, permission, granted_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE permission = VALUES(permission), granted_by = VALUES(granted_by), granted_at = CURRENT_TIMESTAMP`,
  [crypto.randomUUID(), resource.kind, resource.id, ...principalKey(principal), permission, grantedBy]);
}

/** Removes every grant a person or group holds, in the transaction that deletes them. */
async function removeGrantsOf(cx: SqlExecutor, principal: Exclude<Principal, { kind: 'everyone' }>) {
  await cx.execute('DELETE FROM grants WHERE principal_kind = ? AND principal_id = ?', [...principalKey(principal)]);
}

/** Removes the grants on a person's calendars, in the transaction that deletes the person and with them their calendars. */
async function removeGrantsOnCalendarsOf(cx: SqlExecutor, userId: string) {
  await cx.execute(`DELETE g FROM grants g JOIN calendar_calendars c ON c.id = g.resource_id
    WHERE g.resource_kind = 'calendar' AND c.user_id = ?`, [userId]);
}

/**
 * Before a person's calendars (all, or these) are deleted without the bin:
 * refused while one is archived, which only an administrator ends. Deleting
 * the person does not ask.
 */
async function assertNoneArchived(cx: SqlExecutor, userId: string, calendarIds?: readonly string[]) {
  const only = calendarIds ? ` AND id IN (${calendarIds.map(() => '?').join(', ')})` : '';
  const [archived] = await cx.execute<RowDataPacket[]>(`SELECT id FROM calendar_calendars WHERE user_id = ? AND archived_at IS NOT NULL${only} FOR UPDATE`,
    [userId, ...(calendarIds ?? [])]);
  if (archived.length) throw forbidden('CALENDAR_FORBIDDEN', 'An archived calendar cannot be deleted. An administrator unarchives it or hands it over first.');
}

/** Removes every grant on a resource, in the transaction that deletes it for good. */
async function removeGrantsOn(cx: SqlExecutor, resource: Resource) {
  await cx.execute('DELETE FROM grants WHERE resource_kind = ? AND resource_id = ?', [resource.kind, resource.id]);
}

/**
 * The people a conversation reaches, active or not: the stale check and the
 * device list ask for their devices.
 * shortcut: person grants only; a chat that follows a group adds its members here.
 */
async function conversationPeople(conversationId: string, executor: SqlExecutor = db): Promise<string[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT principal_id FROM grants
    WHERE resource_kind = 'conversation' AND resource_id = ? AND principal_kind = 'user' ORDER BY principal_id`, [conversationId]);
  return rows.map(row => String(row.principal_id));
}

/** The resources of a kind on which the person holds a direct grant of exactly `permission` (the books they created). */
async function heldBy(userId: string, kind: AccessKind, permission: string, executor: SqlExecutor = db): Promise<string[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT resource_id FROM grants
    WHERE resource_kind = ? AND principal_kind = 'user' AND principal_id = ? AND permission = ? ORDER BY granted_at, id`, [kind, userId, permission]);
  return rows.map(row => String(row.resource_id));
}

// --- Reach ------------------------------------------------------------------------

const MAX_CANDIDATES = 20;
const outOfReach = () => forbidden('SHARE_OUT_OF_REACH', 'You can share only with your own groups and the people in them.');

/**
 * Whom the caller may give a share or a higher one: an administrator with
 * the kind's permission anyone active, any group or everyone; anyone else
 * their own groups and the active people in them, never everyone.
 */
async function assertReach(cx: SqlExecutor, userId: string, principal: Principal, adminPermission: Permission) {
  const [[caller]] = await cx.execute<RowDataPacket[]>('SELECT role FROM users WHERE id = ?', [userId]);
  const admin = roleCan(caller?.role, adminPermission);
  if (principal.kind === 'everyone') { if (!admin) throw outOfReach(); return; }
  if (principal.kind === 'group') {
    if (!await groupExists(principal.id, cx)) throw notFound('GROUP_NOT_FOUND', 'Group not found');
    if (!admin && !await membershipOf(principal.id, userId, cx)) throw outOfReach();
    return;
  }
  const [[person]] = await cx.execute<RowDataPacket[]>('SELECT id FROM users WHERE id = ? AND is_active = TRUE', [principal.id]);
  if (!person) throw notFound('USER_NOT_FOUND', 'User not found');
  if (!admin && !await shareAGroup(userId, principal.id, cx)) throw outOfReach();
}

/** The people and groups within the caller's reach that match the query, at most 20 of each. */
async function reachCandidates(userId: string, query: string, adminPermission: Permission): Promise<ShareCandidatesResponse> {
  const [[caller]] = await db.execute<RowDataPacket[]>('SELECT role FROM users WHERE id = ?', [userId]);
  const admin = roleCan(caller?.role, adminPermission);
  const people = await peopleMatching(query, admin ? {} : { sharingGroupsWith: userId });
  const needle = query.trim().toLowerCase();
  const groups = (admin ? await listGroups() : await groupsOf(userId))
    .filter(group => group.name.toLowerCase().includes(needle)).slice(0, MAX_CANDIDATES).map(({ id, name }) => ({ id, name }));
  return { people, groups, everyone: admin };
}

export {
  principalsOf, accessLevel, can, assertCan, visible, conversationPeople, grantsOn, namedGrants, shareCounts, lockGrant, setGrant, removeGrantsOf, removeGrantsOnCalendarsOf, removeGrantsOn, assertNoneArchived, heldBy,
  assertReach, reachCandidates,
};
export type { Resource, Grant };
