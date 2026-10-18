import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { EventEmitter } = (require('node:events') as typeof import('node:events'));
const { PassThrough } = (require('node:stream') as typeof import('node:stream'));

function handlerHarness(t: import('node:test').TestContext, { userId = 'u1', route, moduleEnabled = true, restoring = [] }: FixtureValue = {}) {
  const paths = ['../dist/src/request-handler', '../dist/src/auth', '../dist/src/routes', '../dist/src/services/module-settings', '../dist/src/services/restore-locks'].map(name => require.resolve(name));
  const previous = paths.map(name => require.cache[name]);
  t.after(() => paths.forEach((name, i) => { if (previous[i]) require.cache[name] = previous[i]; else delete require.cache[name]; }));
  const stub = (name: FixtureValue, exports: FixtureValue) => { require.cache[name] = { id: name, filename: name, loaded: true, exports } as NodeJS.Module; };
  delete require.cache[paths[0]];
  stub(paths[1], { verifyToken: async () => userId, validateCsrfToken: () => true, refreshSessionCookies: () => {} });
  stub(paths[3], { isModuleEnabled: async () => moduleEnabled });
  stub(paths[4], { getActiveRestoreSections: async () => new Set<FixtureValue>(restoring) });
  stub(paths[2], { 'GET /api/mail/attachments/:id': route, 'PUT /api/mail/emails/:id': route, 'POST /api/mail/writebacks/:id/retry': route,
    'POST /api/mail/writebacks/:id/accept-server-state': route,
    'POST /api/admin/users/:id/2fa/reset': route,
    'PUT /api/recordings/:id': route, 'POST /api/contacts': route, 'PUT /api/contacts/:id': route,
    'POST /api/auth/signin': route, 'POST /api/auth/signup': route, 'PUT /api/auth/password': route, 'PUT /api/admin/users/:id/password': route,
    'GET /api/version': async () => ({ app: 'unihub' }),
    'GET /api/modules': route, 'GET /api/contacts/export': route, 'GET /api/offline/snapshot': route || (async (_req: FixtureValue, user: FixtureValue) => ({ snapshot: { userId: user } })),
    'POST /api/parse-test': route || (async () => ({ success: true })) });
  const { handleRequest } = require(paths[0]) as typeof import('../src/request-handler');
  return async function run(method: string, url: string, body = '', overrides = {}) {
    const req = new PassThrough(); Object.assign(req, { method, url, headers: { host: 'localhost', ...overrides } });
    const res: FixtureValue = new EventEmitter(); const headers = new Map();
    res.setHeader = (key: FixtureValue, value: FixtureValue) => headers.set(key.toLowerCase(), value);
    res.getHeader = (key: FixtureValue) => headers.get(key.toLowerCase());
    res.writeHead = (status: FixtureValue, values = {}) => { res.status = status; res.headersSent = true; Object.entries(values).forEach(([key, value]) => res.setHeader(key, value)); };
    res.end = (value: FixtureValue) => { res.body = JSON.parse(String(value)); };
    const running = handleRequest(req as FixtureValue, res); setImmediate(() => req.end(body)); await running;
    return { status: res.status, body: res.body, headers };
  };
}

test('offline snapshot is authenticated by the central handler and its response is never HTTP-cached', async (t) => {
  const run = handlerHarness(t);
  const result = await run('GET', '/api/offline/snapshot');
  assert.equal(result.status, 200);
  assert.equal(result.body.snapshot.userId, 'u1');
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('malformed authorities and request targets return 400 and later requests still work', async (t) => {
  let called = 0;
  const run = handlerHarness(t, ({ route: async () => { called++; return { success: true }; } }));
  for (const host of ['%', 'localhost/path', 'user@localhost', '[invalid]', 'localhost:999999']) {
    assert.equal((await run('GET', '/api/offline/snapshot', '', { host })).status, 400);
  }
  for (const target of ['//example.test/api/offline/snapshot', 'http://example.test/api/offline/snapshot', '/\\example.test']) {
    assert.equal((await run('GET', target)).status, 400);
  }
  assert.equal(called, 0);
  assert.equal((await run('GET', '/api/offline/snapshot')).status, 200);
  assert.equal(called, 1);
});

test('unauthenticated offline requests never reach the snapshot service', async (t) => {
  let called = false;
  const run = handlerHarness(t, { userId: null, route: async () => { called = true; return {}; } });
  assert.equal((await run('GET', '/api/offline/snapshot')).status, 401);
  assert.equal(called, false);
});

test('the version handshake answers before signing in, so the Android app can recognize the server', async (t) => {
  const run = handlerHarness(t, { userId: null });
  const result = await run('GET', '/api/version');
  assert.equal(result.status, 200);
  assert.equal(result.body.app, 'unihub');
});

test('malformed JSON returns 400 without invoking its mutation route', async (t) => {
  let called = false;
  const run = handlerHarness(t, ({ route: async () => { called = true; return {}; } }));
  const result = await run('POST', '/api/parse-test', '{"unfinished":');
  assert.equal(result.status, 400);
  assert.equal(called, false);
  assert.match(result.body.error, /Invalid JSON/);
});

test('mail provider change retry reaches its parameterized route', async (t) => {
  const run = handlerHarness(t, ({ route: async (req: FixtureValue, userId: string) => ({ id: req.params.id, userId }) }));
  const result = await run('POST', '/api/mail/writebacks/change-1/retry', '{}');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { id: 'change-1', userId: 'u1' });
  const accepted = await run('POST', '/api/mail/writebacks/change-2/accept-server-state', '{}');
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { id: 'change-2', userId: 'u1' });
});


