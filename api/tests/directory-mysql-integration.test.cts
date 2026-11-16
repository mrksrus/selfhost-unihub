import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// The company directory through the real request handler with the shared
// people: every active person with their groups, each edits only their own
// entry, an administrator corrects anyone's with an activity-log entry, and a
// deactivated person leaves at once. It is also the read-only book Company.
test('the company directory: everyone active, own entry, audited correction, deactivation, Company as a book', { skip: !process.env.MYSQL_TEST_HOST, timeout: 120000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, clients, password } = await seedPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey } = clients;
  type Client = typeof admin;
  const call = async (client: Client, method: string, url: string, body?: unknown, status = 200): Promise<FixtureValue> => {
    const reply = await client.request(method, url, body);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    return reply.body;
  };
  const entries = async (client: Client) => (await call(client, 'GET', '/api/directory')).entries as FixtureValue[];
  const byId = (list: FixtureValue[], id: string) => list.find(entry => entry.user_id === id);

  // Every active person, by name, with their groups; the bootstrap administrator too.
  const first = await entries(casey);
  assert.ok(['Ada Admin', 'Alex Manager', 'Blair Member', 'Casey Stranger', 'Drew Revoked'].every(name => first.some(entry => entry.full_name === name)));
  assert.deepEqual(byId(first, ids.manager).groups.map((group: FixtureValue) => group.name), ['Finance', 'Support']);
  assert.deepEqual(byId(first, ids.revoked).groups, []);
  assert.deepEqual([byId(first, ids.member).email, byId(first, ids.member).phone], ['blair@example.test', null]);

  // Blair fills in her own entry; the version follows what is shown.
  const before = byId(first, ids.member).version;
  const mine = (await call(blair, 'PUT', '/api/directory/me', { phone: ' +1 555 0100 ', job_title: 'Support lead', department: 'Support' })).entry;
  assert.deepEqual([mine.phone, mine.job_title, mine.department], ['+1 555 0100', 'Support lead', 'Support']);
  assert.notEqual(mine.version, before);
  assert.equal((await call(blair, 'PUT', '/api/directory/me', { job_title: '' })).entry.phone, '+1 555 0100', 'a field not sent stays');
  assert.equal(byId(await entries(alex), ids.member).job_title, null, 'empty clears');
  assert.equal((await call(blair, 'PUT', '/api/directory/me', { phone: 'x'.repeat(65) }, 400)).code, 'DIRECTORY_INVALID');
  assert.equal((await call(blair, 'PUT', '/api/directory/me', { department: 7 }, 400)).code, 'DIRECTORY_INVALID');

  // Only an administrator corrects someone else's entry, and the activity log names it.
  await call(blair, 'PUT', `/api/admin/users/${ids.manager}/directory`, { job_title: 'Boss' }, 403);
  assert.equal((await call(admin, 'PUT', `/api/admin/users/${ids.manager}/directory`, { job_title: 'Team manager' })).entry.job_title, 'Team manager');
  const [audit] = await pool.execute<RowDataPacket[]>("SELECT actor_id, target_user_id FROM audit_log WHERE action = 'admin.directory_changed'");
  assert.deepEqual(audit.map(row => [row.actor_id, row.target_user_id]), [[ids.admin, ids.manager]]);
  await call(admin, 'PUT', '/api/admin/users/00000000-0000-4000-8000-000000000000/directory', { job_title: 'x' }, 404);

  // Company is the read-only book in front of the person's books, in contact shape.
  const books = (await call(alex, 'GET', '/api/address-books')).books as FixtureValue[];
  assert.deepEqual([books[0].id, books[0].name, books[0].permission, books[0].contact_count], ['company', 'Company', 'read', first.length]);
  const contacts = (await call(alex, 'GET', '/api/address-books/company/contacts?q=blair')).contacts as FixtureValue[];
  assert.deepEqual(contacts.map(contact => [contact.id, contact.display_name, contact.emails[0].value, contact.phones[0].value, contact.organization.department]),
    [[ids.member, 'Blair Member', 'blair@example.test', '+1 555 0100', 'Support']]);
  assert.equal((await call(alex, 'GET', `/api/address-books/company/contacts/${ids.manager}`)).contact.job_title, 'Team manager');
  assert.equal((await call(alex, 'POST', '/api/address-books/company/contacts', { name: { given: 'X' } }, 403)).code, 'BOOK_FORBIDDEN');
  assert.equal((await call(admin, 'PUT', '/api/address-books/company', { name: 'Mine' }, 403)).code, 'BOOK_FORBIDDEN');

  // A deactivated person leaves the directory at once; the entry comes back with them.
  await call(admin, 'PUT', `/api/admin/users/${ids.stranger}/activate`, { is_active: false, current_password: password });
  assert.equal(byId(await entries(blair), ids.stranger), undefined);
  assert.equal((await call(blair, 'GET', '/api/address-books/company')).book.contact_count, first.length - 1);
  await call(admin, 'PUT', `/api/admin/users/${ids.stranger}/activate`, { is_active: true });
  assert.ok(byId(await entries(blair), ids.stranger));
});
