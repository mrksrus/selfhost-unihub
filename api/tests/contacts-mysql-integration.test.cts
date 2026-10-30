import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// The contacts API of 0.26 (F12, D17) through the real request handler and
// MariaDB, as the web page, the 0.24.3 to 0.25.1 Android apps (3+3 bodies,
// whole-contact PUT) and a second person reach it.
test('contacts API: vCard model, input contract, 3+3 compatibility, versions, owner scope, search and gates', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const password = 'synthetic-contacts-password';
  const passwordHash = await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4);
  const users: Record<string, string> = {};
  for (const name of ['owner', 'stranger', 'pager']) {
    users[name] = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)', [users[name], `${name}@example.test`, passwordHash, name]);
  }
  async function signIn(name: string) {
    const client = api.client();
    const reply = await client.request('POST', '/api/auth/signin', { email: `${name}@example.test`, password });
    assert.equal(reply.status, 200, String(reply.body.error));
    return client;
  }
  type Client = Awaited<ReturnType<typeof signIn>>;
  async function call(client: Client, method: string, path: string, body?: unknown, status = 200, headers: Record<string, string> = {}): Promise<FixtureValue> {
    const reply = await client.request(method, path, body, headers);
    assert.equal(reply.status, status, `${method} ${path}: ${JSON.stringify(reply.body).slice(0, 400)}`);
    return reply.body;
  }
  const owner = await signIn('owner');
  const stranger = await signIn('stranger');
  const list = async (client: Client, query = '') => (await call(client, 'GET', `/api/contacts${query}`)).contacts as FixtureValue[];
  const pairs = (values: FixtureValue[]) => values.map(value => [value.value, value.label]);

  // ── A 0.25 app creates a contact with the flat 3+3 body ──
  const ann = (await call(owner, 'POST', '/api/contacts', { first_name: 'Ann', last_name: 'Example', email: 'ann@example.test', email2: 'ann.work@example.test',
    email3: null, phone: '+49 171 1234567', phone2: null, phone3: null, company: 'Example GmbH', job_title: 'Engineer', notes: null })).contact;
  assert.equal(ann.uid, `urn:uuid:${ann.id}`);
  assert.equal(ann.version, 1);
  assert.equal(ann.display_name, 'Ann Example');
  assert.deepEqual(pairs(ann.emails), [['ann@example.test', ''], ['ann.work@example.test', '']]);
  assert.deepEqual([ann.first_name, ann.last_name, ann.email, ann.email2, ann.email3, ann.phone, ann.phone2, ann.company, ann.job_title],
    ['Ann', 'Example', 'ann@example.test', 'ann.work@example.test', null, '+49 171 1234567', null, 'Example GmbH', 'Engineer']);
  assert.equal((await call(owner, 'POST', '/api/contacts', { last_name: 'Nameless', email: 'x@example.test' }, 400)).error, 'First name is required');

  // ── The page creates a full contact ──
  const bea = (await call(owner, 'POST', '/api/contacts', {
    name: { given: 'Bea', family: 'Beispiel', middle: 'Maria', prefix: 'Dr.' },
    organization: { name: 'Example AG', department: 'Research' }, job_title: 'Chemist',
    birthday: '--02-29', anniversary: '2010-06-15', notes: '  Private note\n\n',
    emails: [{ value: 'bea@example.test', label: 'home', preferred: true }, { value: 'bea@work.example.test', label: 'work' }, { value: 'b3@example.test', label: 'other' },
      { value: 'b4@example.test', label: 'custom', custom_label: 'Club' }, 'b5@example.test', '', null],
    phones: [{ value: '+43 1 111', label: 'mobile' }, { value: '+43 1 222', label: 'work' }, { value: '+43 1 333', label: 'home_fax' }, { value: '+43 1 444', label: 'pager' }],
    addresses: [{ label: 'home', street: 'Hauptstraße 1', locality: 'Wien', postal_code: '1010', country: 'Austria' }],
    urls: [{ value: 'https://example.test', label: 'homepage' }], impp: [{ value: 'xmpp:bea@example.test', label: 'work' }],
    related: [{ value: 'Carl', label: 'spouse' }], nicknames: [{ value: 'Bee' }], categories: ['Climbing', 'Family'],
    something_unknown: 'ignored',
  })).contact;
  assert.deepEqual(pairs(bea.emails), [['bea@example.test', 'home'], ['bea@work.example.test', 'work'], ['b3@example.test', 'other'], ['b4@example.test', 'custom'], ['b5@example.test', '']]);
  assert.equal(bea.emails[3].custom_label, 'Club');
  assert.equal(bea.emails[0].preferred, true);
  assert.deepEqual(bea.birthday, { year: null, month: 2, day: 29 });
  assert.deepEqual(bea.anniversary, { year: 2010, month: 6, day: 15 });
  assert.equal(bea.notes, '  Private note\n\n', 'notes keep their whitespace');
  assert.equal(bea.addresses[0].value, 'Hauptstraße 1\n1010 Wien\nAustria');
  assert.deepEqual(bea.categories, ['Climbing', 'Family']);
  assert.deepEqual([bea.name.middle, bea.name.prefix, bea.organization.department, bea.display_name], ['Maria', 'Dr.', 'Research', 'Bea Maria Beispiel']);
  assert.deepEqual([bea.email, bea.email2, bea.email3, bea.phone, bea.phone2, bea.phone3], ['bea@example.test', 'bea@work.example.test', 'b3@example.test', '+43 1 111', '+43 1 222', '+43 1 333']);
  const beaDetail = (await call(owner, 'GET', `/api/contacts/${bea.id}`)).contact;
  assert.deepEqual(beaDetail.properties, []);
  assert.equal(beaDetail.kept_properties, 0);

  // ── The 0.25 app writes back what it shows: its exact whole-contact PUT ──
  // It changed the second email and removed the second number on the phone.
  // Values from the fourth on, every label and the fields it does not know survive.
  const appBody = { first_name: 'Bea', last_name: 'Beispiel', company: 'Example AG', job_title: 'Chemist', notes: '  Private note\n\n',
    phone: '+43 1 111', phone2: '+43 1 333', phone3: null, email: 'bea@example.test', email2: 'bea.new@example.test', email3: 'b3@example.test' };
  const afterApp = (await call(owner, 'PUT', `/api/contacts/${bea.id}`, appBody)).contact;
  assert.deepEqual(pairs(afterApp.emails), [['bea@example.test', 'home'], ['bea.new@example.test', ''], ['b3@example.test', 'other'], ['b4@example.test', 'custom'], ['b5@example.test', '']]);
  assert.deepEqual(pairs(afterApp.phones), [['+43 1 111', 'mobile'], ['+43 1 333', 'home_fax'], ['+43 1 444', 'pager']]);
  assert.equal(afterApp.emails[0].id, bea.emails[0].id, 'a kept value keeps its row');
  assert.equal(afterApp.emails[0].preferred, true);
  assert.deepEqual([afterApp.name.middle, afterApp.name.prefix, afterApp.organization.department, afterApp.birthday, afterApp.categories, pairs(afterApp.nicknames)],
    [bea.name.middle, bea.name.prefix, 'Research', bea.birthday, bea.categories, [['Bee', '']]]);
  assert.equal(afterApp.addresses.length, 1);
  assert.equal(afterApp.version, 2);
  assert.deepEqual([afterApp.email, afterApp.email2, afterApp.email3, afterApp.phone, afterApp.phone2, afterApp.phone3],
    ['bea@example.test', 'bea.new@example.test', 'b3@example.test', '+43 1 111', '+43 1 333', null], 'the fourth number stays out of the app\'s three places');
  // Sending the same body again (a retry after a lost answer) changes nothing but the version.
  const again = (await call(owner, 'PUT', `/api/contacts/${bea.id}`, appBody)).contact;
  assert.deepEqual({ ...again, version: 0, updated_at: '' }, { ...afterApp, version: 0, updated_at: '' });
  // A renamed contact through the app sets the name parts it knows.
  const renamed = (await call(owner, 'PUT', `/api/contacts/${ann.id}`, { first_name: 'Anna', last_name: 'Example', email: 'ann@example.test', email2: 'ann.work@example.test',
    phone: '+49 171 1234567', company: 'Example GmbH', job_title: 'Engineer', notes: null })).contact;
  assert.equal(renamed.display_name, 'Anna Example');

  // ── Versions: a full update needs the version it was made on ──
  const fullUpdate = { name: { given: 'Bea', family: 'Beispiel' }, emails: [{ value: 'bea@example.test', label: 'home' }] };
  assert.equal((await call(owner, 'PUT', `/api/contacts/${bea.id}`, fullUpdate, 400)).code, 'VERSION_REQUIRED');
  const stale = await call(owner, 'PUT', `/api/contacts/${bea.id}`, { ...fullUpdate, version: 1 }, 409);
  assert.equal(stale.code, 'VERSION_CONFLICT');
  assert.equal(stale.contact.version, 3, 'answers the contact as it is now');
  assert.equal((await call(owner, 'PUT', `/api/contacts/${bea.id}`, fullUpdate, 400, { 'If-Match': 'yesterday' })).code, 'INVALID_CONTACT');
  await call(owner, 'PUT', `/api/contacts/${bea.id}/favorite`, { is_favorite: 1 });
  const replaced = (await call(owner, 'PUT', `/api/contacts/${bea.id}`, fullUpdate, 200, { 'If-Match': '"4"' })).contact;
  assert.equal(replaced.version, 5);
  assert.deepEqual([pairs(replaced.emails), replaced.phones, replaced.addresses, replaced.categories, replaced.organization, replaced.birthday, replaced.notes],
    [[['bea@example.test', 'home']], [], [], [], { name: null, department: null }, null, null], 'a full body replaces the content');
  assert.equal(replaced.is_favorite, true, 'an absent favourite stays');

  // ── The input contract (D17) ──
  const refused: [FixtureValue, RegExp][] = [
    [{ name: { given: true } }, /^First name must be text$/],
    [{ name: { given: { text: 'x' } } }, /^First name must be text$/],
    [{ first_name: ['x'] }, /^First name must be text$/],
    [{ name: { given: 'x\ud800' } }, /^First name contains invalid characters$/],
    [{ name: { given: 'x'.repeat(256) } }, /^First name is too long \(at most 255 characters\)$/],
    [{ name: { given: 'A' }, notes: 'é'.repeat(32768) }, /^Notes is too long \(at most 65535 bytes\)$/],
    [{ name: { given: 'A' }, is_favorite: 'yes' }, /^Favorite must be true or false$/],
    [{ emails: [{ value: 'a@example.test', preferred: 1 }] }, /^Email preferred must be true or false$/],
    [{ emails: [{ value: 'a@example.test', label: 'bogus' }] }, /^Email label "bogus" is not one of its labels$/],
    [{ emails: [{ value: 'a@example.test', label: 'custom' }] }, /^Email needs a custom label$/],
    [{ name: { given: 'A' }, birthday: '2023-02-29' }, /^Birthday is not a real date$/],
    [{ name: { given: 'A' }, anniversary: 'circa 1980' }, /^Anniversary must be a date/],
    [{ name: { given: 'A' }, email: 'a@example.test' }, /not both$/],
    [{ emails: Array.from({ length: 101 }, (_, index) => `e${index}@example.test`) }, /^At most 100 values per field \(Email\)$/],
    [{ phones: [{ value: '1'.repeat(65) }] }, /^Phone is too long \(at most 64 characters\)$/],
    [{ name: { given: 'A' }, emails: 'a@example.test' }, /^Email values must be a list$/],
    [{ name: {}, notes: 'only a note' }, /^A contact needs a name/],
  ];
  for (const [body, message] of refused) assert.match((await call(owner, 'POST', '/api/contacts', body, 400)).error, message, JSON.stringify(body).slice(0, 80));
  const accepted = (await call(owner, 'POST', '/api/contacts', { name: { given: 0 }, birthday: '2024-02-29', notes: '   ', phones: [5550100] })).contact;
  assert.deepEqual([accepted.name.given, accepted.birthday, accepted.notes, accepted.phones[0].value], ['0', { year: 2024, month: 2, day: 29 }, null, '5550100']);
  const legacyNumber = (await call(owner, 'POST', '/api/contacts', { first_name: 'Num', phone: 5550101, notes: '  indented\n\n' })).contact;
  assert.deepEqual([legacyNumber.phone, legacyNumber.notes], ['5550101', '  indented\n\n']);
  assert.match((await call(owner, 'POST', '/api/contacts', { first_name: 'Long', phone: '1'.repeat(65) }, 400)).error, /^Phone is too long/);

  // ── Owner scope: another person can neither read nor change it ──
  const ownerBefore = (await call(owner, 'GET', `/api/contacts/${ann.id}`)).contact;
  await call(stranger, 'GET', `/api/contacts/${ann.id}`, undefined, 404);
  await call(stranger, 'PUT', `/api/contacts/${ann.id}`, { first_name: 'Taken' }, 404);
  await call(stranger, 'PUT', `/api/contacts/${ann.id}`, { name: { given: 'Taken' }, version: ownerBefore.version }, 404);
  await call(stranger, 'DELETE', `/api/contacts/${ann.id}`);
  await call(stranger, 'PUT', `/api/contacts/${ann.id}/favorite`, { is_favorite: true });
  assert.equal((await call(stranger, 'POST', '/api/contacts/bulk-delete', { ids: [ann.id, bea.id] })).deleted, 0);
  assert.equal((await call(stranger, 'POST', '/api/contacts/bulk-update', { ids: [ann.id], contact: { company: 'Taken' } })).updated, 0);
  assert.deepEqual(await list(stranger), []);
  assert.deepEqual(await list(stranger, '?q=Ann'), []);
  assert.equal((await call(stranger, 'GET', '/api/search?q=Anna')).results.length, 0);
  assert.deepEqual((await call(owner, 'GET', `/api/contacts/${ann.id}`)).contact, ownerBefore);

  // ── Search: names, accents, digits, categories, literal wildcards ──
  await call(owner, 'POST', '/api/contacts', { first_name: 'Jürgen', last_name: 'Müller', email: 'juergen@example.test' });
  await call(owner, 'POST', '/api/contacts', { first_name: '100% Example' });
  await call(owner, 'POST', '/api/contacts', { name: { given: 'Nina' }, nicknames: ['Ninja'], categories: ['Neighbours'], organization: { department: 'Logistics' }, version: undefined });
  const found = async (q: string) => (await list(owner, `?q=${encodeURIComponent(q)}`)).map(contact => contact.display_name).sort();
  assert.deepEqual(await found('0171 123'), ['Anna Example'], 'trunk zero and spaces ignored');
  assert.deepEqual(await found('+49 171'), ['Anna Example']);
  assert.deepEqual(await found('jurgen muller'), ['Jürgen Müller'], 'accents and the whole name');
  assert.deepEqual(await found('Climbing'), []);
  assert.deepEqual(await found('Neighbours'), ['Nina']);
  assert.deepEqual(await found('Ninja'), ['Nina']);
  assert.deepEqual(await found('Logistics'), ['Nina']);
  assert.deepEqual(await found('100%'), ['100% Example']);
  assert.deepEqual(await found('%'), ['100% Example'], 'a literal % matches itself');
  assert.deepEqual(await found('_'), []);
  assert.deepEqual(await found('ann.work@'), ['Anna Example']);
  const global = (await call(owner, 'GET', '/api/search?q=jurgen')).results.filter((result: FixtureValue) => result.type === 'contact');
  assert.deepEqual(global.map((result: FixtureValue) => [result.title, result.subtitle]), [['Jürgen Müller', 'juergen@example.test']]);
  const emailOnly = (await call(owner, 'POST', '/api/contacts', { emails: ['only@example.test'] })).contact;
  assert.ok((await list(owner, '?group=number_or_email_only')).some(contact => contact.id === emailOnly.id));
  assert.ok((await list(owner, '?group=name_only')).every(contact => !contact.email && !contact.phone && contact.display_name));
  assert.ok((await list(owner, '?group=name_only')).some(contact => contact.display_name === '100% Example'));

  // ── Bulk actions and the 0.25 favourite route ──
  assert.equal((await call(owner, 'POST', '/api/contacts/bulk-update', { ids: [ann.id, bea.id], contact: { department: 'Sales', company: null } })).updated, 2);
  const bulked = (await call(owner, 'GET', `/api/contacts/${ann.id}`)).contact;
  assert.deepEqual([bulked.organization, bulked.company], [{ name: null, department: 'Sales' }, null]);
  assert.match((await call(owner, 'POST', '/api/contacts/bulk-update', { ids: [ann.id], contact: { notes: 'x' } }, 400)).error, /cannot be changed/);

  // ── Gates: the module switch and a running restore of the section ──
  await call(owner, 'PUT', '/api/modules', { modules: { contacts: { enabled: false } } });
  assert.equal((await call(owner, 'GET', '/api/contacts', undefined, 403)).code, 'MODULE_DISABLED');
  assert.equal((await call(owner, 'POST', '/api/contacts', { first_name: 'Off' }, 403)).code, 'MODULE_DISABLED');
  await call(owner, 'PUT', '/api/modules', { modules: { contacts: { enabled: true } } });
  const restoreId = crypto.randomUUID();
  await pool.execute("INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '[\"contacts\"]')", [restoreId, users.owner]);
  assert.equal((await call(owner, 'POST', '/api/contacts', { first_name: 'Restoring' }, 409)).code, 'RESTORE_IN_PROGRESS');
  assert.equal((await call(owner, 'PUT', `/api/contacts/${ann.id}`, { first_name: 'Restoring' }, 409)).code, 'RESTORE_IN_PROGRESS');
  assert.equal((await call(owner, 'DELETE', `/api/contacts/${ann.id}`, undefined, 409)).code, 'RESTORE_IN_PROGRESS');
  assert.ok((await list(owner)).length > 0, 'reading stays possible');
  await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreId]);

  // ── Merges of the last 30 days for the phone (include=merged) ──
  await pool.execute(`INSERT INTO contact_merges (id, user_id, survivor_id, merged_ids, survivor_before, survivor_version_after, created_at, purge_after, undone_at) VALUES
    (?, ?, ?, '["gone-1","gone-2"]', '{}', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 30 DAY, NULL),
    (?, ?, ?, '["undone"]', '{}', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 30 DAY, UTC_TIMESTAMP()),
    (?, ?, ?, '["old"]', '{}', 1, UTC_TIMESTAMP() - INTERVAL 31 DAY, UTC_TIMESTAMP(), NULL),
    (?, ?, ?, '["theirs"]', '{}', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 30 DAY, NULL)`,
  [crypto.randomUUID(), users.owner, ann.id, crypto.randomUUID(), users.owner, ann.id, crypto.randomUUID(), users.owner, ann.id, crypto.randomUUID(), users.stranger, 'x']);
  const withMerged = await call(owner, 'GET', '/api/contacts?include=merged');
  assert.deepEqual(withMerged.merged.map((item: FixtureValue) => [item.id, item.into]), [['gone-1', ann.id], ['gone-2', ann.id]]);
  assert.equal((await call(owner, 'GET', '/api/contacts')).merged, undefined);

  // ── The 0.25 automatic merge and JSON import are gone (they lost data) ──
  for (const [method, path] of [['POST', '/api/contacts/merge-duplicates'], ['POST', '/api/contacts/merge-duplicates/preview'], ['POST', '/api/contacts/import']]) {
    assert.equal((await owner.request(method, path, { vcf_data: 'BEGIN:VCARD\r\nEND:VCARD' })).status, 404, `${method} ${path}`);
  }
  // Their replacements (preview import, vCard 4.0/3.0 and CSV export) are tested in contacts-transfer-mysql-integration.test.cts.

  // ── Paging past 2,000 contacts with equal names: nothing lost or repeated ──
  const pager = await signIn('pager');
  const pagedIds = Array.from({ length: 2105 }, () => crypto.randomUUID());
  for (let start = 0; start < pagedIds.length; start += 500) {
    await pool.query('INSERT INTO contacts (id, user_id, uid, uid_hash, first_name) VALUES ?', [pagedIds.slice(start, start + 500).map(id => [id, users.pager, `urn:uuid:${id}`,
      crypto.createHash('sha256').update(`urn:uuid:${id}`).digest('hex'), 'Same'])]);
  }
  const first = await call(pager, 'GET', '/api/contacts?limit=2000');
  const second = await call(pager, 'GET', '/api/contacts?limit=2000&offset=2000');
  assert.deepEqual([first.contacts.length, first.has_more, second.contacts.length, second.has_more, second.offset], [2000, true, 105, false, 2000]);
  assert.deepEqual([...first.contacts, ...second.contacts].map((contact: FixtureValue) => contact.id), [...pagedIds].sort(), 'ordered by id among equal names');
  const bounded = await call(pager, 'GET', '/api/contacts?limit=-5&offset=abc');
  assert.deepEqual([bounded.contacts.length, bounded.offset], [2000, 0]);

  // Deleting cascades to the values; nothing of the person's contacts remains.
  const [[before]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM contact_values WHERE contact_id = ?', [ann.id]);
  assert.ok(Number(before.n) > 0);
  await call(owner, 'DELETE', `/api/contacts/${ann.id}`);
  await call(owner, 'GET', `/api/contacts/${ann.id}`, undefined, 404);
  const [[after]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM contact_values WHERE contact_id = ?', [ann.id]);
  assert.equal(Number(after.n), 0);
});

