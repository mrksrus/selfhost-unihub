const crypto = require('crypto');
const { db } = require('../state');
const { MIN_PASSWORD_LENGTH } = require('../config');
const {
  getClientIP,
  isRateLimited,
  getSignupMode,
  recordFailedAttempt,
  hashPassword,
  verifyPassword,
  generateToken,
  generateCsrfToken,
  getSessionExpiry,
  resetRateLimit,
  setAuthCookie,
  setCsrfCookie,
  getAuthTokenFromRequest,
  clearAuthCookie,
  clearCsrfCookie,
} = require('../auth');
const {
  generateTwoFactorSecret,
  verifyTotp,
  getOtpAuthUri,
  getTwoFactorStatus,
  enableTwoFactor,
  disableTwoFactor,
  verifyUserSecondFactor,
  createTwoFactorLoginChallenge,
  consumeTwoFactorLoginChallenge,
  deleteTwoFactorLoginChallenge,
} = require('../services/two-factor');

async function createSessionResponse(user, res) {
  const token = generateToken(user.id);
  const csrfToken = generateCsrfToken();
  const expiresAt = getSessionExpiry();
  await db.execute(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)',
    [user.id, token, expiresAt]
  );

  setAuthCookie(res, token);
  setCsrfCookie(res, csrfToken);
  return {
    csrfToken,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      avatar_url: user.avatar_url,
      role: user.role,
      timezone: user.timezone ?? null,
      two_factor_enabled: !!user.two_factor_enabled,
    },
  };
}


