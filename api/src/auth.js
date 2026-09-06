const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./state');
const {
  JWT_SECRET,
  TRUST_PROXY_HEADERS,
  TRUSTED_PROXY_CIDRS,
  AUTH_COOKIE_NAME,
} = require('./config');
const { createClientIpResolver } = require('./security/client-ip');
const { consumeAuthAttempt } = require('./security/login-limits');

// Password hashing
async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Generate CSRF token
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Generate JWT token
function generateToken(userId) {
  return jwt.sign(
    { userId, sub: userId },
    JWT_SECRET,
    { expiresIn: '21d', jwtid: crypto.randomUUID() }
  );
}

function getSessionExpiry() {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 21);
  return expiresAt;
}

const getClientIP = createClientIpResolver({
  trustProxyHeaders: TRUST_PROXY_HEADERS,
  trustedProxyCidrs: TRUSTED_PROXY_CIDRS,
});

// CSRF token validation
function validateCsrfToken(req, res) {
  // Skip CSRF for GET, HEAD, OPTIONS requests
  const method = req.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return true;
  }

  // Skip CSRF for auth endpoints (they generate new tokens)
  const url = req.url.split('?')[0];
  if (url === '/api/auth/signin' || url === '/api/auth/signup') {
    return true;
  }

  // The service worker can start a non-blocking same-origin mail sync while
  // the app window is closed. Cross-origin callers cannot send this custom
  // header without a rejected CORS preflight.
  if (url === '/api/mail/sync/background' && req.headers['x-background-sync'] === '1') {
    return true;
  }

  // Get CSRF token from cookie and header
  const cookieToken = req.headers.cookie
    ?.split(';')
    .find(c => c.trim().startsWith('csrf-token='))
    ?.split('=')[1];
  const headerToken = req.headers['x-csrf-token'];

  // Both must be present and match
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return false;
  }

  return true;
}

function appendSetCookie(res, cookieValue) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookieValue]);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieValue]);
    return;
  }
  res.setHeader('Set-Cookie', [existing, cookieValue]);
}

function parseCookies(req) {
  const rawCookieHeader = req.headers.cookie || '';
  if (!rawCookieHeader) return {};
  return rawCookieHeader.split(';').reduce((acc, part) => {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) return acc;
    const joinedValue = rawValue.join('=');
    acc[rawKey] = decodeURIComponent(joinedValue || '');
    return acc;
  }, {});
}

function getAuthTokenFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const cookies = parseCookies(req);
  return cookies[AUTH_COOKIE_NAME] || null;
}

// Set CSRF token cookie
function setCsrfCookie(res, token) {
  const expires = new Date();
  expires.setDate(expires.getDate() + 21); // Match JWT expiry
  // Note: Secure flag requires HTTPS. For HTTP (development), remove Secure flag
  const isSecure = process.env.NODE_ENV === 'production';
  const secureFlag = isSecure ? 'Secure;' : '';
  appendSetCookie(res, `csrf-token=${token}; HttpOnly; ${secureFlag} SameSite=Strict; Path=/; Expires=${expires.toUTCString()}`);
}

function clearCsrfCookie(res) {
  const isSecure = process.env.NODE_ENV === 'production';
  const secureFlag = isSecure ? 'Secure;' : '';
  appendSetCookie(res, `csrf-token=; HttpOnly; ${secureFlag} SameSite=Strict; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}

function setAuthCookie(res, token) {
  const expires = new Date();
  expires.setDate(expires.getDate() + 21); // Match session expiry
  const isSecure = process.env.NODE_ENV === 'production';
  const secureFlag = isSecure ? 'Secure;' : '';
  appendSetCookie(res, `${AUTH_COOKIE_NAME}=${token}; HttpOnly; ${secureFlag} SameSite=Strict; Path=/; Expires=${expires.toUTCString()}`);
}

function clearAuthCookie(res) {
  const isSecure = process.env.NODE_ENV === 'production';
  const secureFlag = isSecure ? 'Secure;' : '';
  appendSetCookie(res, `${AUTH_COOKIE_NAME}=; HttpOnly; ${secureFlag} SameSite=Strict; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}

// JWT verification + session check
async function verifyToken(req) {
  const token = getAuthTokenFromRequest(req);
  if (!token) return null;
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }

  try {
    // Add retry logic for database queries
    let retries = 3;
    while (retries > 0) {
      try {
        const [sessions] = await db.execute(
          `SELECT s.user_id, s.expires_at, u.is_active
           FROM sessions s
           INNER JOIN users u ON u.id = s.user_id
           WHERE s.token = ?
           LIMIT 1`,
          [token]
        );

        if (sessions.length === 0) return null;
        const session = sessions[0];
        if (new Date(session.expires_at) < new Date()) return null;
        if (!session.is_active) return null;

        return session.user_id || decoded.userId || decoded.sub;
      } catch (dbError) {
        retries--;
        if (retries === 0) {
          console.error('[AUTH] Database error in verifyToken:', dbError.message);
          return null;
        }
        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return null;
  } catch (error) {
    console.error('[AUTH] Error in verifyToken:', error.message);
    return null;
  }
}

// Admin check
async function isAdmin(userId) {
  if (!userId) return false;
  try {
    const [users] = await db.execute('SELECT role FROM users WHERE id = ?', [userId]);
    return users.length > 0 && users[0].role === 'admin';
  } catch {
    return false;
  }
}

// Get signup mode (open, approval, disabled)
async function getSignupMode() {
  try {
    const [rows] = await db.execute(
      'SELECT setting_value FROM system_settings WHERE setting_key = ?',
      ['signup_mode']
    );
    return rows[0]?.setting_value || 'disabled';
  } catch {
    return 'disabled';
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateCsrfToken,
  generateToken,
  getSessionExpiry,
  getClientIP,
  consumeAuthAttempt,
  validateCsrfToken,
  appendSetCookie,
  parseCookies,
  getAuthTokenFromRequest,
  setCsrfCookie,
  clearCsrfCookie,
  setAuthCookie,
  clearAuthCookie,
  verifyToken,
  isAdmin,
  getSignupMode,
};