// The bridge for the 0.24.3 to 0.25.1 apps (P-21), with the exact bodies they
// send: ContactsSync.save() over ContactCard.forServer(), which cuts names to
// 100 UTF-16 units and company and title to 255, drops a number over 50, and
// leaves out every empty field. Their writes must change only what the person
// changed on the phone, and the same write sent twice must not remove more.
test('3+3 bridge: old-app limits, partial bodies, If-Match and replays never lose values', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const password = 'synthetic-bridge-password';
  await pool.execute('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)',
    [crypto.randomUUID(), 'bridge@example.test', await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4), 'Bridge']);
  const owner = api.client();
  assert.equal((await owner.request('POST', '/api/auth/signin', { email: 'bridge@example.test', password })).status, 200);
  async function call(method: string, path: string, body?: unknown, status = 200, headers: Record<string, string> = {}): Promise<FixtureValue> {
    const reply = await owner.request(method, path, body, headers);
    assert.equal(reply.status, status, `${method} ${path}: ${JSON.stringify(reply.body).slice(0, 400)}`);
    return reply.body;
  }
  const get = async (id: string) => (await call('GET', `/api/contacts/${id}`)).contact;
  const listed = async (id: string) => ((await call('GET', '/api/contacts')).contacts as FixtureValue[]).find(contact => contact.id === id);
  // ContactCard.cut(): UTF-16 units, never half a surrogate pair, trimmed.
  const cut = (value: string, max: number) => {
    const text = value.trim();
    if (text.length <= max) return text;
    return text.slice(0, /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max).trim();
  };
  // What a 0.25 app PUTs for the listed contact when nothing changed on the phone.
  function appBody(contact: FixtureValue, phoneEdit: (phones: string[]) => string[] = phones => phones) {
    const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
    const phones = phoneEdit([contact.phone, contact.phone2, contact.phone3].map(text).filter(Boolean).filter(value => value.length <= 50));
    const emails = [contact.email, contact.email2, contact.email3].map(text).filter(Boolean).filter(value => value.length <= 255);
    const body: Record<string, string> = { first_name: cut(text(contact.first_name), 100) };
    const optional: [string, string][] = [['last_name', cut(text(contact.last_name), 100)], ['company', cut(text(contact.company), 255)], ['job_title', cut(text(contact.job_title), 255)],
      ...phones.map((value, index): [string, string] => [['phone', 'phone2', 'phone3'][index], value]), ...emails.map((value, index): [string, string] => [['email', 'email2', 'email3'][index], value])];
    for (const [key, value] of optional) if (value) body[key] = value;
    if (contact.notes != null) body.notes = contact.notes;
    return body;
  }
  const values = (contact: FixtureValue, kind: 'emails' | 'phones') => contact[kind].map((item: FixtureValue) => item.value);

  // ── An old app round-trips a contact it cannot hold whole ──
  const longName = 'Maximiliane-' + 'x'.repeat(108);
  const longPhone = '+43 ' + '1'.repeat(56);
  const wideCompany = '😀'.repeat(200);
  const created = (await call('POST', '/api/contacts', { name: { given: longName, family: 'Example' }, organization: { name: wideCompany }, job_title: 'Engineer',
    phones: [{ value: '+43 1 100', label: 'mobile' }, { value: longPhone, label: 'work' }, { value: '+43 1 300', label: 'home' }], emails: ['long@example.test'] })).contact;
  assert.deepEqual([longName.length, longPhone.length, wideCompany.length], [120, 60, 400], 'UTF-16 lengths, as the app counts');
  const seen = await listed(created.id);
  assert.deepEqual([seen.first_name, seen.phone, seen.phone2, seen.phone3], [longName, '+43 1 100', '+43 1 300', null], 'a number the app would drop is not shown to it');
  const roundTrip = (await call('PUT', `/api/contacts/${created.id}`, appBody(seen))).contact;
  assert.deepEqual([roundTrip.name.given, roundTrip.name.family, roundTrip.organization.name, roundTrip.job_title, roundTrip.display_name],
    [longName, 'Example', wideCompany, 'Engineer', `${longName} Example`], 'cut names come back as unchanged');
  assert.deepEqual(values(roundTrip, 'phones').sort(), ['+43 1 100', '+43 1 300', longPhone].sort(), 'the 60-character number survives');
  assert.deepEqual(roundTrip.phones.find((phone: FixtureValue) => phone.value === longPhone).label, 'work');
  const replayed = (await call('PUT', `/api/contacts/${created.id}`, appBody(seen))).contact;
  assert.deepEqual({ ...replayed, version: 0, updated_at: '' }, { ...roundTrip, version: 0, updated_at: '' }, 'the same write again changes nothing');
  // A real change on the phone still arrives, and the hidden number stays.
  const edited = (await call('PUT', `/api/contacts/${created.id}`, appBody(await listed(created.id), phones => phones.map(phone => phone === '+43 1 300' ? '+43 1 333' : phone)))).contact;
  assert.deepEqual(values(edited, 'phones').sort(), ['+43 1 100', '+43 1 333', longPhone].sort());
  assert.equal(edited.name.given, longName);
  // A name really renamed on the phone is taken as sent.
  const renamed = (await call('PUT', `/api/contacts/${created.id}`, { ...appBody(await listed(created.id)), first_name: 'Maxi' })).contact;
  assert.deepEqual([renamed.name.given, renamed.organization.name], ['Maxi', wideCompany]);

  // ── The review probe: a body of shared fields only, with a stale If-Match ──
  const probe = (await call('POST', '/api/contacts', { first_name: 'Probe', last_name: 'Person', email: 'p1@example.test', email2: 'p2@example.test', email3: 'p3@example.test', phone: '+1 555 0100' })).contact;
  for (let index = 0; index < 6; index++) await call('PUT', `/api/contacts/${probe.id}/favorite`, { is_favorite: index % 2 === 0 });
  assert.equal((await get(probe.id)).version, 7);
  const stale = await call('PUT', `/api/contacts/${probe.id}`, { notes: 'changed' }, 409, { 'If-Match': '"1"' });
  assert.deepEqual([stale.code, stale.contact.version], ['VERSION_CONFLICT', 7]);
  assert.equal((await call('PUT', `/api/contacts/${probe.id}`, { ...appBody(await listed(probe.id)), notes: 'changed' }, 409, { 'If-Match': '"6"' })).code, 'VERSION_CONFLICT', 'a stale whole flat body too');
  const unchangedProbe = await get(probe.id);
  assert.deepEqual([unchangedProbe.version, unchangedProbe.notes], [7, null], 'a refused write changes nothing');
  const notesOnly = (await call('PUT', `/api/contacts/${probe.id}`, { notes: 'changed' }, 200, { 'If-Match': '"7"' })).contact;
  assert.equal(notesOnly.version, 8);
  assert.deepEqual([notesOnly.name.given, notesOnly.name.family, values(notesOnly, 'emails'), values(notesOnly, 'phones'), notesOnly.notes],
    ['Probe', 'Person', ['p1@example.test', 'p2@example.test', 'p3@example.test'], ['+1 555 0100'], 'changed'], 'a partial body changes only what it carries');
  const titleOnly = (await call('PUT', `/api/contacts/${probe.id}`, { job_title: 'Boss', is_favorite: true })).contact;
  assert.deepEqual([titleOnly.job_title, titleOnly.is_favorite, titleOnly.notes, titleOnly.name.given, values(titleOnly, 'emails').length], ['Boss', true, 'changed', 'Probe', 3]);

  // ── The review probe: replaying a write that keeps one of five emails ──
  const five = (await call('POST', '/api/contacts', { name: { given: 'Five' }, emails: ['a@example.test', 'b@example.test', 'c@example.test', { value: 'd@example.test', label: 'work' }, 'e@example.test'] })).contact;
  const keepOne = { first_name: 'Five', email: 'a@example.test' };
  const first = (await call('PUT', `/api/contacts/${five.id}`, keepOne)).contact;
  assert.deepEqual(values(first, 'emails'), ['a@example.test', 'd@example.test', 'e@example.test'], 'only the values the app saw can go');
  assert.deepEqual([first.email, first.email2, first.email3], ['a@example.test', null, null], 'the others are not moved into its places');
  const second = (await call('PUT', `/api/contacts/${five.id}`, keepOne)).contact;
  assert.deepEqual({ ...second, version: 0, updated_at: '' }, { ...first, version: 0, updated_at: '' }, 'the same PUT twice gives the same contact');
  assert.equal(second.emails[1].label, 'work');
  // The page (a full write) shows every value again in its order; the app then sees the first three.
  const reordered = (await call('PUT', `/api/contacts/${five.id}`, { name: { given: 'Five' }, emails: second.emails, version: second.version })).contact;
  assert.deepEqual([reordered.email, reordered.email2, reordered.email3], ['a@example.test', 'd@example.test', 'e@example.test']);
  const [[stored]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM contact_values WHERE contact_id = ? AND kind = 'email'", [five.id]);
  assert.equal(Number(stored.n), 3);
});

