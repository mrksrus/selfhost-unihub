import type { FixtureValue } from './helpers/test-types.cts';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// Where shared books show beside a person's own contacts, through the real
// request handler: search, the offline snapshot and the phone's listing hold
// exactly Company and the books the person sees, the phone listing follows
// the person's choice and the phone rule, a person removed from the group
// loses the group's book in all three at once, and a personal contact names
// the books that hold the same address ("Also in").
test('shared books in search, the offline copy and the phone listing: exactly the visible ones, the phone choice and rule, revocation', { skip: !process.env.MYSQL_TEST_HOST, timeout: 180000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, groups, clients, password } = await seedPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey } = clients;
  type Client = typeof admin;
  const call = async (client: Client, method: string, url: string, body?: unknown, status = 200, headers: Record<string, string> = {}): Promise<FixtureValue> => {
    const reply = await client.request(method, url, body, headers);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    return reply.body;
  };
  const phone = { 'x-background-sync': '1' };

  // Alex keeps a book for Support (read) and one for Finance; Casey sees neither.
  const support = (await call(alex, 'POST', '/api/address-books', { name: 'Support suppliers' })).book;
  const finance = (await call(alex, 'POST', '/api/address-books', { name: 'Finance ledger' })).book;
  await call(alex, 'PUT', `/api/address-books/${support.id}/shares`, { principal: { kind: 'group', id: groups.support }, permission: 'read' });
  await call(alex, 'PUT', `/api/address-books/${finance.id}/shares`, { principal: { kind: 'group', id: groups.finance }, permission: 'edit' });
  await call(alex, 'POST', `/api/address-books/${support.id}/contacts`, { name: { given: 'Quinn', family: 'Vendor' }, emails: ['quinn@vendor.example'] });
  await call(alex, 'POST', `/api/address-books/${finance.id}/contacts`, { name: { given: 'Quinn', family: 'Auditor' }, emails: ['quinn@audit.example'] });

  const searched = async (client: Client, q: string) => ((await call(client, 'GET', `/api/search?q=${q}`)).results as FixtureValue[])
    .filter(result => result.book_id).map(result => [result.book_id, result.title]).sort();
  const snapshotBooks = async (client: Client) => ((await call(client, 'GET', '/api/offline/snapshot')).snapshot.books as FixtureValue[])
    .map(item => [item.name, (item.contacts as FixtureValue[]).length]);
  const phoneBooks = async (client: Client) => ((await call(client, 'GET', '/api/address-books/phone', undefined, 200, phone)).books as FixtureValue[]).map(item => item.name);

  // ── Exactly Company and the visible books ──
  assert.deepEqual(await searched(blair, 'quinn'), [[support.id, 'Quinn Vendor']]);
  assert.deepEqual(await searched(alex, 'quinn'), [[finance.id, 'Quinn Auditor'], [support.id, 'Quinn Vendor']].sort());
  assert.deepEqual(await searched(casey, 'quinn'), []);
  assert.deepEqual(await searched(casey, 'blair'), [['company', 'Blair Member']], 'Company is searched for everyone');
  const people = (await call(casey, 'GET', '/api/directory')).entries.length;
  assert.deepEqual(await snapshotBooks(blair), [['Company', people], ['Support suppliers', 1]]);
  assert.deepEqual(await snapshotBooks(casey), [['Company', people]]);
  assert.ok(((await call(blair, 'GET', '/api/offline/snapshot')).snapshot.directory as FixtureValue[]).some(entry => entry.user_id === ids.manager && entry.groups.length === 2));
  assert.deepEqual(await phoneBooks(blair), ['Company', 'Support suppliers']);
  assert.deepEqual(await phoneBooks(alex), ['Company', 'Finance ledger', 'Support suppliers']);

  // ── "Also in": the books that hold one of a personal contact's addresses ──
  const own = (await call(alex, 'POST', '/api/contacts', { name: { given: 'Q' }, emails: ['Quinn@Vendor.example', 'blair@example.test'] })).contact;
  assert.deepEqual((await call(alex, 'GET', `/api/contacts/${own.id}`)).contact.also_in, [{ book_id: 'company', name: 'Company' }, { book_id: support.id, name: 'Support suppliers' }]);
  const casual = (await call(casey, 'POST', '/api/contacts', { name: { given: 'Q' }, emails: ['quinn@vendor.example'] })).contact;
  assert.deepEqual((await call(casey, 'GET', `/api/contacts/${casual.id}`)).contact.also_in, [], 'a book Casey does not see is not named');

  // ── The phone choice: off for Company, an unknown id ignored ──
  await call(blair, 'PUT', '/api/settings/values', { values: { contacts_phone_books_off: ['company', '00000000-0000-4000-8000-000000000000'] } });
  assert.deepEqual(await phoneBooks(blair), ['Support suppliers']);
  assert.equal((await call(blair, 'PUT', '/api/settings/values', { values: { contacts_phone_books_off: ['not-a-book'] } }, 400)).code, 'SETTING_INVALID');
  assert.deepEqual((await call(blair, 'GET', '/api/address-books')).books.map((item: FixtureValue) => item.name), ['Company', 'Support suppliers'], 'the web still shows it');

  // ── The phone rule: the listing and the books' contacts answer MODULE_DISABLED to the phone only ──
  await call(admin, 'PUT', '/api/admin/policies', { values: { 'contacts.phone_sync': 'forbidden' }, current_password: password });
  for (const url of ['/api/address-books/phone', `/api/address-books/${support.id}/contacts`, '/api/address-books/company/contacts']) {
    assert.equal((await call(blair, 'GET', url, undefined, 403, phone)).code, 'MODULE_DISABLED', url);
  }
  assert.equal((await call(blair, 'GET', `/api/address-books/${support.id}/contacts`)).contacts.length, 1, 'the web keeps reading');
  await call(admin, 'PUT', '/api/admin/policies', { values: { 'contacts.phone_sync': 'allowed' }, current_password: password });

  // ── Removed from Support: the book is gone from the next search, copy and listing ──
  await call(alex, 'DELETE', `/api/groups/${groups.support}/members/${ids.member}`);
  assert.deepEqual(await searched(blair, 'quinn'), []);
  assert.deepEqual(await snapshotBooks(blair), [['Company', people]]);
  assert.deepEqual(await phoneBooks(blair), []);
  assert.equal((await call(blair, 'GET', `/api/address-books/${support.id}/contacts`, undefined, 404, phone)).code, 'BOOK_NOT_FOUND');
});
