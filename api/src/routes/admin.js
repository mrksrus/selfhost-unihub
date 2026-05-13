const { db } = require('../state');
const { MIN_PASSWORD_LENGTH } = require('../config');
const {
  isAdmin,
  hashPassword,
  getSignupMode,
} = require('../auth');

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

module.exports = {
  // ── Admin endpoints (require admin role) ────────────────────────
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
