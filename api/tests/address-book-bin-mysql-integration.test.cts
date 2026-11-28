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

// A shared book's own bin through the real request handler: Blair's book is
// shared with Support for editing and with Casey for reading. Alex (editor)
// deletes and restores; Casey sees no bin; Drew (removed from Support) gets
// 404. The book retention (30 days, or a bin minimum of Everyone or any
// group) holds for its items and for the book itself once deleted, and the
// purge and the photo sweep take what is due.
test('a shared book\'s bin: editors restore, readers and strangers do not, bin.delete and the minimum retention hold, a deleted book is purged', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'unihub-book-bin-'));
  const saved = { CONTACT_PHOTOS_ROOT: process.env.CONTACT_PHOTOS_ROOT, UPLOAD_SPOOL_ROOT: process.env.UPLOAD_SPOOL_ROOT };
  process.env.CONTACT_PHOTOS_ROOT = path.join(scratch, 'photos');
  process.env.UPLOAD_SPOOL_ROOT = path.join(scratch, 'spool');
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const pool = await withTestDatabase(t);
  const { purgeBin } = require('../dist/src/services/bin') as typeof import('../src/services/bin');
  const { sweepContactPhotos } = require('../dist/src/services/contact-photos') as typeof import('../src/services/contact-photos');
  const { ids, groups, clients } = await seedPeople(t, pool);
  const { admin, manager: alex, member: blair, stranger: casey, revoked: drew } = clients;
  type Client = typeof admin;
  const call = async (client: Client, method: string, url: string, body?: unknown, status = 200, headers: Record<string, string> = {}): Promise<FixtureValue> => {
    const reply = await client.request(method, url, body, headers);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    return reply.body;
  };
  const days = (n: number) => new Date(Date.now() + n * 86400000);
  const policy = (target: string, key: string, value: string) => pool.execute(
    "INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES (?, ?, ?, ?, 0)", [target ? 'group' : 'installation', target, `policy.${key}`, value]);
  const clearPolicies = () => pool.execute("DELETE FROM setting_policies WHERE setting_key LIKE 'policy.bin.%'");

  const book = (await call(blair, 'POST', '/api/address-books', { name: 'Suppliers' })).book;
  const base = `/api/address-books/${book.id}`;
  await call(blair, 'PUT', `${base}/shares`, { principal: { kind: 'group', id: groups.support }, permission: 'edit' });
  await call(admin, 'PUT', `${base}/shares`, { principal: { kind: 'user', id: ids.stranger }, permission: 'read' });
  const contact = (await call(alex, 'POST', `${base}/contacts`, { name: { given: 'Sam', family: 'Supplier' }, emails: ['sam@supplier.example'] })).contact;
  const photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#208040' } }).jpeg().toBuffer();
  await call(alex, 'PUT', `${base}/contacts/${contact.id}/photo`, photo, 200, { 'content-type': 'image/jpeg' });

  // ── Alex deletes into the book's bin, not anyone's own ──
  const [itemId] = (await call(alex, 'DELETE', `${base}/contacts/${contact.id}`)).bin_item_ids;
  const bin = await call(alex, 'GET', `/api/bin?book=${book.id}`);
  assert.deepEqual([bin.items.map((item: FixtureValue) => [item.id, item.title]), bin.retention], [[[itemId, 'Sam Supplier']], '30']);
  assert.ok(Math.abs(Date.parse(bin.items[0].purge_after) - days(30).getTime()) < 3600000, 'due in 30 days');
  assert.deepEqual((await call(blair, 'GET', `/api/bin?book=${book.id}`)).items.length, 1, 'the manager sees it too');
  for (const client of [alex, blair]) assert.deepEqual((await call(client, 'GET', '/api/bin')).items, [], 'never in a personal bin');
  assert.equal((await call(casey, 'GET', `/api/bin?book=${book.id}`, undefined, 403)).code, 'BOOK_FORBIDDEN');
  assert.equal((await call(drew, 'GET', `/api/bin?book=${book.id}`, undefined, 404)).code, 'BOOK_NOT_FOUND');
  // A reader and the revoked person reach none of its items.
  assert.deepEqual((await call(casey, 'POST', '/api/bin/restore', { ids: [itemId] })).failed.map((item: FixtureValue) => item.code), ['BIN_ITEM_NOT_FOUND']);
  assert.equal((await call(drew, 'POST', `/api/bin/${itemId}/restore`, {}, 404)).code, 'BIN_ITEM_NOT_FOUND');
  await call(casey, 'DELETE', `/api/bin/${itemId}`, undefined, 404);
  assert.equal((await call(casey, 'POST', '/api/bin/empty', { book: book.id }, 403)).code, 'BOOK_FORBIDDEN');

  // ── Alex restores it into the book, as it was, with its photo ──
  const restored = (await call(alex, 'POST', `/api/bin/${itemId}/restore`, {})).restored;
  assert.deepEqual(restored.map((item: FixtureValue) => item.item_id), [contact.id]);
  const back = (await call(casey, 'GET', `${base}/contacts/${contact.id}`)).contact;
  assert.deepEqual([back.display_name, back.emails[0].value, !!back.photo], ['Sam Supplier', 'sam@supplier.example', true]);
  assert.deepEqual((await call(alex, 'GET', '/api/contacts')).contacts, [], 'restored into the book only');

  // ── bin.delete forbidden: no delete for good, and the purge keeps it for good ──
  const [second] = (await call(alex, 'DELETE', `${base}/contacts/${contact.id}`)).bin_item_ids;
  await policy('', 'bin.delete', 'forbidden');
  assert.equal((await call(alex, 'DELETE', `/api/bin/${second}`, undefined, 403)).code, 'POLICY_FORBIDS');
  assert.equal((await call(alex, 'POST', '/api/bin/empty', { book: book.id }, 403)).code, 'POLICY_FORBIDS');
  await purgeBin({ now: days(400) });
  assert.equal((await call(alex, 'GET', `/api/bin?book=${book.id}`)).retention, 'forever');
  assert.equal((await call(alex, 'GET', `/api/bin?book=${book.id}`)).items.length, 1, 'a minimum of forever keeps it');
  // Forbidden only for a group the book is not shared with, under a minimum of 90 days: that minimum holds.
  await clearPolicies();
  await policy(groups.finance, 'bin.delete', 'forbidden');
  await policy('', 'bin.min_retention', '90');
  assert.equal((await call(alex, 'GET', `/api/bin?book=${book.id}`)).retention, '90');
  await purgeBin({ now: days(40) });
  assert.equal((await call(alex, 'GET', `/api/bin?book=${book.id}`)).items.length, 1, 'kept for the minimum');
  await purgeBin({ now: days(91) });
  assert.deepEqual((await call(alex, 'GET', `/api/bin?book=${book.id}`)).items, [], 'purged after the minimum');
  await clearPolicies();

  // ── Allowed again: an editor deletes for good and empties ──
  const third = (await call(alex, 'POST', `${base}/contacts`, { name: { given: 'Pat' } })).contact;
  const fourth = (await call(alex, 'POST', `${base}/contacts`, { name: { given: 'Lee' } })).contact;
  const [thirdItem] = (await call(alex, 'DELETE', `${base}/contacts/${third.id}`)).bin_item_ids;
  await call(alex, 'DELETE', `${base}/contacts/${fourth.id}`);
  assert.equal((await call(alex, 'DELETE', `/api/bin/${thirdItem}`)).deleted, 1);
  assert.equal((await call(blair, 'POST', '/api/bin/empty', { book: book.id })).deleted, 1);
  // The purge leaves the book's items alone before 30 days.
  const kept = (await call(alex, 'POST', `${base}/contacts`, { name: { given: 'Kim' } })).contact;
  await call(alex, 'DELETE', `${base}/contacts/${kept.id}`);
  await purgeBin({ now: days(20) });
  assert.equal((await call(alex, 'GET', `/api/bin?book=${book.id}`)).items.length, 1);

  // ── A deleted book: hidden, restored by an administrator, purged after the retention ──
  await call(blair, 'DELETE', base);
  assert.equal((await call(alex, 'GET', `/api/bin?book=${book.id}`, undefined, 404)).code, 'BOOK_NOT_FOUND');
  await call(blair, 'GET', '/api/admin/address-books', undefined, 403);
  const listed = (await call(admin, 'GET', '/api/admin/address-books')).books as FixtureValue[];
  assert.deepEqual(listed.map(item => [item.id, !!item.deleted_at, item.created_by?.id]), [[book.id, true, ids.member]]);
  assert.equal((await call(admin, 'POST', `/api/admin/address-books/${book.id}/restore`, {})).book.deleted_at, null);
  assert.equal((await call(casey, 'GET', base)).book.name, 'Suppliers', 'back with its shares');
  await call(blair, 'DELETE', base);
  await purgeBin({ now: days(20) });
  assert.equal((await pool.execute<RowDataPacket[]>('SELECT id FROM address_books WHERE id = ?', [book.id]))[0].length, 1, 'kept within the retention');
  await purgeBin({ now: days(31) });
  const count = async (sql: string) => Number((await pool.execute<RowDataPacket[]>(sql, [book.id]))[0][0].n);
  assert.deepEqual([
    await count('SELECT COUNT(*) AS n FROM address_books WHERE id = ?'), await count('SELECT COUNT(*) AS n FROM contacts WHERE address_book_id = ?'),
    await count('SELECT COUNT(*) AS n FROM contact_photos WHERE address_book_id = ?'), await count('SELECT COUNT(*) AS n FROM bin_items WHERE address_book_id = ?'),
    await count("SELECT COUNT(*) AS n FROM grants WHERE resource_kind = 'address_book' AND resource_id = ?"),
  ], [0, 0, 0, 0, 0], 'the book, its contacts, photos, bin and shares are gone');
  // The sweep removes its photo files and folder an hour after their last write.
  const folder = path.join(process.env.CONTACT_PHOTOS_ROOT!, 'books', book.id);
  assert.ok(fs.readdirSync(folder).length >= 2);
  assert.ok(await sweepContactPhotos({ now: Date.now() + 2 * 3600000 }) >= 2);
  assert.equal(fs.existsSync(folder), false);
});
