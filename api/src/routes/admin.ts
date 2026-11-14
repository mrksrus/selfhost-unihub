import type { RowDataPacket } from 'mysql2/promise';
import type { RouteRequest, ApiError, SqlExecutor } from '../types';
import fs from 'fs';
import path from 'path';
import { db } from '../state';
import { MIN_PASSWORD_LENGTH } from '../config';
import { attachmentsRoot, rawRoot } from '../services/mail-storage';
import { RECORDINGS_ROOT } from '../services/recordings';
import { BACKUPS_ROOT } from '../services/export-jobs';
import { realtime } from '../services/realtime';
import { endUserSessions, lockOwnSession } from '../services/sessions';
import { assertKeepsAnAdmin, assertNotOwner, deleteUser } from '../services/user-lifecycle';
import { asCaller, assertCaller } from '../services/caller-proof';
import { withTransaction } from '../services/transactions';
import { listAuditLog, recordAudit, recordAuditAfter } from '../services/audit';
import { clientError } from '../http/errors';
import {
  hashPassword,
  getAuthTokenFromRequest,
} from '../auth';
import { confirmPassword, confirmPasswordHash } from '../security/reauthentication';
import { disableTwoFactor } from '../services/two-factor';
import { getSignupMode, isSignupMode, setSignupMode } from '../services/settings';
import { defineRoutes } from '../http/route';
import { can } from '../security/permissions';
import { personFromParam } from '../services/admin-path';

type Request = RouteRequest & { url: string; params: Record<string, string> };
interface Input {
  new_password?: string;
  current_password?: unknown;
  role?: unknown;
  is_active?: unknown;
  signup_mode: string;
}

async function getActiveAdminCount() {
  const [rows] = await db.execute<RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM users WHERE role IN ('owner', 'admin') AND is_active = TRUE"
  );
  return Number(rows[0]?.count || 0);
}

// Changing another person's password, role or 2FA, deactivating or deleting
// them needs the admin's own password again, so a stolen or unattended admin
// session cannot take over or remove an account (security/reauthentication.ts).
// The person's row, locked for the change: false when they are gone.
async function lockPerson(connection: SqlExecutor, id: string) {
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT id FROM users WHERE id = ? FOR UPDATE', [id]);
  return rows.length > 0;
}

// The person of `:id` as stored (admin-path.ts personFromParam): one
// spelling of their id for the checks below and for every change.
async function storedPerson(req: Request): Promise<{ id: string } | { refused: ReturnType<typeof clientError> }> {
  try { return { id: await personFromParam(req.params.id) }; } catch (error) { return { refused: clientError(error, 'User not found') }; }
}

function confirmAdminPassword(userId: string, body: Input, res?: import('node:http').ServerResponse | null) {
  return confirmPassword(userId, body?.current_password, res);
}

// The change of a person's password, role or status, or their deletion, as
// the administrator who asked (services/caller-proof.ts): its final step asks
// again, under its locks, that they are still an active administrator,
// signed in with this session and, where they entered it, this password
// (`passwordHash`, the hash it matched; null when none was asked).
function asAdmin<T>(req: Request, userId: string, passwordHash: string | null, work: () => Promise<T>) {
  return asCaller({ userId, token: getAuthTokenFromRequest(req), permission: 'users.manage', passwordHash }, work);
}

async function getUserRoleStatus(targetId: string) {
  const [rows] = await db.execute<RowDataPacket[]>(
    'SELECT id, email, role, is_active FROM users WHERE id = ? LIMIT 1',
    [targetId]
  );
  return rows[0] || null;
}

function numericValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function sumFilesUnder(rootPath: string) {
  const resolvedRoot = path.resolve(rootPath);
  const totals = { bytes: 0, files: 0, exists: true, error: null as string | null };
  async function walk(currentPath: string) {
    let entries;
    try {
      entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if ((error as ApiError).code === 'ENOENT') {
        if (currentPath === resolvedRoot) totals.exists = false;
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.promises.stat(entryPath);
      totals.files += 1;
      totals.bytes += stat.size;
    }
  }

  try {
    await walk(resolvedRoot);
  } catch (error) {
    totals.error = (error as ApiError).message || 'Failed to scan storage path';
  }
  return totals;
}

async function sumFilesByImmediateChild(rootPath: string, ignoredNames = new Set<string>()) {
  const resolvedRoot = path.resolve(rootPath);
  const result = new Map();
  let entries;

  try {
    entries = await fs.promises.readdir(resolvedRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as ApiError).code === 'ENOENT') return result;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredNames.has(entry.name)) continue;
    const totals = await sumFilesUnder(path.join(resolvedRoot, entry.name));
    result.set(entry.name, {
      bytes: totals.bytes,
      files: totals.files,
    });
  }

  return result;
}

