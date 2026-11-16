// Shared address books on the phone (ContactsSync.kt, syncBooks): with a
// server that lists `contacts-books`, each book the person keeps on their
// phones, Company included, is a read-only group of read-only copies, one way
// from the server. An edit or deletion on the phone comes back at the next
// sync and changes nothing in UniHub; a book switched off, a removal from the
// group that holds the share and the phone rule take the copies off the phone
// without "Too many deletions" and without making them personal contacts.
// The person is the test's own, in the seeded Support group.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE, adb, contactsOn, contactsUri, openApp, query, requestSync, signOutApp, until } from '../support/android.mjs';
import { addPerson, ok, people, resetPeople, seedOrganisation, setRules } from '../support/people.mjs';

const tag = `E2e${Date.now().toString(36).slice(-5)}`;

before(async () => {
  await resetPeople();
  await signOutApp();
});

after(async () => {
  await resetPeople();
  requestSync();
});

// ── The phone, as Android's contacts provider holds it ──
const groups = () => query(`${contactsUri}/groups`, ['_id', 'sourceid', 'title', 'group_is_read_only'], `account_type='${PACKAGE}' AND sync1='book' AND deleted=0`);
const copies = () => query(`${contactsUri}/raw_contacts`, ['_id', 'sourceid', 'deleted', 'dirty'], `account_type='${PACKAGE}' AND sync1='book'`);
const copyOf = (book, id) => copies().filter(row => row.sourceid === `${book}:${id}` && row.deleted === '0');
const dataOf = raw => query(`${contactsUri}/data`, ['_id', 'mimetype', 'data1', 'data2', 'data4', 'data5'], `raw_contact_id=${raw}`)
  .map(row => ({ ...row, mime: row.mimetype.split('/').pop() }));
