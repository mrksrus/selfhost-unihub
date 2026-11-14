import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { GroupRole, PersonGroup } from '../contracts/organisation';

import { db } from '../state';

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

/** Every group's id, by name. */
async function allGroupIds(executor: SqlExecutor = db): Promise<string[]> {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT id FROM org_groups ORDER BY name, id');
  return rows.map(row => String(row.id));
}

export { groupsOf, membershipOf, groupExists, allGroupIds };
