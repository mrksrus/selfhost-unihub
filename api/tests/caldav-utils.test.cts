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
} = require('../dist/src/services/caldav');
const {
  parseDigestChallenge,
  digestAuthorization,
  resolveCalDavUrl,
  davRequest,
} = require('../dist/src/security/caldav-transport');
const { calendarErrorResponse } = require('../dist/src/services/calendar-sync');

test('known providers are matched by IMAP host before mail domain', () => {
  assert.equal(matchCalendarProvider({ emailAddress: 'user@icloud.com' }).id, 'icloud');
  assert.equal(matchCalendarProvider({ emailAddress: 'user@example.com', imapHost: 'imap.fastmail.com' }).id, 'fastmail');
  assert.equal(matchCalendarProvider({ emailAddress: 'user@gmail.com' }).unsupported, true);
  assert.equal(matchCalendarProvider({ emailAddress: 'user@example.com', imapHost: 'mail.example.com' }), null);
});

test('well-known candidates cover the mail domain and the IMAP host', () => {
  assert.deepEqual(wellKnownCandidates({ emailAddress: 'user@example.com', imapHost: 'mail.example.net' }), [
    'https://example.com/.well-known/caldav',
    'https://example.net/.well-known/caldav',
    'https://mail.example.net/.well-known/caldav',
  ]);
  assert.deepEqual(wellKnownCandidates({ emailAddress: 'user@example.com', imapHost: 'imap.example.com' }), [
    'https://example.com/.well-known/caldav',
    'https://imap.example.com/.well-known/caldav',
  ]);
});

test('SRV records become ordered HTTPS candidates with the TXT path', async () => {
  const urls = await lookupSrvCandidates('example.com', {
    resolveSrv: async (name: FixtureValue) => {
      assert.equal(name, '_caldavs._tcp.example.com');
      return [
        { name: 'backup.example.com', port: 8443, priority: 20, weight: 0 },
        { name: 'dav.example.com.', port: 443, priority: 10, weight: 5 },
        { name: '.', port: 0, priority: 0, weight: 0 },
      ];
    },
    resolveTxt: async () => [['path=/dav/', 'cal/']],
  });
  assert.deepEqual(urls, ['https://dav.example.com/dav/cal/', 'https://backup.example.com:8443/dav/cal/']);
  assert.deepEqual(await lookupSrvCandidates('example.com', { resolveSrv: async () => { throw new Error('NXDOMAIN'); } }), []);
});

test('discovery explains unsupported providers and missing passwords without network access', async () => {
  await assert.rejects(findCalDavServer({ emailAddress: 'user@gmail.com', password: 'x' }), { code: 'CALDAV_PROVIDER_UNSUPPORTED', status: 422 });
  await assert.rejects(findCalDavServer({ emailAddress: 'user@example.com' }), { code: 'CALDAV_NO_PASSWORD' });
});

test('credential scope uses known presets only and otherwise the discovery origin', () => {
  const icloud = matchCalendarProvider({ emailAddress: 'user@icloud.com' }).scope;
  assert.deepEqual(accountCredentialScope({ provider_config: { credentialScope: icloud }, discovery_url: 'https://caldav.icloud.com/' }), icloud);
  assert.equal(resolveCalDavUrl('https://p42-caldav.icloud.com/123/calendars/', undefined, icloud), 'https://p42-caldav.icloud.com/123/calendars/');
  // A widened scope that is not a preset (a tampered backup) falls back to the origin.
  const widened = JSON.stringify({ credentialScope: { origin: 'https://dav.example.com', hostSuffixes: ['.com'] } });
  assert.equal(accountCredentialScope({ provider_config: widened, discovery_url: 'https://dav.example.com/dav/', base_url: 'https://other.example.com/' }), 'https://dav.example.com');
  assert.throws(() => resolveCalDavUrl('https://other.example.com/cal/', undefined, 'https://dav.example.com'), /different server origin/);
});

test('hrefs are compared decoded and subscription addresses are normalized', () => {
  assert.equal(canonicalHref('/cal/my%20event.ics', 'https://dav.example.com/'), '/cal/my event.ics');
  assert.equal(canonicalHref('https://dav.example.com/cal/a.ics?x=1'), '/cal/a.ics');
  assert.equal(normalizeIcsFeedUrl('webcal://calendar.example.com/feed.ics'), 'https://calendar.example.com/feed.ics');
  assert.throws(() => normalizeIcsFeedUrl('http://calendar.example.com/feed.ics'), /HTTPS/);
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
  const result = await davRequest('https://dav.example.com/cal/', { username: 'u', password: 'p' }, { request, resolveTarget });
  assert.equal(result.status, 207);
  assert.match(seen[0].headers.Authorization, /^Basic /);
  assert.match(seen[1].headers.Authorization, /^Digest username="u"/);

  const redirect = fakeServer([{ status: 301, headers: { location: 'https://evil.example.net/cal/' } }], []);
  await assert.rejects(davRequest('https://dav.example.com/cal/', { username: 'u', password: 'p' }, { request: redirect, resolveTarget }), /different server origin/);
});

test('calendar errors never forward a raw 401 to the browser', () => {
  assert.deepEqual(calendarErrorResponse({ status: 401 }, 'x'), { error: 'The calendar server rejected the login. Update the password of this account.', status: 422, code: 'CALDAV_AUTH_FAILED' });
  assert.equal(calendarErrorResponse({ status: 403 }, 'x').status, 422);
  assert.equal(calendarErrorResponse({ status: 500 }, 'x').code, 'CALDAV_SERVER_ERROR');
  assert.deepEqual(calendarErrorResponse({ status: 409, code: 'CALDAV_CONFLICT', message: 'Changed' }, 'x'), { error: 'Changed', status: 409, code: 'CALDAV_CONFLICT' });
});