function getUserStorageSection(sectionMap: Map<string, { bytes: number; files: number }>, userId: string) {
  return sectionMap.get(String(userId)) || { bytes: 0, files: 0 };
}

async function buildAdminStorageOverview() {
  const [
    [userRows],
    [users],
    [mailRows],
    [attachmentRows],
    [rawMailRows],
    [recordingRows],
    [exportRows],
    [contactRows],
    [calendarRows],
    attachmentFiles,
    rawMailFiles,
    recordingFiles,
    exportFiles,
    attachmentFilesByUser,
    rawMailFilesByUser,
    recordingFilesByUser,
    exportFilesByUser,
  ] = await Promise.all([
    db.execute<RowDataPacket[]>('SELECT COUNT(*) AS total, SUM(is_active = TRUE) AS active FROM users'),
    db.execute<RowDataPacket[]>('SELECT id, email, full_name, is_active FROM users ORDER BY created_at DESC'),
    db.execute<RowDataPacket[]>('SELECT (SELECT COUNT(*) FROM mail_accounts) AS accounts, (SELECT COUNT(*) FROM emails) AS emails'),
    db.execute<RowDataPacket[]>('SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM email_attachments'),
    db.execute<RowDataPacket[]>('SELECT COUNT(*) AS emails_with_raw FROM emails WHERE raw_storage_path IS NOT NULL'),
    db.execute<RowDataPacket[]>('SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM recordings'),
    db.execute<RowDataPacket[]>("SELECT COUNT(*) AS jobs, SUM(status = 'ready') AS ready_jobs, COALESCE(SUM(file_size), 0) AS bytes FROM data_export_jobs"),
    db.execute<RowDataPacket[]>('SELECT COUNT(*) AS contacts FROM contacts'),
    db.execute<RowDataPacket[]>('SELECT COUNT(*) AS events FROM calendar_events'),
    sumFilesUnder(attachmentsRoot()),
    sumFilesUnder(rawRoot()),
    sumFilesUnder(RECORDINGS_ROOT),
    sumFilesUnder(BACKUPS_ROOT),
    sumFilesByImmediateChild(attachmentsRoot()),
    sumFilesByImmediateChild(rawRoot()),
    sumFilesByImmediateChild(RECORDINGS_ROOT, new Set(['.tmp'])),
    sumFilesByImmediateChild(BACKUPS_ROOT),
  ]);

  const sections = [
    {
      key: 'mail_attachments',
      label: 'Mail attachments',
      bytes: attachmentFiles.bytes,
      files: attachmentFiles.files,
      tracked_bytes: numericValue(attachmentRows[0]?.bytes),
      tracked_items: numericValue(attachmentRows[0]?.files),
      path_exists: attachmentFiles.exists,
      scan_error: attachmentFiles.error,
    },
    {
      key: 'mail_raw',
      label: 'Raw mail archive',
      bytes: rawMailFiles.bytes,
      files: rawMailFiles.files,
      tracked_items: numericValue(rawMailRows[0]?.emails_with_raw),
      path_exists: rawMailFiles.exists,
      scan_error: rawMailFiles.error,
    },
    {
      key: 'recordings',
      label: 'Recordings',
      bytes: recordingFiles.bytes,
      files: recordingFiles.files,
      tracked_bytes: numericValue(recordingRows[0]?.bytes),
      tracked_items: numericValue(recordingRows[0]?.files),
      path_exists: recordingFiles.exists,
      scan_error: recordingFiles.error,
    },
    {
      key: 'exports',
      label: 'Generated exports',
      bytes: exportFiles.bytes,
      files: exportFiles.files,
      tracked_bytes: numericValue(exportRows[0]?.bytes),
      tracked_items: numericValue(exportRows[0]?.jobs),
      ready_items: numericValue(exportRows[0]?.ready_jobs),
      path_exists: exportFiles.exists,
      scan_error: exportFiles.error,
    },
  ];
  const usersById = new Map((users || []).map(row => [String(row.id), row]));
  const userIds = new Set([
    ...(users || []).map(row => String(row.id)),
    ...attachmentFilesByUser.keys(),
    ...rawMailFilesByUser.keys(),
    ...recordingFilesByUser.keys(),
    ...exportFilesByUser.keys(),
  ]);

  const perUser = Array.from(userIds).map((userId) => {
    const user = usersById.get(userId);
    const mailAttachments = getUserStorageSection(attachmentFilesByUser, userId);
    const mailRaw = getUserStorageSection(rawMailFilesByUser, userId);
    const recordings = getUserStorageSection(recordingFilesByUser, userId);
    const exports = getUserStorageSection(exportFilesByUser, userId);
    const userSections = {
      mail_attachments: mailAttachments,
      mail_raw: mailRaw,
      recordings,
      exports,
    };
    const bytes = Object.values(userSections).reduce((sum, section) => sum + section.bytes, 0);
    const files = Object.values(userSections).reduce((sum, section) => sum + section.files, 0);
    return {
      user_id: userId,
      email: user?.email || null,
      full_name: user?.full_name || null,
      is_active: user ? !!user.is_active : false,
      orphaned: !user,
      bytes,
      files,
      sections: userSections,
    };
  }).sort((a, b) => b.bytes - a.bytes || String(a.email || a.user_id).localeCompare(String(b.email || b.user_id)));

  return {
    generated_at: new Date().toISOString(),
    totals: {
      users: numericValue(userRows[0]?.total),
      active_users: numericValue(userRows[0]?.active),
      mail_accounts: numericValue(mailRows[0]?.accounts),
      emails: numericValue(mailRows[0]?.emails),
      contacts: numericValue(contactRows[0]?.contacts),
      calendar_events: numericValue(calendarRows[0]?.events),
      bytes: sections.reduce((sum, section) => sum + section.bytes, 0),
      files: sections.reduce((sum, section) => sum + section.files, 0),
    },
    sections,
    users: perUser,
  };
}

