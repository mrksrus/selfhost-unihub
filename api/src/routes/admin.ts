import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { RouteRequest, ApiError } from '../types';
import fs from 'fs';
import path from 'path';
import { db } from '../state';
import { MIN_PASSWORD_LENGTH } from '../config';
import { MAIL_RAW_STORAGE_ROOT } from '../services/mail';
import { RECORDINGS_ROOT, deleteRecordingFiles } from '../services/recordings';
import { BACKUPS_ROOT } from '../services/export-jobs';
import { serverEvents } from '../services/server-events';
import {
  isAdmin,
  hashPassword,
  verifyPassword,
  consumeAuthAttempt,
  getSignupMode,
  getAuthTokenFromRequest,
} from '../auth';
import { disableTwoFactor } from '../services/two-factor';

type Request = RouteRequest & { url: string; params: Record<string, string> };
interface Input {
  new_password?: string;
  current_password?: unknown;
  role?: unknown;
  is_active?: unknown;
  signup_mode: string;
}

const ATTACHMENTS_ROOT = '/app/uploads/attachments';

async function getActiveAdminCount() {
  const [rows] = await db.execute<RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = TRUE"
  );
  return Number(rows[0]?.count || 0);
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
    sumFilesUnder(ATTACHMENTS_ROOT),
    sumFilesUnder(MAIL_RAW_STORAGE_ROOT),
    sumFilesUnder(RECORDINGS_ROOT),
    sumFilesUnder(BACKUPS_ROOT),
    sumFilesByImmediateChild(ATTACHMENTS_ROOT),
    sumFilesByImmediateChild(MAIL_RAW_STORAGE_ROOT),
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

