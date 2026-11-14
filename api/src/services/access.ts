import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { AccessKind, AccessPermissions, Principals } from '../contracts/organisation';

import { db } from '../state';
import { forbidden, notFound } from '../http/errors';
import { can as roleCan } from '../security/permissions';
import { allGroupIds, groupExists, groupsOf, membershipOf } from './groups';

// The access service (F4): the one place that decides who may read or
// manage a resource beyond its owner. Routes and workers ask it before any
// side effect, and again inside the transaction that writes. Private tables
// keep their plain user_id rule; only resources that others can reach come
// here. 0.30 has one kind, a group (managed by its managers and by
// administrators with groups.manage); shared resources (0.31 on) add their
// kinds and the grants that reach them through a person's principals.

type Resource<K extends AccessKind = AccessKind> = { kind: K; id: string };

// Each kind's permissions from the least to the most; a higher one includes the lower.
const ORDER: { readonly [K in AccessKind]: readonly AccessPermissions[K][] } = {
  group: ['read', 'manage'],
};

const REFUSALS: { readonly [K in AccessKind]: { notFound: { code: string; message: string }; forbidden: { code: string; message: string } } } = {
  group: { notFound: { code: 'GROUP_NOT_FOUND', message: 'Group not found' }, forbidden: { code: 'GROUP_FORBIDDEN', message: 'You cannot manage this group.' } },
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

/** The most the person may do with the resource, or null when they cannot see it. */
async function accessLevel<K extends AccessKind>(userId: string, resource: Resource<K>, executor: SqlExecutor = db): Promise<AccessPermissions[K] | null> {
  const role = await activeRole(userId, executor);
  if (!role) return null;
  // group (the one kind until 0.31)
  if (!await groupExists(resource.id, executor)) return null;
  const levels: AccessPermissions['group'][] = [];
  if (roleCan(role, 'groups.manage')) levels.push('manage');
  else if (roleCan(role, 'users.read')) levels.push('read');
  const membership = await membershipOf(resource.id, userId, executor);
  if (membership) levels.push(membership === 'manager' ? 'manage' : 'read');
  if (!levels.length) return null;
  const order = ORDER[resource.kind] as readonly string[];
  return levels.reduce((a, b) => (order.indexOf(a) >= order.indexOf(b) ? a : b)) as AccessPermissions[K];
}

/** Whether the person may do `permission` (or more) with the resource. */
async function can<K extends AccessKind>(userId: string, resource: Resource<K>, permission: AccessPermissions[K], executor: SqlExecutor = db): Promise<boolean> {
  const level = await accessLevel(userId, resource, executor);
  const order = ORDER[resource.kind] as readonly string[];
  return level !== null && order.indexOf(level) >= order.indexOf(permission);
}

/**
 * Throws 404 when the person cannot see the resource (so its existence is not
 * told), 403 when they see it but may not do `permission`.
 */
async function assertCan<K extends AccessKind>(userId: string, resource: Resource<K>, permission: AccessPermissions[K], executor: SqlExecutor = db): Promise<void> {
  const level = await accessLevel(userId, resource, executor);
  const { notFound: hidden, forbidden: refused } = REFUSALS[resource.kind];
  if (level === null) throw notFound(hidden.code, hidden.message);
  const order = ORDER[resource.kind] as readonly string[];
  if (order.indexOf(level) < order.indexOf(permission)) throw forbidden(refused.code, refused.message);
}

/** The ids of the resources of a kind the person can see, for list queries. */
async function visible(userId: string, kind: AccessKind, executor: SqlExecutor = db): Promise<string[]> {
  const role = await activeRole(userId, executor);
  if (!role) return [];
  // group (the one kind until 0.31)
  if (roleCan(role, 'groups.manage') || roleCan(role, 'users.read')) return allGroupIds(executor);
  return (await groupsOf(userId, executor)).map(group => group.id);
}

export { principalsOf, accessLevel, can, assertCan, visible };
export type { Resource };