test('admin 2FA reset reaches its parameterized route with the body', async (t) => {
  const run = handlerHarness(t, ({ route: async (req: FixtureValue, userId: string, body: FixtureValue) => ({ url: req.url, userId, body }) }));
  const result = await run('POST', '/api/admin/users/user-2/2fa/reset', '{"current_password":"synthetic"}');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { url: '/api/admin/users/user-2/2fa/reset', userId: 'u1', body: { current_password: 'synthetic' } });
});

test('disabled module reads, attachments and writes are rejected before reaching a handler', async (t) => {
  let calls = 0;
  const run = handlerHarness(t, ({ moduleEnabled: false, route: async () => { calls++; return { ok: true }; } }));
  for (const [method, path] of [['GET', '/api/mail/attachments/file'], ['PUT', '/api/mail/emails/email'], ['GET', '/api/contacts/export']] as const) {
    const result = await run(method, path, method === 'PUT' ? '{}' : '');
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'MODULE_DISABLED');
  }
  assert.equal(calls, 0);
  assert.equal((await run('GET', '/api/modules')).status, 200);
  assert.equal(calls, 1);
});

test('writes during a restore of their section get a 409 that clients can tell from lasting conflicts', async (t) => {
  let called = false;
  const run = handlerHarness(t, { restoring: ['mail'], route: async () => { called = true; return { success: true }; } });
  const result = await run('PUT', '/api/mail/emails/e1', '{}', { 'content-type': 'application/json' });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'RESTORE_IN_PROGRESS');
  assert.equal(called, false);
});

test('body limits come from the route table: the default applies to ordinary routes', async (t) => {
  let called = 0;
  const run = handlerHarness(t, ({ route: async () => { called++; return { success: true }; } }));
  const oversized = await run('POST', '/api/parse-test', '{}', { 'content-length': '16385' });
  assert.equal(oversized.status, 413);
  assert.match(oversized.body.error, /max 16384 bytes/);
  assert.equal(called, 0);
  assert.equal((await run('POST', '/api/parse-test', '{}', { 'content-length': '2' })).status, 200);
  assert.equal(called, 1);
});

test('a long chord sheet and long contact notes reach their handlers; each explicit limit still refuses more', async (t) => {
  let called = 0;
  const run = handlerHarness(t, ({ route: async () => { called++; return { success: true }; } }));
  const chords = JSON.stringify({ category: 'music', metadata: { chords: '[Verse]\nC  G  Am  F\n'.repeat(180) } });
  assert.ok(chords.length > 3000);
  assert.equal((await run('PUT', '/api/recordings/r1', chords)).status, 200);
  const contact = JSON.stringify({ first_name: 'Alice', notes: 'Met at the spring conference; prefers mail. '.repeat(50) });
  assert.ok(contact.length > 2000);
  assert.equal((await run('POST', '/api/contacts', contact)).status, 200);
  assert.equal(called, 2);
  for (const [method, path, limit] of [
    ['PUT', '/api/recordings/r1', 262144],
    ['POST', '/api/contacts', 65536],
    ['PUT', '/api/contacts/c1', 65536],
    ['POST', '/api/auth/signin', 4096],
    ['POST', '/api/auth/signup', 4096],
    ['PUT', '/api/auth/password', 4096],
    ['PUT', '/api/admin/users/u2/password', 4096],
  ] as const) {
    const result = await run(method, path, '{}', { 'content-length': String(limit + 1) });
    assert.equal(result.status, 413, `${method} ${path}`);
    assert.match(result.body.error, new RegExp(`max ${limit} bytes`), `${method} ${path}`);
  }
  assert.equal(called, 2);
});

test('a parameter with malformed percent-encoding is rejected with 400 before any route runs', async (t) => {
  let called = 0;
  const run = handlerHarness(t, ({ route: async (req: FixtureValue) => { called++; return { id: req.params.id }; } }));
  const result = await run('PUT', '/api/mail/emails/%E0%A4%A', '{}');
  assert.equal(result.status, 400);
  assert.equal(called, 0);
  const decoded = await run('PUT', '/api/mail/emails/e%201', '{}');
  assert.equal(decoded.status, 200);
  assert.equal(decoded.body.id, 'e 1');
});