const personal = () => query(`${contactsUri}/raw_contacts`, ['_id', 'sourceid'], `account_type='${PACKAGE}' AND (sync1 IS NULL OR sync1!='book') AND deleted=0`);
const tooManyDeletions = () => /too many|deletes/i.test(adb('shell', 'dumpsys', 'notification', '--noredact').split(/\n\s*NotificationRecord\(/)
  .filter(record => record.includes('pkg=android ')).join('\n'));

test('shared books and Company come to the phone read-only, one way, and leave it when switched off, revoked or forbidden', { timeout: 1_800_000 }, async () => {
  const { support } = await seedOrganisation();
  const person = await addPerson('books', { groups: [support.id] });
  const api = await person.session();
  const [admin] = await people();
  await ok(api('PUT', '/api/directory/me', { job_title: `Buyer ${tag}`, department: 'Purchasing', phone: '+15550720' }), 'own directory entry');
  const own = (await ok(api('POST', '/api/contacts', { name: { given: 'Own', family: tag }, phones: [{ value: '+15550721', label: 'mobile', custom_label: null, preferred: false }] }), 'personal contact')).contact;

  // Suppliers, shared with Support, has a dozen contacts: enough for Android's "Too many deletions" if they counted as the person's.
  const suppliers = (await ok(admin('POST', '/api/address-books', { name: `Suppliers ${tag}` }), 'book')).book;
  await ok(admin('PUT', `/api/address-books/${suppliers.id}/shares`, { principal: { kind: 'group', id: support.id }, permission: 'read' }), 'share with Support');
  const supplier = [];
  for (let i = 0; i < 12; i++) {
    supplier.push((await ok(admin('POST', `/api/address-books/${suppliers.id}/contacts`, {
      name: { given: `Vera${i}`, family: tag }, emails: [{ value: `vera${i}.${tag.toLowerCase()}@example.org`, label: 'work', custom_label: null, preferred: false }],
    }), 'supplier')).contact);
  }
  const partners = (await ok(admin('POST', '/api/address-books', { name: `Partners ${tag}` }), 'book')).book;
  await ok(admin('PUT', `/api/address-books/${partners.id}/shares`, { principal: { kind: 'user', id: person.id }, permission: 'read' }), 'share with the person');
  const partner = (await ok(admin('POST', `/api/address-books/${partners.id}/contacts`, { name: { given: 'Walt', family: tag }, phones: [{ value: '+15550730', label: 'work', custom_label: null, preferred: false }] }), 'partner')).contact;

  await openApp({ email: person.email }).then(({ device }) => device.close());
  await contactsOn();
  await until(() => copyOf(suppliers.id, supplier[11].id).length === 1 && copyOf(partners.id, partner.id).length === 1 && copyOf('company', person.id).length === 1,
    'the books on the phone');

  // One read-only group per book, Company included; every copy and its rows read-only and in its book's group.
  const shown = Object.fromEntries(groups().map(group => [group.sourceid, group]));
  assert.deepEqual([suppliers.id, partners.id, 'company'].map(id => [shown[id]?.title, shown[id]?.group_is_read_only]),
    [[suppliers.name, '1'], [partners.name, '1'], ['Company', '1']]);
  const [walt] = copyOf(partners.id, partner.id);
  const waltRows = dataOf(walt._id);
  // Read-only rows (the provider does not list the flag): a contacts app's change of the name does not take.
  const name = waltRows.find(row => row.mime === 'name');
  adb('shell', 'content', 'update', '--uri', `${contactsUri}/data`, '--bind', 'data2:s:Changed', '--where', `"_id=${name._id}"`);
  assert.equal(dataOf(walt._id).find(row => row._id === name._id).data2, 'Walt', 'a read-only row stays as it was');
  assert.deepEqual(waltRows.filter(row => row.mime === 'group_membership').map(row => row.data1), [shown[partners.id]._id]);
  // Company: the job title and department on the organisation row, the directory phone.
  const self = dataOf(copyOf('company', person.id)[0]._id);
  assert.deepEqual(self.filter(row => row.mime === 'organization').map(row => [row.data1, row.data4, row.data5]), [['NULL', `Buyer ${tag}`, 'Purchasing']]);
  assert.ok(self.some(row => row.mime === 'phone_v2' && row.data1 === '+15550720'));
  // The person's own contact stays theirs, the books' copies are not among them.
  assert.deepEqual(personal().map(row => row.sourceid), [own.id]);

  // What a contacts app can still do, as a caller that is not the sync: Walt deleted, Vera0 given another number.
  adb('shell', 'content', 'delete', '--uri', `${contactsUri}/raw_contacts/${walt._id}`);
  const [vera] = copyOf(suppliers.id, supplier[0].id);
  adb('shell', 'content', 'insert', '--uri', `${contactsUri}/data`, '--bind', `raw_contact_id:i:${vera._id}`,
    '--bind', 'mimetype:s:vnd.android.cursor.item/phone_v2', '--bind', 'data1:s:+15550799', '--bind', 'data2:i:2');
  assert.equal(copies().find(row => row._id === vera._id)?.dirty, '1', 'the added number is a change on the phone');
  await until(() => {
    const back = copyOf(partners.id, partner.id);
    const veraNow = copyOf(suppliers.id, supplier[0].id);
    return back.length === 1 && back[0]._id !== walt._id && veraNow.length === 1 && veraNow[0].dirty === '0' &&
      !dataOf(veraNow[0]._id).some(row => row.data1 === '+15550799');
  }, 'the server\'s copies back on the phone');
  for (const [book, contact] of [[partners, partner], [suppliers, supplier[0]]]) {
    const now = (await ok(admin('GET', `/api/address-books/${book.id}/contacts/${contact.id}`), 'book contact')).contact;
    assert.equal(now.version, contact.version, 'unchanged in UniHub');
  }
  assert.equal((await ok(api('GET', '/api/contacts?limit=50'), 'personal contacts')).contacts.length, 1, 'no new personal contact in UniHub');

  // Partners switched off for the person's phones: only that book leaves.
  await ok(api('PUT', '/api/settings/values', { values: { contacts_phone_books_off: [partners.id] } }), 'switch Partners off');
  await until(() => copyOf(partners.id, partner.id).length === 0 && !groups().some(group => group.sourceid === partners.id), 'Partners off the phone');
  assert.equal(copyOf(suppliers.id, supplier[11].id).length, 1, 'Suppliers stays');

  // Out of Support: Suppliers leaves, without a question and without becoming the person's contacts.
  await ok(admin('DELETE', `/api/groups/${support.id}/members/${person.id}`), 'remove from Support');
  await until(() => supplier.every(contact => copyOf(suppliers.id, contact.id).length === 0) && !groups().some(group => group.sourceid === suppliers.id),
    'Suppliers off the phone');
  assert.equal(copyOf('company', person.id).length, 1, 'Company stays');
  assert.deepEqual(personal().map(row => row.sourceid), [own.id]);
  assert.equal((await ok(api('GET', '/api/contacts?limit=50'), 'personal contacts')).contacts.length, 1);
  assert.equal(tooManyDeletions(), false, 'no "Too many deletions"');

  // Phone contacts forbidden: Company and the person's own contacts leave, and stay in UniHub.
  await setRules({ 'contacts.phone_sync': 'forbidden' }, { others: [api] });
  await until(() => copies().filter(row => row.deleted === '0').length === 0 && groups().length === 0 && personal().length === 0, 'everything off the phone');
  assert.equal((await ok(api('GET', '/api/contacts?limit=50'), 'personal contacts')).contacts.length, 1);
});
