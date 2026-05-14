const test = require('node:test');
const assert = require('node:assert/strict');

function setRequireStub(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

test('password change invalidates all sessions and clears auth cookies', async (t) => {
  const routePath = require.resolve('../src/routes/auth');
  const authPath = require.resolve('../src/auth');
  const statePath = require.resolve('../src/state');
  const twoFactorPath = require.resolve('../src/services/two-factor');
  const originalRoute = require.cache[routePath];
  const originalAuth = require.cache[authPath];
  const originalState = require.cache[statePath];
  const originalTwoFactor = require.cache[twoFactorPath];
  const calls = [];

  t.after(() => {
    if (originalRoute) require.cache[routePath] = originalRoute;
    else delete require.cache[routePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
    if (originalState) require.cache[statePath] = originalState;
    else delete require.cache[statePath];
    if (originalTwoFactor) require.cache[twoFactorPath] = originalTwoFactor;
    else delete require.cache[twoFactorPath];
  });

  delete require.cache[routePath];
  setRequireStub(statePath, {
    db: {
      execute: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT password_hash')) {
          return [[{ password_hash: 'old-hash' }]];
        }
        return [{}];
      },
    },
  });
  setRequireStub(authPath, {
    getClientIP: () => '127.0.0.1',
    isRateLimited: () => null,
    getSignupMode: async () => 'disabled',
    recordFailedAttempt: () => {},
    hashPassword: async () => 'new-hash',
    verifyPassword: async () => true,
    generateToken: () => 'jwt-token',
    generateCsrfToken: () => 'csrf-token',
    getSessionExpiry: () => new Date('2030-01-01T00:00:00.000Z'),
    resetRateLimit: () => {},
    setAuthCookie: () => {},
    setCsrfCookie: () => {},
    getAuthTokenFromRequest: () => 'current-token',
    clearAuthCookie: (res) => res.cleared.push('auth'),
    clearCsrfCookie: (res) => res.cleared.push('csrf'),
  });
  setRequireStub(twoFactorPath, {
    generateTwoFactorSecret: () => 'SECRET',
    verifyTotp: () => true,
    getOtpAuthUri: () => 'otpauth://test',
    getTwoFactorStatus: async () => ({ enabled: false, recoveryCodesRemaining: 0 }),
    enableTwoFactor: async () => [],
    disableTwoFactor: async () => {},
    verifyUserSecondFactor: async () => ({ ok: true }),
    createTwoFactorLoginChallenge: async () => 'challenge',
    consumeTwoFactorLoginChallenge: async () => null,
    deleteTwoFactorLoginChallenge: async () => {},
  });

  const routes = require('../src/routes/auth');
  const res = { cleared: [] };
  const result = await routes['PUT /api/auth/password'](
    { headers: {}, url: '/api/auth/password' },
    'user-1',
    { current_password: 'old-password', new_password: 'new-password-123' },
    res
  );

  assert.match(result.message, /Sign in again/);
  assert.deepEqual(res.cleared, ['auth', 'csrf']);
  assert.ok(calls.some(call => call.sql === 'UPDATE users SET password_hash = ? WHERE id = ?'));
  assert.ok(calls.some(call => call.sql === 'DELETE FROM sessions WHERE user_id = ?'));
});

test('public signup mode endpoint defaults to disabled', async (t) => {
  const routePath = require.resolve('../src/routes/auth');
  const authPath = require.resolve('../src/auth');
  const statePath = require.resolve('../src/state');
  const twoFactorPath = require.resolve('../src/services/two-factor');
  const originalRoute = require.cache[routePath];
  const originalAuth = require.cache[authPath];
  const originalState = require.cache[statePath];
  const originalTwoFactor = require.cache[twoFactorPath];

  t.after(() => {
    if (originalRoute) require.cache[routePath] = originalRoute;
    else delete require.cache[routePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
    if (originalState) require.cache[statePath] = originalState;
    else delete require.cache[statePath];
    if (originalTwoFactor) require.cache[twoFactorPath] = originalTwoFactor;
    else delete require.cache[twoFactorPath];
  });

  delete require.cache[routePath];
  setRequireStub(statePath, { db: { execute: async () => [[]] } });
  setRequireStub(authPath, {
    getClientIP: () => '127.0.0.1',
    isRateLimited: () => null,
    getSignupMode: async () => 'disabled',
    recordFailedAttempt: () => {},
    hashPassword: async () => 'hash',
    verifyPassword: async () => true,
    generateToken: () => 'jwt-token',
    generateCsrfToken: () => 'csrf-token',
    getSessionExpiry: () => new Date('2030-01-01T00:00:00.000Z'),
    resetRateLimit: () => {},
    setAuthCookie: () => {},
    setCsrfCookie: () => {},
    getAuthTokenFromRequest: () => null,
    clearAuthCookie: () => {},
    clearCsrfCookie: () => {},
  });
  setRequireStub(twoFactorPath, {
    generateTwoFactorSecret: () => 'SECRET',
    verifyTotp: () => true,
    getOtpAuthUri: () => 'otpauth://test',
    getTwoFactorStatus: async () => ({ enabled: false, recoveryCodesRemaining: 0 }),
    enableTwoFactor: async () => [],
    disableTwoFactor: async () => {},
    verifyUserSecondFactor: async () => ({ ok: true }),
    createTwoFactorLoginChallenge: async () => 'challenge',
    consumeTwoFactorLoginChallenge: async () => null,
    deleteTwoFactorLoginChallenge: async () => {},
  });

  const routes = require('../src/routes/auth');
  assert.deepEqual(await routes['GET /api/auth/signup-mode'](), { signup_mode: 'disabled' });
});
