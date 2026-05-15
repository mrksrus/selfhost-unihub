const fs = require('fs');
const path = require('path');
const { db } = require('../state');
const { MIN_PASSWORD_LENGTH } = require('../config');
const { MAIL_RAW_STORAGE_ROOT } = require('../services/mail');
const { RECORDINGS_ROOT } = require('../services/recordings');
const { BACKUPS_ROOT } = require('../services/export-jobs');
const {
  isAdmin,
  hashPassword,
  getSignupMode,
} = require('../auth');

const ATTACHMENTS_ROOT = '/app/uploads/attachments';

async function getActiveAdminCount() {
  const [rows] = await db.execute(
    "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = TRUE"
  );
  return Number(rows[0]?.count || 0);
}

async function getUserRoleStatus(targetId) {
  const [rows] = await db.execute(
    'SELECT id, email, role, is_active FROM users WHERE id = ? LIMIT 1',
    [targetId]
  );
  return rows[0] || null;
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function sumFilesUnder(rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  const totals = { bytes: 0, files: 0, exists: true, error: null };
  async function walk(currentPath) {
    let entries;
    try {
      entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
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
    totals.error = error.message || 'Failed to scan storage path';
  }
  return totals;
}

async function sumFilesByImmediateChild(rootPath, ignoredNames = new Set()) {
  const resolvedRoot = path.resolve(rootPath);
  const result = new Map();
  let entries;

  try {
    entries = await fs.promises.readdir(resolvedRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return result;
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

function getUserStorageSection(sectionMap, userId) {
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
    db.execute('SELECT COUNT(*) AS total, SUM(is_active = TRUE) AS active FROM users'),
    db.execute('SELECT id, email, full_name, is_active FROM users ORDER BY created_at DESC'),
    db.execute('SELECT (SELECT COUNT(*) FROM mail_accounts) AS accounts, (SELECT COUNT(*) FROM emails) AS emails'),
    db.execute('SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM email_attachments'),
    db.execute('SELECT COUNT(*) AS emails_with_raw FROM emails WHERE raw_storage_path IS NOT NULL'),
    db.execute('SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM recordings'),
    db.execute("SELECT COUNT(*) AS jobs, SUM(status = 'ready') AS ready_jobs, COALESCE(SUM(file_size), 0) AS bytes FROM data_export_jobs"),
    db.execute('SELECT COUNT(*) AS contacts FROM contacts'),
    db.execute('SELECT COUNT(*) AS events FROM calendar_events'),
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

module.exports = {
  // ── Admin endpoints (require admin role) ────────────────────────
  'GET /api/admin/storage': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    try {
      return { storage: await buildAdminStorageOverview() };
    } catch (error) {
      console.error('Admin storage overview error:', error);
      return { error: 'Failed to get storage overview', status: 500 };
    }
  },

  'GET /api/admin/users': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    try {
      const [users] = await db.execute(
        'SELECT id, email, full_name, role, is_active, created_at FROM users ORDER BY created_at DESC'
      );
      return { users };
    } catch (error) {
      return { error: 'Failed to get users', status: 500 };
    }
  },

  'PUT /api/admin/users/:id/password': async (req, userId, body) => {
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
      await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, targetId]);
      // Invalidate all sessions so the user must re-login
      await db.execute('DELETE FROM sessions WHERE user_id = ?', [targetId]);
      return { message: 'Password updated successfully' };
    } catch (error) {
      return { error: 'Failed to update password', status: 500 };
    }
  },

  'DELETE /api/admin/users/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    const id = req.url.split('?')[0].split('/').pop();

    if (id === userId) {
      return { error: 'Cannot delete your own account', status: 400 };
    }

    try {
      const targetUser = await getUserRoleStatus(id);
      if (!targetUser) return { error: 'User not found', status: 404 };
      if (targetUser.role === 'admin' && targetUser.is_active && (await getActiveAdminCount()) <= 1) {
        return { error: 'Cannot delete the last active admin', status: 400 };
      }
      await db.execute('DELETE FROM users WHERE id = ?', [id]);
      return { message: 'User deleted' };
    } catch (error) {
      return { error: 'Failed to delete user', status: 500 };
    }
  },

  'PUT /api/admin/users/:id/role': async (req, userId, body) => {
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
      await db.execute('UPDATE users SET role = ? WHERE id = ?', [nextRole, id]);
      return { message: `User role set to ${nextRole}` };
    } catch (error) {
      console.error('Update user role error:', error);
      return { error: 'Failed to update user role', status: 500 };
    }
  },
  
  'PUT /api/admin/users/:id/activate': async (req, userId, body) => {
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
      await db.execute('UPDATE users SET is_active = ? WHERE id = ?', [!!is_active, id]);
      if (!is_active) {
        await db.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
      }
      return { message: is_active ? 'User activated' : 'User deactivated' };
    } catch (error) {
      return { error: 'Failed to update user status', status: 500 };
    }
  },
  
  'GET /api/admin/settings/signup-mode': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    try {
      const mode = await getSignupMode();
      return { signup_mode: mode };
    } catch (error) {
      return { error: 'Failed to get settings', status: 500 };
    }
  },
  
  'PUT /api/admin/settings/signup-mode': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    const { signup_mode } = body;
    if (!['open', 'approval', 'disabled'].includes(signup_mode)) {
      return { error: 'Invalid signup mode. Must be: open, approval, or disabled', status: 400 };
    }

    try {
      await db.execute(
        'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
        ['signup_mode', signup_mode, signup_mode]
      );
      return { message: `Signup mode set to: ${signup_mode}` };
    } catch (error) {
      return { error: 'Failed to update settings', status: 500 };
    }
  },
};
