// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

const skip = !process.env.MYSQL_TEST_HOST;

// Phone contacts forbidden (0.30): the Android app's contacts sync, which
// marks every request with X-Background-Sync: 1, is told the module is off
// (403 MODULE_DISABLED with the policy), so every app in the support window
// removes UniHub's contacts from the phone. The page's same routes keep working.
test('phone contacts forbidden: the app\'s sync gets MODULE_DISABLED with the policy, the page keeps its contacts', { skip, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { groups, clients, password } = await seedPeople(t, pool);
  const { admin, member: blair, stranger: casey } = clients;
  type Client = typeof admin;
  const sync = { 'X-Background-Sync': '1' };
  const reason = 'Your administrator does not allow UniHub contacts in the phone\'s contacts.';
  const refusal = { error: reason, code: 'MODULE_DISABLED', module: 'contacts', details: { policy: 'contacts.phone_sync', reason } };
  async function call(client: Client, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    return client.request(method, url, method === 'GET' ? undefined : body ?? {}, headers);
  }
  const contact = (await call(blair, 'POST', '/api/contacts', { name: { given: 'Synthetic' } })).body.contact as { id: string };
  assert.ok(contact?.id);

  // For a group: its members' phones only.
  assert.equal((await call(admin, 'PUT', `/api/admin/groups/${groups.support}/policies`, { values: { 'contacts.phone_sync': 'forbidden' }, current_password: password })).status, 200);
  const listing = await call(blair, 'GET', '/api/contacts?limit=1', undefined, sync);
  assert.deepEqual([listing.status, listing.body], [403, refusal]);
  for (const [method, url, body] of [['POST', '/api/contacts', { name: { given: 'From the phone' } }], ['PUT', `/api/contacts/${contact.id}`, { name: { given: 'Edited on the phone' } }],
    ['DELETE', `/api/contacts/${contact.id}`, undefined], ['GET', `/api/contacts/${contact.id}/photo`, undefined]] as const) {
    assert.deepEqual([(await call(blair, method, url, body, sync)).status], [403], `${method} ${url}`);
  }
  assert.equal((await call(casey, 'GET', '/api/contacts?limit=1', undefined, sync)).status, 200, 'not a member');
  // The page (no header) keeps the same routes, and nothing the phone sent was written.
  const page = await call(blair, 'GET', '/api/contacts');
  assert.equal(page.status, 200);
  assert.ok(JSON.stringify(page.body).includes(contact.id));
  assert.ok(!JSON.stringify(page.body).includes('From the phone') && !JSON.stringify(page.body).includes('Edited on the phone'));

  // For everyone, and allowed again.
  assert.equal((await call(admin, 'PUT', '/api/admin/policies', { values: { 'contacts.phone_sync': 'forbidden' }, current_password: password })).status, 200);
  assert.deepEqual((await call(casey, 'GET', '/api/contacts?limit=1', undefined, sync)).body, refusal);
  assert.equal((await call(admin, 'PUT', '/api/admin/policies', { values: { 'contacts.phone_sync': 'allowed' }, current_password: password })).status, 200);
  assert.equal((await call(casey, 'GET', '/api/contacts?limit=1', undefined, sync)).status, 200);
  assert.equal((await call(blair, 'GET', '/api/contacts?limit=1', undefined, sync)).status, 403, 'Support still forbids it');
  assert.equal((await call(admin, 'PUT', `/api/admin/groups/${groups.support}/policies`, { clear: ['contacts.phone_sync'], current_password: password })).status, 200);
  assert.equal((await call(blair, 'GET', '/api/contacts?limit=1', undefined, sync)).status, 200, 'the phone gets its contacts back');
});
