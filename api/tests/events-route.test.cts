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
  stub(routesPath, require(eventsPath));
  const { handleRequest } = require(handlerPath);
  const events = require(busPath);
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

test('an authenticated stream sends SSE headers, the retry hint, ready and heartbeats', async (t) => {
  const { connect, events } = await eventsServer(t, { sessions: new Map([['good', 'user-1']]) });
  const client: FixtureValue = await connect('good');
  assert.equal(client.status, 200);
  assert.match(client.headers['content-type'], /^text\/event-stream/);
  assert.equal(client.headers['x-accel-buffering'], 'no');
  assert.match(client.headers['cache-control'], /no-store/);
  await client.until(/event: ready\n/);
  assert.match(client.text(), /^retry: \d+\n\n/);
  await events.serverEvents.tick();
  await client.until(/: ping\n\n/);
});

test('a user never receives another user\'s events', async (t) => {
  const { connect, events } = await eventsServer(t, { sessions: new Map([['alice', 'user-a'], ['bob', 'user-b']]) });
  const alice: FixtureValue = await connect('alice');
  const bob: FixtureValue = await connect('bob');
  await alice.until(/event: ready/);
  await bob.until(/event: ready/);
  events.publishMailJob({ id: 'job-b', user_id: 'user-b', mail_account_id: 'account-b', kind: 'sync', state: 'queued' });
  events.publishMailChanged('user-a', 'account-a', 'import');
  await bob.until(/account-b/);
  await alice.until(/account-a/);
  assert.doesNotMatch(alice.text(), /account-b|job-b/);
  assert.doesNotMatch(bob.text(), /account-a/);
});

test('mail events are withheld while the mail module is disabled', async (t) => {
  let enabled = ['calendar'];
  const { connect, events } = await eventsServer(t, { sessions: new Map([['good', 'user-1']]), modules: () => enabled });
  const client: FixtureValue = await connect('good');
  await client.until(/event: ready/);
  events.publishMailChanged('user-1', 'account-1', 'import');
  enabled = ['mail'];
  await events.serverEvents.tick(); // revalidation refreshes the module set
  events.publishMailChanged('user-1', 'account-2', 'import');
  await client.until(/account-2/);
  assert.doesNotMatch(client.text(), /account-1/);
});

test('a revoked session is ended at the next heartbeat', async (t) => {
  const sessions = new Map([['good', 'user-1']]);
  const { connect, events } = await eventsServer(t, { sessions });
  const client: FixtureValue = await connect('good');
  await client.until(/event: ready/);
  sessions.delete('good');
  await events.serverEvents.tick();
  await client.ended;
  assert.match(client.text(), /event: end\ndata: \{"reason":"session_ended"\}/);
  assert.equal(events.serverEvents.stats().streams, 0);
});

test('a disconnected client is removed and the per-user cap is enforced', async (t) => {
  const { connect, events } = await eventsServer(t, { sessions: new Map([['good', 'user-1']]) });
  const open = [];
  for (let i = 0; i < events.DEFAULTS.maxPerUser; i++) {
    const client: FixtureValue = await connect('good');
    await client.until(/event: ready/);
    open.push(client);
  }
  const refused: FixtureValue = await connect('good');
  assert.equal(refused.status, 429);
  assert.equal(refused.headers['retry-after'], '60');
  open[0].close();
  for (let i = 0; i < 50 && events.serverEvents.stats().streams !== events.DEFAULTS.maxPerUser - 1; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(events.serverEvents.stats().streams, events.DEFAULTS.maxPerUser - 1);
  const again: FixtureValue = await connect('good');
  assert.equal(again.status, 200);
});

test('nginx and the service worker pass the event stream through unbuffered and uncached', () => {
  const root = path.join(__dirname, '../..');
  const nginx = fs.readFileSync(path.join(root, 'docker/nginx/default.conf'), 'utf8');
  const block = /location = \/api\/events \{([\s\S]*?)\n {4}\}/.exec(nginx)?.[1];
  assert.ok(block, 'nginx has a dedicated /api/events location');
  assert.match(block, /proxy_buffering off;/);
  assert.match(block, /proxy_read_timeout 1h;/);
  assert.match(block, /gzip off;/);
  assert.doesNotMatch(block, /add_header/);
  assert.ok(nginx.indexOf('location = /api/events') < nginx.indexOf('location /api/ {'));
  const vite = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
  assert.match(vite, /url\.pathname\.startsWith\('\/api\/'\) && url\.pathname !== '\/api\/events'/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.worker-dist/sw-custom.js'), 'utf8'), /addEventListener\(['"]fetch/);
});
