import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http = (require('node:http') as typeof import('node:http'));
const fs = (require('node:fs') as typeof import('node:fs'));
const path = (require('node:path') as typeof import('node:path'));

// A real HTTP server around the central request handler, with only the
// session lookup and module settings replaced by synthetic data.
async function eventsServer(t: import('node:test').TestContext, { sessions = new Map(), modules = () => ['mail'] }: FixtureValue = {}) {
  const names = ['../dist/src/request-handler', '../dist/src/auth', '../dist/src/routes', '../dist/src/routes/events',
    '../dist/src/services/module-settings', '../dist/src/services/restore-locks', '../dist/src/services/server-events'].map(name => require.resolve(name));
  const previous = names.map(name => require.cache[name]);
  const stub = (name: FixtureValue, exports: FixtureValue) => { require.cache[name] = { id: name, filename: name, loaded: true, exports } as NodeJS.Module; };
  const [handlerPath, authPath, routesPath, eventsPath, modulesPath, locksPath, busPath] = names;
  for (const name of [handlerPath, eventsPath, busPath]) delete require.cache[name];
  const tokenOf = (req: FixtureValue) => /(?:^|;\s*)token=([^;]+)/.exec(req.headers.cookie || '')?.[1] || null;
  stub(authPath, {
    getAuthTokenFromRequest: tokenOf,
    verifyToken: async (req: FixtureValue) => sessions.get(tokenOf(req)) || null,
    validateCsrfToken: () => true,
    refreshSessionCookies: () => {},
  });
  stub(modulesPath, {
    getUserModules: async (userId: string) => ['mail', 'calendar'].map(id => ({ id, enabled: modules(userId).includes(id) })),
    isModuleEnabled: async (userId: string, id: FixtureValue) => modules(userId).includes(id),
  });
  stub(locksPath, { getActiveRestoreSections: async () => new Set<FixtureValue>() });
  stub(routesPath, require(eventsPath) as typeof import('../src/routes/events'));
  const { handleRequest } = require(handlerPath) as typeof import('../src/request-handler');
  const events = require(busPath) as typeof import('../src/services/server-events');
  const server: FixtureValue = http.createServer((req, res) => { void handleRequest(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const clients = new Set<FixtureValue>();
  t.after(async () => {
    for (const client of clients) client.destroy();
    events.serverEvents.closeAll();
    await new Promise(resolve => server.close(resolve));
    names.forEach((name, i) => { if (previous[i]) require.cache[name] = previous[i]; else delete require.cache[name]; });
  });
  const port = server.address().port;
  function connect(token: FixtureValue, headers: FixtureValue = {}) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/events',
        headers: { Accept: 'text/event-stream', ...(token ? { Cookie: `token=${token}` } : {}), ...headers } }, res => {
        let text = '';
        const waiters: FixtureValue[] = [];
        res.setEncoding('utf8');
        res.on('data', chunk => {
          text += chunk;
          for (const waiter of [...waiters]) if (waiter.test(text)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
        });
        const ended = new Promise(done => res.on('end', done));
        resolve({
          res,
          status: res.statusCode,
          headers: res.headers,
          text: () => text,
          ended,
          until: (pattern: FixtureValue) => pattern.test(text) ? Promise.resolve()
            : new Promise<void>((done, fail) => {
              const timer = setTimeout(() => fail(new Error(`Timed out waiting for ${pattern}: ${text}`)), 2000);
              waiters.push({ test: (value: FixtureValue) => pattern.test(value), resolve: () => { clearTimeout(timer); done(); } });
            }),
          close: () => req.destroy(),
        });
      });
      clients.add(req);
      req.on('error', error => { if ((error as FixtureValue).code !== 'ECONNRESET') reject(error); });
    });
  }
  return { connect, events };
}

const readBody = async (client: FixtureValue) => { await client.ended; return client.text(); };

test('the events endpoint requires an authenticated session', async (t) => {
  const { connect, events } = await eventsServer(t, { sessions: new Map([['good', 'user-1']]) });
  for (const token of [null, 'revoked']) {
    const client: FixtureValue = await connect(token);
    assert.equal(client.status, 401);
    assert.match(client.headers['content-type'], /application\/json/);
    assert.match(await readBody(client), /Unauthorized/);
  }
  assert.equal(events.serverEvents.stats().streams, 0);
});

test('a foreign origin is refused before the stream opens', async (t) => {
  const { connect, events } = await eventsServer(t, { sessions: new Map([['good', 'user-1']]) });
  const client: FixtureValue = await connect('good', { Origin: 'https://attacker.example' });
  assert.equal(client.status, 403);
  assert.equal(events.serverEvents.stats().streams, 0);
});
