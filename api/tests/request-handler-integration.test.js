const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function handlerHarness(t, { userId = 'u1', route } = {}) {
  const paths = ['../src/request-handler', '../src/auth', '../src/routes'].map(require.resolve);
  const previous = paths.map(name => require.cache[name]);
  t.after(() => paths.forEach((name, i) => { if (previous[i]) require.cache[name] = previous[i]; else delete require.cache[name]; }));
  const stub = (name, exports) => { require.cache[name] = { id: name, filename: name, loaded: true, exports }; };
  delete require.cache[paths[0]];
  stub(paths[1], { verifyToken: async () => userId, validateCsrfToken: () => true });
  stub(paths[2], { 'GET /api/offline/snapshot': route || (async (_req, user) => ({ snapshot: { userId: user } })),
    'POST /api/parse-test': route || (async () => ({ success: true })) });
  const { handleRequest } = require(paths[0]);
  return async function run(method, url, body = '', overrides = {}) {
    const req = new PassThrough(); Object.assign(req, { method, url, headers: { host: 'localhost', ...overrides } });
    const res = new EventEmitter(); const headers = new Map();
    res.setHeader = (key, value) => headers.set(key.toLowerCase(), value);
    res.getHeader = key => headers.get(key.toLowerCase());
    res.writeHead = (status, values = {}) => { res.status = status; res.headersSent = true; Object.entries(values).forEach(([key, value]) => res.setHeader(key, value)); };
    res.end = value => { res.body = JSON.parse(String(value)); };
    const running = handleRequest(req, res); setImmediate(() => req.end(body)); await running;
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
  const run = handlerHarness(t, { route: async () => { called++; return { success: true }; } });
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

test('malformed JSON returns 400 without invoking its mutation route', async (t) => {
  let called = false;
  const run = handlerHarness(t, { route: async () => { called = true; return {}; } });
  const result = await run('POST', '/api/parse-test', '{"unfinished":');
  assert.equal(result.status, 400);
  assert.equal(called, false);
  assert.match(result.body.error, /Invalid JSON/);
});
