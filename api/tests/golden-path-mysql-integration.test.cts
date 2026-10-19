import type { FixtureValue } from './helpers/test-types.cts';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// One pass through the real stack (HTTP, request boundary, sessions, CSRF,
// routes, MariaDB) the way two people use a fresh server.
test('a fresh server: the admin signs in, opens sign-up, and two people each see only their own contacts', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'golden-admin@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-golden-admin-password';
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  await withTestDatabase(t);
  const api = await startTestApi(t);
  const admin = api.client(), person = api.client();

  assert.equal((await admin.request('GET', '/api/auth/me')).status, 401);
  const wrong = await admin.request('POST', '/api/auth/signin', { email: 'golden-admin@example.test', password: 'not-the-password' });
  assert.equal(wrong.status, 401);
  const signin = await admin.request('POST', '/api/auth/signin', { email: 'golden-admin@example.test', password: 'synthetic-golden-admin-password' });
  assert.equal(signin.status, 200, String(signin.body.error));
  assert.ok(admin.signedIn);
  assert.equal(((await admin.request('GET', '/api/auth/me')).body.user as FixtureValue).role, 'admin');

  // A new server is closed to sign-ups until the admin opens it.
  const closed = await person.request('POST', '/api/auth/signup', { email: 'person@example.test', password: 'synthetic-person-password' });
  assert.equal(closed.status, 403);
  assert.equal((await admin.request('PUT', '/api/admin/settings/signup-mode', { signup_mode: 'open' })).status, 200);
  const signup = await person.request('POST', '/api/auth/signup', { email: 'person@example.test', password: 'synthetic-person-password', full_name: 'Person' });
  assert.equal(signup.status, 200, String(signup.body.error));
  assert.equal((await person.request('GET', '/api/admin/users')).status, 403, 'a person is not an admin');

  // State-changing requests need the CSRF token that came with the session.
  const created = await person.request('POST', '/api/contacts', { first_name: 'Ada', email: 'ada@example.test' });
  assert.equal(created.status, 200, String(created.body.error));
  const theirs = await admin.request('POST', '/api/contacts', { first_name: 'Grace', email: 'grace@example.test' });
  assert.equal(theirs.status, 200, String(theirs.body.error));
  const names = async (client: typeof admin) => ((await client.request('GET', '/api/contacts')).body.contacts as FixtureValue[]).map(contact => contact.first_name);
  assert.deepEqual(await names(person), ['Ada']);
  assert.deepEqual(await names(admin), ['Grace']);

  // Every response names its request; signing out ends the session on the server.
  assert.match(String(created.headers['x-request-id']), /\S/);
  assert.equal((await person.request('POST', '/api/auth/signout')).status, 200);
  assert.equal((await person.request('GET', '/api/contacts')).status, 401);
  assert.deepEqual(await names(admin), ['Grace'], 'the other session is untouched');
});
