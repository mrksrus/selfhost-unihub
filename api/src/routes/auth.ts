import type { RowDataPacket } from 'mysql2/promise';
import type { RouteRequest, SqlExecutor, StoredFlag } from '../types';
import type { ServerResponse } from 'node:http';
import crypto from 'crypto';
import { db } from '../state';
import { MIN_PASSWORD_LENGTH } from '../config';
import {
  getClientIP,
  consumeAuthAttempt,
  getSignupMode,
  hashPassword,
  verifyPassword,
  generateToken,
  generateCsrfToken,
  getSessionExpiry,
  setAuthCookie,
  setCsrfCookie,
  getAuthTokenFromRequest,
  clearAuthCookie,
  clearCsrfCookie,
} from '../auth';
import {
  generateTwoFactorSecret,
  verifyTotp,
  getOtpAuthUri,
  getTwoFactorStatus,
  createRecoveryCodes,
  enableTwoFactor,
  replaceRecoveryCodes,
  disableTwoFactor,
  verifyUserSecondFactor,
  readTwoFactorSecret,
  createTwoFactorLoginChallenge,
  consumeTwoFactorLoginChallenge,
  deleteTwoFactorLoginChallenge,
} from '../services/two-factor';
import { serverEvents } from '../services/server-events';

type Request = RouteRequest & { url: string; params: Record<string, string> };
interface Input {
  email: string;
  password: string;
  full_name?: string | null;
  challenge_token?: unknown;
  code?: string;
  secret?: unknown;
  current_password?: string;
  new_password?: string;
  timezone?: unknown;
}
interface UserRow extends RowDataPacket {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: string;
  timezone?: string | null;
  two_factor_enabled: StoredFlag;
  password_hash: string;
  is_active: StoredFlag;
  encrypted_two_factor_secret?: string | null;
  two_factor_recovery_codes?: unknown;
}

async function createSessionResponse(user: Pick<UserRow, 'id' | 'email' | 'full_name' | 'avatar_url' | 'role' | 'timezone' | 'two_factor_enabled'>, res: ServerResponse, connection: SqlExecutor = db, afterCommit: (() => void)[] | null = null) {
  const token = generateToken(user.id);
  const csrfToken = generateCsrfToken();
  const expiresAt = getSessionExpiry();
  await connection.execute(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)',
    [user.id, token, expiresAt]
  );

  const sendCookies = () => { setAuthCookie(res, token); setCsrfCookie(res, csrfToken); };
  if (afterCommit) afterCommit.push(sendCookies);
  else sendCookies();
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

function checkLoginBudget(res: ServerResponse, scope: Parameters<typeof consumeAuthAttempt>[0], identity: string) {
  const retryAfter = consumeAuthAttempt(scope, identity);
  if (!retryAfter) return null;
  res?.setHeader('Retry-After', String(retryAfter));
  return { error: `Too many attempts. Try again in ${retryAfter} seconds.`, status: 429 };
}

const UNREADABLE_SECRET_MESSAGE = 'The authenticator key can no longer be read because the server encryption key changed. '
  + 'Turn two-factor authentication off with a recovery code and set it up again.';

function validCredentials(email: unknown, password: unknown) {
  return typeof email === 'string' && email.trim().length > 0 && email.length <= 254
    && typeof password === 'string' && password.length > 0 && password.length <= 1024;
}

