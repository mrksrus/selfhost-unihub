import type { RowDataPacket } from 'mysql2/promise';
import type { AuthRequest, SqlExecutor } from '../types';
import type { GroupCandidate, GroupMember, GroupResponse, GroupRole, GroupSummary, PersonGroup } from '../contracts/organisation';

import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { can as roleCan } from '../security/permissions';
import { withTransaction } from './transactions';
import { assertCaller } from './caller-proof';
import { recordAudit } from './audit';
import { checkPeoplePolicies, deleteGroupPolicies, groupsWithPolicies, lockRules } from './settings';
import { applyPolicyChange } from './module-lifecycle';

// The organisation's groups and their members (F3) have one owner: this
// service (a lint fence keeps their SQL here). Who may do what with a group
// is services/access.ts's question; policies per group are settings.ts's,
// which asks this service for a person's groups.

/** The person's groups with their role in each, by name. */
async function groupsOf(userId: string, executor: SqlExecutor = db): Promise<PersonGroup[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT g.id, g.name, m.role FROM org_group_members m
    JOIN org_groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY g.name, g.id`, [userId]);
  return rows.map(row => ({ id: String(row.id), name: String(row.name), role: row.role as GroupRole }));
}

/** The person's role in the group, or null when they are not in it (or it does not exist). */
async function membershipOf(groupId: string, userId: string, executor: SqlExecutor = db): Promise<GroupRole | null> {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT role FROM org_group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
  return rows.length ? rows[0].role as GroupRole : null;
}

async function groupExists(groupId: string, executor: SqlExecutor = db): Promise<boolean> {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT 1 FROM org_groups WHERE id = ?', [groupId]);
  return rows.length > 0;
}

/** Whether the person manages at least one group. */
async function managesAnyGroup(userId: string, executor: SqlExecutor = db): Promise<boolean> {
  const [rows] = await executor.execute<RowDataPacket[]>("SELECT 1 FROM org_group_members WHERE user_id = ? AND role = 'manager' LIMIT 1", [userId]);
  return rows.length > 0;
}

/** Every group's id, by name. */
async function allGroupIds(executor: SqlExecutor = db): Promise<string[]> {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT id FROM org_groups ORDER BY name, id');
  return rows.map(row => String(row.id));
}

/** Every person's groups with their role in each, by person; for the People list. */
async function membershipsByUser(executor: SqlExecutor = db): Promise<Map<string, PersonGroup[]>> {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT m.user_id, g.id, g.name, m.role FROM org_group_members m
    JOIN org_groups g ON g.id = m.group_id ORDER BY g.name, g.id`);
  const byUser = new Map<string, PersonGroup[]>();
  for (const row of rows) {
    const list = byUser.get(String(row.user_id)) ?? [];
    list.push({ id: String(row.id), name: String(row.name), role: row.role as GroupRole });
    byUser.set(String(row.user_id), list);
  }
  return byUser;
}

// --- Reading groups --------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MEMBERS_AT_ONCE = 200;
const MAX_CANDIDATES = 20;

// The access service decides; it loads this file, so it is loaded on first use.
const access = () => require('./access') as typeof import('./access');
const assertGroup = (userId: string, groupId: string, permission: 'read' | 'manage', executor: SqlExecutor = db) => {
  if (!UUID.test(groupId)) throw notFound('GROUP_NOT_FOUND', 'Group not found');
  return access().assertCan(userId, { kind: 'group', id: groupId }, permission, executor);
};

