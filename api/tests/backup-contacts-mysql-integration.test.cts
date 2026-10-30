import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const sharp = require('sharp') as typeof import('sharp').default;
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// The contacts section of data schema 5 (0.26.0) through the real exporter,
// ZIP reader, validation and restore on MariaDB: the frozen 0.25.1 archive
// (fixed 3+3 fields), old-archive replace onto a richer contact, every child
// table and the photo files between two people, restoring twice, Replace
// matching, Keep both, a damaged photo file, an interrupted restore and a
// commit whose outcome is lost.
test('contacts recovery: frozen 0.25.1 archive, schema 5 round trip with photos, conflicts and interruptions', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'unihub-contacts-recovery-'));
  const saved = process.env.CONTACT_PHOTOS_ROOT;
  process.env.CONTACT_PHOTOS_ROOT = path.join(scratch, 'contact-photos');
  t.after(() => {
    if (saved === undefined) delete process.env.CONTACT_PHOTOS_ROOT; else process.env.CONTACT_PHOTOS_ROOT = saved;
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const pool = await withTestDatabase(t);
  const backup = require('../dist/src/services/backup') as typeof import('../src/services/backup');
  const { writeZip } = require('../dist/src/services/export-jobs') as typeof import('../src/services/export-jobs');
  const contacts = require('../dist/src/services/contacts') as typeof import('../src/services/contacts');
  const photos = require('../dist/src/services/contact-photos') as typeof import('../src/services/contact-photos');
  const { countRestoreConflicts } = require('../dist/src/services/backup-validate') as typeof import('../src/services/backup-validate');
  const { uuidV5 } = require('../dist/src/services/backup-formats/v5') as typeof import('../src/services/backup-formats/v5');
  const { normalizeBackupPayload } = require('../dist/src/services/backup-format') as typeof import('../src/services/backup-format');
  const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

  async function newUser(label: string) {
    const id = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)', [id, `${label}@example.test`, 'synthetic-hash', label]);
    return id;
  }
  async function rows(table: string, userId: string, order = '') {
    return (await pool.execute<RowDataPacket[]>(`SELECT * FROM ${table} WHERE user_id = ?${order}`, [userId]))[0].map(row => ({ ...row }) as FixtureValue);
  }
  async function contactState(userId: string) {
    const out: FixtureValue = {};
    for (const table of ['contacts', 'contact_values', 'contact_properties', 'contact_photos', 'contact_uid_aliases', 'contact_duplicate_dismissals']) out[table] = await rows(table, userId);
    out.files = fs.existsSync(path.join(process.env.CONTACT_PHOTOS_ROOT!, userId)) ? fs.readdirSync(path.join(process.env.CONTACT_PHOTOS_ROOT!, userId)).sort() : [];
    return out;
  }
  const valuesOf = async (contactId: string, kind: string) => (await pool.execute<RowDataPacket[]>(
    'SELECT * FROM contact_values WHERE contact_id = ? AND kind = ? ORDER BY position', [contactId, kind]))[0];
  const picture = (background: string) => sharp({ create: { width: 64, height: 48, channels: 3, background } }).png().toBuffer();
  type Parsed = Awaited<ReturnType<typeof backup.backupFromZipFile>>;
  const restore = (userId: string, parsed: Parsed, conflictMode: string, extra: FixtureValue = {}) => backup.importBackupForUser(userId, parsed.backup,
    { mode: 'apply', conflict_mode: conflictMode, fileSourcesByPath: parsed.fileSourcesByPath, ...extra });

  // ── 1. The frozen 0.25.1 archive: 3+3 fields become values ────────────
  const fixture = path.join(__dirname, 'fixtures/backups/v4-0.25.1');
  const expected = JSON.parse(fs.readFileSync(path.join(fixture, 'expected.json'), 'utf8'));
  assert.equal(sha256(fs.readFileSync(path.join(fixture, 'plain.zip'))), expected.sha256, 'The frozen archive is unchanged');
  const v4 = await backup.backupFromZipFile(path.join(fixture, 'plain.zip'));
  assert.equal(v4.backup.version, 4);
  const reader = await newUser('v4-reader');
  const first = await restore(reader, v4, 'replace');
  assert.equal(first.valid, true, (first as FixtureValue).errors?.join('\n'));
  const slots = (contact: FixtureValue, kind: string) => [1, 2, 3].map(n => contact[n === 1 ? kind : `${kind}${n}`]).filter((value: unknown) => typeof value === 'string' && value.trim() !== '');
  async function assertV4(userId: string) {
    const restored = await rows('contacts', userId);
    assert.equal(restored.length, expected.contacts.length);
    for (const source of expected.contacts) {
      const contact = restored.find((row: FixtureValue) => row.uid === `urn:uuid:${source.id}`);
      assert.ok(contact, `${source.first_name}: restored with the uid upgrade 22 gives it`);
      assert.notEqual(contact.id, source.id, 'An archive id is never reused for a new row');
      for (const field of ['first_name', 'last_name', 'company', 'job_title']) assert.equal(contact[field], source[field], `${source.first_name}.${field}`);
      assert.equal(contact.notes, source.notes || null);
      assert.equal(contact.is_favorite, source.is_favorite);
      for (const kind of ['email', 'phone']) {
        const values = await valuesOf(contact.id, kind);
        // Verbatim, in slot order, blanks dropped, repeats kept, no label: as upgrade 22 copies them.
        assert.deepEqual(values.map(value => value.value), slots(source, kind), `${source.first_name} ${kind}s`);
        assert.deepEqual(values.map(value => value.position), values.map((_, index) => index));
        assert.ok(values.every(value => value.label === ''));
      }
    }
    // Old apps see the values in the three places as an upgraded database
    // shows them (the projection hides a repeated value).
    const once = (kind: string, values: string[]) => values.filter((value, index) => values.findIndex(other =>
      kind === 'email' ? other.trim().toLowerCase() === value.trim().toLowerCase() : other.replace(/[^+\d]/g, '') === value.replace(/[^+\d]/g, '')) === index);
    for (const listed of (await contacts.listContacts(userId, {})).contacts as FixtureValue[]) {
      const source = expected.contacts.find((row: FixtureValue) => `urn:uuid:${row.id}` === listed.uid);
      assert.deepEqual([listed.email, listed.email2, listed.email3].filter(Boolean), once('email', slots(source, 'email')));
      assert.deepEqual([listed.phone, listed.phone2, listed.phone3].filter(Boolean), once('phone', slots(source, 'phone')));
    }
  }
  await assertV4(reader);
  const once = await contactState(reader);
  // Restoring twice equals restoring once, whichever way a match is resolved.
  assert.equal(((await countRestoreConflicts(reader, normalizeBackupPayload(structuredClone(v4.backup)))) as FixtureValue).contacts, expected.contacts.length);
  assert.equal((await restore(reader, v4, 'replace')).valid, true);
  await assertV4(reader);
  assert.equal((await rows('contact_values', reader)).length, once.contact_values.length);
  assert.equal((await restore(reader, v4, 'keep_existing')).valid, true);
  assert.deepEqual((await rows('contacts', reader)).map((row: FixtureValue) => row.version).sort(), (await rows('contacts', reader)).map(() => 2), 'keep_existing writes nothing');
  // The conversion is deterministic: the same archive converts to the same rows.
  const converted = (archive: Parsed) => normalizeBackupPayload(structuredClone(archive.backup)).data.contact_values as FixtureValue[];
  assert.deepEqual(converted(v4), converted(v4));
  assert.equal(converted(v4)[0].id, uuidV5(`${expected.contacts[0].id}\nemail\n0`));
  assert.ok(converted(v4).every(row => [1, 2, 3].includes(row.legacy_slot) && row.legacy_slot === row.position + 1));

  // ── 2. An old archive replaces only what it carried ──────────────────
  const richer = await newUser('v4-richer');
  const created = await contacts.createContact(richer, {
    name: { given: 'Full', family: 'Example', middle: 'Middle', display: 'Dr. Full Example' }, organization: { name: 'Old Ltd', department: 'Research' },
    job_title: 'Former', birthday: '--04-01',
    emails: [{ value: 'a@example.net', label: 'work' }, 'B@Example.net', 'c@example.net', { value: 'd@example.net', label: 'home' }, 'e@example.net'],
    addresses: [{ street: 'Beispielgasse 1', locality: 'Wien', label: 'home' }], urls: ['https://example.net/full'],
  }) as FixtureValue;
  await pool.execute("INSERT INTO contact_properties (id, contact_id, user_id, position, name, value, source_version) VALUES (?, ?, ?, 0, 'X-KEPT', 'stays', '4.0')", [crypto.randomUUID(), created.id, richer]);
  const richerPhoto = await photos.setContactPhoto(richer, created.id, await picture('#204080'));
  assert.equal((await restore(richer, v4, 'replace')).valid, true);
  const [after] = (await pool.execute<RowDataPacket[]>('SELECT * FROM contacts WHERE id = ?', [created.id]))[0];
  assert.equal(after.job_title, 'Tester', 'The archive replaces what it carried');
  assert.equal(after.company, 'Example Ltd');
  assert.equal(after.uid, created.uid, 'A matched contact keeps its own uid');
  assert.equal(after.middle_name, 'Middle'); assert.equal(after.department, 'Research'); assert.equal(after.birthday, '--04-01');
  const emails = await valuesOf(created.id, 'email');
  assert.deepEqual(emails.map(value => value.value), ['a@example.net', 'B@Example.net', 'c@example.net', 'd@example.net', 'e@example.net'], 'Values beyond the three places stay');
  assert.equal(emails[0].label, 'work'); assert.equal(emails[3].label, 'home');
  assert.deepEqual((await valuesOf(created.id, 'phone')).map(value => value.value), ['+1 555 0100', '0664 555 0101', '(555) 0102']);
  assert.equal((await valuesOf(created.id, 'address')).length, 1); assert.equal((await valuesOf(created.id, 'url')).length, 1);
  assert.equal((await rows('contact_properties', richer)).length, 1);
  assert.equal((await rows('contact_photos', richer))[0].sha256, richerPhoto.etag, 'The photo an old archive never had stays');

  // ── 3. Schema 5 between two people, with every child table and photos ─
  const owner = await newUser('v5-owner');
  const ann = await contacts.createContact(owner, {
    name: { given: 'Ann', family: 'Ørsted', prefix: 'Dr.' }, organization: { name: 'Example GmbH' }, birthday: '1980-02-29', notes: 'Grüße\nzweite Zeile',
    emails: [{ value: 'ann@example.test', label: 'work', preferred: true }, { value: 'ann.home@example.test', label: 'custom', custom_label: 'Lake house' }],
    phones: [{ value: '+43 660 1234567', label: 'mobile' }], addresses: [{ street: 'Hauptplatz 2', postal_code: '8010', locality: 'Graz', country: 'Austria', label: 'work' }],
    urls: ['https://example.test/ann'], nicknames: ['Annie'], categories: ['Friends'],
  }) as FixtureValue;
  const bea = await contacts.createContact(owner, { name: { given: 'Bea' }, emails: ['bea@example.test'] }) as FixtureValue;
  await pool.execute("INSERT INTO contact_properties (id, contact_id, user_id, position, vcard_group, name, params, value, source_version) VALUES (?, ?, ?, 0, 'item1', 'X-ABLABEL', ?, 'Lake', '3.0')",
    [crypto.randomUUID(), ann.id, owner, JSON.stringify({ type: ['pref'] })]);
  const annPhoto = await photos.setContactPhoto(owner, ann.id, await picture('#cc3355'));
  await photos.setContactPhoto(owner, bea.id, await picture('#cc3355'));
  await pool.execute('INSERT INTO contact_uid_aliases (user_id, uid_hash, uid, contact_id) VALUES (?, ?, ?, ?)', [owner, sha256(Buffer.from('urn:uuid:merged-away')), 'urn:uuid:merged-away', ann.id]);
  await pool.execute('INSERT INTO contact_duplicate_dismissals (contact_a, contact_b, user_id) VALUES (?, ?, ?)', [ann.id < bea.id ? ann.id : bea.id, ann.id < bea.id ? bea.id : ann.id, owner]);
  const ownerBefore = await contactState(owner);
  const zip = path.join(scratch, 'v5.zip');
  await writeZip(await backup.buildBackupArchiveEntriesForUser(owner, 'contacts'), zip);
  const v5 = await backup.backupFromZipFile(zip);
  assert.equal(v5.backup.version, 5);
  // One pair of files although two contacts share the picture.
  assert.deepEqual(v5.backup.files.map((file: FixtureValue) => file.id).sort(), [annPhoto.etag, (await rows('contact_photos', owner))[0].thumb_sha256].sort());
  assert.ok(v5.backup.files.every((file: FixtureValue) => file.kind === 'contact_photo' && file.sha256 === file.id));

  const reader5 = await newUser('v5-reader');
  const restored = await restore(reader5, v5, 'replace');
  assert.equal(restored.valid, true, (restored as FixtureValue).errors?.join('\n'));
  assert.deepEqual(await contactState(owner), ownerBefore, 'The source person is untouched');
  const state = await contactState(reader5);
  for (const table of ['contacts', 'contact_values', 'contact_properties', 'contact_photos', 'contact_uid_aliases', 'contact_duplicate_dismissals']) {
    assert.equal(state[table].length, ownerBefore[table].length, `${table}: every row`);
    assert.ok(state[table].every((row: FixtureValue) => row.user_id === reader5), `${table}: owned by the restoring person`);
  }
  const ids = new Set(state.contacts.map((row: FixtureValue) => row.id));
  assert.ok(!state.contacts.some((row: FixtureValue) => row.id === ann.id || row.id === bea.id), 'New ids for another person');
  assert.ok(['contact_values', 'contact_properties', 'contact_photos', 'contact_uid_aliases'].every(table => state[table].every((row: FixtureValue) => ids.has(row.contact_id))));
  assert.ok(state.contact_duplicate_dismissals.every((row: FixtureValue) => ids.has(row.contact_a) && ids.has(row.contact_b)));
  assert.deepEqual(state.files, ownerBefore.files, 'The same photo files, in this person\'s directory');
  const restoredAnn = (await contacts.loadContacts(pool, reader5, state.contacts.filter((row: FixtureValue) => row.first_name === 'Ann').map((row: FixtureValue) => row.id)))[0] as FixtureValue;
  const sourceAnn = (await contacts.loadContacts(pool, owner, [ann.id]))[0] as FixtureValue;
  const comparable = (contact: FixtureValue) => {
    const { id, version, created_at, updated_at, ...rest } = contact;
    return JSON.parse(JSON.stringify(rest, (key, value) => key === 'id' ? undefined : value));
  };
  assert.deepEqual(comparable(restoredAnn), comparable(sourceAnn), 'The whole contact: names, labelled values, dates, kept properties and photo');
  assert.ok(state.contact_photos.every((row: FixtureValue) => row.source === 'restore'));
  assert.equal(restored.restored_files, 2);

  // Restoring twice equals restoring once.
  assert.equal(((await countRestoreConflicts(reader5, normalizeBackupPayload(structuredClone(v5.backup)))) as FixtureValue).contacts, 2);
  assert.equal((await restore(reader5, v5, 'replace')).valid, true);
  const twice = await contactState(reader5);
  for (const table of ['contacts', 'contact_values', 'contact_properties', 'contact_photos', 'contact_uid_aliases', 'contact_duplicate_dismissals']) assert.equal(twice[table].length, state[table].length, `${table} after a second restore`);
  assert.deepEqual(twice.files, state.files);
  // A person replacing from their own archive keeps their value ids.
  assert.equal((await restore(owner, v5, 'replace')).valid, true);
  assert.deepEqual((await rows('contact_values', owner)).map((row: FixtureValue) => row.id).sort(), ownerBefore.contact_values.map((row: FixtureValue) => row.id).sort());

  // Replace matching: the archive's state wins, children and photo included,
  // and the photo file it replaced is released after the commit.
  const restoredAnnId = restoredAnn.id;
  const changed = await contacts.updateContact(reader5, restoredAnnId, { version: (await rows('contacts', reader5)).find((row: FixtureValue) => row.id === restoredAnnId).version,
    name: { given: 'Ann', family: 'Changed' }, emails: ['other@example.test'] }, null) as FixtureValue;
  assert.equal(changed.name.family, 'Changed');
  const newer = await photos.setContactPhoto(reader5, restoredAnnId, await picture('#11aa44'));
  assert.ok(fs.existsSync(photos.photoPath(reader5, newer.etag)));
  assert.equal((await restore(reader5, v5, 'replace')).valid, true);
  assert.deepEqual(comparable((await contacts.loadContacts(pool, reader5, [restoredAnnId]))[0]), comparable(sourceAnn));
  assert.equal(fs.existsSync(photos.photoPath(reader5, newer.etag)), false, 'The replaced photo file is gone');
  assert.deepEqual((await contactState(reader5)).files, state.files);

  // Keep both: a second copy with new ids and uids; both share the files.
  assert.equal((await restore(reader5, v5, 'keep_both')).valid, true);
  const both = await contactState(reader5);
  assert.equal(both.contacts.length, 4);
  assert.equal(new Set(both.contacts.map((row: FixtureValue) => row.uid)).size, 4);
  assert.equal(both.contact_values.length, state.contact_values.length * 2);
  assert.equal(new Set(both.contact_values.map((row: FixtureValue) => row.id)).size, both.contact_values.length);
  assert.equal(both.contact_photos.length, 4);
  assert.equal(both.contact_duplicate_dismissals.length, 2);
  assert.deepEqual(both.files, state.files);

  // ── 4. A damaged or misnamed photo file stops the restore before writes ─
  const careful = await newUser('v5-careful');
  const fullFile = v5.backup.files.find((file: FixtureValue) => file.id === annPhoto.etag) as FixtureValue;
  const damaged = new Map(v5.fileSourcesByPath);
  damaged.set(fullFile.archive_path, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  const refused = await backup.importBackupForUser(careful, v5.backup, { mode: 'apply', conflict_mode: 'replace', fileSourcesByPath: damaged });
  assert.equal(refused.valid, false);
  assert.match((refused as FixtureValue).errors.join('\n'), new RegExp(`Checksum mismatch for file contact_photo:${annPhoto.etag}`));
  const misnamed = structuredClone(v5.backup);
  (misnamed.files as FixtureValue[]).find(file => file.id === annPhoto.etag).sha256 = sha256(Buffer.from('other'));
  const refusedName = await backup.importBackupForUser(careful, misnamed, { mode: 'apply', conflict_mode: 'replace', fileSourcesByPath: v5.fileSourcesByPath });
  assert.match((refusedName as FixtureValue).errors.join('\n'), /does not match its name/);
  const empty = await contactState(careful);
  assert.deepEqual([empty.contacts.length, empty.contact_photos.length, empty.files.length], [0, 0, 0], 'Nothing is written for a refused archive');

  // ── 5. Interrupted: files staged, then the restore stops before commit ─
  const interrupted = await newUser('v5-interrupted');
  await assert.rejects(restore(interrupted, v5, 'replace', { onProgress: async (phase: string) => { if (phase === 'contacts') throw new Error('stopped by the test'); } }), /stopped by the test/);
  const stopped = await contactState(interrupted);
  assert.deepEqual([stopped.contacts.length, stopped.contact_photos.length, stopped.files.length], [0, 0, 0], 'A known rollback leaves no photo file behind');
  // A photo file the person already had is never removed by a failed restore.
  const kept = await contacts.createContact(interrupted, { name: { given: 'Own' } }) as FixtureValue;
  const own = await photos.setContactPhoto(interrupted, kept.id, await picture('#cc3355'));
  assert.equal(own.etag, annPhoto.etag, 'Same picture, same file');
  await assert.rejects(restore(interrupted, v5, 'replace', { onProgress: async (phase: string) => { if (phase === 'contacts') throw new Error('stopped again'); } }), /stopped again/);
  assert.ok(fs.existsSync(photos.photoPath(interrupted, own.etag)));

  // ── 6. A lost commit response keeps every staged file ──────────────────
  const uncertain = await newUser('v5-uncertain');
  const lost = await restore(uncertain, v5, 'replace', {
    beforeCommit: async (connection: FixtureValue) => {
      const commit = connection.commit.bind(connection);
      connection.commit = async () => { await commit(); throw new Error('commit response lost'); };
    },
  }).then(() => null, (error: FixtureValue) => error);
  assert.equal(lost?.backupCommitUncertain, true);
  const committed = await contactState(uncertain);
  assert.equal(committed.contact_photos.length, 2, 'The commit did happen');
  for (const row of committed.contact_photos) for (const sha of [row.sha256, row.thumb_sha256]) assert.ok(fs.existsSync(photos.photoPath(uncertain, sha)), 'Its files are still there');
});
