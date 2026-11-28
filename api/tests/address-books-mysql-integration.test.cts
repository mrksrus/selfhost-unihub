import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const sharp = require('sharp') as typeof import('sharp');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// Shared address books through the real request handler with the shared
// people: Blair (member of Support) creates a book and manages it; Alex
// (manager of Support, member of Finance) edits it through Support; Casey
// (in no group) reads it after the owner shares it with them; Drew (removed
// from Support) and everyone without a grant see nothing; an administrator
// manages every book without a grant but lists only the books shared with them.
test('shared address books: access, reach, isolation from personal contacts, copy and import, and what stays when people leave', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'unihub-books-'));
  const saved = { photos: process.env.CONTACT_PHOTOS_ROOT, imports: process.env.CONTACT_IMPORTS_ROOT, spool: process.env.UPLOAD_SPOOL_ROOT };
  process.env.CONTACT_PHOTOS_ROOT = path.join(scratch, 'photos');
  process.env.CONTACT_IMPORTS_ROOT = path.join(scratch, 'imports');
  process.env.UPLOAD_SPOOL_ROOT = path.join(scratch, 'spool');
  t.after(() => {
    for (const [name, value] of [['CONTACT_PHOTOS_ROOT', saved.photos], ['CONTACT_IMPORTS_ROOT', saved.imports], ['UPLOAD_SPOOL_ROOT', saved.spool]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const pool = await withTestDatabase(t);
  const { ids, groups, clients, password } = await seedPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey, revoked: drew } = clients;
  type Client = typeof admin;
  const call = async (client: Client, method: string, url: string, body?: unknown, status = 200, headers: Record<string, string> = {}): Promise<FixtureValue> => {
    const reply = await client.request(method, url, body, headers);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    return reply.body;
  };
  const refused = async (client: Client, method: string, url: string, body?: unknown) => {
    const reply = await client.request(method, url, body);
    return [reply.status, reply.body.code ?? null];
  };
  // The books besides Company, which everyone sees first.
  const sharedBooks = async (client: Client) => ((await call(client, 'GET', '/api/address-books')).books as FixtureValue[]).filter(item => item.id !== 'company');
  const user = (id: string) => ({ kind: 'user', id });
  const group = (id: string) => ({ kind: 'group', id });

  // ── Blair creates a book and manages it; nobody else sees it yet ──
  const created = (await call(blair, 'POST', '/api/address-books', { name: 'Suppliers', description: 'Who delivers what' })).book;
  assert.deepEqual([created.name, created.permission, created.contact_count], ['Suppliers', 'manage', 0]);
  const book = `/api/address-books/${created.id}`;
  assert.deepEqual(await refused(blair, 'POST', '/api/address-books', { name: ' ' }), [400, 'BOOK_NAME_INVALID']);
  for (const client of [alex, casey, drew]) assert.deepEqual((await sharedBooks(client)), []);
  // An administrator manages it without a grant, and does not list it.
  assert.equal((await call(admin, 'GET', book)).book.permission, 'manage');
  assert.deepEqual((await sharedBooks(admin)), []);

  // ── Reach: a member shares with their own groups and the people in them, never everyone ──
  assert.deepEqual(await refused(blair, 'PUT', `${book}/shares`, { principal: { kind: 'everyone' }, permission: 'read' }), [403, 'SHARE_OUT_OF_REACH']);
  assert.deepEqual(await refused(blair, 'PUT', `${book}/shares`, { principal: group(groups.finance), permission: 'read' }), [403, 'SHARE_OUT_OF_REACH']);
  assert.deepEqual(await refused(blair, 'PUT', `${book}/shares`, { principal: user(ids.stranger), permission: 'read' }), [403, 'SHARE_OUT_OF_REACH']);
  assert.deepEqual(await refused(blair, 'PUT', `${book}/shares`, { principal: user(ids.manager), permission: 'manage' }), [400, 'SHARE_INVALID']);
  await call(blair, 'PUT', `${book}/shares`, { principal: group(groups.support), permission: 'edit' });
  await call(blair, 'PUT', `${book}/shares`, { principal: user(ids.manager), permission: 'read' });
  const candidates = await call(blair, 'GET', `${book}/share-candidates?q=`);
  assert.deepEqual([candidates.people.map((person: FixtureValue) => person.email).sort(), candidates.groups.map((item: FixtureValue) => item.name), candidates.everyone],
    [['alex@example.test', 'blair@example.test'], ['Support'], false]);
  // The administrator shares with anyone; Blair may then lower or remove that share, never raise it.
  await call(admin, 'PUT', `${book}/shares`, { principal: user(ids.stranger), permission: 'read' });
  assert.deepEqual(await refused(blair, 'PUT', `${book}/shares`, { principal: user(ids.stranger), permission: 'edit' }), [403, 'SHARE_OUT_OF_REACH']);
  assert.equal((await call(admin, 'GET', `${book}/share-candidates?q=cas`)).everyone, true);
  assert.deepEqual(await refused(admin, 'PUT', `${book}/shares`, { principal: user(ids.member), permission: 'read' }), [400, 'SHARE_IS_CREATOR']);
  const shares = (await call(blair, 'GET', `${book}/shares`)).shares as FixtureValue[];
  assert.deepEqual(shares.map(share => [share.principal.kind, share.name, share.permission]).sort(),
    [['group', 'Support', 'edit'], ['user', 'Alex Manager', 'read'], ['user', 'Blair Member', 'manage'], ['user', 'Casey Stranger', 'read']]);

  // Each sees the book at the most any grant gives them.
  assert.deepEqual((await sharedBooks(alex)).map((item: FixtureValue) => [item.name, item.permission]), [['Suppliers', 'edit']]);
  assert.deepEqual((await sharedBooks(casey)).map((item: FixtureValue) => [item.name, item.permission]), [['Suppliers', 'read']]);
  assert.deepEqual((await sharedBooks(drew)), []);

  // ── The book's contacts: editors write, readers read, the others see nothing ──
  const contact = (await call(alex, 'POST', `${book}/contacts`, { name: { given: 'Sam', family: 'Supplier' }, emails: ['sam@supplier.example'], is_favorite: true })).contact;
  assert.equal(contact.is_favorite, false, 'a book contact has no favourite');
  const photo = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#2050c0' } }).jpeg().toBuffer();
  await call(alex, 'PUT', `${book}/contacts/${contact.id}/photo`, photo, 200, { 'content-type': 'image/jpeg' });
  assert.ok(fs.readdirSync(path.join(process.env.CONTACT_PHOTOS_ROOT!, 'books', created.id)).length >= 2, 'the book keeps its photos under books/<id>');
  const read = await call(casey, 'GET', `${book}/contacts`);
  assert.deepEqual(read.contacts.map((item: FixtureValue) => item.display_name), ['Sam Supplier']);
  assert.deepEqual((await call(casey, 'GET', `${book}/contacts`, undefined, 200, { 'x-background-sync': '1' })).contacts.length, 1);
  const routes: [string, string, unknown?][] = [
    ['GET', book], ['PUT', book, { name: 'Renamed' }], ['DELETE', book], ['GET', `${book}/shares`],
    ['PUT', `${book}/shares`, { principal: user(ids.revoked), permission: 'read' }], ['GET', `${book}/share-candidates?q=a`],
    ['GET', `${book}/contacts`], ['POST', `${book}/contacts`, { name: { given: 'X' } }], ['GET', `${book}/contacts/${contact.id}`],
    ['PUT', `${book}/contacts/${contact.id}`, { name: { given: 'X' }, version: 9 }], ['DELETE', `${book}/contacts/${contact.id}`],
    ['POST', `${book}/contacts/bulk-delete`, { ids: [contact.id] }], ['GET', `${book}/contacts/${contact.id}/photo`],
    ['PUT', `${book}/contacts/${contact.id}/photo`, photo], ['DELETE', `${book}/contacts/${contact.id}/photo`],
    ['POST', `${book}/copy`, { ids: [contact.id] }], ['POST', `${book}/imports`, Buffer.from('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:X\r\nEND:VCARD\r\n')],
  ];
  for (const [method, url, body] of routes) {
    assert.deepEqual(await refused(drew, method, url, body), [404, 'BOOK_NOT_FOUND'], `Drew ${method} ${url}`);
  }
  const reads = new Set(['GET']);
  for (const [method, url, body] of routes) {
    if (reads.has(method) && !/shares|share-candidates/.test(url)) continue;
    assert.deepEqual(await refused(casey, method, url, body), [403, 'BOOK_FORBIDDEN'], `Casey (reader) ${method} ${url}`);
  }
  for (const [method, url, body] of [['PUT', book, { name: 'Renamed' }], ['DELETE', book], ['GET', `${book}/shares`],
    ['PUT', `${book}/shares`, { principal: group(groups.support), permission: 'read' }]] as const) {
    assert.deepEqual(await refused(alex, method, url, body), [403, 'BOOK_FORBIDDEN'], `Alex (editor) ${method} ${url}`);
  }
  // Another group's book is hidden from Blair (in Support only).
  const ledger = (await call(alex, 'POST', '/api/address-books', { name: 'Ledger' })).book;
  await call(alex, 'PUT', `/api/address-books/${ledger.id}/shares`, { principal: group(groups.finance), permission: 'edit' });
  assert.deepEqual(await refused(blair, 'GET', `/api/address-books/${ledger.id}/contacts`), [404, 'BOOK_NOT_FOUND']);
  assert.deepEqual(await refused(blair, 'GET', '/api/address-books/not-a-book'), [404, 'BOOK_NOT_FOUND']);

  // ── Isolation: a book contact is never a personal one, and a personal one never a book's ──
  const own = (await call(alex, 'POST', '/api/contacts', { name: { given: 'Sam', family: 'Supplier' }, emails: ['sam@supplier.example'] })).contact;
  for (const headers of [{}, { 'x-background-sync': '1' }] as Record<string, string>[]) {
    const listed = await call(alex, 'GET', '/api/contacts', undefined, 200, headers);
    assert.deepEqual(listed.contacts.map((item: FixtureValue) => item.id), [own.id], 'GET /api/contacts lists only personal contacts');
  }
  assert.deepEqual(await refused(alex, 'GET', `/api/contacts/${contact.id}`), [404, 'CONTACT_NOT_FOUND']);
  assert.deepEqual(await refused(alex, 'PUT', `/api/contacts/${contact.id}`, { name: { given: 'Taken' }, version: contact.version }), [404, 'CONTACT_NOT_FOUND']);
  assert.deepEqual(await refused(alex, 'GET', `/api/contacts/${contact.id}/photo`), [404, 'PHOTO_NOT_FOUND']);
  await call(alex, 'POST', '/api/contacts/bulk-delete', { ids: [contact.id] });
  await call(alex, 'DELETE', `/api/contacts/${contact.id}`);
  assert.deepEqual(await refused(alex, 'GET', `${book}/contacts/${own.id}`), [404, 'CONTACT_NOT_FOUND']);
  assert.deepEqual(await refused(alex, 'PUT', `${book}/contacts/${own.id}`, { name: { given: 'Taken' }, version: own.version }), [404, 'CONTACT_NOT_FOUND']);
  assert.equal((await call(alex, 'GET', `${book}/contacts/${contact.id}`)).contact.name.given, 'Sam', 'the personal routes changed nothing in the book');
  const { buildExport } = require('../dist/src/services/contacts-export') as typeof import('../src/services/contacts-export');
  const file = await buildExport(ids.manager, 'vcard4', null);
  let exported = file.body ? file.body.toString('utf8') : '';
  if (file.slices) for await (const slice of file.slices) exported += slice.toString('utf8');
  assert.equal((exported.match(/BEGIN:VCARD/g) || []).length, 1, 'the personal export holds the personal contact only');
  assert.ok(!JSON.stringify((await call(alex, 'GET', '/api/contacts/duplicates')).groups).includes(contact.id), 'no duplicate across a book');

  // An update goes through the version check; a stale one answers the contact as it is.
  const stale = await alex.request('PUT', `${book}/contacts/${contact.id}`, { name: { given: 'Old' }, version: 1 });
  assert.deepEqual([stale.status, stale.body.code, (stale.body.contact as FixtureValue).id], [409, 'VERSION_CONFLICT', contact.id]);
  const current = (await call(alex, 'GET', `${book}/contacts/${contact.id}`)).contact;
  assert.equal((await call(alex, 'PUT', `${book}/contacts/${current.id}`, { name: { given: 'Samuel', family: 'Supplier' }, emails: ['sam@supplier.example'], version: current.version })).contact.name.given, 'Samuel');

  // Deleting goes into the book's bin, never the person's.
  const spare = (await call(alex, 'POST', `${book}/contacts`, { name: { given: 'Spare' } })).contact;
  await call(blair, 'DELETE', `${book}/contacts/${spare.id}`);
  assert.deepEqual(await refused(blair, 'DELETE', `${book}/contacts/${spare.id}`), [404, 'CONTACT_NOT_FOUND']);
  const [[binned]] = await pool.query<RowDataPacket[]>('SELECT user_id, address_book_id FROM bin_items WHERE item_id = ?', [spare.id]);
  assert.deepEqual([binned.user_id, binned.address_book_id], [null, created.id]);
  for (const client of [alex, blair]) assert.deepEqual((await call(client, 'GET', '/api/bin')).items, [], 'the personal bin holds no book item');

  // ── A removal while a write waits for the book is seen inside the write's transaction ──
  const holder = await pool.getConnection();
  try {
    await holder.beginTransaction();
    await holder.execute('SELECT id FROM address_books WHERE id = ? FOR UPDATE', [created.id]);
    await holder.execute("DELETE FROM grants WHERE resource_id = ? AND principal_kind = 'group'", [created.id]);
    const pending = alex.request('POST', `${book}/contacts`, { name: { given: 'Late' } });
    for (let waited = 0; ; waited += 50) {
      const [[row]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE '%address_books%LOCK IN SHARE MODE%' AND ID NOT IN (?, CONNECTION_ID())", [holder.threadId]);
      if (Number(row.n) > 0) break;
      assert.ok(waited < 20000, 'the write reaches the book lock');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await holder.commit();
    assert.deepEqual((await pending).status, 403, 'only the direct read share is left: refused, nothing written');
  } finally { holder.release(); }
  assert.equal((await pool.query<RowDataPacket[]>("SELECT 1 FROM contacts WHERE first_name = 'Late'"))[0].length, 0);
  await call(blair, 'PUT', `${book}/shares`, { principal: group(groups.support), permission: 'edit' });

  // ── Drew joins Support and reads the book; removed from it again, the book is gone for them ──
  await call(alex, 'POST', `/api/groups/${groups.support}/members`, { user_ids: [ids.revoked] });
  assert.equal((await call(drew, 'GET', book)).book.permission, 'edit');
  await call(alex, 'DELETE', `/api/groups/${groups.support}/members/${ids.revoked}`);
  assert.deepEqual(await refused(drew, 'GET', `${book}/contacts`), [404, 'BOOK_NOT_FOUND']);

  // ── Copy personal contacts into the book: new ids and UIDs, the photo too, the originals unchanged ──
  await call(alex, 'PUT', `/api/contacts/${own.id}/photo`, photo, 200, { 'content-type': 'image/jpeg' });
  const before = (await call(alex, 'GET', `/api/contacts/${own.id}`)).contact;
  assert.deepEqual(await refused(alex, 'POST', `${book}/copy`, { ids: [own.id, contact.id] }), [404, 'CONTACT_NOT_FOUND'], 'only the person\'s own contacts are copied');
  const copied = await call(alex, 'POST', `${book}/copy`, { ids: [own.id] });
  assert.equal(copied.copied, 1);
  const copy = (await call(alex, 'GET', `${book}/contacts/${copied.contact_ids[0]}`)).contact;
  assert.notEqual(copy.id, own.id);
  assert.notEqual(copy.uid, before.uid);
  assert.deepEqual([copy.display_name, copy.emails.map((item: FixtureValue) => item.value), copy.photo?.etag], [before.display_name, ['sam@supplier.example'], before.photo.etag]);
  assert.equal((await alex.request('GET', `${book}/contacts/${copy.id}/photo`)).status, 200);
  assert.deepEqual(await call(alex, 'GET', `/api/contacts/${own.id}`), { contact: before }, 'the original is as it was');
  assert.deepEqual(await refused(casey, 'POST', `${book}/copy`, { ids: [own.id] }), [403, 'BOOK_FORBIDDEN']);

  // ── Import a file into the book: reviewed and committed as the person's import, never merged ──
  const vcard = Buffer.from([
    'BEGIN:VCARD', 'VERSION:4.0', 'UID:urn:uuid:7a1c0d3e-0000-4000-8000-00000000b001', 'FN:Pat Parcel', 'EMAIL:pat@parcel.example', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:4.0', 'FN:Samuel Supplier', 'N:Supplier;Samuel;;;', 'EMAIL:sam@supplier.example', 'END:VCARD', '',
  ].join('\r\n'));
  const personalBefore = (await call(alex, 'GET', '/api/contacts')).contacts;
  const staged = await call(alex, 'POST', `${book}/imports`, vcard, 200, { 'content-type': 'text/vcard' });
  assert.ok(!staged.groups.some((item: FixtureValue) => item.default_decision === 'merge'), 'a book import offers no merge');
  assert.ok(staged.groups.some((item: FixtureValue) => item.existing_ids.includes(contact.id)), 'matched against the book\'s contacts');
  assert.equal((await call(alex, 'POST', `/api/contacts/imports/${staged.id}/commit`, { decisions: [{ group_id: staged.groups[0].id, decision: 'merge' }] }, 400)).code, 'INVALID_IMPORT_DECISIONS');
  await call(alex, 'POST', `/api/contacts/imports/${staged.id}/commit`, { decisions: staged.groups.map((item: FixtureValue) => ({ group_id: item.id, decision: 'add' })) });
  for (let waited = 0; (await call(alex, 'GET', `/api/contacts/imports/${staged.id}`)).state !== 'committed'; waited += 50) {
    assert.ok(waited < 20000, 'the import commits');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const names = (await call(alex, 'GET', `${book}/contacts`)).contacts.map((item: FixtureValue) => item.display_name).sort();
  assert.deepEqual(names, ['Pat Parcel', 'Sam Supplier', 'Samuel Supplier', 'Samuel Supplier']);
  assert.deepEqual((await call(alex, 'GET', '/api/contacts')).contacts, personalBefore, 'the personal contacts are unchanged');
  assert.deepEqual(await refused(casey, 'POST', `${book}/imports`, vcard), [403, 'BOOK_FORBIDDEN']);
  assert.deepEqual(await refused(drew, 'GET', `/api/contacts/imports/${staged.id}`), [404, 'IMPORT_NOT_FOUND']);

  // ── People leave: a deactivated creator's grant is dormant; a deleted creator's book stays for administrators ──
  const access = require('../dist/src/services/access') as typeof import('../src/services/access');
  await pool.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [ids.manager]);
  assert.equal(await access.accessLevel(ids.manager, { kind: 'address_book', id: ledger.id }), null);
  await pool.execute('UPDATE users SET is_active = TRUE WHERE id = ?', [ids.manager]);
  assert.equal(await access.accessLevel(ids.manager, { kind: 'address_book', id: ledger.id }), 'manage');
  assert.deepEqual((await call(admin, 'GET', `/api/admin/users/${ids.member}/accounts`)).managed_books, [{ id: created.id, name: 'Suppliers' }]);
  await call(admin, 'DELETE', `/api/admin/users/${ids.member}`, { current_password: password });
  const grantsOf = async (principal: string) => (await pool.query<RowDataPacket[]>('SELECT 1 FROM grants WHERE principal_id = ?', [principal]))[0].length;
  assert.equal(await grantsOf(ids.member), 0, 'the deleted person\'s grants went with them');
  const kept = (await call(admin, 'GET', book)).book;
  assert.deepEqual([kept.name, kept.permission, kept.contact_count], ['Suppliers', 'manage', 4]);
  // Deleting a group takes its grants in the same transaction.
  await call(admin, 'DELETE', `/api/admin/groups/${groups.finance}`, { current_password: password });
  assert.equal(await grantsOf(groups.finance), 0);
  assert.deepEqual(await refused(alex, 'GET', `/api/address-books/${ledger.id}`), [200, null], 'Alex still manages the book they created');

  // ── A manager deletes a book: hidden at once, its contacts kept for a restore ──
  await call(alex, 'DELETE', `/api/address-books/${ledger.id}`);
  assert.deepEqual(await refused(alex, 'GET', `/api/address-books/${ledger.id}`), [404, 'BOOK_NOT_FOUND']);
  assert.deepEqual(await refused(admin, 'GET', `/api/address-books/${ledger.id}`), [404, 'BOOK_NOT_FOUND']);
  assert.equal((await pool.query<RowDataPacket[]>('SELECT 1 FROM address_books WHERE id = ? AND deleted_at IS NOT NULL', [ledger.id]))[0].length, 1);
});
