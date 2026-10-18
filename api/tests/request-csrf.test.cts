import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { EventEmitter } = (require('node:events') as typeof import('node:events'));
const { PassThrough } = (require('node:stream') as typeof import('node:stream'));
process.env.JWT_SECRET = 'request-csrf-test-only-secret';
const jwt = require('jsonwebtoken');

// The real request boundary, the real auth module and the real session routes:
// only the user and session rows, the other routes and the module/restore gates
// are synthetic.
function harness(t: import('node:test').TestContext) {
  const paths = ['../dist/src/request-handler', '../dist/src/routes', '../dist/src/services/module-settings', '../dist/src/services/restore-locks'].map(name => require.resolve(name));
  const previous = paths.map(name => require.cache[name]);
  const { setDb } = require('../dist/src/state') as typeof import('../src/state');
  t.after(() => { setDb(null); paths.forEach((name, i) => { if (previous[i]) require.cache[name] = previous[i]; else delete require.cache[name]; }); });
  const stub = (name: FixtureValue, exports: FixtureValue) => { require.cache[name] = { id: name, filename: name, loaded: true, exports } as NodeJS.Module; };
  delete require.cache[paths[0]];
  const calls: FixtureValue[] = [];
  const route = async (req: FixtureValue, userId: string) => { calls.push({ userId, credential: req.authCredential }); return { ok: true }; };
  const auth = require('../dist/src/routes/auth') as typeof import('../src/routes/auth');
  const { legacyTable } = require('./helpers/route-table.cts') as { legacyTable: (handlers: Record<string, FixtureValue>) => FixtureValue };
  const { mergeRouteTables } = require('../dist/src/http/route') as typeof import('../src/http/route');
  stub(paths[1], mergeRouteTables(legacyTable({ 'PUT /api/contacts/:id': route, 'GET /api/contacts': route, 'POST /api/mail/sync/background': route }), {
    'GET /api/auth/me': auth['GET /api/auth/me'], 'POST /api/auth/signin': auth['POST /api/auth/signin'], 'POST /api/auth/signout': auth['POST /api/auth/signout'],
  }));
  stub(paths[2], { isModuleEnabled: async () => true });
  stub(paths[3], { getActiveRestoreSections: async () => new Set<FixtureValue>() });
  const sessions = new Set([token]);
  const user = { id: 'u1', email: 'one@example.test', full_name: 'One', avatar_url: null, role: 'user', timezone: null, two_factor_enabled: 0, is_active: 1, password_hash: passwordHash };
  setDb({ async execute(sql: string, values: FixtureValue) {
    if (sql.includes('FROM sessions s')) return [sessions.has(values[0]) ? [{ user_id: 'u1', expires_at: new Date(Date.now() + 3600000), is_active: 1 }] : []];
    if (sql.startsWith('INSERT INTO sessions')) { sessions.add(values[1]); return [{ affectedRows: 1 }]; }
    if (sql.startsWith('DELETE FROM sessions WHERE token')) { sessions.delete(values[0]); return [{ affectedRows: 1 }]; }
    if (sql.includes('FROM users WHERE')) return [[user]];
    return [{ affectedRows: 0 }];
  } } as FixtureValue);
  const { handleRequest } = require(paths[0]) as typeof import('../src/request-handler');
  async function run(method: string, url: string, headers: Record<string, string>, body: FixtureValue = {}) {
    const req = new PassThrough(); Object.assign(req, { method, url, headers: { host: 'localhost', ...headers } });
    const res: FixtureValue = new EventEmitter(); const sent = new Map();
    res.setHeader = (key: FixtureValue, value: FixtureValue) => sent.set(key.toLowerCase(), value);
    res.getHeader = (key: FixtureValue) => sent.get(key.toLowerCase());
    res.writeHead = (status: FixtureValue, values = {}) => { res.status = status; res.headersSent = true; Object.entries(values).forEach(([key, value]) => res.setHeader(key, value)); };
    res.end = (value: FixtureValue) => { res.body = value === undefined ? undefined : JSON.parse(String(value)); };
    const running = handleRequest(req as FixtureValue, res); setImmediate(() => req.end(method === 'GET' ? '' : JSON.stringify(body))); await running;
    return { status: res.status, body: res.body, headers: sent };
  }
  return { run, calls };
}
const token = jwt.sign({ userId: 'u1', sub: 'u1' }, process.env.JWT_SECRET, { expiresIn: '21d' });
const password = 'request-csrf-password';
const passwordHash = require('bcryptjs').hashSync(password, 4);
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