export = {
  // ── Admin endpoints (require admin role) ────────────────────────
  'GET /api/admin/storage': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    try {
      return { storage: await buildAdminStorageOverview() };
    } catch (error) {
      console.error('Admin storage overview error:', error);
      return { error: 'Failed to get storage overview', status: 500 };
    }
  },

  'GET /api/admin/users': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    try {
      const [users] = await db.execute<RowDataPacket[]>(
        'SELECT id, email, full_name, role, is_active, two_factor_enabled, created_at FROM users ORDER BY created_at DESC'
      );
      return { users: users.map(user => ({ ...user, two_factor_enabled: !!user.two_factor_enabled })) };
    } catch (error) {
      return { error: 'Failed to get users', status: 500 };
    }
  },

  'PUT /api/admin/users/:id/password': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    const parts = req.url.split('?')[0].split('/');
    const targetId = parts[parts.length - 2];
    const { new_password } = body;

    if (!new_password || new_password.length < MIN_PASSWORD_LENGTH) {
      return { error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`, status: 400 };
    }

    try {
      const newHash = await hashPassword(new_password);
      await db.execute<RowDataPacket[]>('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, targetId]);
      // Invalidate all sessions so the user must re-login
      await db.execute<RowDataPacket[]>('DELETE FROM sessions WHERE user_id = ?', [targetId]);
      serverEvents.closeUser(targetId);
      return { message: 'Password updated successfully' };
    } catch (error) {
      return { error: 'Failed to update password', status: 500 };
    }
  },

  // For a user who lost both the authenticator and the recovery codes. The admin
  // confirms with their own password; their own 2FA is turned off in Settings,
  // which needs a code, so a stolen admin session cannot remove it.
  'POST /api/admin/users/:id/2fa/reset': async (req: Request, userId: string | null, body: Input, res: import('node:http').ServerResponse) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    const parts = req.url.split('?')[0].split('/');
    const targetId = parts[parts.length - 3];
    if (targetId === userId) {
      return { error: 'Turn off your own two-factor authentication in Settings', status: 400 };
    }
    const retryAfter = consumeAuthAttempt('password', userId);
    if (retryAfter) {
      res?.setHeader('Retry-After', String(retryAfter));
      return { error: `Too many attempts. Try again in ${retryAfter} seconds.`, status: 429 };
    }
    const currentPassword = body?.current_password;
    if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 1024) {
      return { error: 'Your current password is required', status: 400 };
    }

    let connection;
    try {
      const [admins] = await db.execute<RowDataPacket[]>('SELECT password_hash FROM users WHERE id = ?', [userId]);
      if (!admins.length || !(await verifyPassword(currentPassword, admins[0].password_hash))) {
        // Not 401: the client treats a 401 outside /api/auth/ as an expired session and signs out.
        return { error: 'Current password is incorrect', status: 403 };
      }
      connection = await db.getConnection();
      await connection.beginTransaction();
      // Both rows in one statement, in id order, so two admins resetting each other cannot deadlock.
      // 2FA setup locks the user row too; together with the session check below, a request from an
      // admin session that was signed out meanwhile (e.g. by enabling 2FA elsewhere) changes nothing.
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT id, role, is_active, two_factor_enabled, password_hash FROM users WHERE id IN (?, ?) ORDER BY id FOR UPDATE', [userId, targetId]);
      const requester = rows.find(row => row.id === userId);
      const [current] = await connection.execute<RowDataPacket[]>('SELECT 1 FROM sessions WHERE user_id = ? AND token = ? FOR UPDATE',
        [userId, getAuthTokenFromRequest(req) || '']);
      // Deactivation and password changes commit before they delete sessions, so check the
      // flag and that the password verified above is still the admin's.
      if (!current.length || !requester?.is_active || requester.password_hash !== admins[0].password_hash) {
        await connection.rollback();
        return { error: 'Unauthorized', status: 401 };
      }
      if (requester?.role !== 'admin') { await connection.rollback(); return { error: 'Forbidden', status: 403 }; }
      const targets = rows.filter(row => row.id === targetId);
      if (!targets.length) { await connection.rollback(); return { error: 'User not found', status: 404 }; }
      if (!targets[0].two_factor_enabled) {
        await connection.rollback();
        return { error: 'Two-factor authentication is not enabled for this user', status: 400 };
      }
      await disableTwoFactor(targetId, connection);
      await connection.execute<RowDataPacket[]>('DELETE FROM two_factor_challenges WHERE user_id = ?', [targetId]);
      // Sessions may be on the lost device.
      await connection.execute<RowDataPacket[]>('DELETE FROM sessions WHERE user_id = ?', [targetId]);
      await connection.commit();
      serverEvents.closeUser(targetId);
      return { message: 'Two-factor authentication reset' };
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      console.error('Admin 2FA reset error:', error);
      return { error: 'Failed to reset two-factor authentication', status: 500 };
    } finally {
      connection?.release();
    }
  },

  'DELETE /api/admin/users/:id': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    const id = req.url.split('?')[0].split('/').pop()!;

    if (id === userId) {
      return { error: 'Cannot delete your own account', status: 400 };
    }

    try {
      const targetUser = await getUserRoleStatus(id);
      if (!targetUser) return { error: 'User not found', status: 404 };
      if (targetUser.role === 'admin' && targetUser.is_active && (await getActiveAdminCount()) <= 1) {
        return { error: 'Cannot delete the last active admin', status: 400 };
      }
      const [recordings] = await db.execute<RowDataPacket[]>(
        'SELECT storage_path FROM recordings WHERE user_id = ?',
        [id]
      );
      for (const recording of recordings || []) {
        await deleteRecordingFiles(recording.storage_path);
      }
      await db.execute<RowDataPacket[]>('DELETE FROM users WHERE id = ?', [id]);
      serverEvents.closeUser(id);
      return { message: 'User deleted' };
    } catch (error) {
      return { error: 'Failed to delete user', status: 500 };
    }
  },

  'PUT /api/admin/users/:id/role': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    const parts = req.url.split('?')[0].split('/');
    const id = parts[parts.length - 2];
    const nextRole = String(body?.role || '').trim().toLowerCase();
    if (!['user', 'admin'].includes(nextRole)) {
      return { error: 'Invalid role. Must be user or admin.', status: 400 };
    }

    try {
      const targetUser = await getUserRoleStatus(id);
      if (!targetUser) return { error: 'User not found', status: 404 };
      if (targetUser.role === 'admin' && nextRole === 'user' && targetUser.is_active && (await getActiveAdminCount()) <= 1) {
        return { error: 'Cannot demote the last active admin', status: 400 };
      }
      await db.execute<RowDataPacket[]>('UPDATE users SET role = ? WHERE id = ?', [nextRole, id]);
      return { message: `User role set to ${nextRole}` };
    } catch (error) {
      console.error('Update user role error:', error);
      return { error: 'Failed to update user role', status: 500 };
    }
  },

  'PUT /api/admin/users/:id/activate': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    const parts = req.url.split('?')[0].split('/');
    const id = parts[parts.length - 2];
    const { is_active } = body;

    try {
      const targetUser = await getUserRoleStatus(id);
      if (!targetUser) return { error: 'User not found', status: 404 };
      if (!is_active && targetUser.role === 'admin' && targetUser.is_active && (await getActiveAdminCount()) <= 1) {
        return { error: 'Cannot deactivate the last active admin', status: 400 };
      }
      await db.execute<RowDataPacket[]>('UPDATE users SET is_active = ? WHERE id = ?', [!!is_active, id]);
      if (!is_active) {
        await db.execute<RowDataPacket[]>('DELETE FROM sessions WHERE user_id = ?', [id]);
        serverEvents.closeUser(id);
      }
      return { message: is_active ? 'User activated' : 'User deactivated' };
    } catch (error) {
      return { error: 'Failed to update user status', status: 500 };
    }
  },

  'GET /api/admin/settings/signup-mode': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    try {
      const mode = await getSignupMode();
      return { signup_mode: mode };
    } catch (error) {
      return { error: 'Failed to get settings', status: 500 };
    }
  },

  'PUT /api/admin/settings/signup-mode': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    const { signup_mode } = body;
    if (!['open', 'approval', 'disabled'].includes(signup_mode)) {
      return { error: 'Invalid signup mode. Must be: open, approval, or disabled', status: 400 };
    }

    try {
      await db.execute<RowDataPacket[]>(
        'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
        ['signup_mode', signup_mode, signup_mode]
      );
      return { message: `Signup mode set to: ${signup_mode}` };
    } catch (error) {
      return { error: 'Failed to update settings', status: 500 };
    }
  },
};