// Review round 2: a partial flat body changes only the slots it names; an
// old app's addition beside hidden values never passes the per-kind limit,
// and a restore keeps all it stored or refuses loudly; the values an old app
// sees follow its own key rules (ContactCard.phoneKey, UTF-16 chars).
test('3+3 bridge: partial slots, the per-kind limit with lossless restore, and the apps\' own keys', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const password = 'synthetic-bridge-two-password';
  const userId = crypto.randomUUID();
  await pool.execute('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)',
    [userId, 'bridge-two@example.test', await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4), 'Bridge two']);
  const owner = api.client();
  assert.equal((await owner.request('POST', '/api/auth/signin', { email: 'bridge-two@example.test', password })).status, 200);
  async function call(method: string, path: string, body?: unknown, status = 200): Promise<FixtureValue> {
    const reply = await owner.request(method, path, body);
    assert.equal(reply.status, status, `${method} ${path}: ${JSON.stringify(reply.body).slice(0, 400)}`);
    return reply.body;
  }
  const phones = (contact: FixtureValue) => contact.phones.map((item: FixtureValue) => item.value);
  const listed = async (id: string) => ((await call('GET', '/api/contacts')).contacts as FixtureValue[]).find(contact => contact.id === id);

  // ── A partial body names one slot: the others stay ──
  const threePhones = { first_name: 'Slots', email: 'slots@example.test', phone: '111', phone2: '222', phone3: '333' };
  const cleared = (await call('POST', '/api/contacts', threePhones)).contact;
  const afterClear = (await call('PUT', `/api/contacts/${cleared.id}`, { phone2: '' })).contact;
  assert.deepEqual(phones(afterClear), ['111', '333'], 'only the second number goes');
  assert.deepEqual([afterClear.name.given, afterClear.email], ['Slots', 'slots@example.test']);
  const replaced = (await call('POST', '/api/contacts', threePhones)).contact;
  const afterReplace = (await call('PUT', `/api/contacts/${replaced.id}`, { phone2: '444' })).contact;
  assert.deepEqual(phones(afterReplace), ['111', '444', '333'], 'only the second number changes');
  assert.deepEqual([afterReplace.phone, afterReplace.phone2, afterReplace.phone3], ['111', '444', '333']);
  const afterThird = (await call('PUT', `/api/contacts/${replaced.id}`, { phone3: null, email2: 'second@example.test' })).contact;
  assert.deepEqual([phones(afterThird), afterThird.emails.map((item: FixtureValue) => item.value)], [['111', '444'], ['slots@example.test', 'second@example.test']]);

  // ── 100 numbers with a hidden long one: an old app's third number is refused, nothing is lost ──
  const longPhone = '+43 ' + '9'.repeat(56);
  const hundred = ['+43 1 0', longPhone, ...Array.from({ length: 98 }, (_, index) => `+43 1 ${index + 1}`)];
  const full = (await call('POST', '/api/contacts', { name: { given: 'Hundred' }, phones: hundred })).contact;
  const seen = await listed(full.id);
  assert.deepEqual([seen.phone, seen.phone2, seen.phone3], ['+43 1 0', '+43 1 1', null], 'the app sees two numbers');
  const refused = await call('PUT', `/api/contacts/${full.id}`, { first_name: 'Hundred', phone: '+43 1 0', phone2: '+43 1 1', phone3: '+43 1 999' }, 400);
  assert.equal(refused.code, 'TOO_MANY_VALUES');
  assert.match(refused.error, /already has 100 phone numbers/);
  const kept = (await call('GET', `/api/contacts/${full.id}`)).contact;
  assert.deepEqual([phones(kept).length, phones(kept).includes(longPhone), kept.version], [100, true, 1], 'the refused write changed nothing');
  // An edit that stays within the limit still arrives, and the hidden number stays.
  const swapped = (await call('PUT', `/api/contacts/${full.id}`, { first_name: 'Hundred', phone: '+43 1 0', phone2: '+43 1 777' })).contact;
  assert.deepEqual([phones(swapped).length, phones(swapped).includes(longPhone), phones(swapped).includes('+43 1 777')], [100, true, true]);

  // A restore keeps every value it was given up to the limit, and refuses more instead of dropping any.
  const { importBackupForUser } = require('../dist/src/services/backup') as typeof import('../src/services/backup');
  const archive = (count: number) => {
    const id = crypto.randomUUID();
    return { app: 'unihub', version: 5, files: [], data: { contacts: [{ id, first_name: `Restored ${count}` }],
      contact_values: Array.from({ length: count }, (_, index) => ({ id: crypto.randomUUID(), contact_id: id, kind: 'phone', position: index === 1 ? count - 1 : index === count - 1 ? 1 : index,
        value: index === 1 ? longPhone : `+44 20 ${index}`, label: '' })) } };
  };
  await importBackupForUser(userId, archive(100) as FixtureValue, { mode: 'apply', conflict_mode: 'keep_both' });
  const restored = ((await call('GET', '/api/contacts?q=Restored')).contacts as FixtureValue[]);
  assert.equal(restored.length, 1);
  assert.deepEqual([restored[0].phones.length, phones(restored[0]).includes(longPhone)], [100, true], 'all 100, the long number included');
  const [[before]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM contacts WHERE user_id = ?', [userId]);
  await assert.rejects(importBackupForUser(userId, archive(101) as FixtureValue, { mode: 'apply', conflict_mode: 'keep_both' }), /more than 100 values of one kind \(phone\)/);
  const [[after]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM contacts WHERE user_id = ?', [userId]);
  assert.equal(after.n, before.n, 'a refused restore writes nothing');

  // ── The apps' keys: digits outside the BMP count for nothing, one value per key ──
  const keyed = (await call('POST', '/api/contacts', { name: { given: 'Keys' }, phones: ['𝟙', '𝟚', '+43 1 5'] })).contact;
  const keyedSeen = await listed(keyed.id);
  assert.deepEqual([keyedSeen.phone, keyedSeen.phone2, keyedSeen.phone3], ['+43 1 5', null, null], 'numbers with an empty app key are not shown');
  const keyedAfter = (await call('PUT', `/api/contacts/${keyed.id}`, { first_name: 'Keys', phone: '+43 1 5' })).contact;
  assert.deepEqual(phones(keyedAfter).sort(), ['+43 1 5', '𝟙', '𝟚'].sort(), 'both survive the app\'s write');
  const twins = (await call('POST', '/api/contacts', { name: { given: 'Twins' }, phones: ['+1 555 0100', '+15550100', '٣٣٣', '333'] })).contact;
  const twinsSeen = await listed(twins.id);
  assert.deepEqual([twinsSeen.phone, twinsSeen.phone2, twinsSeen.phone3], ['+1 555 0100', '٣٣٣', null], 'one value per app key; a BMP digit is a digit');
  const twinsAfter = (await call('PUT', `/api/contacts/${twins.id}`, { first_name: 'Twins', phone: '+1 555 0100', phone2: '٣٣٣' })).contact;
  assert.deepEqual(phones(twinsAfter).sort(), ['+1 555 0100', '+15550100', '٣٣٣', '333'].sort(), 'the hidden twin survives');
});
