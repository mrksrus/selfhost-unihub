import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { spawnSync } = (require('node:child_process') as typeof import('node:child_process'));

function setRequireStub(modulePath: string, exports: FixtureValue) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  } as NodeJS.Module;
}

test('public signup mode endpoint defaults to disabled, with no data rules while every policy is at its default', async (t) => {
  const routePath = require.resolve('../dist/src/routes/auth');
  const authPath = require.resolve('../dist/src/auth');
  const statePath = require.resolve('../dist/src/state');
  const twoFactorPath = require.resolve('../dist/src/services/two-factor');
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
    consumeAuthAttempt: () => null,
    hashPassword: async () => 'hash',
    verifyPassword: async () => true,
    generateToken: () => 'jwt-token',
    generateCsrfToken: () => 'csrf-token',
    getSessionExpiry: () => new Date('2030-01-01T00:00:00.000Z'),
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

  const routes = require('../dist/src/routes/auth') as typeof import('../src/routes/auth');
  assert.deepEqual(await routes['GET /api/auth/signup-mode'].handler(), { signup_mode: 'disabled', data_rules: [] });
});

// COOKIE_SECURE is read once at load, so each mode runs in its own process.
test('session and CSRF cookies carry Secure exactly when NODE_ENV is production', () => {
  const script = `
    const auth = require(${JSON.stringify(require.resolve('../dist/src/auth'))});
    const headers = new Map();
    const res = { setHeader: (key, value) => headers.set(key, value), getHeader: key => headers.get(key) };
    auth.setAuthCookie(res, 'session-token'); auth.setCsrfCookie(res, 'csrf-token');
    auth.clearAuthCookie(res); auth.clearCsrfCookie(res);
    process.stdout.write(JSON.stringify(headers.get('Set-Cookie')));`;
  const cookiesWith = (nodeEnv: string | null) => {
    const env: NodeJS.ProcessEnv = { ...process.env, JWT_SECRET: 'auth-route-cookie-test-secret' };
    if (nodeEnv === null) delete env.NODE_ENV; else env.NODE_ENV = nodeEnv;
    const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as string[];
  };
  const production = cookiesWith('production');
  assert.equal(production.length, 4);
  for (const cookie of production) assert.match(cookie, /; Secure; SameSite=Strict; Path=\//, cookie);
  for (const cookie of cookiesWith(null)) assert.doesNotMatch(cookie, /Secure/, cookie);
});
