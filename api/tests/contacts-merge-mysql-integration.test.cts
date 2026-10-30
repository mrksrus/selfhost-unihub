import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// Duplicates, merges, the bin and the 30-day undo (0.26.0 slices 5 and 6)
// through the real request handler and MariaDB, with a second person as the
// stranger.
test('contact duplicates and merges: detection, merge review, Merge all, undo, purge, concurrency, owner scope and gates', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const { purgeExpiredMerges, photosHeldForUndo } = require('../dist/src/services/contact-merge') as typeof import('../src/services/contact-merge');
  const password = 'synthetic-merge-password';
  const passwordHash = await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4);
  const users: Record<string, string> = {};
  for (const name of ['owner', 'stranger']) {
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
  async function call(client: Client, method: string, path: string, body?: unknown, status = 200): Promise<FixtureValue> {
    const reply = await client.request(method, path, body);
    assert.equal(reply.status, status, `${method} ${path}: ${JSON.stringify(reply.body).slice(0, 500)}`);
    return reply.body;
  }
  const owner = await signIn('owner');
  const stranger = await signIn('stranger');
  const create = async (body: FixtureValue, client = owner) => (await call(client, 'POST', '/api/contacts', body)).contact;
  const detail = async (id: string) => (await call(owner, 'GET', `/api/contacts/${id}`)).contact;
  const duplicates = async (min = 'medium', client = owner) => (await call(client, 'GET', `/api/contacts/duplicates?min=${min}`)).groups as FixtureValue[];
  const groupOf = (groups: FixtureValue[], id: string) => groups.find(group => group.members.some((member: FixtureValue) => member.id === id));
  const memberIds = (group: FixtureValue) => group.members.map((member: FixtureValue) => member.id).sort();
  const values = (contact: FixtureValue, list = 'emails') => contact[list].map((value: FixtureValue) => [value.value, value.label]);
  const versions = (...contacts: FixtureValue[]) => Object.fromEntries(contacts.map(contact => [contact.id, contact.version]));
  const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
  async function addPhoto(contactId: string, seed: string) {
    await pool.execute(`INSERT INTO contact_photos (contact_id, user_id, sha256, width, height, bytes, thumb_sha256, source) VALUES (?, ?, ?, 512, 512, 1000, ?, 'upload')`,
      [contactId, users.owner, sha(seed), sha(`${seed}-96`)]);
  }
  async function addKept(contactId: string, name: string, value: string, position = 0) {
    await pool.execute(`INSERT INTO contact_properties (id, contact_id, user_id, position, name, params, value, source_version) VALUES (?, ?, ?, ?, ?, '{"TYPE":"x"}', ?, '4.0')`,
      [crypto.randomUUID(), contactId, users.owner, position, name, value]);
  }

  // ── Detection quality through the route ──
  const anna = await create({ name: { given: 'Anna', family: 'Müller' }, organization: { name: 'Example GmbH' }, notes: 'Met at the fair',
    emails: [{ value: 'anna@example.com', label: 'work', preferred: true }, { value: 'a1@example.com', label: 'home' }, 'a2@example.com', 'a3@example.com'],
    phones: [{ value: '+49 171 1234567', label: 'mobile' }], categories: ['Clients'], is_favorite: true });
  const anna2 = await create({ name: { given: 'Anna', family: 'Müller' }, organization: { name: 'Example AG' }, birthday: '1990-04-01', notes: 'Prefers email',
    emails: ['Anna@Example.com', 'b1@example.com', 'b2@example.com', 'b3@example.com', 'b4@example.com'],
    phones: [{ value: '0171 1234567', label: '' }, { value: '+43 1 5550100', label: 'work' }], categories: ['Clients', 'Fair 2026'],
    addresses: [{ label: 'work', street: 'Ring 1', locality: 'Wien' }] });
  const swapped = await create({ name: { given: 'Smith', family: 'Jane' } });
  const jane = await create({ name: { given: 'Jane', family: 'Smith' }, organization: { name: 'Example Ltd' } });
  const office1 = await create({ name: { given: 'Carl', family: 'Office' }, emails: ['office@example.org'] });
  const office2 = await create({ name: { given: 'Dora', family: 'Desk' }, emails: ['office@example.org'] });
  const carl = await create({ name: { given: 'Carl', family: 'Clark' }, emails: ['carl@example.org'] });
  await addPhoto(anna.id, 'anna'); await addPhoto(anna2.id, 'anna2');
  await addKept(anna.id, 'X-SHARED', 'same'); await addKept(anna2.id, 'X-SHARED', 'same'); await addKept(anna2.id, 'X-ONLY-B', 'kept from b', 1);

  let groups = await duplicates('medium');
  const annaGroup = groupOf(groups, anna.id);
  assert.deepEqual([memberIds(annaGroup), annaGroup.confidence, annaGroup.auto_merge], [[anna.id, anna2.id].sort(), 'high', false]);
  assert.deepEqual(annaGroup.conflicts, ['organization', 'photo'], 'the same name, different organisation and photo');
  assert.ok(annaGroup.reasons.some((reason: FixtureValue) => reason.kind === 'email' && reason.detail.toLowerCase() === 'anna@example.com'));
  assert.ok(annaGroup.reasons.some((reason: FixtureValue) => reason.kind === 'phone'), 'phone written differently');
  const janeGroup = groupOf(groups, jane.id);
  assert.deepEqual([memberIds(janeGroup), janeGroup.confidence, janeGroup.reasons[0].kind], [[jane.id, swapped.id].sort(), 'medium', 'name_order']);
  assert.equal(groupOf(groups, office1.id).confidence, 'medium', 'a shared office address under two names');
  assert.equal(groupOf(await duplicates('high'), office1.id), undefined);
  assert.equal(groupOf(groups, carl.id), undefined);
  assert.equal((await call(owner, 'GET', '/api/contacts/duplicates?min=certain', undefined, 400)).code, 'INVALID_DUPLICATES_QUERY');

  // ── "Not the same person" ──
  await call(owner, 'POST', '/api/contacts/duplicates/dismiss', { contact_ids: [office1.id, office2.id] });
  assert.equal(groupOf(await duplicates('low'), office1.id), undefined, 'gone, also after a reload');
  await call(stranger, 'POST', '/api/contacts/duplicates/dismiss', { contact_ids: [jane.id, swapped.id] }, 404);
  await call(owner, 'POST', '/api/contacts/duplicates/dismiss', { contact_ids: [jane.id] }, 400);
  // Anna2 is "not the same person" as Carl; after the merge the survivor is.
  await call(owner, 'POST', '/api/contacts/duplicates/dismiss', { contact_ids: [anna2.id, carl.id] });

  // ── Manual merge: review, choices, stale versions ──
  const annaBefore = await detail(anna.id);
  const anna2Before = await detail(anna2.id);
  const request = { contact_ids: [anna.id, anna2.id], survivor_id: anna.id, versions: versions(anna, anna2) };
  const needsChoice = await call(owner, 'POST', '/api/contacts/merges', request, 400);
  assert.deepEqual([needsChoice.code, needsChoice.conflicts], ['CHOICE_REQUIRED', ['organization', 'photo']]);
  assert.equal((await call(owner, 'POST', '/api/contacts/merges', { ...request, choices: { organization: crypto.randomUUID() } }, 400)).code, 'INVALID_MERGE');
  assert.equal((await call(owner, 'POST', '/api/contacts/merges', { ...request, versions: { [anna.id]: 1 } }, 400)).code, 'INVALID_MERGE');
  await call(owner, 'PUT', `/api/contacts/${anna2.id}/favorite`, { is_favorite: false });
  const stale = await call(owner, 'POST', '/api/contacts/merges', { ...request, choices: { organization: anna2.id, photo: anna2.id } }, 409);
  assert.equal(stale.code, 'VERSION_CONFLICT');
  assert.deepEqual(stale.contacts.map((contact: FixtureValue) => [contact.id, contact.version]).sort(), [[anna.id, 1], [anna2.id, 2]].sort());
  assert.equal(groupOf(await duplicates('high'), anna.id).id === annaGroup.id, false, 'the group id moved with the version');
  const anna2Now = await detail(anna2.id);
  await call(stranger, 'POST', '/api/contacts/merges', { ...request, versions: versions(anna, anna2Now), choices: { organization: anna2.id, photo: anna2.id } }, 404);

  const merged = await call(owner, 'POST', '/api/contacts/merges', { ...request, versions: versions(anna, anna2Now), choices: { organization: anna2.id, photo: anna2.id } });
  const survivor = merged.contact;
  assert.deepEqual(merged.merged_ids, [anna2.id]);
  // Every value of both is kept, deduplicated by its normalised key; the survivor's first and in its places.
  assert.deepEqual(values(survivor), [['anna@example.com', 'work'], ['a1@example.com', 'home'], ['a2@example.com', ''], ['a3@example.com', ''],
    ['b1@example.com', ''], ['b2@example.com', ''], ['b3@example.com', ''], ['b4@example.com', '']]);
  // Numbers are kept as written; only the same digits count as the same value.
  assert.deepEqual(values(survivor, 'phones'), [['+49 171 1234567', 'mobile'], ['0171 1234567', ''], ['+43 1 5550100', 'work']]);
  assert.deepEqual([survivor.addresses.length, survivor.categories, survivor.organization.name, survivor.birthday, survivor.is_favorite],
    [1, ['Clients', 'Fair 2026'], 'Example AG', { year: 1990, month: 4, day: 1 }, true]);
  assert.equal(survivor.notes, 'Met at the fair\n\nPrefers email');
  assert.equal(survivor.photo.etag, sha('anna2'), 'the chosen photo');
  assert.deepEqual([survivor.email, survivor.email2, survivor.email3], ['anna@example.com', 'a1@example.com', 'a2@example.com'], 'old apps see the survivor\'s places');
  assert.deepEqual([survivor.uid, survivor.version], [anna.uid, annaBefore.version + 1]);
  const survivorDetail = await detail(anna.id);
  assert.deepEqual(survivorDetail.properties.map((property: FixtureValue) => [property.name, property.value]), [['X-SHARED', 'same'], ['X-ONLY-B', 'kept from b']]);
  await call(owner, 'GET', `/api/contacts/${anna2.id}`, undefined, 404);
  const [[alias]] = await pool.execute<RowDataPacket[]>('SELECT contact_id, merge_id FROM contact_uid_aliases WHERE user_id = ? AND uid = ?', [users.owner, anna2.uid]);
  assert.deepEqual([alias.contact_id, alias.merge_id], [anna.id, merged.merge_id], 'the merged UID now names the survivor');
  const [[bin]] = await pool.execute<RowDataPacket[]>("SELECT module, item_type, item_id, reason, group_id, title, file_refs, purge_after > UTC_TIMESTAMP() + INTERVAL 29 DAY AS later FROM bin_items WHERE user_id = ?", [users.owner]);
  assert.deepEqual([bin.module, bin.item_type, bin.item_id, bin.reason, bin.group_id, bin.title, Number(bin.later)], ['contacts', 'contact', anna2.id, 'merged', merged.merge_id, 'Anna Müller', 1]);
  assert.ok((await photosHeldForUndo(users.owner)).has(sha('anna')), 'the survivor\'s earlier photo waits for the undo window');
  // Its own photo, and the survivor's photo the merge replaced, stay for the photo sweep until the undo window ends.
  assert.deepEqual(typeof bin.file_refs === 'string' ? JSON.parse(bin.file_refs) : bin.file_refs, [sha('anna2'), sha('anna2-96'), sha('anna'), sha('anna-96')]);
  const [dismissals] = await pool.execute<RowDataPacket[]>('SELECT contact_a, contact_b FROM contact_duplicate_dismissals WHERE user_id = ? ORDER BY contact_a', [users.owner]);
  assert.ok(dismissals.some(row => [row.contact_a, row.contact_b].sort().join() === [anna.id, carl.id].sort().join()), 'Not the same person moved to the survivor');
  // The phone sees the tombstone (include=merged) and the survivor as an edit.
  const listed = await call(owner, 'GET', '/api/contacts?include=merged');
  assert.deepEqual(listed.merged.map((item: FixtureValue) => [item.id, item.into]), [[anna2.id, anna.id]]);
  // Recently merged.
  const recent = (await call(owner, 'GET', '/api/contacts/merges')).merges;
  assert.deepEqual(recent.map((merge: FixtureValue) => [merge.id, merge.survivor_id, merge.survivor_name, merge.merged, merge.undone_at]),
    [[merged.merge_id, anna.id, 'Anna Müller', [{ id: anna2.id, display_name: 'Anna Müller' }], null]]);
  assert.deepEqual((await call(stranger, 'GET', '/api/contacts/merges')).merges, []);
  await call(stranger, 'POST', `/api/contacts/merges/${merged.merge_id}/undo`, {}, 404);

  // ── Undo with an unchanged survivor: both exactly as before ──
  const undone = await call(owner, 'POST', `/api/contacts/merges/${merged.merge_id}/undo`, {});
  assert.deepEqual([undone.restored_ids, undone.survivor_restored], [[anna2.id], true]);
  const strip = (contact: FixtureValue) => ({ ...contact, version: 0, updated_at: '' });
  assert.deepEqual(await detail(anna2.id), anna2Now, 'the merged contact is back exactly: values, labels, ids, kept properties, photo, version');
  const annaAfterUndo = await detail(anna.id);
  assert.deepEqual(strip(annaAfterUndo), strip(annaBefore), 'the survivor is back as it was');
  assert.equal(annaAfterUndo.version, annaBefore.version + 2, 'as a new version');
  assert.equal((await pool.execute<RowDataPacket[]>('SELECT * FROM contact_uid_aliases WHERE user_id = ?', [users.owner]))[0].length, 0);
  const [afterUndoPairs] = await pool.execute<RowDataPacket[]>('SELECT contact_a, contact_b FROM contact_duplicate_dismissals WHERE user_id = ?', [users.owner]);
  assert.deepEqual(afterUndoPairs.map(row => [row.contact_a, row.contact_b].sort().join()).sort(),
    [[office1.id, office2.id], [anna2.id, carl.id]].map(pair => pair.sort().join()).sort(), 'the pairs are as before');
  assert.equal((await call(owner, 'POST', `/api/contacts/merges/${merged.merge_id}/undo`, {}, 409)).code, 'ALREADY_UNDONE');
  assert.equal((await call(owner, 'GET', '/api/contacts?include=merged')).merged.length, 0);
  assert.ok((await call(owner, 'GET', '/api/contacts/merges')).merges[0].undone_at);

  // ── Undo after the survivor was edited: the edit stays, nothing is lost ──
  const again = await call(owner, 'POST', '/api/contacts/merges', { contact_ids: [anna.id, anna2.id], versions: versions(annaAfterUndo, anna2Now),
    choices: { organization: anna.id, photo: anna.id } });
  const edited = (await call(owner, 'PUT', `/api/contacts/${anna.id}`, { name: { given: 'Anna', family: 'Müller' }, version: again.contact.version,
    emails: [...again.contact.emails, { value: 'new@example.com', label: 'other' }], phones: again.contact.phones })).contact;
  const undoEdited = await call(owner, 'POST', `/api/contacts/merges/${again.merge_id}/undo`, {});
  assert.deepEqual([undoEdited.restored_ids, undoEdited.survivor_restored], [[anna2.id], false]);
  assert.match(undoEdited.message, /Kept the later changes to Anna Müller/);
  const keptEdit = await detail(anna.id);
  assert.deepEqual([keptEdit.version, values(keptEdit).length], [edited.version, 9], 'the edited survivor stays as it is');
  assert.deepEqual(await detail(anna2.id), anna2Now);

  // ── Undo after a restore took the id: the copy from the bin comes back beside it ──
  const third = await call(owner, 'POST', '/api/contacts/merges', { contact_ids: [anna.id, anna2.id], versions: versions(keptEdit, anna2Now),
    choices: { organization: anna.id, photo: anna.id } });
  await pool.execute(`INSERT INTO contacts (id, user_id, uid, uid_hash, first_name, last_name, name_key) VALUES (?, ?, ?, ?, 'Restored', 'Anna', 'anna restored')`,
    [anna2.id, users.owner, anna2.uid, sha(anna2.uid)]);
  const undoTaken = await call(owner, 'POST', `/api/contacts/merges/${third.merge_id}/undo`, {});
  assert.notEqual(undoTaken.restored_ids[0], anna2.id);
  const besides = await detail(undoTaken.restored_ids[0]);
  assert.deepEqual([besides.uid, values(besides)], [`urn:uuid:${besides.id}`, values(anna2Now)], 'a new id and UID, the content as it was');
  assert.equal((await detail(anna2.id)).name.given, 'Restored');
  await call(owner, 'DELETE', `/api/contacts/${anna2.id}`);
  await call(owner, 'DELETE', `/api/contacts/${besides.id}`);

  // ── Merge all high-confidence ──
  const pair = async (given: string, extra: FixtureValue = {}) => [
    await create({ name: { given, family: 'Auto' }, emails: [`${given.toLowerCase()}@example.net`], ...extra }),
    await create({ name: { given, family: 'Auto' }, emails: [`${given.toLowerCase()}@example.net`] }),
  ];
  const [p1, p2] = await pair('Paula');
  const [q1, q2] = await pair('Quentin');
  const [r1, r2] = await pair('Rosa', { job_title: 'Chemist' });
  await call(owner, 'PUT', `/api/contacts/${r2.id}`, { name: { given: 'Rosa', family: 'Auto' }, emails: ['rosa@example.net'], job_title: 'Physicist', version: r2.version });
  const [s1, s2] = await pair('Sven');
  groups = await duplicates('medium');
  const listedIds = [p1, q1, r1, s1, jane].map(contact => groupOf(groups, contact.id).id);
  assert.deepEqual([p1, q1, r1, s1, jane].map(contact => groupOf(groups, contact.id).auto_merge), [true, true, false, true, false]);
  // Sven changed after the listing.
  await call(owner, 'PUT', `/api/contacts/${s2.id}/favorite`, { is_favorite: true });
  const auto = await call(owner, 'POST', '/api/contacts/merges/auto', { group_ids: [...listedIds, 'not-a-group'], min: 'high' });
  assert.deepEqual(auto.results.map((result: FixtureValue) => result.status), ['merged', 'merged', 'needs_choice', 'changed', 'needs_choice', 'changed']);
  for (const [first, second] of [[p1, p2], [q1, q2]]) {
    const ids = new Set((await call(owner, 'GET', '/api/contacts?q=Auto')).contacts.map((contact: FixtureValue) => contact.id));
    assert.equal(ids.has(first.id) !== ids.has(second.id), true, 'one of each merged pair is left');
  }
  assert.equal((await call(owner, 'POST', '/api/contacts/merges/auto', { group_ids: listedIds, min: 'medium' }, 400)).code, 'INVALID_MERGE');

  // ── Old apps' places: the survivor's stay, a merged value takes a free one ──
  const slots1 = await create({ name: { given: 'Olga', family: 'Slot' }, emails: ['o1@example.net', 'o2@example.net'] });
  const slots2 = await create({ name: { given: 'Olga', family: 'Slot' }, emails: ['o2@example.net', 'O1@Example.net', 'more@example.net', 'last@example.net'] });
  const slotted = (await call(owner, 'POST', '/api/contacts/merges', { contact_ids: [slots1.id, slots2.id], versions: versions(slots1, slots2) })).contact;
  assert.deepEqual(slotted.emails.map((email: FixtureValue) => email.value), ['o1@example.net', 'o2@example.net', 'more@example.net', 'last@example.net']);
  assert.deepEqual([slotted.email, slotted.email2, slotted.email3], ['o1@example.net', 'o2@example.net', 'more@example.net'], 'no place moved; one free place filled');
  const [slotRows] = await pool.execute<RowDataPacket[]>("SELECT value, legacy_slot FROM contact_values WHERE contact_id = ? AND kind = 'email' ORDER BY position", [slots1.id]);
  assert.deepEqual(slotRows.map(row => [row.value, row.legacy_slot]), [['o1@example.net', 1], ['o2@example.net', 2], ['more@example.net', 3], ['last@example.net', null]]);
  const slotUndo = await call(owner, 'POST', `/api/contacts/merges/${(await call(owner, 'GET', '/api/contacts/merges')).merges[0].id}/undo`, {});
  assert.equal(slotUndo.survivor_restored, true);
  const [restoredSlots] = await pool.execute<RowDataPacket[]>("SELECT contact_id, value, legacy_slot FROM contact_values WHERE contact_id IN (?, ?) AND kind = 'email' ORDER BY contact_id = ?, position",
    [slots1.id, slots2.id, slots2.id]);
  assert.deepEqual(restoredSlots.map(row => [row.value, row.legacy_slot]), [['o1@example.net', 1], ['o2@example.net', 2],
    ['o2@example.net', 1], ['O1@Example.net', 2], ['more@example.net', 3], ['last@example.net', null]], 'undo puts every place back');

  // ── Two merges of overlapping groups at once: one wins, nothing is lost ──
  const x = await create({ name: { given: 'Xenia', family: 'Race' }, emails: ['x1@example.net'] });
  const y = await create({ name: { given: 'Xenia', family: 'Race' }, emails: ['x2@example.net'] });
  const z = await create({ name: { given: 'Xenia', family: 'Race' }, emails: ['x3@example.net'] });
  const [left, right] = await Promise.all([
    owner.request('POST', '/api/contacts/merges', { contact_ids: [x.id, y.id], versions: versions(x, y) }),
    owner.request('POST', '/api/contacts/merges', { contact_ids: [z.id, y.id], versions: versions(z, y) }),
  ]);
  assert.deepEqual([left.status, right.status].sort(), [200, 409], JSON.stringify([left.body, right.body]).slice(0, 400));
  const race = (await call(owner, 'GET', '/api/contacts?q=Race')).contacts;
  assert.equal(race.length, 2);
  assert.deepEqual(race.flatMap((contact: FixtureValue) => contact.emails.map((email: FixtureValue) => email.value)).sort(), ['x1@example.net', 'x2@example.net', 'x3@example.net']);

  // ── Gates: the module switch and a running restore ──
  const last = (await call(owner, 'GET', '/api/contacts/merges')).merges[0];
  await call(owner, 'PUT', '/api/modules', { modules: { contacts: { enabled: false } } });
  for (const [method, path] of [['GET', '/api/contacts/duplicates'], ['GET', '/api/contacts/merges'], ['POST', '/api/contacts/merges'],
    ['POST', '/api/contacts/merges/auto'], ['POST', '/api/contacts/duplicates/dismiss'], ['POST', `/api/contacts/merges/${last.id}/undo`]]) {
    assert.equal((await call(owner, method, path, method === 'GET' ? undefined : {}, 403)).code, 'MODULE_DISABLED', `${method} ${path}`);
  }
  await call(owner, 'PUT', '/api/modules', { modules: { contacts: { enabled: true } } });
  const restoreId = crypto.randomUUID();
  await pool.execute("INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '[\"contacts\"]')", [restoreId, users.owner]);
  for (const path of ['/api/contacts/merges', '/api/contacts/merges/auto', '/api/contacts/duplicates/dismiss', `/api/contacts/merges/${last.id}/undo`]) {
    assert.equal((await call(owner, 'POST', path, {}, 409)).code, 'RESTORE_IN_PROGRESS', path);
  }
  assert.ok(Array.isArray(await duplicates('medium')), 'reading stays possible');

  // ── Purge after 30 days: skipped during a restore and with the module off, then done ──
  const later = new Date(Date.now() + 31 * 24 * 3600 * 1000);
  const [[{ binBefore }]] = await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS binBefore FROM bin_items WHERE user_id = ?', [users.owner]);
  assert.ok(Number(binBefore) >= 3);
  assert.deepEqual(await purgeExpiredMerges({ now: later }), { items: 0, merges: 0 }, 'a running restore waits');
  await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreId]);
  assert.deepEqual(await purgeExpiredMerges({ now: later, moduleEnabled: async () => false }), { items: 0, merges: 0 }, 'a paused module waits');
  assert.deepEqual(await purgeExpiredMerges(), { items: 0, merges: 0 }, 'nothing is due today');
  const purged = await purgeExpiredMerges({ now: later });
  assert.equal(purged.items, Number(binBefore));
  assert.ok(purged.merges >= 4);
  for (const table of ['bin_items', 'contact_merges']) {
    assert.equal((await pool.execute<RowDataPacket[]>(`SELECT * FROM ${table} WHERE user_id = ?`, [users.owner]))[0].length, 0, table);
  }
  const [aliases] = await pool.execute<RowDataPacket[]>('SELECT merge_id FROM contact_uid_aliases WHERE user_id = ?', [users.owner]);
  assert.ok(aliases.length >= 2 && aliases.every(row => row.merge_id === null), 'aliases stay for later imports');
  assert.equal((await call(owner, 'POST', `/api/contacts/merges/${last.id}/undo`, {}, 404)).code, 'MERGE_NOT_FOUND');
  assert.deepEqual((await call(owner, 'GET', '/api/contacts/merges')).merges, []);
  assert.equal((await photosHeldForUndo(users.owner)).size, 0);
  // The stranger's view never held any of it.
  assert.deepEqual(await duplicates('low', stranger), []);
});
