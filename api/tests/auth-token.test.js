const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'auth-token-test-only-secret';
const jwt = require('jsonwebtoken');
const { generateToken } = require('../dist/src/auth');

test('separate sessions for one user remain unique within the same second and verify normally', t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const firstToken = generateToken('fixture-user');
  const secondToken = generateToken('fixture-user');
  assert.notEqual(firstToken, secondToken);
  const first = jwt.verify(firstToken, process.env.JWT_SECRET);
  const second = jwt.verify(secondToken, process.env.JWT_SECRET);
  assert.equal(first.iat, second.iat);
  assert.equal(first.userId, 'fixture-user');
  assert.equal(second.sub, 'fixture-user');
  assert.notEqual(first.jti, second.jti);
  assert.equal(first.exp - first.iat, 21 * 24 * 60 * 60);
});

function sessionDb(expiresAt) {
  const calls = [];
  const row = { user_id: 'fixture-user', expires_at: expiresAt, is_active: 1 };
  return { calls, row, async execute(sql, values) {
    calls.push({ sql, values });
    if (sql.startsWith('UPDATE sessions')) { row.expires_at = values[0]; return [{ affectedRows: 1 }]; }
    return [[row]];
  } };
}
function cookieRequest(token, csrf = 'a'.repeat(64)) {
  return { headers: { cookie: `auth-token=${token}; csrf-token=${csrf}` } };
}

test('sessions slide at most once a day and keep working after the JWT lifetime', async t => {
  const { setDb } = require('../dist/src/state');
  const { verifyToken, refreshSessionCookies, sessionNeedsRenewal, getSessionExpiry } = require('../dist/src/auth');
  t.after(() => setDb(null));
  const now = new Date('2026-10-03T12:00:00Z');
  assert.equal(sessionNeedsRenewal(getSessionExpiry(now), now), false);
  assert.equal(sessionNeedsRenewal(new Date(getSessionExpiry(now).getTime() - 23 * 3600000), now), false);
  assert.equal(sessionNeedsRenewal(new Date(getSessionExpiry(now).getTime() - 25 * 3600000), now), true);

  // A token signed 30 days ago has an expired JWT, but its session row is live.
  const old = jwt.sign({ userId: 'fixture-user', sub: 'fixture-user', iat: Math.floor(Date.now() / 1000) - 30 * 86400 }, process.env.JWT_SECRET, { expiresIn: '21d' });
  const db = sessionDb(new Date(Date.now() + 3600000));
  setDb(db);
  const read = cookieRequest(old);
  assert.equal(await verifyToken(read), 'fixture-user');
  assert.equal(db.calls.some(call => call.sql.startsWith('UPDATE')), false, 'only the central handler renews');
  const req = cookieRequest(old);
  assert.equal(await verifyToken(req, { renew: true }), 'fixture-user');
  assert.equal(req.sessionRenewed, old);
  assert.ok(db.row.expires_at.getTime() > Date.now() + 20 * 86400000);

  const headers = new Map();
  const res = { getHeader: key => headers.get(key), setHeader: (key, value) => headers.set(key, value) };
  refreshSessionCookies(req, res);
  const cookies = headers.get('Set-Cookie');
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], new RegExp(`^auth-token=${old.replace(/[.]/g, '\\.')};`));
  assert.match(cookies[1], new RegExp(`^csrf-token=${'a'.repeat(64)};`));

  // Renewed today: no second write.
  const again = cookieRequest(old);
  db.calls.length = 0;
  assert.equal(await verifyToken(again, { renew: true }), 'fixture-user');
  assert.equal(again.sessionRenewed, undefined);
  assert.equal(db.calls.length, 1);
});

test('expired session rows and bad signatures are rejected without renewal', async t => {
  const { setDb } = require('../dist/src/state');
  const { verifyToken } = require('../dist/src/auth');
  t.after(() => setDb(null));
  const token = generateToken('fixture-user');
  const db = sessionDb(new Date(Date.now() - 1000));
  setDb(db);
  const req = cookieRequest(token);
  assert.equal(await verifyToken(req, { renew: true }), null);
  assert.equal(req.sessionRenewed, undefined);
  const forged = jwt.sign({ userId: 'fixture-user' }, 'some-other-secret');
  db.row.expires_at = new Date(Date.now() + 3600000);
  assert.equal(await verifyToken(cookieRequest(forged), { renew: true }), null);
});

test('only recording uploads accept the service worker header instead of a CSRF token', () => {
  const { validateCsrfToken } = require('../dist/src/auth');
  const request = (method, url, headers = {}) => ({ method, url, headers });
  const background = { 'x-background-sync': '1' };
  assert.equal(validateCsrfToken(request('POST', '/api/recordings/uploads/start', background)), true);
  assert.equal(validateCsrfToken(request('POST', '/api/recordings/uploads/abc/chunk', background)), true);
  assert.equal(validateCsrfToken(request('POST', '/api/recordings/uploads/abc/complete', background)), true);
  assert.equal(validateCsrfToken(request('DELETE', '/api/recordings/uploads/abc', background)), true);
  assert.equal(validateCsrfToken(request('POST', '/api/recordings/uploads/abc/chunk')), false);
  assert.equal(validateCsrfToken(request('DELETE', '/api/recordings/abc', background)), false);
  assert.equal(validateCsrfToken(request('PUT', '/api/recordings/uploads/abc', background)), false);
  assert.equal(validateCsrfToken(request('POST', '/api/contacts', background)), false);
});
