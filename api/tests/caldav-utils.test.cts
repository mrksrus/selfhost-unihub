import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { EventEmitter } = (require('node:events') as typeof import('node:events'));
const {
  matchCalendarProvider,
  wellKnownCandidates,
  lookupSrvCandidates,
  findCalDavServer,
  accountCredentialScope,
  canonicalHref,
  normalizeIcsFeedUrl,
} = require('../dist/src/services/caldav') as typeof import('../src/services/caldav');
const {
  parseDigestChallenge,
  digestAuthorization,
  resolveCalDavUrl,
  davRequest,
} = require('../dist/src/security/caldav-transport') as typeof import('../src/security/caldav-transport');
const { calendarErrorResponse } = require('../dist/src/services/calendar-sync') as typeof import('../src/services/calendar-sync');

test('discovery explains unsupported providers and missing passwords without network access', async () => {
  await assert.rejects(findCalDavServer({ emailAddress: 'user@gmail.com', password: 'x' }), { code: 'CALDAV_PROVIDER_UNSUPPORTED', status: 422 });
  await assert.rejects(findCalDavServer({ emailAddress: 'user@example.com' }), { code: 'CALDAV_NO_PASSWORD' });
});

test('credential scope uses known presets only and otherwise the discovery origin', () => {
  const icloud = matchCalendarProvider({ emailAddress: 'user@icloud.com' })!.scope;
  assert.deepEqual(accountCredentialScope({ provider_config: { credentialScope: icloud }, discovery_url: 'https://caldav.icloud.com/' }), icloud);
  assert.equal(resolveCalDavUrl('https://p42-caldav.icloud.com/123/calendars/', undefined, icloud!), 'https://p42-caldav.icloud.com/123/calendars/');
  // A widened scope that is not a preset (a tampered backup) falls back to the origin.
  const widened = JSON.stringify({ credentialScope: { origin: 'https://dav.example.com', hostSuffixes: ['.com'] } });
  assert.equal(accountCredentialScope({ provider_config: widened, discovery_url: 'https://dav.example.com/dav/', base_url: 'https://other.example.com/' }), 'https://dav.example.com');
  assert.throws(() => resolveCalDavUrl('https://other.example.com/cal/', undefined, 'https://dav.example.com'), /different server origin/);
});

test('Digest challenges are parsed and answered per RFC 7616', () => {
  const challenge = parseDigestChallenge('Digest realm="dav@example.com", qop="auth,auth-int", nonce="abc", opaque="xyz"');
  assert.deepEqual(challenge, { realm: 'dav@example.com', nonce: 'abc', opaque: 'xyz', algorithm: 'MD5', qop: 'auth' });
  assert.equal(parseDigestChallenge('Basic realm="dav"'), null);
  assert.equal(parseDigestChallenge('Digest realm="dav", nonce="n", Basic realm="dav"'), null, 'Basic is used when offered');
  assert.equal(parseDigestChallenge('Digest realm="dav", nonce="n", algorithm=SHA-512-256'), null);
  const header = digestAuthorization({ realm: 'r', nonce: 'n', algorithm: 'MD5', qop: null }, { method: 'GET', uri: '/x', username: 'u', password: 'p' });
  // MD5(MD5("u:r:p"):n:MD5("GET:/x"))
  assert.match(header, /response="3042aef13752cb1d63f6787a080ffdfc"/);
  assert.match(header, /^Digest username="u", realm="r", nonce="n", uri="\/x", algorithm=MD5/);
});

function fakeServer(responses: FixtureValue, seen: FixtureValue) {
  return (options: FixtureValue, onResponse: FixtureValue) => {
    const req: FixtureValue = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      seen.push(options);
      const next = responses.shift();
      const response = new EventEmitter();
      Object.assign(response, { statusCode: next.status, headers: next.headers || {}, destroy() {} });
      onResponse(response);
      process.nextTick(() => { if (next.body) response.emit('data', Buffer.from(next.body)); response.emit('end'); });
    };
    return req;
  };
}

test('davRequest retries once with Digest and never sends credentials across origins', async () => {
  const seen: FixtureValue[] = [];
  const resolveTarget = async (hostname: string) => ({ hostname, address: '203.0.113.10', family: 4 });
  const request = fakeServer([
    { status: 401, headers: { 'www-authenticate': 'Digest realm="r", nonce="n", qop="auth"' } },
    { status: 207, body: '<multistatus/>' },
  ], seen);
  const result = await davRequest('https://dav.example.com/cal/', { username: 'u', password: 'p' }, { request, resolveTarget: resolveTarget as FixtureValue });
  assert.equal(result.status, 207);
  assert.match(seen[0].headers.Authorization, /^Basic /);
  assert.match(seen[1].headers.Authorization, /^Digest username="u"/);

  const redirect = fakeServer([{ status: 301, headers: { location: 'https://evil.example.net/cal/' } }], []);
  await assert.rejects(davRequest('https://dav.example.com/cal/', { username: 'u', password: 'p' }, { request: redirect, resolveTarget: resolveTarget as FixtureValue }), /different server origin/);
});

test('calendar errors never forward a raw 401 to the browser', () => {
  assert.deepEqual(calendarErrorResponse({ status: 401 }, 'x'), { error: 'The calendar server rejected the login. Update the password of this account.', status: 422, code: 'CALDAV_AUTH_FAILED' });
  assert.equal(calendarErrorResponse({ status: 403 }, 'x').status, 422);
  assert.equal(calendarErrorResponse({ status: 500 }, 'x').code, 'CALDAV_SERVER_ERROR');
  assert.deepEqual(calendarErrorResponse({ status: 409, code: 'CALDAV_CONFLICT', message: 'Changed' }, 'x'), { error: 'Changed', status: 409, code: 'CALDAV_CONFLICT' });
});
