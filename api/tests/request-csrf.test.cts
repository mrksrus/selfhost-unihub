import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { EventEmitter } = (require('node:events') as typeof import('node:events'));
const { PassThrough } = (require('node:stream') as typeof import('node:stream'));
process.env.JWT_SECRET = 'request-csrf-test-only-secret';
const jwt = require('jsonwebtoken');

// The real request boundary and the real auth module: only the session row
// lookup, the route table and the module/restore gates are synthetic.
function harness(t: import('node:test').TestContext) {
  const paths = ['../dist/src/request-handler', '../dist/src/routes', '../dist/src/services/module-settings', '../dist/src/services/restore-locks'].map(name => require.resolve(name));
  const previous = paths.map(name => require.cache[name]);
  const { setDb } = require('../dist/src/state') as typeof import('../src/state');
  t.after(() => { setDb(null); paths.forEach((name, i) => { if (previous[i]) require.cache[name] = previous[i]; else delete require.cache[name]; }); });
  const stub = (name: FixtureValue, exports: FixtureValue) => { require.cache[name] = { id: name, filename: name, loaded: true, exports } as NodeJS.Module; };
  delete require.cache[paths[0]];
  const calls: FixtureValue[] = [];
  const route = async (req: FixtureValue, userId: string) => { calls.push({ userId, credential: req.authCredential }); return { ok: true }; };
  stub(paths[1], { 'PUT /api/contacts/:id': route, 'GET /api/contacts': route });
  stub(paths[2], { isModuleEnabled: async () => true });
  stub(paths[3], { getActiveRestoreSections: async () => new Set<FixtureValue>() });
  setDb({ async execute(sql: string, values: FixtureValue) {
    if (sql.includes('FROM sessions s')) return [values[0] === token ? [{ user_id: 'u1', expires_at: new Date(Date.now() + 3600000), is_active: 1 }] : []];
    return [{ affectedRows: 0 }];
  } } as FixtureValue);
  const { handleRequest } = require(paths[0]) as typeof import('../src/request-handler');
  async function run(method: string, url: string, headers: Record<string, string>) {
    const req = new PassThrough(); Object.assign(req, { method, url, headers: { host: 'localhost', ...headers } });
    const res: FixtureValue = new EventEmitter(); const sent = new Map();
    res.setHeader = (key: FixtureValue, value: FixtureValue) => sent.set(key.toLowerCase(), value);
    res.getHeader = (key: FixtureValue) => sent.get(key.toLowerCase());
    res.writeHead = (status: FixtureValue, values = {}) => { res.status = status; res.headersSent = true; Object.entries(values).forEach(([key, value]) => res.setHeader(key, value)); };
    res.end = (value: FixtureValue) => { res.body = JSON.parse(String(value)); };
    const running = handleRequest(req as FixtureValue, res); setImmediate(() => req.end(method === 'GET' ? '' : '{}')); await running;
    return { status: res.status, body: res.body };
  }
  return { run, calls };
}
const token = jwt.sign({ userId: 'u1', sub: 'u1' }, process.env.JWT_SECRET, { expiresIn: '21d' });
const csrf = 'c'.repeat(64);
const bearer = { authorization: `Bearer ${token}` };
const cookie = (extra = '') => ({ cookie: `auth-token=${token}${extra}` });

test('a bearer-authenticated write without an auth cookie needs no CSRF token', async (t) => {
  const { run, calls } = harness(t);
  const result = await run('PUT', '/api/contacts/c1', bearer);
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{ userId: 'u1', credential: 'bearer' }]);
  assert.equal((await run('GET', '/api/contacts', bearer)).status, 200);
});

test('a cookie-authenticated write without a CSRF token is still refused', async (t) => {
  const { run, calls } = harness(t);
  const result = await run('PUT', '/api/contacts/c1', cookie());
  assert.equal(result.status, 403);
  assert.match(result.body.error, /CSRF/);
  assert.equal(calls.length, 0);
  // The matching cookie/header pair keeps working for browser sessions.
  const allowed = await run('PUT', '/api/contacts/c1', { ...cookie(`; csrf-token=${csrf}`), 'x-csrf-token': csrf });
  assert.equal(allowed.status, 200);
  assert.deepEqual(calls, [{ userId: 'u1', credential: 'cookie' }]);
});

test('a bearer header next to an ambient auth cookie does not lift the CSRF check', async (t) => {
  const { run, calls } = harness(t);
  const result = await run('PUT', '/api/contacts/c1', { ...bearer, ...cookie() });
  assert.equal(result.status, 403);
  assert.equal(calls.length, 0);
  const allowed = await run('PUT', '/api/contacts/c1', { ...bearer, ...cookie(`; csrf-token=${csrf}`), 'x-csrf-token': csrf });
  assert.equal(allowed.status, 200);
  assert.deepEqual(calls, [{ userId: 'u1', credential: 'bearer' }]);
});

test('an invalid bearer token is unauthenticated rather than CSRF-exempt', async (t) => {
  const { run, calls } = harness(t);
  const result = await run('PUT', '/api/contacts/c1', { authorization: 'Bearer not-a-session' });
  assert.equal(result.status, 401);
  assert.equal(calls.length, 0);
});