const iso = (value: unknown) => (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString();

async function summaries(where: string, params: string[], executor: SqlExecutor = db): Promise<(GroupSummary & { role?: GroupRole })[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT g.id, g.name, g.description,
      (SELECT COUNT(*) FROM org_group_members c WHERE c.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM org_group_members c WHERE c.group_id = g.id AND c.role = 'manager') AS manager_count${where.includes('m.') ? ', m.role' : ''}
    FROM org_groups g ${where} ORDER BY g.name, g.id`, params);
  const withPolicies = await groupsWithPolicies(executor);
  return rows.map(row => ({
    id: String(row.id), name: String(row.name), description: row.description == null ? null : String(row.description),
    member_count: Number(row.member_count), manager_count: Number(row.manager_count), has_policies: withPolicies.has(String(row.id)),
    ...(row.role ? { role: row.role as GroupRole } : {}),
  }));
}

/** GET /api/admin/groups: every group. */
async function listGroups(): Promise<GroupSummary[]> {
  return summaries('', []);
}

/** GET /api/groups: the person's groups and their role in each. */
async function myGroups(userId: string): Promise<(GroupSummary & { role: GroupRole })[]> {
  return summaries('JOIN org_group_members m ON m.group_id = g.id AND m.user_id = ?', [userId]) as Promise<(GroupSummary & { role: GroupRole })[]>;
}

/** GET /api/groups/:id: who may manage the group sees its members; who may read it, its managers. */
async function groupDetail(userId: string, groupId: string): Promise<GroupResponse> {
  await assertGroup(userId, groupId, 'read');
  const id = groupId;
  const canManage = await access().can(userId, { kind: 'group', id }, 'manage');
  const [group] = await summaries('WHERE g.id = ?', [id]);
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT u.id, u.email, u.full_name, m.role, m.added_at FROM org_group_members m
    JOIN users u ON u.id = m.user_id WHERE m.group_id = ?${canManage ? '' : " AND m.role = 'manager'"}
    ORDER BY m.role = 'manager' DESC, u.full_name, u.email`, [id]);
  const members: GroupMember[] = rows.map(row => ({ id: String(row.id), email: String(row.email), full_name: row.full_name ?? null, role: row.role as GroupRole, added_at: iso(row.added_at) }));
  return { group, can_manage: canManage, members };
}