export = {
  // Authentication endpoints
  'GET /api/auth/signup-mode': async () => {
    try {
      return { signup_mode: await getSignupMode() };
    } catch {
      return { signup_mode: 'disabled' };
    }
  },

  'POST /api/auth/signup': async (req: Request, userId: string | null, body: Input, res: import('node:http').ServerResponse) => {
    const ip = getClientIP(req);
    const limited = checkLoginBudget(res, 'ip', ip);
    if (limited) return limited;

    // Check signup mode
    const signupMode = await getSignupMode();
    if (signupMode === 'disabled') {
      return { error: 'Signups are currently disabled. Contact an administrator if you need an account.', status: 403 };
    }

    const { email, password, full_name } = body || {};
    const signupLimited = checkLoginBudget(res, 'signup', ip);
    if (signupLimited) return signupLimited;
    if (!validCredentials(email, password)) {
      return { error: 'Email and password are required', status: 400 };
    }
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`, status: 400 };
    }

    try {
      // Check if user exists
      const [existing] = await db.execute<UserRow[]>(
        'SELECT id FROM users WHERE email = ?',
        [email]
      );

      if (existing.length > 0) {
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

      const result = { csrfToken, user: { id: newUserId, email, full_name, role: 'user', timezone: null, two_factor_enabled: false } };
      setAuthCookie(res, token);
      setCsrfCookie(res, csrfToken);
      return result;
    } catch (error) {
      console.error('Signup error:', error);
      return { error: 'Failed to create user', status: 500 };
    }
  },

  'POST /api/auth/signin': async (req: Request, userId: string | null, body: Input, res: import('node:http').ServerResponse) => {
    const ip = getClientIP(req);
    const limited = checkLoginBudget(res, 'ip', ip);
    if (limited) return limited;

    const { email, password } = body || {};
    if (!validCredentials(email, password)) {
      return { error: 'Email and password are required', status: 400 };
    }

    try {
      // Add retry logic for database queries
      let users!: UserRow[];
      let retries = 3;
      while (retries > 0) {
        try {
          const result = await db.execute<UserRow[]>(
            'SELECT id, email, password_hash, full_name, avatar_url, role, is_active, timezone, two_factor_enabled, encrypted_two_factor_secret, two_factor_recovery_codes FROM users WHERE email = ?',
            [email]
          );
          users = result[0];
          break;
        } catch (dbError) {
          retries--;
          if (retries === 0) {
            console.error('[AUTH] Database error in signin:', (dbError as Error).message);
            return { error: 'Database connection error. Please try again.', status: 503 };
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      const accountIdentity = users[0]?.id || `unknown:${email.trim().toLowerCase()}`;
      const accountLimited = checkLoginBudget(res, 'password', accountIdentity);
      if (accountLimited) return accountLimited;
      if (users.length === 0) {
        return { error: 'Invalid credentials', status: 401 };
      }

      const user = users[0];
      const isValid = await verifyPassword(password, user.password_hash);

      if (!isValid) {
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
          return result;
        } catch (dbError) {
          retries--;
          if (retries === 0) {
            console.error('[AUTH] Database error creating session:', (dbError as Error).message);
            return { error: 'Failed to create session. Please try again.', status: 503 };
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } catch (error) {
      console.error('Signin error:', error);
      return { error: 'Failed to sign in', status: 500 };
    }
  },

  'POST /api/auth/2fa/login': async (req: Request, userId: string | null, body: Input, res: import('node:http').ServerResponse) => {
    const ip = getClientIP(req);
    const limited = checkLoginBudget(res, 'ip', ip);
    if (limited) return limited;

    const challengeToken = String(body?.challenge_token || '').trim();
    const code = String(body?.code || '').trim();
    if (!/^[a-f0-9]{64}$/.test(challengeToken) || !code || code.length > 32) {
      return { error: 'Challenge token and authentication code are required', status: 400 };
    }

    let connection;
    try {
      connection = await db.getConnection();
      await connection.beginTransaction();
      const challengeUser = await consumeTwoFactorLoginChallenge(challengeToken, connection, { lock: true });
      if (!challengeUser || !challengeUser.is_active || !challengeUser.two_factor_enabled) {
        await connection.rollback();
        return { error: 'Two-factor challenge expired. Sign in again.', status: 401 };
      }
      const accountLimited = checkLoginBudget(res, 'secondFactor', challengeUser.id);
      if (accountLimited) { await connection.rollback(); return accountLimited; }
      const verification = await verifyUserSecondFactor(challengeUser, code, connection);
      if (!verification.ok) {
        await connection.rollback();
        return { error: 'Invalid authentication code', status: 401 };
      }

      await deleteTwoFactorLoginChallenge(challengeToken, connection);
      const afterCommit: (() => void)[] = [];
      const result = await createSessionResponse(challengeUser, res, connection, afterCommit);
      await connection.commit();
      afterCommit.forEach(apply => apply());
      return {
        ...result,
        usedRecoveryCode: !!verification.usedRecoveryCode,
        recoveryCodesRemaining: verification.recoveryCodesRemaining,
      };
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      console.error('2FA login error:', error);
      return { error: 'Failed to verify authentication code', status: 500 };
    } finally {
      connection?.release();
    }
  },

  'GET /api/auth/2fa/status': async (req: Request, userId: string | null) => {
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

  'POST /api/auth/2fa/setup/start': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const [users] = await db.execute<UserRow[]>('SELECT email, two_factor_enabled FROM users WHERE id = ?', [userId]);
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

  'POST /api/auth/2fa/setup/confirm': async (req: Request, userId: string | null, body: Input, res: import('node:http').ServerResponse) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    // Each accepted request hashes ten recovery codes, which takes seconds of CPU.
    const limited = checkLoginBudget(res, 'secondFactor', userId);
    if (limited) return limited;
    const secret = String(body?.secret || '').trim().toUpperCase();
    const code = String(body?.code || '').trim();
    const currentPassword = typeof body?.current_password === 'string' ? body.current_password : '';
    if (!secret || !code) return { error: 'Secret and authentication code are required', status: 400 };
    // Enabling signs out every other device, so a stolen session alone must not be enough.
    if (!currentPassword) return { error: 'Current password is required', status: 400 };
    if (!verifyTotp(secret, code)) return { error: 'Invalid authentication code', status: 400 };

    const currentToken = getAuthTokenFromRequest(req) || '';
    let connection;
    try {
      // Cheap checks before hashing; the 2FA state is checked again below under the lock.
      const [status] = await db.execute<UserRow[]>('SELECT two_factor_enabled, password_hash FROM users WHERE id = ?', [userId]);
      if (status.length === 0) return { error: 'User not found', status: 404 };
      if (status[0].two_factor_enabled) return { error: 'Two-factor authentication is already enabled', status: 400 };
      if (!await verifyPassword(currentPassword, status[0].password_hash)) return { error: 'Current password is incorrect', status: 401 };
      const recovery = await createRecoveryCodes();
      connection = await db.getConnection();
      await connection.beginTransaction();
      // Locked like the admin 2FA reset, so a request whose session that reset deleted
      // cannot turn 2FA back on once the reset has committed.
      const [users] = await connection.execute<UserRow[]>('SELECT id, two_factor_enabled, password_hash, is_active FROM users WHERE id = ? FOR UPDATE', [userId]);
      if (users.length === 0) { await connection.rollback(); return { error: 'User not found', status: 404 }; }
      // A password change or deactivation commits before deleting the sessions, so the
      // session row alone does not show that the password checked above still holds.
      if (!users[0].is_active || users[0].password_hash !== status[0].password_hash) {
        await connection.rollback();
        return { error: 'Unauthorized', status: 401 };
      }
      if (users[0].two_factor_enabled) {
        await connection.rollback();
        return { error: 'Two-factor authentication is already enabled', status: 400 };
      }
      // Locking the session row also holds back a sign-out of it until this commits.
      const [current] = await connection.execute<UserRow[]>('SELECT 1 FROM sessions WHERE user_id = ? AND token = ? FOR UPDATE', [userId, currentToken]);
      if (current.length === 0) { await connection.rollback(); return { error: 'Unauthorized', status: 401 }; }
      await enableTwoFactor(userId, secret, recovery.hashes, connection);
      // Sessions on other devices were opened with the password alone.
      await connection.execute('DELETE FROM sessions WHERE user_id = ? AND token != ?', [userId, currentToken]);
      await connection.commit();
      serverEvents.closeUser(userId, { exceptToken: currentToken });
      return {
        enabled: true,
        recoveryCodes: recovery.codes,
        recoveryCodesRemaining: recovery.codes.length,
      };
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      console.error('2FA setup confirm error:', error);
      return { error: 'Failed to enable two-factor authentication', status: 500 };
    } finally {
      connection?.release();
    }
  },

  'POST /api/auth/2fa/disable': async (req: Request, userId: string | null, body: Input, res: import('node:http').ServerResponse) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const limited = checkLoginBudget(res, 'secondFactor', userId);
    if (limited) return limited;
    const { current_password, code } = body || {};
    if (!current_password || !code) {
      return { error: 'Current password and authentication code are required', status: 400 };
    }

    try {
      const [users] = await db.execute<UserRow[]>(
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
      serverEvents.closeUser(userId, { exceptToken: getAuthTokenFromRequest(req) });
      return { enabled: false };
    } catch (error) {
      console.error('2FA disable error:', error);
      return { error: 'Failed to disable two-factor authentication', status: 500 };
    }
  },

  'POST /api/auth/2fa/recovery-codes/regenerate': async (req: Request, userId: string | null, body: Input, res: import('node:http').ServerResponse) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const limited = checkLoginBudget(res, 'secondFactor', userId);
    if (limited) return limited;
    const code = String(body?.code || '').trim();
    if (!code) return { error: 'Authentication code is required', status: 400 };

    try {
      const [users] = await db.execute<UserRow[]>(
        'SELECT id, email, two_factor_enabled, encrypted_two_factor_secret, two_factor_recovery_codes FROM users WHERE id = ?',
        [userId]
      );
      if (users.length === 0) return { error: 'User not found', status: 404 };
      if (!users[0].two_factor_enabled) return { error: 'Two-factor authentication is not enabled', status: 400 };
      // Checked first, so a recovery code is not used up by a request that cannot succeed.
      if (!readTwoFactorSecret(users[0])) return { error: UNREADABLE_SECRET_MESSAGE, status: 409 };
      const verification = await verifyUserSecondFactor(users[0], code);
      if (!verification.ok) return { error: 'Invalid authentication code', status: 401 };
      const recovery = await createRecoveryCodes();
      if (!(await replaceRecoveryCodes(userId, recovery.hashes))) {
        return { error: 'Two-factor authentication was turned off', status: 409 };
      }
      return {
        recoveryCodes: recovery.codes,
        recoveryCodesRemaining: recovery.codes.length,
      };
    } catch (error) {
      console.error('2FA recovery regenerate error:', error);
      return { error: 'Failed to regenerate recovery codes', status: 500 };
    }
  },

  'POST /api/auth/signout': async (req: Request, userId: string | null, body: Input, res: import('node:http').ServerResponse) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const token = getAuthTokenFromRequest(req);
      if (token) {
        await db.execute('DELETE FROM sessions WHERE token = ?', [token]);
        serverEvents.closeToken(token, { reason: 'signed_out' });
      }
      clearAuthCookie(res);
      clearCsrfCookie(res);
      return { message: 'Signed out successfully' };
    } catch (error) {
      return { error: 'Failed to sign out', status: 500 };
    }
  },

  'GET /api/auth/me': async (req: Request, userId: string | null, body: Input, res: import('node:http').ServerResponse) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const [users] = await db.execute<UserRow[]>(
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

  'PUT /api/auth/password': async (req: Request, userId: string | null, body: Input, res: import('node:http').ServerResponse) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { current_password, new_password } = body;
    if (!current_password || !new_password) {
      return { error: 'Current password and new password are required', status: 400 };
    }
    if (new_password.length < MIN_PASSWORD_LENGTH) {
      return { error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`, status: 400 };
    }

    try {
      const [users] = await db.execute<UserRow[]>(
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
      await db.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
      serverEvents.closeUser(userId);
      clearAuthCookie(res);
      clearCsrfCookie(res);

      return { message: 'Password updated successfully. Sign in again on all devices.' };
    } catch (error) {
      console.error('Password change error:', error);
      return { error: 'Failed to change password', status: 500 };
    }
  },

  'PUT /api/auth/profile': async (req: Request, userId: string | null, body: Input) => {
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
      const [users] = await db.execute<UserRow[]>(
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