module.exports = {
  // Authentication endpoints
  'POST /api/auth/signup': async (req, userId, body, res) => {
    const ip = getClientIP(req);
    const blockedMinutes = isRateLimited(ip);
    if (blockedMinutes) {
      return { error: `Too many attempts. Try again in ${blockedMinutes} minutes.`, status: 429 };
    }

    // Check signup mode
    const signupMode = await getSignupMode();
    if (signupMode === 'disabled') {
      return { error: 'Signups are currently disabled', status: 403 };
    }

    const { email, password, full_name } = body;
    if (!email || !password) {
      return { error: 'Email and password are required', status: 400 };
    }
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`, status: 400 };
    }
    
    try {
      // Check if user exists
      const [existing] = await db.execute(
        'SELECT id FROM users WHERE email = ?',
        [email]
      );
      
      if (existing.length > 0) {
        recordFailedAttempt(ip);
        return { error: 'User already exists', status: 400 };
      }
      
      // Create user (active if mode is 'open', inactive if 'approval')
      const isActive = signupMode === 'open';
      const passwordHash = await hashPassword(password);
      const newUserId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO users (id, email, password_hash, full_name, email_verified, is_active) VALUES (?, ?, ?, ?, TRUE, ?)',
        [newUserId, email, passwordHash, full_name || null, isActive]
      );
      
      // If approval required, don't create session or return token
      if (!isActive) {
        return { 
          message: 'Account created. Waiting for admin approval.',
          requiresApproval: true 
        };
      }
      
      const token = generateToken(newUserId);
      const csrfToken = generateCsrfToken();
      
      // Create session
      const expiresAt = getSessionExpiry();
      await db.execute(
        'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)',
        [newUserId, token, expiresAt]
      );
      
      resetRateLimit(ip);
      const result = { csrfToken, user: { id: newUserId, email, full_name, role: 'user', timezone: null, two_factor_enabled: false } };
      setAuthCookie(res, token);
      setCsrfCookie(res, csrfToken);
      return result;
    } catch (error) {
      console.error('Signup error:', error);
      recordFailedAttempt(ip);
      return { error: 'Failed to create user', status: 500 };
    }
  },
  
  'POST /api/auth/signin': async (req, userId, body, res) => {
    const ip = getClientIP(req);
    const blockedMinutes = isRateLimited(ip);
    if (blockedMinutes) {
      return { error: `Too many attempts. Try again in ${blockedMinutes} minutes.`, status: 429 };
    }

    const { email, password } = body;
    if (!email || !password) {
      return { error: 'Email and password are required', status: 400 };
    }
    
    try {
      // Add retry logic for database queries
      let users;
      let retries = 3;
      while (retries > 0) {
        try {
          const result = await db.execute(
            'SELECT id, email, password_hash, full_name, avatar_url, role, is_active, timezone, two_factor_enabled, encrypted_two_factor_secret, two_factor_recovery_codes FROM users WHERE email = ?',
            [email]
          );
          users = result[0];
          break;
        } catch (dbError) {
          retries--;
          if (retries === 0) {
            console.error('[AUTH] Database error in signin:', dbError.message);
            recordFailedAttempt(ip);
            return { error: 'Database connection error. Please try again.', status: 503 };
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      if (users.length === 0) {
        recordFailedAttempt(ip);
        return { error: 'Invalid credentials', status: 401 };
      }
      
      const user = users[0];
      const isValid = await verifyPassword(password, user.password_hash);
      
      if (!isValid) {
        recordFailedAttempt(ip);
        return { error: 'Invalid credentials', status: 401 };
      }
      
      if (!user.is_active) {
        return { error: 'Your account is pending admin approval', status: 403 };
      }

      if (user.two_factor_enabled) {
        const challengeToken = await createTwoFactorLoginChallenge(user.id, req);
        return {
          requires2fa: true,
          challengeToken,
          message: 'Two-factor authentication code required',
        };
      }
      
      // Create session with retry logic
      retries = 3;
      while (retries > 0) {
        try {
          const result = await createSessionResponse(user, res);
          resetRateLimit(ip);
          return result;
        } catch (dbError) {
          retries--;
          if (retries === 0) {
            console.error('[AUTH] Database error creating session:', dbError.message);
            recordFailedAttempt(ip);
            return { error: 'Failed to create session. Please try again.', status: 503 };
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } catch (error) {
      console.error('Signin error:', error);
      recordFailedAttempt(ip);
      return { error: 'Failed to sign in', status: 500 };
    }
  },

  'POST /api/auth/2fa/login': async (req, userId, body, res) => {
    const ip = getClientIP(req);
    const blockedMinutes = isRateLimited(ip);
    if (blockedMinutes) {
      return { error: `Too many attempts. Try again in ${blockedMinutes} minutes.`, status: 429 };
    }

    const challengeToken = String(body?.challenge_token || '').trim();
    const code = String(body?.code || '').trim();
    if (!challengeToken || !code) {
      return { error: 'Challenge token and authentication code are required', status: 400 };
    }

    try {
      const challengeUser = await consumeTwoFactorLoginChallenge(challengeToken);
      if (!challengeUser || !challengeUser.is_active) {
        recordFailedAttempt(ip);
        return { error: 'Two-factor challenge expired. Sign in again.', status: 401 };
      }

      const verification = await verifyUserSecondFactor(challengeUser, code);
      if (!verification.ok) {
        recordFailedAttempt(ip);
        return { error: 'Invalid authentication code', status: 401 };
      }

      await deleteTwoFactorLoginChallenge(challengeToken);
      resetRateLimit(ip);
      const result = await createSessionResponse(challengeUser, res);
      return {
        ...result,
        usedRecoveryCode: !!verification.usedRecoveryCode,
        recoveryCodesRemaining: verification.recoveryCodesRemaining,
      };
    } catch (error) {
      console.error('2FA login error:', error);
      recordFailedAttempt(ip);
      return { error: 'Failed to verify authentication code', status: 500 };
    }
  },

  'GET /api/auth/2fa/status': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const status = await getTwoFactorStatus(userId);
      if (!status) return { error: 'User not found', status: 404 };
      return status;
    } catch (error) {
      console.error('2FA status error:', error);
      return { error: 'Failed to get two-factor status', status: 500 };
    }
  },

  'POST /api/auth/2fa/setup/start': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const [users] = await db.execute('SELECT email, two_factor_enabled FROM users WHERE id = ?', [userId]);
      if (users.length === 0) return { error: 'User not found', status: 404 };
      if (users[0].two_factor_enabled) {
        return { error: 'Two-factor authentication is already enabled', status: 400 };
      }

      const secret = generateTwoFactorSecret();
      return {
        secret,
        otpauth_uri: getOtpAuthUri({ email: users[0].email, secret }),
      };
    } catch (error) {
      console.error('2FA setup start error:', error);
      return { error: 'Failed to start two-factor setup', status: 500 };
    }
  },

  'POST /api/auth/2fa/setup/confirm': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const secret = String(body?.secret || '').trim().toUpperCase();
    const code = String(body?.code || '').trim();
    if (!secret || !code) return { error: 'Secret and authentication code are required', status: 400 };
    if (!verifyTotp(secret, code)) return { error: 'Invalid authentication code', status: 400 };

    try {
      const [users] = await db.execute('SELECT id, two_factor_enabled FROM users WHERE id = ?', [userId]);
      if (users.length === 0) return { error: 'User not found', status: 404 };
      if (users[0].two_factor_enabled) {
        return { error: 'Two-factor authentication is already enabled', status: 400 };
      }
      const recoveryCodes = await enableTwoFactor(userId, secret);
      return {
        enabled: true,
        recoveryCodes,
        recoveryCodesRemaining: recoveryCodes.length,
      };
    } catch (error) {
      console.error('2FA setup confirm error:', error);
      return { error: 'Failed to enable two-factor authentication', status: 500 };
    }
  },

  'POST /api/auth/2fa/disable': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const { current_password, code } = body || {};
    if (!current_password || !code) {
      return { error: 'Current password and authentication code are required', status: 400 };
    }

    try {
      const [users] = await db.execute(
        'SELECT id, password_hash, two_factor_enabled, encrypted_two_factor_secret, two_factor_recovery_codes FROM users WHERE id = ?',
        [userId]
      );
      if (users.length === 0) return { error: 'User not found', status: 404 };
      const isValidPassword = await verifyPassword(current_password, users[0].password_hash);
      if (!isValidPassword) return { error: 'Current password is incorrect', status: 401 };
      const verification = await verifyUserSecondFactor(users[0], code);
      if (!verification.ok) return { error: 'Invalid authentication code', status: 401 };
      await disableTwoFactor(userId);
      await db.execute('DELETE FROM sessions WHERE user_id = ? AND token != ?', [userId, getAuthTokenFromRequest(req) || '']);
      return { enabled: false };
    } catch (error) {
      console.error('2FA disable error:', error);
      return { error: 'Failed to disable two-factor authentication', status: 500 };
    }
  },

  'POST /api/auth/2fa/recovery-codes/regenerate': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const code = String(body?.code || '').trim();
    if (!code) return { error: 'Authentication code is required', status: 400 };

    try {
      const [users] = await db.execute(
        'SELECT id, email, two_factor_enabled, encrypted_two_factor_secret, two_factor_recovery_codes FROM users WHERE id = ?',
        [userId]
      );
      if (users.length === 0) return { error: 'User not found', status: 404 };
      if (!users[0].two_factor_enabled) return { error: 'Two-factor authentication is not enabled', status: 400 };
      const verification = await verifyUserSecondFactor(users[0], code);
      if (!verification.ok) return { error: 'Invalid authentication code', status: 401 };
      const secret = users[0].encrypted_two_factor_secret ? require('../security/encryption').decrypt(users[0].encrypted_two_factor_secret) : null;
      if (!secret) return { error: 'Two-factor secret is unavailable', status: 500 };
      const recoveryCodes = await enableTwoFactor(userId, secret);
      return {
        recoveryCodes,
        recoveryCodesRemaining: recoveryCodes.length,
      };
    } catch (error) {
      console.error('2FA recovery regenerate error:', error);
      return { error: 'Failed to regenerate recovery codes', status: 500 };
    }
  },
  
  'POST /api/auth/signout': async (req, userId, body, res) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const token = getAuthTokenFromRequest(req);
      if (token) {
        await db.execute('DELETE FROM sessions WHERE token = ?', [token]);
      }
      clearAuthCookie(res);
      clearCsrfCookie(res);
      return { message: 'Signed out successfully' };
    } catch (error) {
      return { error: 'Failed to sign out', status: 500 };
    }
  },
  
  'GET /api/auth/me': async (req, userId, body, res) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [users] = await db.execute(
        'SELECT id, email, full_name, avatar_url, role, timezone, two_factor_enabled FROM users WHERE id = ?',
        [userId]
      );
      
      if (users.length === 0) {
        return { error: 'User not found', status: 404 };
      }
      
      const url = new URL(req.url, `http://${req.headers.host}`);
      const isBackgroundCheck = url.searchParams.get('background') === '1' || req.headers['x-background-sync'] === '1';
      if (isBackgroundCheck) {
        return { user: users[0] };
      }

      // Refresh CSRF token on regular /auth/me calls to prevent stale tokens.
      const csrfToken = generateCsrfToken();
      setCsrfCookie(res, csrfToken);

      return { user: users[0], csrfToken };
    } catch (error) {
      return { error: 'Failed to get user', status: 500 };
    }
  },

  'PUT /api/auth/password': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { current_password, new_password } = body;
    if (!current_password || !new_password) {
      return { error: 'Current password and new password are required', status: 400 };
    }
    if (new_password.length < MIN_PASSWORD_LENGTH) {
      return { error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`, status: 400 };
    }

    try {
      const [users] = await db.execute(
        'SELECT password_hash FROM users WHERE id = ?',
        [userId]
      );
      if (users.length === 0) {
        return { error: 'User not found', status: 404 };
      }

      const isValid = await verifyPassword(current_password, users[0].password_hash);
      if (!isValid) {
        return { error: 'Current password is incorrect', status: 401 };
      }

      const newHash = await hashPassword(new_password);
      await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);

      return { message: 'Password updated successfully' };
    } catch (error) {
      console.error('Password change error:', error);
      return { error: 'Failed to change password', status: 500 };
    }
  },

  'PUT /api/auth/profile': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { full_name, timezone } = body;
    if (full_name === undefined || full_name === null) {
      return { error: 'Full name is required', status: 400 };
    }
    const tzValue = timezone === undefined || timezone === null || (typeof timezone === 'string' && timezone.trim() === '')
      ? null
      : (typeof timezone === 'string' && timezone.length <= 64 ? timezone.trim() : null);
    if (timezone !== undefined && timezone !== null && typeof timezone === 'string' && timezone.trim() !== '' && tzValue === null) {
      return { error: 'Timezone must be at most 64 characters', status: 400 };
    }

    try {
      await db.execute('UPDATE users SET full_name = ?, timezone = ? WHERE id = ?', [full_name.trim() || null, tzValue, userId]);
      const [users] = await db.execute(
        'SELECT id, email, full_name, avatar_url, role, timezone, two_factor_enabled FROM users WHERE id = ?',
        [userId]
      );
      return { user: users[0] };
    } catch (error) {
      console.error('Profile update error:', error);
      return { error: 'Failed to update profile', status: 500 };
    }
  },
};