/** GET /api/groups/:id/candidates?q=: active people not in the group whose name or address matches, at most 20. */
async function groupCandidates(userId: string, groupId: string, query: string): Promise<GroupCandidate[]> {
  await assertGroup(userId, groupId, 'manage');
  const like = `%${query.trim().slice(0, 100).replace(/[\\%_]/g, character => `\\${character}`)}%`;
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT u.id, u.email, u.full_name FROM users u
    WHERE u.is_active = TRUE AND (u.full_name LIKE ? OR u.email LIKE ?)
      AND NOT EXISTS (SELECT 1 FROM org_group_members m WHERE m.group_id = ? AND m.user_id = u.id)
    ORDER BY u.full_name, u.email LIMIT ${MAX_CANDIDATES}`, [like, like, groupId]);
  return rows.map(row => ({ id: String(row.id), email: String(row.email), full_name: row.full_name ?? null }));
}

// --- Changing groups --------------------------------------------------------------

function groupInput(input: unknown): { name: string; description: string | null } {
  const body = (input && typeof input === 'object' ? input : {}) as { name?: unknown; description?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100) throw badRequest('GROUP_NAME_INVALID', 'A group needs a name of at most 100 characters.');
  if (body.description != null && (typeof body.description !== 'string' || body.description.length > 500)) {
    throw badRequest('GROUP_DESCRIPTION_INVALID', 'A description has at most 500 characters.');
  }
  const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null;
  return { name, description };
}

const nameTaken = (error: unknown) => (error as { code?: string }).code === 'ER_DUP_ENTRY'
  ? conflict('GROUP_NAME_TAKEN', 'A group with this name exists already.') : error;

/**
 * A change of memberships or of a whole group: under the rules lock (the
 * revision row, as an administrator's policy save), so a destructive step's
 * final check sees memberships either before or after it. Locking reads come
 * first, so the access check inside `work` reads what committed before the
 * lock was ours: a manager removed meanwhile changes nothing. The rules of
 * the people it reached are checked before it commits, and what they mean
 * for running work is applied after.
 */
async function underRulesLock<T>(work: (cx: SqlExecutor) => Promise<{ value: T; reached: string[] }>): Promise<T> {
  const { value, reached } = await withTransaction(async cx => {
    await lockRules(cx);
    await assertCaller(cx);
    const result = await work(cx);
    await checkPeoplePolicies(cx, result.reached);
    return result;
  });
  if (reached.length) await applyPolicyChange(reached);
  return value;
}

/** POST /api/admin/groups (groups.manage): an empty group. */
async function createGroup(adminId: string, input: unknown, req: AuthRequest | null = null): Promise<GroupSummary> {
  const { name, description } = groupInput(input);
  const id = crypto.randomUUID();
  await withTransaction(async cx => {
    await assertCaller(cx);
    await cx.execute('INSERT INTO org_groups (id, name, description, created_by) VALUES (?, ?, ?, ?)', [id, name, description, adminId]).catch(error => { throw nameTaken(error); });
    await recordAudit({ action: 'admin.group_created', actorId: adminId, req, details: { group: id } }, cx);
  });
  const [group] = await summaries('WHERE g.id = ?', [id]);
  return group;
}

/** PUT /api/groups/:id (manage): its name and description; no one's rules change. */
async function renameGroup(userId: string, groupId: string, input: unknown, req: AuthRequest | null = null): Promise<GroupSummary> {
  const { name, description } = groupInput(input);
  await assertGroup(userId, groupId, 'manage');
  await withTransaction(async cx => {
    await assertCaller(cx);
    await cx.execute('SELECT id FROM org_groups WHERE id = ? FOR UPDATE', [groupId]);
    await assertGroup(userId, groupId, 'manage', cx);
    await cx.execute('UPDATE org_groups SET name = ?, description = ? WHERE id = ?', [name, description, groupId]).catch(error => { throw nameTaken(error); });
    await recordAudit({ action: 'group.renamed', actorId: userId, req, details: { group: groupId } }, cx);
  });
  const [group] = await summaries('WHERE g.id = ?', [groupId]);
  return group;
}

/** DELETE /api/admin/groups/:id (groups.manage): the group, its memberships and its policies; no person's data. */
async function deleteGroup(adminId: string, groupId: string, req: AuthRequest | null = null): Promise<{ deleted: true }> {
  await assertGroup(adminId, groupId, 'manage');
  return underRulesLock(async cx => {
    await assertGroup(adminId, groupId, 'manage', cx);
    const [members] = await cx.execute<RowDataPacket[]>('SELECT user_id FROM org_group_members WHERE group_id = ? FOR UPDATE', [groupId]);
    await deleteGroupPolicies(cx, groupId);
    await cx.execute('DELETE FROM org_groups WHERE id = ?', [groupId]);
    await recordAudit({ action: 'admin.group_deleted', actorId: adminId, req, details: { group: groupId, members: members.length } }, cx);
    return { value: { deleted: true as const }, reached: members.map(row => String(row.user_id)) };
  });
}

function memberIds(input: unknown): string[] {
  const ids = (input && typeof input === 'object' ? input as { user_ids?: unknown } : {}).user_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_MEMBERS_AT_ONCE || !ids.every(id => typeof id === 'string' && UUID.test(id))) {
    throw badRequest('MEMBERS_INVALID', `Expected { user_ids: [...] } with 1 to ${MAX_MEMBERS_AT_ONCE} people.`);
  }
  return [...new Set(ids.map(id => (id as string).toLowerCase()))];
}

/** POST /api/groups/:id/members (manage): active people join as members; those already in it stay as they are. */
async function addMembers(userId: string, groupId: string, input: unknown, req: AuthRequest | null = null): Promise<GroupResponse> {
  const ids = memberIds(input);
  await assertGroup(userId, groupId, 'manage');
  await underRulesLock(async cx => {
    await assertGroup(userId, groupId, 'manage', cx);
    const [people] = await cx.execute<RowDataPacket[]>(`SELECT id FROM users WHERE is_active = TRUE AND id IN (${ids.map(() => '?').join(', ')}) LOCK IN SHARE MODE`, ids);
    if (people.length !== ids.length) throw notFound('USER_NOT_FOUND', 'Someone in the list is not an active person on this server; nobody was added.');
    const [present] = await cx.execute<RowDataPacket[]>(`SELECT user_id FROM org_group_members WHERE group_id = ? AND user_id IN (${ids.map(() => '?').join(', ')}) FOR UPDATE`, [groupId, ...ids]);
    const already = new Set(present.map(row => String(row.user_id).toLowerCase()));
    const added = people.map(row => String(row.id)).filter(id => !already.has(id.toLowerCase()));
    for (const id of added) {
      await cx.execute("INSERT INTO org_group_members (group_id, user_id, role, added_by) VALUES (?, ?, 'member', ?)", [groupId, id, userId]);
      await recordAudit({ action: 'group.member_added', actorId: userId, targetUserId: id, req, details: { group: groupId } }, cx);
    }
    return { value: null, reached: added };
  });
  return groupDetail(userId, groupId);
}

/**
 * DELETE /api/groups/:id/members/:userId (manage): a membership; no data.
 * A manager's membership only an administrator with groups.manage removes.
 */
async function removeMember(userId: string, groupId: string, memberId: unknown, req: AuthRequest | null = null): Promise<{ removed: true }> {
  await assertGroup(userId, groupId, 'manage');
  if (typeof memberId !== 'string' || !UUID.test(memberId)) throw notFound('MEMBER_NOT_FOUND', 'This person is not in the group.');
  return underRulesLock(async cx => {
    await assertGroup(userId, groupId, 'manage', cx);
    const [[membership]] = await cx.execute<RowDataPacket[]>('SELECT user_id, role FROM org_group_members WHERE group_id = ? AND user_id = ? FOR UPDATE', [groupId, memberId]);
    if (!membership) throw notFound('MEMBER_NOT_FOUND', 'This person is not in the group.');
    if (membership.role === 'manager') {
      const [[caller]] = await cx.execute<RowDataPacket[]>('SELECT role FROM users WHERE id = ?', [userId]);
      if (!roleCan(caller?.role, 'groups.manage')) throw forbidden('GROUP_FORBIDDEN', 'Only an administrator can remove a manager from a group.');
    }
    const member = String(membership.user_id);
    await cx.execute('DELETE FROM org_group_members WHERE group_id = ? AND user_id = ?', [groupId, member]);
    await recordAudit({ action: 'group.member_removed', actorId: userId, targetUserId: member, req, details: { group: groupId } }, cx);
    return { value: { removed: true as const }, reached: [member] };
  });
}

/** PUT /api/admin/groups/:id/managers/:userId (groups.manage): a person who is not in the group yet joins it as its manager. */
async function setManager(adminId: string, groupId: string, personId: unknown, input: unknown, req: AuthRequest | null = null): Promise<GroupResponse> {
  const manager = (input && typeof input === 'object' ? input as { manager?: unknown } : {}).manager;
  if (typeof manager !== 'boolean') throw badRequest('MANAGER_INVALID', 'Expected { manager: true | false }');
  await assertGroup(adminId, groupId, 'manage');
  if (typeof personId !== 'string' || !UUID.test(personId)) throw notFound('USER_NOT_FOUND', 'User not found');
  await underRulesLock(async cx => {
    await assertGroup(adminId, groupId, 'manage', cx);
    const [[person]] = await cx.execute<RowDataPacket[]>('SELECT id FROM users WHERE id = ? LOCK IN SHARE MODE', [personId]);
    if (!person) throw notFound('USER_NOT_FOUND', 'User not found');
    const id = String(person.id);
    const [[membership]] = await cx.execute<RowDataPacket[]>('SELECT role FROM org_group_members WHERE group_id = ? AND user_id = ? FOR UPDATE', [groupId, id]);
    if (!membership && !manager) throw notFound('MEMBER_NOT_FOUND', 'This person is not in the group.');
    const role: GroupRole = manager ? 'manager' : 'member';
    if (membership?.role === role) return { value: null, reached: [] };
    if (membership) await cx.execute('UPDATE org_group_members SET role = ? WHERE group_id = ? AND user_id = ?', [role, groupId, id]);
    else await cx.execute('INSERT INTO org_group_members (group_id, user_id, role, added_by) VALUES (?, ?, ?, ?)', [groupId, id, role, adminId]);
    await recordAudit({ action: 'admin.group_manager_set', actorId: adminId, targetUserId: id, req, details: { group: groupId, manager } }, cx);
    // Joining changes the person's rules; becoming or ceasing to be a manager does not.
    return { value: null, reached: membership ? [] : [id] };
  });
  return groupDetail(adminId, groupId);
}

/**
 * In the transaction that creates a person (Add person), before it commits:
 * they join the given groups as members. 404 GROUP_NOT_FOUND for an unknown group.
 * The caller holds the rules lock.
 */
async function joinGroups(cx: SqlExecutor, adminId: string, userId: string, groupIds: readonly string[]): Promise<void> {
  for (const groupId of groupIds) {
    const [[group]] = await cx.execute<RowDataPacket[]>('SELECT id FROM org_groups WHERE id = ? LOCK IN SHARE MODE', [groupId]);
    if (!group) throw notFound('GROUP_NOT_FOUND', 'Group not found');
    await cx.execute("INSERT INTO org_group_members (group_id, user_id, role, added_by) VALUES (?, ?, 'member', ?)", [group.id, userId, adminId]);
  }
}

export {
  groupsOf, membershipOf, groupExists, managesAnyGroup, allGroupIds, membershipsByUser,
  listGroups, myGroups, groupDetail, groupCandidates,
  createGroup, renameGroup, deleteGroup, addMembers, removeMember, setManager, joinGroups, underRulesLock,
};
