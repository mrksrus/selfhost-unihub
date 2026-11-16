import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { AccessKind, AccessPermissions, Principal, Principals } from '../contracts/organisation';

import crypto from 'node:crypto';
import { db } from '../state';
import { forbidden, notFound } from '../http/errors';
import { can as roleCan } from '../security/permissions';
import { allGroupIds, groupExists, groupsOf, membershipOf } from './groups';

// The access service (F4): the one place that decides who may read or
// manage a resource beyond its owner. Routes and workers ask it before any
// side effect, and again inside the transaction that writes. Private tables
// keep their plain user_id rule; only resources that others can reach come
// here. A group is managed by its managers and by administrators with
// groups.manage. A shared address book is reached through grants to a
// person's principals (the person, their groups, everyone); administrators
// with contacts.books.manage manage every book without one. The grants
// table is this file's alone (a lint fence keeps its SQL here).

type Resource<K extends AccessKind = AccessKind> = { kind: K; id: string };

// Each kind's permissions from the least to the most; a higher one includes the lower.
const ORDER: { readonly [K in AccessKind]: readonly AccessPermissions[K][] } = {
  group: ['read', 'manage'],
  address_book: ['read', 'edit', 'manage'],
};

const REFUSALS: { readonly [K in AccessKind]: { notFound: { code: string; message: string }; forbidden: { code: string; message: string } } } = {
  group: { notFound: { code: 'GROUP_NOT_FOUND', message: 'Group not found' }, forbidden: { code: 'GROUP_FORBIDDEN', message: 'You cannot manage this group.' } },
  address_book: { notFound: { code: 'BOOK_NOT_FOUND', message: 'Address book not found' }, forbidden: { code: 'BOOK_FORBIDDEN', message: 'You cannot change this address book.' } },
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

/** The most the person may do with the resource, or null when they cannot see it. */
async function accessLevel<K extends AccessKind>(userId: string, resource: Resource<K>, executor: SqlExecutor = db): Promise<AccessPermissions[K] | null> {
  const role = await activeRole(userId, executor);
  if (!role) return null;
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
 * finds the others under Server › Shared books.
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

/** The resources of a kind on which the person holds a direct grant of exactly `permission` (the books they created). */
async function heldBy(userId: string, kind: AccessKind, permission: string, executor: SqlExecutor = db): Promise<string[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT resource_id FROM grants
    WHERE resource_kind = ? AND principal_kind = 'user' AND principal_id = ? AND permission = ? ORDER BY granted_at, id`, [kind, userId, permission]);
  return rows.map(row => String(row.resource_id));
}

export { principalsOf, accessLevel, can, assertCan, visible, grantsOn, lockGrant, setGrant, removeGrantsOf, heldBy };
export type { Resource, Grant };