export = defineRoutes({
  // The boundary admits only an admin session (auth 'admin'); the 2FA reset
  // re-checks the role inside its transaction because it also verifies the
  // admin's password and live session there.
  'GET /api/admin/storage': { auth: 'admin', permission: 'storage.read', module: null, handler: async (req: Request, userId: string) => {

    try {
      return { storage: await buildAdminStorageOverview() };
    } catch (error) {
      console.error('Admin storage overview error:', error);
      return { error: 'Failed to get storage overview', status: 500 };
    }
  } },

  'GET /api/admin/users': { auth: 'admin', permission: 'users.read', module: null, handler: async (req: Request, userId: string) => {

    try {
      const [users] = await db.execute<RowDataPacket[]>(
        'SELECT id, email, full_name, role, is_active, two_factor_enabled, created_at FROM users ORDER BY created_at DESC'
      );
      return { users: users.map(user => ({ ...user, two_factor_enabled: !!user.two_factor_enabled })) };
    } catch (error) {
      return { error: 'Failed to get users', status: 500 };
    }
  } },

  'PUT /api/admin/users/:id/password': { auth: 'admin', permission: 'users.manage', module: null, restoreSection: null, body: { limit: 4096 }, handler: async (req: Request, userId: string, body: Input, res: import('node:http').ServerResponse) => {

    const target = await storedPerson(req);
    if ('refused' in target) return target.refused;
    const targetId = target.id;
    const { new_password } = body;

    if (!new_password || new_password.length < MIN_PASSWORD_LENGTH) {
      return { error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`, status: 400 };
    }

    try {
      const confirmed = await confirmPasswordHash(userId, body?.current_password, res);
      if ('refused' in confirmed) return confirmed.refused;
      const newHash = await hashPassword(new_password);
      const found = await asAdmin(req, userId, confirmed.passwordHash, () => withTransaction(async connection => {
        if (!await lockPerson(connection, targetId)) return false;
        await assertCaller(connection);
        await connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, targetId]);
        // Invalidate all sessions so the user must re-login
        await endUserSessions(targetId, connection);
        return true;
      }));
      if (!found) return { error: 'User not found', status: 404 };
      realtime.closeUser(targetId);
      await recordAuditAfter({ action: 'admin.password_reset', actorId: userId, targetUserId: targetId, req });
      return { message: 'Password updated successfully' };
    } catch (error) {
      if (!(error as ApiError).status) console.error('Admin password reset error:', error);
      return clientError(error, 'Failed to update password');
    }
  } },

  // For a user who lost both the authenticator and the recovery codes. The admin
  // confirms with their own password; their own 2FA is turned off in Settings,
  // which needs a code, so a stolen admin session cannot remove it.
  'POST /api/admin/users/:id/2fa/reset': { auth: 'admin', permission: 'users.manage', module: null, restoreSection: null, handler: async (req: Request, userId: string, body: Input, res: import('node:http').ServerResponse) => {

    const target = await storedPerson(req);
    if ('refused' in target) return target.refused;
    const targetId = target.id;
    if (targetId === userId) {
      return { error: 'Turn off your own two-factor authentication in Settings', status: 400 };
    }
    let connection;
    try {
      const refused = await confirmAdminPassword(userId, body, res);
      if (refused) return refused;
      const [admins] = await db.execute<RowDataPacket[]>('SELECT password_hash FROM users WHERE id = ?', [userId]);
      connection = await db.getConnection();
      await connection.beginTransaction();
      // Both rows in one statement, in id order, so two admins resetting each other cannot deadlock.
      // 2FA setup locks the user row too; together with the session check below, a request from an
      // admin session that was signed out meanwhile (e.g. by enabling 2FA elsewhere) changes nothing.
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT id, role, is_active, two_factor_enabled, password_hash FROM users WHERE id IN (?, ?) ORDER BY id FOR UPDATE', [userId, targetId]);
      const requester = rows.find(row => row.id === userId);
      const current = await lockOwnSession(userId, getAuthTokenFromRequest(req), connection);
      // Deactivation and password changes commit before they delete sessions, so check the
      // flag and that the password verified above is still the admin's.
      if (!current || !requester?.is_active || requester.password_hash !== admins[0].password_hash) {
        await connection.rollback();
        return { error: 'Unauthorized', status: 401 };
      }
      if (!can(requester?.role, 'users.manage')) { await connection.rollback(); return { error: 'Forbidden', status: 403 }; }
      const targets = rows.filter(row => row.id === targetId);
      if (!targets.length) { await connection.rollback(); return { error: 'User not found', status: 404 }; }
      if (!targets[0].two_factor_enabled) {
        await connection.rollback();
        return { error: 'Two-factor authentication is not enabled for this user', status: 400 };
      }
      await disableTwoFactor(targetId, connection);
      await connection.execute('DELETE FROM two_factor_challenges WHERE user_id = ?', [targetId]);
      // Sessions may be on the lost device.
      await endUserSessions(targetId, connection);
      await recordAudit({ action: 'admin.two_factor_reset', actorId: userId, targetUserId: targetId, req }, connection);
      await connection.commit();
      realtime.closeUser(targetId);
      return { message: 'Two-factor authentication reset' };
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      console.error('Admin 2FA reset error:', error);
      return { error: 'Failed to reset two-factor authentication', status: 500 };
    } finally {
      connection?.release();
    }
  } },

  'DELETE /api/admin/users/:id': { auth: 'admin', permission: 'users.manage', module: null, restoreSection: null, body: { limit: 4096 }, handler: async (req: Request, userId: string, body: Input, res: import('node:http').ServerResponse) => {

    const target = await storedPerson(req);
    if ('refused' in target) return target.refused;
    const id = target.id;

    if (id === userId) {
      return { error: 'Cannot delete your own account', status: 400 };
    }

    try {
      const confirmed = await confirmPasswordHash(userId, body?.current_password, res);
      if ('refused' in confirmed) return confirmed.refused;
      const targetUser = await getUserRoleStatus(id);
      if (!targetUser) return { error: 'User not found', status: 404 };
      // A quick answer before any work stops; deleteUser checks again under its locks.
      if (can(targetUser.role, 'users.manage') && targetUser.is_active && (await getActiveAdminCount()) <= 1) {
        return { error: 'Cannot delete the last active admin', status: 400 };
      }
      await asAdmin(req, userId, confirmed.passwordHash, () => deleteUser(id, { actor: 'admin', actorId: userId, req }));
      return { message: 'User deleted' };
    } catch (error) {
      if (!(error as ApiError).status) console.error('Admin delete user error:', error);
      return clientError(error, 'Failed to delete user');
    }
  } },

  'PUT /api/admin/users/:id/role': { auth: 'admin', permission: 'users.manage', module: null, restoreSection: null, body: { limit: 4096 }, handler: async (req: Request, userId: string, body: Input, res: import('node:http').ServerResponse) => {

    const target = await storedPerson(req);
    if ('refused' in target) return target.refused;
    const id = target.id;
    const nextRole = String(body?.role || '').trim().toLowerCase();
    if (!['user', 'admin'].includes(nextRole)) {
      return { error: 'Invalid role. Must be user or admin.', status: 400 };
    }

    try {
      const confirmed = await confirmPasswordHash(userId, body?.current_password, res);
      if ('refused' in confirmed) return confirmed.refused;
      const found = await asAdmin(req, userId, confirmed.passwordHash, () => withTransaction(async connection => {
        if (nextRole === 'user') await assertKeepsAnAdmin(connection, id, 'demote');
        if (!await lockPerson(connection, id)) return false;
        await assertNotOwner(connection, id, 'demote');
        await assertCaller(connection);
        await connection.execute('UPDATE users SET role = ? WHERE id = ?', [nextRole, id]);
        return true;
      }));
      if (!found) return { error: 'User not found', status: 404 };
      await recordAuditAfter({ action: 'admin.role_changed', actorId: userId, targetUserId: id, req, details: { role: nextRole } });
      return { message: `User role set to ${nextRole}` };
    } catch (error) {
      if (!(error as ApiError).status) console.error('Update user role error:', error);
      return clientError(error, 'Failed to update user role');
    }
  } },

  'PUT /api/admin/users/:id/activate': { auth: 'admin', permission: 'users.manage', module: null, restoreSection: null, body: { limit: 4096 }, handler: async (req: Request, userId: string, body: Input, res: import('node:http').ServerResponse) => {

    const target = await storedPerson(req);
    if ('refused' in target) return target.refused;
    const id = target.id;
    const { is_active } = body;

    try {
      // Activating gives an account back; taking it away is confirmed.
      let passwordHash: string | null = null;
      if (!is_active) {
        const confirmed = await confirmPasswordHash(userId, body?.current_password, res);
        if ('refused' in confirmed) return confirmed.refused;
        passwordHash = confirmed.passwordHash;
      }
      const found = await asAdmin(req, userId, passwordHash, () => withTransaction(async connection => {
        if (!is_active) await assertKeepsAnAdmin(connection, id, 'deactivate');
        if (!await lockPerson(connection, id)) return false;
        if (!is_active) await assertNotOwner(connection, id, 'deactivate');
        await assertCaller(connection);
        await connection.execute('UPDATE users SET is_active = ? WHERE id = ?', [!!is_active, id]);
        if (!is_active) await endUserSessions(id, connection);
        return true;
      }));
      if (!found) return { error: 'User not found', status: 404 };
      if (!is_active) realtime.closeUser(id);
      await recordAuditAfter({ action: is_active ? 'admin.user_activated' : 'admin.user_deactivated', actorId: userId, targetUserId: id, req });
      return { message: is_active ? 'User activated' : 'User deactivated' };
    } catch (error) {
      if (!(error as ApiError).status) console.error('Update user status error:', error);
      return clientError(error, 'Failed to update user status');
    }
  } },

  // Newest first; `before` is the `cursor` of the previous page.
  'GET /api/admin/audit': { auth: 'admin', permission: 'audit.read', module: null, handler: async (req: Request) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const cursor = url.searchParams.get('before');
    const [createdAt, id] = cursor ? cursor.split('|') : [];
    const before = createdAt && id && !Number.isNaN(Date.parse(createdAt)) && /^[0-9a-f-]{36}$/i.test(id) ? { createdAt, id } : null;
    const { entries, more } = await listAuditLog({ limit: Number(url.searchParams.get('limit')) || 50, before });
    const last = entries[entries.length - 1];
    return { entries, cursor: more && last ? `${last.createdAt}|${last.id}` : null };
  } },

  'GET /api/admin/settings/signup-mode': { auth: 'admin', permission: 'server.settings', module: null, handler: async (req: Request, userId: string) => {

    try {
      const mode = await getSignupMode();
      return { signup_mode: mode };
    } catch (error) {
      return { error: 'Failed to get settings', status: 500 };
    }
  } },

  'PUT /api/admin/settings/signup-mode': { auth: 'admin', permission: 'server.settings', module: null, restoreSection: null, handler: async (req: Request, userId: string, body: Input) => {

    const { signup_mode } = body;
    if (!isSignupMode(signup_mode)) {
      return { error: 'Invalid signup mode. Must be: open, approval, or disabled', status: 400 };
    }

    try {
      await setSignupMode(signup_mode);
      await recordAuditAfter({ action: 'admin.signup_mode_changed', actorId: userId, req, details: { mode: signup_mode } });
      return { message: `Signup mode set to: ${signup_mode}` };
    } catch (error) {
      return { error: 'Failed to update settings', status: 500 };
    }
  } },
});
