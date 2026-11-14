import fs from 'node:fs/promises';
import path from 'node:path';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { db } from '../state';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { withTransaction } from './transactions';
import { getActiveRestoreSections } from './restore-locks';
import { attachmentsRoot, rawRoot, mailPathUnderRoot, ownedMailPath } from './mail-storage';
import { RECORDINGS_ROOT, deleteRecordingFiles } from './recordings';
import { BACKUPS_ROOT, isBackupPathUnderRoot } from './export-jobs';
import { photosRoot } from './contact-photos';
import { realtime } from './realtime';
import { fileRemovalGate } from './file-removal-gate';
import { log } from '../log';
import { recordAudit } from './audit';
import { assertFinalStep } from './final-step';
import { withPersonLock } from './person-lock';
import type { AuthRequest, SqlExecutor } from '../types';
import type { AddPersonResponse, Person, PersonStatus, Role } from '../contracts/organisation';
import crypto from 'node:crypto';
import { can } from '../security/permissions';
import { hashPassword } from '../auth';
import { assertCaller } from './caller-proof';
import { joinGroups, membershipsByUser, underRulesLock } from './groups';
import { assertPasswordLength, createSetupLink, peopleWithLiveLinks } from './invites';
import { lastActiveByUser } from './devices';

type DeleteActor = 'self' | 'admin';
interface DeleteUserResult { files: { removed: number; failed: number; deferred?: boolean } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AdminLoss = 'delete' | 'demote' | 'deactivate';
const LAST_ADMIN: Readonly<Record<AdminLoss, string>> = {
  delete: 'Cannot delete the last active admin',
  demote: 'Cannot demote the last active admin',
  deactivate: 'Cannot deactivate the last active admin',
};

/**
 * In the transaction of a change that deletes, demotes or deactivates
 * `userId`: refuses it when they are the only active administrator. Every
 * active administrator's row is locked first, in id order, so two such
 * changes (each removing a different administrator) take turns and the
 * second counts what the first left. A route may refuse earlier for a quick
 * answer; this is the check that holds.
 */
async function assertKeepsAnAdmin(connection: SqlExecutor, userId: string, loss: AdminLoss) {
  const [admins] = await connection.execute<RowDataPacket[]>("SELECT id FROM users WHERE role IN ('owner', 'admin') AND is_active = TRUE ORDER BY id FOR UPDATE");
  if (admins.length <= 1 && admins.some(row => String(row.id) === userId)) throw badRequest('LAST_ADMIN', LAST_ADMIN[loss]);
}

const OWNER_PROTECTED: Readonly<Record<AdminLoss, string>> = {
  delete: 'The owner cannot be deleted. Hand ownership to another administrator first.',
  demote: 'The owner\'s role cannot be changed. Hand ownership to another administrator first.',
  deactivate: 'The owner cannot be deactivated. Hand ownership to another administrator first.',
};

/**
 * In the transaction of a change that deletes, demotes or deactivates
 * `userId`, with their row locked: refuses it while they are the owner, who
 * keeps the installation until they hand it on (POST /api/admin/owner/transfer).
 */
async function assertNotOwner(connection: SqlExecutor, userId: string, loss: AdminLoss) {
  const [rows] = await connection.execute<RowDataPacket[]>("SELECT 1 FROM users WHERE id = ? AND role = 'owner' FOR UPDATE", [userId]);
  if (rows.length) throw badRequest('OWNER_PROTECTED', OWNER_PROTECTED[loss]);
}

// Removing a person's account, whether they ask (DELETE /api/settings/account)
// or an administrator does (DELETE /api/admin/users/:id). The routes keep their
// own checks (password, role); this owns the owner and last-admin checks and the order that keeps the
// outcome recoverable: refuse while a restore writes for this person, stop the
// mail work that could still write files, delete the users row (every table
// cascades from it), then remove the files. A file that outlives its rows is a
// hygiene problem; a row whose file is gone would be data loss, so files go last.
// Under the person's lock (person-lock.ts), whoever asks.
async function deleteUser(userId: string, request: { actor: DeleteActor; actorId?: string | null; req?: AuthRequest | null }): Promise<DeleteUserResult> {
  return withPersonLock(userId, () => deleteUserNow(userId, request));
}

async function deleteUserNow(userId: string, { actor, actorId = null, req = null }: { actor: DeleteActor; actorId?: string | null; req?: AuthRequest | null }): Promise<DeleteUserResult> {
  if ((await getActiveRestoreSections(userId)).size > 0) {
    throw conflict('RESTORE_IN_PROGRESS', 'Restore in progress. The account can be deleted when it has finished.');
  }

  // Each with a pause of this change's own: refused, the mail work goes on
  // as before (mail-sync-control.ts stopOwnedMailAccountWork).
  const mail = require('./mail') as typeof import('./mail');
  const [accounts] = await db.execute<(RowDataPacket & { id: string })[]>('SELECT id FROM mail_accounts WHERE user_id = ?', [userId]);
  const pauses: Awaited<ReturnType<typeof mail.stopOwnedMailAccountWork>>[] = [];
  let removed: { deleted: boolean; files: Set<string>; recordingPaths: string[] };
  try {
    for (const account of accounts) pauses.push(await mail.stopOwnedMailAccountWork(account.id, actor === 'admin' ? 'Account deleted by an administrator' : 'Account deleted'));
    removed = await removeRows(userId, { actor, actorId, req });
  } catch (error) {
    for (const pause of pauses) await mail.releaseOwnedMailAccountStop(pause);
    throw error;
  }
  // The person's accounts and jobs are gone, and with them their turns.
  for (const pause of pauses) await mail.endOwnedMailAccountStop(pause);
  if (!removed.deleted) throw notFound('USER_NOT_FOUND', 'User not found');

  // The rows are gone; while an instance backup copies files, they go after it.
  const removal = await fileRemovalGate.run(() => removeUserFiles(userId, removed.files, removed.recordingPaths));
  const outcome: DeleteUserResult = removal === 'deferred' ? { files: { removed: 0, failed: 0, deferred: true } } : removal;
  realtime.closeUser(userId);
  return outcome;
}

// The files the rows name, then the rows: whether the users row went.
async function removeRows(userId: string, { actor, actorId, req }: { actor: DeleteActor; actorId: string | null; req: AuthRequest | null }) {

  // Collected before the rows go, checked against the configured roots like
  // the routes always did: the row proves ownership, the root check keeps a
  // stored path from reaching outside.
  const [[attachments], [rawEmails], [recordings], [exports]] = await Promise.all([
    db.execute<(RowDataPacket & { storage_path: string | null })[]>('SELECT storage_path FROM email_attachments WHERE user_id = ?', [userId]),
    db.execute<(RowDataPacket & { raw_storage_path: string | null })[]>('SELECT raw_storage_path FROM emails WHERE user_id = ? AND raw_storage_path IS NOT NULL', [userId]),
    db.execute<(RowDataPacket & { storage_path: string | null })[]>('SELECT storage_path FROM recordings WHERE user_id = ?', [userId]),
    db.execute<(RowDataPacket & { file_path: string | null })[]>('SELECT file_path FROM data_export_jobs WHERE user_id = ?', [userId]),
  ]);
  const files = new Set<string>();
  for (const row of attachments) {
    const file = mailPathUnderRoot('attachment', row.storage_path);
    if (file) files.add(file);
  }
  for (const row of rawEmails) {
    const file = ownedMailPath('raw', row.raw_storage_path, userId);
    if (file) files.add(file);
  }
  for (const row of exports) {
    if (row.file_path && isBackupPathUnderRoot(row.file_path)) files.add(path.resolve(row.file_path));
  }
  const recordingPaths = recordings.map(row => row.storage_path).filter((value): value is string => Boolean(value));

  const deleted = await withTransaction(async connection => {
    // Under the person's row, the final check (final-step.ts): their own
    // request still allowed (account.delete), and no restore of theirs
    // admitted meanwhile.
    // An administrator's account, also their own, never the last one.
    await assertKeepsAnAdmin(connection, userId, 'delete');
    const [[person]] = await connection.execute<RowDataPacket[]>('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!person) return false;
    await assertNotOwner(connection, userId, 'delete');
    await assertFinalStep(connection, { userId, policies: actor === 'self' ? ['account.delete'] : [], anyRestore: true });
    const [result] = await connection.execute<ResultSetHeader>('DELETE FROM users WHERE id = ?', [userId]);
    if (result.affectedRows > 0) {
      await recordAudit({ action: actor === 'admin' ? 'admin.user_deleted' : 'auth.account_deleted', actorId, targetUserId: userId, req }, connection);
    }
    return result.affectedRows > 0;
  });
  return { deleted, files, recordingPaths };
}

// Never throws: the rows are gone, so a file that stays behind is reported in
// the log and shows in the admin storage overview as orphaned.
async function removeUserFiles(userId: string, files: Set<string>, recordingPaths: readonly string[]): Promise<DeleteUserResult> {
  let removed = 0;
  const failed: string[] = [];
  for (const file of files) {
    try {
      await fs.rm(file, { force: true });
      removed++;
    } catch (error) {
      failed.push(file);
      log.error('USERS', 'Could not remove a deleted user\'s file', error);
    }
  }
  for (const storagePath of recordingPaths) {
    await deleteRecordingFiles(storagePath);
    removed++;
  }
  // Each root keeps one directory per person (<root>/<userId>/...), so what no
  // row named any more (staged uploads, a file whose row was lost) goes with it.
  if (UUID.test(userId)) {
    const roots = [attachmentsRoot(), rawRoot(), RECORDINGS_ROOT, path.join(RECORDINGS_ROOT, '.tmp'), BACKUPS_ROOT, photosRoot()];
    for (const directory of roots.map(root => path.join(root, userId))) {
      try {
        await fs.rm(directory, { recursive: true, force: true });
      } catch (error) {
        failed.push(directory);
        log.error('USERS', 'Could not remove a deleted user\'s directory', error);
      }
    }
  }
  if (failed.length) log.error('USERS', 'Files of a deleted user remain on disk', undefined, { user: userId, count: failed.length, files: failed.join(', ') });
  return { files: { removed, failed: failed.length } };
}

// --- People (0.30): the list, Add person, the owner ------------------------------

const GRACE_DAYS = 7;
const UUID_LIST_MAX = 50;
const iso = (value: unknown) => (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString();

/** GET /api/admin/users (users.read): everyone, newest first, with status, groups and last use. */
async function listPeople(onlyId: string | null = null): Promise<Person[]> {
  const [[rows], groups, links, lastActive] = await Promise.all([
    db.execute<RowDataPacket[]>(`SELECT id, email, full_name, role, is_active, two_factor_enabled, two_factor_required_since, created_at,
        password_hash = '' AS no_password FROM users${onlyId ? ' WHERE id = ?' : ''} ORDER BY created_at DESC, id`, onlyId ? [onlyId] : []),
    membershipsByUser(), peopleWithLiveLinks(), lastActiveByUser(),
  ]);
  return rows.map(row => {
    const id = String(row.id);
    const status: PersonStatus = !Number(row.is_active) ? 'inactive' : Number(row.no_password) ? (links.has(id) ? 'invited' : 'not_set_up') : 'active';
    const graceStart = !row.two_factor_enabled && row.two_factor_required_since ? new Date(iso(row.two_factor_required_since)) : null;
    return {
      id, email: String(row.email), full_name: row.full_name ?? null, role: row.role as Role, status,
      is_active: !!Number(row.is_active), two_factor_enabled: !!Number(row.two_factor_enabled),
      two_factor_grace_ends_at: graceStart ? new Date(graceStart.getTime() + GRACE_DAYS * 86400000).toISOString() : null,
      groups: groups.get(id) ?? [], created_at: iso(row.created_at), last_active_at: lastActive.get(id) ?? null,
    };
  });
}

const adminsManageRequired = () => forbidden('ADMINS_MANAGE_REQUIRED', 'Only the owner can make or remove administrators; nothing was changed.');

/** In the change's transaction: the caller (caller-proof.ts) may make or remove administrators. */
async function assertCallerManagesAdmins(connection: SqlExecutor, callerId: string) {
  const [[caller]] = await connection.execute<RowDataPacket[]>('SELECT role FROM users WHERE id = ? LOCK IN SHARE MODE', [callerId]);
  if (!can(caller?.role, 'admins.manage')) throw adminsManageRequired();
}

function personInput(input: unknown) {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw badRequest('EMAIL_INVALID', 'Enter the person\'s email address.');
  if (body.full_name != null && (typeof body.full_name !== 'string' || body.full_name.length > 255)) throw badRequest('NAME_INVALID', 'A name has at most 255 characters.');
  const fullName = typeof body.full_name === 'string' && body.full_name.trim() ? body.full_name.trim() : null;
  if (body.role !== 'user' && body.role !== 'admin') throw badRequest('ROLE_INVALID', 'The role is user or admin.');
  const groupIds = body.group_ids ?? [];
  if (!Array.isArray(groupIds) || groupIds.length > UUID_LIST_MAX || !groupIds.every(id => typeof id === 'string' && UUID.test(id))) {
    throw badRequest('GROUPS_INVALID', `Expected group_ids: at most ${UUID_LIST_MAX} group ids.`);
  }
  if (body.password != null && (typeof body.password !== 'string' || !body.password.length || body.password.length > 1024)) throw badRequest('PASSWORD_INVALID', 'Invalid password');
  return { email, fullName, role: body.role as 'user' | 'admin', groupIds: [...new Set(groupIds.map(id => (id as string).toLowerCase()))], password: (body.password as string | undefined) ?? null };
}

/**
 * POST /api/admin/users (users.manage; admins.manage for an administrator),
 * after the route checked the administrator's password: the account exists
 * at once, in its groups. Without a password the answer carries a setup
 * link; with one, the person signs in with it. The password must meet the
 * person's minimum (their groups included).
 */
async function addPerson(adminId: string, input: unknown, req: AuthRequest | null = null): Promise<AddPersonResponse> {
  const person = personInput(input);
  const passwordHash = person.password ? await hashPassword(person.password) : '';
  const id = crypto.randomUUID();
  const setupLink = await underRulesLock(async cx => {
    if (person.role === 'admin') await assertCallerManagesAdmins(cx, adminId);
    try {
      await cx.execute('INSERT INTO users (id, email, password_hash, full_name, role, email_verified, is_active) VALUES (?, ?, ?, ?, ?, TRUE, TRUE)',
        [id, person.email, passwordHash, person.fullName, person.role]);
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw conflict('USER_EXISTS', 'Someone on this server already uses this address.');
      throw error;
    }
    await joinGroups(cx, adminId, id, person.groupIds);
    if (person.password) await assertPasswordLength(id, person.password, cx);
    const link = person.password ? null : await createSetupLink(cx, adminId, id, req);
    await recordAudit({ action: 'admin.user_created', actorId: adminId, targetUserId: id, req,
      details: { role: person.role, groups: person.groupIds.length, setup: link ? 'link' : 'password' } }, cx);
    return { value: link, reached: [id] };
  });
  const [user] = await listPeople(id);
  return { user, setup_link: setupLink };
}

/**
 * POST /api/admin/owner/transfer (owner.transfer), after the route checked
 * the owner's password: an active administrator becomes the owner and the
 * owner an administrator, in one transaction (the database allows one owner).
 */
async function transferOwnership(ownerId: string, targetId: unknown, req: AuthRequest | null = null): Promise<{ owner: string }> {
  if (typeof targetId !== 'string' || !UUID.test(targetId)) throw notFound('USER_NOT_FOUND', 'User not found');
  return withTransaction(async cx => {
    const [rows] = await cx.execute<RowDataPacket[]>('SELECT id, role, is_active, password_hash FROM users WHERE id IN (?, ?) ORDER BY id FOR UPDATE', [ownerId, targetId]);
    await assertCaller(cx);
    const target = rows.find(row => String(row.id).toLowerCase() === targetId.toLowerCase());
    if (!target) throw notFound('USER_NOT_FOUND', 'User not found');
    if (String(target.id) === ownerId) throw badRequest('OWNER_TRANSFER_INVALID', 'You are the owner already.');
    if (target.role !== 'admin' || !Number(target.is_active) || !target.password_hash) {
      throw badRequest('OWNER_TRANSFER_INVALID', 'Ownership goes to an active administrator. Make them an administrator first.');
    }
    await cx.execute("UPDATE users SET role = 'admin' WHERE id = ? AND role = 'owner'", [ownerId]);
    await cx.execute("UPDATE users SET role = 'owner' WHERE id = ?", [target.id]);
    await recordAudit({ action: 'owner.transferred', actorId: ownerId, targetUserId: String(target.id), req }, cx);
    return { owner: String(target.id) };
  });
}

export type { DeleteActor, DeleteUserResult };
export { assertKeepsAnAdmin, assertNotOwner, assertCallerManagesAdmins, deleteUser, listPeople, addPerson, transferOwnership };
