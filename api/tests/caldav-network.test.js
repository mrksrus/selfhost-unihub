const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const https = require('node:https');
const dns = require('node:dns').promises;
const { davRequest, MAX_DAV_RESPONSE_BYTES } = require('../src/security/caldav-transport');
const { discoverCalDavCalendars, validateDavUrlPolicy } = require('../src/services/caldav');

const origin = 'https://calendar.example';
const credentials = { username: 'fixture-user', password: 'fixture-secret' };
const publicAddress = '93.184.216.34';

function installDavFixture(t, responses) {
  const calls = [];
  t.mock.method(dns, 'lookup', async () => [{ address: publicAddress, family: 4 }]);
  t.mock.method(https, 'request', (options, onResponse) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = body => {
      calls.push({ ...options, body });
      const fixture = responses[calls.length - 1];
      assert.ok(fixture, `Unexpected outgoing request ${calls.length}`);
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = fixture.status || 207;
        response.headers = fixture.headers || {};
        onResponse(response);
        if (!response.destroyed) {
          for (const chunk of fixture.chunks || [Buffer.from(fixture.text || '')]) response.write(chunk);
          response.end();
        }
      });
    };
    return request;
  });
  return calls;
}

test('CalDAV follows legitimate same-origin HTTPS redirects with checked IP, Host and TLS name', async t => {
  const calls = installDavFixture(t, [
    { status: 302, headers: { location: '/dav/' } }, { text: '<ok />' },
  ]);
  const result = await davRequest(`${origin}/.well-known/caldav`, { ...credentials, body: '<propfind />' });
  assert.equal(result.url, `${origin}/dav/`);
  assert.equal(result.text, '<ok />');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.hostname, publicAddress);
    assert.equal(call.servername, 'calendar.example');
    assert.equal(call.headers.Host, 'calendar.example');
    assert.equal(call.rejectUnauthorized, true);
    assert.equal(call.agent, false);
    assert.equal(call.method, 'PROPFIND');
    assert.equal(call.body, '<propfind />');
    assert.ok(call.signal);
  }
});

test('CalDAV refuses private/mapped initial endpoints and HTTP before creating a request', async t => {
  const calls = installDavFixture(t, []);
  for (const url of ['http://calendar.example/', 'https://127.0.0.1/', 'https://[::ffff:7f00:1]/']) {
    await assert.rejects(davRequest(url, credentials), /HTTPS|non-public/);
    assert.equal((await validateDavUrlPolicy(url)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('CalDAV does not forward credentials across redirects, including private and downgraded targets', async t => {
  for (const destination of ['https://attacker.example/', 'https://127.0.0.1/', 'http://calendar.example/']) {
    const calls = installDavFixture(t, [{ status: 307, headers: { location: destination } }]);
    await assert.rejects(davRequest(`${origin}/start`, credentials), /different server origin|HTTPS/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.Host, 'calendar.example');
    t.mock.restoreAll();
  }
});

test('CalDAV resolves every redirect hop and blocks DNS rebinding before the next connection', async t => {
  const calls = installDavFixture(t, [{ status: 302, headers: { location: '/next' } }]);
  let lookups = 0;
  t.mock.method(dns, 'lookup', async () => [{ address: ++lookups === 1 ? publicAddress : '192.168.1.1', family: 4 }]);
  await assert.rejects(davRequest(`${origin}/start`, credentials), /non-public/);
  assert.equal(lookups, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostname, publicAddress);
});

test('CalDAV limits redirect loops and response bytes (headers and streamed bodies)', async t => {
  let calls = installDavFixture(t, Array.from({ length: 6 }, () => ({ status: 302, headers: { location: '/loop' } })));
  await assert.rejects(davRequest(`${origin}/loop`, credentials), /redirect limit/);
  assert.equal(calls.length, 6);
  t.mock.restoreAll();
  calls = installDavFixture(t, [{ headers: { 'content-length': MAX_DAV_RESPONSE_BYTES + 1 } }]);
  await assert.rejects(davRequest(`${origin}/large`, credentials), /16 MiB/);
  assert.equal(calls.length, 1);
  t.mock.restoreAll();
  installDavFixture(t, [{ chunks: [Buffer.alloc(MAX_DAV_RESPONSE_BYTES), Buffer.from('x')] }]);
  await assert.rejects(davRequest(`${origin}/large`, credentials), /16 MiB/);
});

test('discovery never sends credentials to a server named by an untrusted principal/home/calendar href', async t => {
  for (const responses of [
    [{ text: '<current-user-principal><href>https://attacker.example/principal</href></current-user-principal>' }],
    [{ text: '<calendar-home-set><href>https://attacker.example/home</href></calendar-home-set>' }],
    [{ text: '<calendar-home-set><href>/home</href></calendar-home-set>' },
      { text: '<response><href>https://attacker.example/calendar</href><resourcetype><calendar /></resourcetype></response>' }],
  ]) {
    const calls = installDavFixture(t, responses);
    await assert.rejects(discoverCalDavCalendars({ discoveryUrl: `${origin}/discovery`, ...credentials }), /different server origin/);
    assert.equal(calls.length, responses.length);
    assert.ok(calls.every(call => call.headers.Host === 'calendar.example'));
    t.mock.restoreAll();
  }
});

test('same-origin principal, home and calendar discovery continues to work', async t => {
  const calls = installDavFixture(t, [
    { text: '<current-user-principal><href>/principal</href></current-user-principal>' },
    { text: '<calendar-home-set><href>/home/</href></calendar-home-set>' },
    { text: '<response><href>/home/personal/</href><displayname>Personal</displayname><resourcetype><calendar /></resourcetype></response>' },
  ]);
  const result = await discoverCalDavCalendars({ discoveryUrl: `${origin}/discovery`, ...credentials });
  assert.equal(result.baseUrl, `${origin}/home/`);
  assert.equal(result.calendars[0].url, `${origin}/home/personal/`);
  assert.equal(result.calendars[0].displayName, 'Personal');
  assert.deepEqual(calls.map(call => call.path), ['/discovery', '/principal', '/home/']);
});