test('the background-sync header stands in for the token only on a route that declares it', async (t) => {
  const { run, calls } = harness(t);
  const header = { ...cookie(), 'x-background-sync': '1' };
  assert.equal((await run('POST', '/api/mail/sync/background', header)).status, 200);
  assert.deepEqual(calls, [{ userId: 'u1', credential: 'cookie' }]);
  assert.equal((await run('PUT', '/api/contacts/c1', header)).status, 403);
  assert.equal((await run('POST', '/api/mail/sync/background', cookie())).status, 403);
  assert.equal(calls.length, 1);
});

test('an invalid bearer token is unauthenticated rather than CSRF-exempt', async (t) => {
  const { run, calls } = harness(t);
  const result = await run('PUT', '/api/contacts/c1', { authorization: 'Bearer not-a-session' });
  assert.equal(result.status, 401);
  assert.equal(calls.length, 0);
});

test('a cross-origin preflight allows every header the client sends', async t => {
  const { run } = harness(t);
  const result = await run('OPTIONS', '/api/contacts/c1', { 'access-control-request-method': 'PUT' });
  assert.equal(result.status, 204);
  const allowed = String(result.headers.get('access-control-allow-headers')).toLowerCase().split(/,\s*/);
  for (const header of ['content-type', 'x-csrf-token', 'idempotency-key', 'x-background-sync']) assert(allowed.includes(header), header);
});

// One browser session in several tabs shares one cookie jar, but each page
// keeps the token /auth/me gave it in memory. Reloading one tab (for example
// to apply an update) must not invalidate the token of a tab that still has
// unsaved work.
test('every tab of a browser session keeps a working CSRF token until sign-out or a new sign-in', async t => {
  const { run, calls } = harness(t);
  const jar = new Map([['auth-token', token]]);
  async function send(method: string, url: string, headers: Record<string, string> = {}, body?: FixtureValue) {
    const result = await run(method, url, { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), ...headers }, body);
    for (const line of [result.headers.get('set-cookie') || []].flat() as string[]) {
      const [pair] = line.split(';'); const name = pair.slice(0, pair.indexOf('=')), value = pair.slice(pair.indexOf('=') + 1);
      if (line.includes('Expires=Thu, 01 Jan 1970')) jar.delete(name); else jar.set(name, value);
    }
    return result;
  }
  const page = async () => (await send('GET', '/api/auth/me')).body.csrfToken as string;
  const tabA = await page(), tabB = await page(), tabAReloaded = await page();
  assert.match(tabA, /^[a-f0-9]{64}$/);
  assert.equal(tabB, tabA, 'A second tab gets the session token');
  assert.equal(tabAReloaded, tabA, 'Reloading a tab keeps the token the other tabs hold');
  assert.equal((await send('PUT', '/api/contacts/c1', { 'x-csrf-token': tabB })).status, 200, 'Tab B saves after tab A reloaded');
  assert.equal(calls.length, 1);

  // The check itself is unchanged: a missing or different token is refused.
  assert.equal((await send('PUT', '/api/contacts/c1')).status, 403);
  assert.equal((await send('PUT', '/api/contacts/c1', { 'x-csrf-token': 'f'.repeat(64) })).status, 403);
  // A cookie value the server never issues is replaced, not handed to the page.
  jar.set('csrf-token', 'planted');
  const replaced = await page();
  assert.match(replaced, /^[a-f0-9]{64}$/);
  assert.equal(jar.get('csrf-token'), replaced);

  // Sign-out clears the token; the next sign-in issues a different one, so a
  // page still holding the old token cannot write with the new session.
  assert.equal((await send('POST', '/api/auth/signout', { 'x-csrf-token': replaced })).status, 200);
  assert.equal(jar.has('csrf-token'), false);
  const signedIn = await send('POST', '/api/auth/signin', {}, { email: 'one@example.test', password });
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.body.csrfToken, /^[a-f0-9]{64}$/);
  assert.notEqual(signedIn.body.csrfToken, replaced);
  assert.equal(await page(), signedIn.body.csrfToken);
  assert.equal((await send('PUT', '/api/contacts/c1', { 'x-csrf-token': replaced })).status, 403);
  assert.equal((await send('PUT', '/api/contacts/c1', { 'x-csrf-token': signedIn.body.csrfToken })).status, 200);
  assert.equal(calls.length, 2);
});
