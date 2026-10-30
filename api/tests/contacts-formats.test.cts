import type { ContactRecord } from '../src/contracts/contacts';
import type { ImportedCard } from '../src/services/contacts-vcard-map';
import type { ExportContact } from '../src/services/contacts-vcard-write';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const { parseContactsFile } = require('../dist/src/services/contacts-import') as typeof import('../src/services/contacts-import');
const { readVCards, IMPORT_LIMITS } = require('../dist/src/services/contacts-vcard-read') as typeof import('../src/services/contacts-vcard-read');
const { writeVCards } = require('../dist/src/services/contacts-vcard-write') as typeof import('../src/services/contacts-vcard-write');
const { writeGoogleCsv, writeOutlookCsv, parseCsv } = require('../dist/src/services/contacts-csv') as typeof import('../src/services/contacts-csv');
const { displayName } = require('../dist/src/services/contacts') as typeof import('../src/services/contacts');

// The vCard and CSV formats (D6) with synthetic fixtures: what each reader
// takes from real-world shapes, that a 4.0 export reads back to the same
// contact (every value, label, parameter and kept property), that 3.0 and the
// CSV exports read back, and that hostile input stays bounded.
const FIXTURES = path.join(__dirname, 'fixtures', 'contacts');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));
const parse = (bytes: Buffer) => parseContactsFile(bytes);

// A card as the store would answer it (ids for values; params and groups as the export reads them).
function asExport(card: ImportedCard, at: number): ExportContact {
  const id = `00000000-0000-4000-8000-${String(at).padStart(12, '0')}`;
  const draft = card.draft;
  const values = draft.values.map((value, index) => ({ ...value, id: `${id}-${index}` }));
  const of = (kind: string) => values.filter(value => value.kind === kind).map(value => ({ id: value.id, value: value.value, label: value.label, custom_label: value.custom_label,
    preferred: value.preferred, ...(kind === 'address' ? { po_box: value.po_box ?? null, extended: value.extended ?? null, street: value.street ?? null, locality: value.locality ?? null,
      region: value.region ?? null, postal_code: value.postal_code ?? null, country: value.country ?? null } : {}) }));
  const date = (stored: string | null) => { const m = stored ? /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(stored) : null; return m ? { year: m[1] ? Number(m[1]) : null, month: Number(m[2]), day: Number(m[3]) } : null; };
  const contact = {
    id, uid: card.uid || `urn:uuid:${id}`, version: 1, display_name: displayName(draft, draft.values),
    name: { display: draft.display_name, given: draft.first_name || null, family: draft.last_name, middle: draft.middle_name, prefix: draft.name_prefix, suffix: draft.name_suffix },
    organization: { name: draft.company, department: draft.department }, job_title: draft.job_title, birthday: date(draft.birthday), anniversary: date(draft.anniversary),
    notes: draft.notes, is_favorite: !!draft.is_favorite, emails: of('email'), phones: of('phone'), addresses: of('address'), urls: of('url'), impp: of('impp'),
    related: of('related'), nicknames: of('nickname'), categories: values.filter(value => value.kind === 'category').map(value => value.value), photo: null,
    kept_properties: card.properties.length, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
  } as unknown as ContactRecord;
  return { contact, extras: new Map(values.filter(value => value.params || value.vcard_group).map(value => [value.id, { params: (value.params ?? null) as Record<string, string[]> | null, group: value.vcard_group ?? null }])),
    properties: card.properties,
    // The photo service's stored picture stands in for the card's photo (the conversion is contact-photos.ts').
    photo: card.photo ? { data: Buffer.from(card.photo.data, 'base64'), media_type: card.photo.media_type || 'image/jpeg' } : null };
}

// What must survive: every field, every value with label, preference, parameters and group, every kept property.
function meaning(card: ImportedCard) {
  const { values, ...fields } = card.draft;
  return {
    uid: card.uid, fields,
    values: values.map(value => ({ kind: value.kind, value: value.value, label: value.label, custom_label: value.custom_label, preferred: value.preferred,
      params: value.params ?? null, group: value.vcard_group?.toLowerCase() ?? null, parts: value.kind === 'address' ? [value.po_box, value.extended, value.street, value.locality, value.region, value.postal_code, value.country] : null })),
    kept: card.properties.map(property => ({ name: property.name.toUpperCase(), group: property.group?.toLowerCase() ?? null, params: property.params ?? null, value: property.value,
      field: property.source_version === 'field' })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    photo: card.photo ? [card.photo.media_type, Buffer.from(card.photo.data, 'base64').toString('hex')] : null,
  };
}

test('vCard 4.0: every field, labelled value and parameter is read, and an export reads back to the same contact', () => {
  const first = parse(fixture('vcard40.vcf'));
  assert.equal(first.format, 'vcard4');
  assert.deepEqual(first.warnings, []);
  const [card, organisation] = first.cards;
  assert.equal(card.uid, 'urn:uuid:6f1d2a3c-0000-4000-8000-000000000001');
  assert.deepEqual([card.draft.display_name, card.draft.first_name, card.draft.last_name, card.draft.middle_name, card.draft.name_prefix, card.draft.name_suffix],
    ['Dr. Jürgen Müller', 'Jürgen', 'Müller', 'Karl,Otto', 'Dr.', 'Jr.']);
  assert.deepEqual([card.draft.company, card.draft.department, card.draft.job_title, card.draft.birthday, card.draft.anniversary],
    ['Example GmbH', 'Research', 'Chemist', '--03-15', '2010-06-15']);
  assert.equal(card.draft.notes, 'First line\nSecond, with comma; and semicolon');
  const value = (kind: string, text: string) => card.draft.values.find(item => item.kind === kind && item.value === text)!;
  assert.deepEqual([value('phone', '+49-171-5550001').label, value('phone', '+49-171-5550001').preferred, value('phone', '+49-171-5550001').params], ['mobile', true, { TYPE: ['voice'] }],
    'a tel: URI is read as the number; voice stays as a parameter');
  assert.equal(value('phone', '+49 40 5550002').label, 'work_fax');
  assert.equal(value('phone', '+49 40 5550003').label, 'company_main');
  assert.deepEqual([value('phone', '+49 171 5550004').label, value('phone', '+49 171 5550004').custom_label, value('phone', '+49 171 5550004').vcard_group], ['custom', 'Kids phone', 'item1']);
  assert.deepEqual(value('email', 'juergen@example.com').params, { PREF: ['2'], PID: ['1.1'] }, 'a PREF rank other than 1 and PID are kept');
  assert.deepEqual(value('address', 'Hauptstraße 1\n10115 Berlin\nGermany').params, { LABEL: ['Hauptstraße 1\n10115 Berlin'] }, 'RFC 6868 ^n in a parameter');
  assert.equal(value('address', 'PO 7\nBuilding B\nWerkweg 2, Hof\n20095 Hamburg\nHH\nGermany').street, 'Werkweg 2, Hof');
  assert.deepEqual(['Anna Müller', 'Erika Müller'].map(name => value('related', name).label), ['spouse', 'mother']);
  assert.deepEqual(card.draft.values.filter(item => item.kind === 'category').map(item => item.value), ['Family', 'Climbing, indoor']);
  assert.deepEqual(card.draft.values.filter(item => item.kind === 'nickname').map(item => [item.value, item.label]), [['Jüm', 'maiden_name'], ['Jay', 'maiden_name']]);
  assert.equal(value('url', 'https://blog.example.org/').label, 'blog');
  const keptNames = card.properties.map(property => property.name);
  for (const name of ['FN', 'N', 'ORG', 'KIND', 'GENDER', 'LANG', 'ROLE', 'GEO', 'TZ', 'KEY', 'X-FOO', 'X-ABDATE', 'X-ABLABEL', 'CLIENTPIDMAP']) assert.ok(keptNames.includes(name), `${name} is kept`);
  assert.ok(!keptNames.includes('PHOTO') && card.photo?.media_type === 'image/jpeg', 'the inline photo goes to the photo service');
  for (const name of ['REV', 'PRODID', 'VERSION', 'UID']) assert.ok(!keptNames.includes(name), `${name} is written from the contact`);
  assert.equal(card.properties.find(property => property.name === 'ORG')!.source_version, 'field', 'the third ORG unit keeps a shadow of ORG');
  assert.equal(organisation.draft.display_name, null, 'an FN equal to what the fields give is not stored');

  const exported = writeVCards(first.cards.map(asExport), '4.0');
  assert.match(exported, /^BEGIN:VCARD\r\nVERSION:4\.0\r\n/);
  assert.ok(exported.split('\r\n').every(line => Buffer.byteLength(line) <= 75), 'lines are folded at 75 octets');
  assert.match(exported, /\r\nitem1\.X-ABLabel:Kids phone\r\n/);
  assert.match(exported, /\r\nPHOTO:data:image\/jpeg;base64,/);
  const again = parse(Buffer.from(exported, 'utf8'));
  assert.deepEqual(again.warnings, []);
  // A card without a UID gets the store's urn:uuid:<id>, which the export writes.
  const expected = first.cards.map((card, at) => meaning({ ...card, uid: card.uid ?? asExport(card, at).contact.uid }));
  assert.deepEqual(again.cards.map(meaning), expected, 'import → export 4.0 → import keeps every value, label, parameter and kept property');
  // And once more: the export of the re-import is the same file.
  assert.equal(writeVCards(again.cards.map(asExport), '4.0'), exported);
});

test('vCard 4.0 export: an edited field is written from the contact and its old copy is not brought back', () => {
  const [card] = parse(fixture('vcard40.vcf')).cards;
  const entry = asExport(card, 1);
  const contact = entry.contact as ContactRecord & { job_title: string | null };
  Object.assign(contact, { organization: { name: 'Other AG', department: null }, job_title: null, anniversary: null, impp: [] });
  const text = writeVCards([entry], '4.0');
  assert.match(text, /\r\nORG:Other AG\r\n/);
  assert.doesNotMatch(text, /Example GmbH|Lab 3/, 'the ORG shadow of the old value is dropped');
  assert.doesNotMatch(text, /\r\nTITLE/);
  assert.match(text, /\r\nFN;LANGUAGE=de:Dr\. Jürgen Müller\r\n/, 'an unchanged field keeps its parameters');
});

test('vCard 3.0 as Apple writes it: groups, X-ABLabel, year-less birthday, related names, photo; a 3.0 export reads back', () => {
  const read = parse(fixture('vcard30-apple.vcf'));
  assert.equal(read.format, 'vcard3');
  const [card] = read.cards;
  const byValue = Object.fromEntries(card.draft.values.map(item => [item.value, item]));
  assert.deepEqual([byValue['bea@example.com'].label, byValue['bea@example.com'].preferred, byValue['bea@example.com'].params], ['other', true, null], 'INTERNET is noise; pref is the preference');
  assert.deepEqual([byValue['+43 1 5550101'].label, byValue['+43 1 5550101'].custom_label], ['custom', 'Kids']);
  assert.equal(byValue['Carla Beispiel'].label, 'mother');
  assert.equal(byValue['https://bea.example.com'].label, 'homepage');
  assert.equal(byValue['xmpp:bea@example.org'].kind, 'impp', 'X-JABBER is read as IMPP');
  assert.deepEqual([card.draft.birthday, card.draft.anniversary], ['--07-04', '2015-09-12'], 'X-APPLE-OMIT-YEAR and an X-ABDATE anniversary');
  assert.ok(!card.properties.some(property => property.name === 'PHOTO'));
  assert.deepEqual([card.photo!.media_type, Buffer.from(card.photo!.data, 'base64').subarray(0, 2)], ['image/jpeg', Buffer.from([0xff, 0xd8])], 'the inline photo goes to the photo service');
  assert.ok(card.properties.some(property => property.name === 'X-ABADR' && property.group === 'item3'), 'a group partner stays with its group');

  for (const version of ['3.0', '4.0'] as const) {
    const text = writeVCards([asExport(card, 1)], version);
    const back = parse(Buffer.from(text, 'utf8')).cards[0];
    const simple = (c: ImportedCard) => c.draft.values.map(item => [item.kind, item.value, item.label, item.custom_label, item.preferred]).sort();
    assert.deepEqual(simple(back), simple(card), `${version} export reads back with every value and label`);
    assert.deepEqual([back.draft.birthday, back.draft.anniversary], ['--07-04', '2015-09-12']);
    if (version === '3.0') {
      assert.match(text, /\r\nBDAY;X-APPLE-OMIT-YEAR=1604:1604-07-04\r\n/);
      assert.match(text, /\r\nPHOTO;ENCODING=b;TYPE=JPEG:/);
      assert.match(text, /X-ABRELATEDNAMES:Carla Beispiel\r\nitem\d+\.X-ABLabel:_\$!<Mother>!\$_|item4\.X-ABRELATEDNAMES:Carla Beispiel\r\nitem4\.X-ABLabel:_\$!<Mother>!\$_/);
      assert.match(text, /\r\nX-ANNIVERSARY:2015-09-12\r\n/);
      assert.match(text, /TEL;TYPE=cell,VOICE,pref:/);
    }
  }
});

test('vCard 2.1: quoted-printable UTF-8 and ISO-8859-1, soft breaks, bare types, Android labels and a BASE64 block', () => {
  const read = parse(fixture('vcard21-android.vcf'));
  assert.equal(read.format, 'vcard21');
  assert.deepEqual(read.warnings, []);
  const [android, latin] = read.cards;
  assert.deepEqual([android.draft.first_name, android.draft.last_name], ['Jürgen', 'Müller'], 'no mojibake');
  assert.equal(android.draft.notes, 'Grüße aus\nBerlin, äöü', 'a soft line break joins; =0D=0A is a line break');
  const phones = android.draft.values.filter(item => item.kind === 'phone').map(item => [item.value, item.label, item.custom_label, item.preferred]);
  assert.deepEqual(phones, [['+49 171 5550200', 'mobile', null, true], ['+49 30 5550201', 'home', null, false], ['+49 30 5550202', 'custom', 'Büro', false]]);
  assert.equal(android.draft.anniversary, '2012-05-01', 'an Android anniversary event');
  assert.ok(Buffer.from(android.photo!.data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'the unindented BASE64 block is read whole');
  assert.deepEqual([latin.draft.first_name, latin.draft.last_name, latin.draft.company], ['Änne', 'Schön', 'Fürst AG'], 'CHARSET=ISO-8859-1 per property');
});

test('encodings: a UTF-16 file with a BOM and a windows-1252 file without one read the same as UTF-8', () => {
  const text = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Größer;Jörg;;;\r\nFN:Jörg Größer\r\nEMAIL:joerg@example.com\r\nEND:VCARD\r\n';
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const utf16be = Buffer.from(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]));
  const cp1252 = Buffer.from(text, 'latin1');
  const utf8bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  for (const [name, bytes] of [['UTF-16LE', utf16le], ['UTF-16BE', utf16be], ['windows-1252', cp1252], ['UTF-8 BOM', utf8bom]] as const) {
    const [card] = parse(bytes).cards;
    assert.deepEqual([card.draft.first_name, card.draft.last_name], ['Jörg', 'Größer'], name);
  }
  assert.equal(readVCards(cp1252).encoding, 'windows-1252');
  // The character sets the importer relies on are known to this Node (full ICU).
  for (const label of ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252', 'iso-8859-1', 'iso-8859-2', 'iso-8859-15', 'shift_jis', 'gb18030', 'big5', 'euc-kr', 'koi8-r']) {
    assert.doesNotThrow(() => new TextDecoder(label), label);
  }
});

test('malformed vCards cost a line or a card with a warning that names no value', () => {
  const read = parse(fixture('malformed.vcf'));
  assert.deepEqual(read.cards.map(card => card.number), [1, 3]);
  assert.deepEqual(read.warnings.map(warning => [warning.card, warning.code]),
    [[1, 'LINE_UNREADABLE'], [1, 'LINE_UNREADABLE'], [1, 'UNKNOWN_CHARSET'], [3, 'CARD_NOT_CLOSED'], [2, 'CARD_EMPTY']]);
  assert.equal(read.cards[0].draft.notes, 'still read');
  for (const warning of read.warnings) assert.doesNotMatch(warning.message, /Broken|broken@|still read|nothing shown/, 'warnings never quote a value');
});

test('bounds: file size, card count, an over-long line, many properties and a regex-hostile value', () => {
  assert.throws(() => readVCards(Buffer.alloc(IMPORT_LIMITS.fileBytes + 1, 0x20)), { code: 'IMPORT_TOO_LARGE' });
  const many = Buffer.from('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:x\r\nEND:VCARD\r\n'.repeat(IMPORT_LIMITS.cards + 1));
  assert.throws(() => readVCards(many), { code: 'IMPORT_TOO_MANY_CARDS' });
  const long = Buffer.from(`BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Long\r\nNOTE:${'x'.repeat(2 * 1024 * 1024)}\r\nEMAIL:long@example.com\r\nEND:VCARD\r\n`);
  const longRead = parse(long);
  assert.deepEqual(longRead.warnings.map(warning => [warning.card, warning.property, warning.code]), [[1, 'NOTE', 'LINE_TOO_LONG']]);
  assert.equal(longRead.cards[0].draft.values[0].value, 'long@example.com', 'the card keeps everything else');
  // A long line folded into many short ones counts unfolded.
  const folded = Buffer.from(`BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Folded\r\nNOTE:${Array(30000).fill('y'.repeat(70)).join('\r\n ')}\r\nEND:VCARD\r\n`);
  assert.equal(parse(folded).warnings[0].code, 'LINE_TOO_LONG');
  const properties = Buffer.from(`BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Many\r\n${Array.from({ length: 600 }, (_, at) => `X-P${at}:v`).join('\r\n')}\r\nEND:VCARD\r\n`);
  const propertyRead = parse(properties);
  assert.equal(propertyRead.warnings[0].code, 'TOO_MANY_PROPERTIES');
  assert.ok(propertyRead.cards[0].properties.length <= 500);
  // Patterns that make a backtracking regular expression take exponential time.
  const hostile = Buffer.from(`BEGIN:VCARD\r\nVERSION:4.0\r\nFN:${'\\'.repeat(50000)}a\r\nN:${';'.repeat(50000)}\r\nADR:${'\\;'.repeat(20000)}\r\nBDAY:${'1'.repeat(50000)}\r\nEMAIL;TYPE="${'"'.repeat(1000)}:${'a,'.repeat(20000)}\r\nEND:VCARD\r\n`);
  const started = Date.now();
  parse(hostile);
  assert.ok(Date.now() - started < 2000, 'linear on hostile input');
  // A photo past 20 MB is not read.
  const photo = Buffer.concat([Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Photo\r\nPHOTO;ENCODING=b;TYPE=JPEG:'), Buffer.from(Buffer.alloc(Math.round(20.4 * 1024 * 1024), 1).toString('base64')), Buffer.from('\r\nEND:VCARD\r\n')]);
  assert.deepEqual(parse(photo).warnings.map(warning => warning.code), ['VALUE_TOO_LARGE']);
});

test('Google CSV, new and old layout: names, numbered values with labels, preferred, events, IM, custom fields, labels and starred', () => {
  const read = parse(fixture('google.csv'));
  assert.equal(read.format, 'google-csv');
  const [zoe, formula] = read.cards;
  assert.deepEqual([zoe.draft.first_name, zoe.draft.last_name, zoe.draft.company, zoe.draft.job_title, zoe.draft.department, zoe.draft.birthday, zoe.draft.anniversary, zoe.draft.notes],
    ['Zoë', 'Exämple', 'Example Ltd', 'Engineer', 'Platform', '--04-01', '2019-08-17', 'Line one\nLine two']);
  assert.equal(zoe.draft.is_favorite, true, '* starred is the favourite');
  const pairs = (kind: string) => zoe.draft.values.filter(item => item.kind === kind).map(item => [item.value, item.label, item.preferred]);
  assert.deepEqual(pairs('email'), [['zoe@example.com', 'work', true], ['zoe.home@example.org', 'home', false], ['zoe.alt@example.org', 'home', false]], '" ::: " holds several values');
  assert.deepEqual(pairs('phone'), [['+44 7700 900001', 'mobile', false], ['+44 20 7946 0001', 'work_fax', false]]);
  assert.deepEqual(pairs('category'), [['Friends', '', false]], '* myContacts is not a category');
  assert.deepEqual(pairs('impp'), [['xmpp:zoe@example.com', 'work', false]]);
  assert.deepEqual(pairs('related'), [['Sam Exämple', 'spouse', false]]);
  const address = zoe.draft.values.find(item => item.kind === 'address')!;
  assert.deepEqual([address.street, address.locality, address.postal_code, address.country, address.extended], ['1 Example Road', 'London', 'N1 1AA', 'United Kingdom', 'Flat 2']);
  assert.deepEqual(zoe.properties.map(property => [property.name, property.params?.['X-LABEL'] ?? null, property.value]), [
    ['X-PHONETIC-FIRST-NAME', null, 'Zo-e'], ['PHOTO', null, 'https://photos.example.com/zoe.jpg'], ['X-CSV-FIELD', ['Event (Graduation)'], '2010-06-30'], ['X-CSV-FIELD', ['Shoe size'], '38']]);
  assert.equal(formula.draft.values[0].value, '+44 20 7946 0999', "UniHub's own defusing quote is removed");
  assert.deepEqual(formula.properties.map(property => [property.params?.['X-LABEL'], property.value]), [[['=HYPERLINK(1)'], '@sum']]);

  const old = parse(fixture('google-old.csv')).cards[0];
  assert.deepEqual([old.draft.first_name, old.draft.last_name, old.draft.company, old.draft.job_title, old.draft.birthday], ['Old', 'Layout', 'Legacy Inc', 'Clerk', '1980-12-24']);
  assert.deepEqual(old.draft.values.map(item => [item.kind, item.value, item.label]), [['category', 'Work', ''], ['email', 'old@example.com', 'work'], ['phone', '+1 555 0100', 'mobile']]);
});

test('Outlook CSV in English and German (semicolons, windows-1252, DD.MM.YYYY)', () => {
  const en = parse(fixture('outlook-en.csv'));
  assert.equal(en.format, 'outlook-csv');
  const [olivia] = en.cards;
  assert.deepEqual([olivia.draft.first_name, olivia.draft.middle_name, olivia.draft.last_name, olivia.draft.name_prefix, olivia.draft.birthday, olivia.draft.anniversary],
    ['Olivia', 'Q', 'Outlook', 'Ms.', '1985-03-15', null], '0/0/00 is empty');
  const values = olivia.draft.values.map(item => [item.kind, item.value, item.label]);
  for (const expected of [['phone', '+1 217 555 0102', 'work_fax'], ['phone', '+1 217 555 0104', 'mobile'], ['category', 'VIP', ''], ['related', 'Lee', 'child'], ['email', 'o.outlook@example.org', '']]) {
    assert.ok(values.some(value => JSON.stringify(value) === JSON.stringify(expected)), JSON.stringify(expected));
  }
  assert.equal(olivia.draft.values.find(item => item.kind === 'address' && item.label === 'work')!.street, '1 Main St\nSuite 5');
  assert.deepEqual(olivia.properties.map(property => property.params?.['X-LABEL']), [['Office Location']], 'unknown columns are kept, Outlook defaults are not');
  const [joerg] = parse(fixture('outlook-de.csv')).cards;
  assert.deepEqual([joerg.draft.first_name, joerg.draft.last_name, joerg.draft.company, joerg.draft.birthday, joerg.draft.notes],
    ['Jörg', 'Größer', 'Bäckerei Süß GmbH', '1975-12-24', 'Grüße; bitte "Herr" anreden']);
  assert.throws(() => parse(Buffer.from('Nom;Prénom;Courriel\r\nA;B;c@example.com\r\n')), { code: 'IMPORT_UNKNOWN_LAYOUT' });
  assert.throws(() => parse(Buffer.from('%PDF-1.7 not contacts')), { code: 'IMPORT_UNSUPPORTED' });
});

test('CSV export: Google numbers every value, Outlook spills into Notes, and both defuse formulas and read back', () => {
  const cards = [...parse(fixture('vcard40.vcf')).cards, ...parse(fixture('google.csv')).cards];
  const entries = cards.map(asExport);
  const google = writeGoogleCsv(entries);
  assert.ok(google.startsWith('\uFEFF'), 'a UTF-8 BOM for spreadsheets');
  const back = parse(Buffer.from(google, 'utf8'));
  assert.equal(back.format, 'google-csv');
  const [juergen] = back.cards;
  const original = cards[0].draft.values.filter(item => ['email', 'phone', 'address', 'url', 'impp', 'related'].includes(item.kind));
  for (const item of original) {
    assert.ok(juergen.draft.values.some(other => other.kind === item.kind && other.value === item.value && other.label === item.label
      && (other.custom_label ?? null) === (item.custom_label ?? null)), `${item.kind} ${item.value} with its label`);
  }
  assert.deepEqual(back.cards.map(card => !!card.draft.is_favorite), [false, false, true, false], 'starred stays the favourite');
  const rows = parseCsv(google.slice(1), ',');
  assert.ok(rows.flat().every(cell => !/^[=+\-@\t\r]/.test(cell)), 'no cell starts a formula');
  assert.ok(rows.flat().includes("'+44 20 7946 0999"));

  const outlook = writeOutlookCsv(entries);
  const outlookBack = parse(Buffer.from(outlook, 'utf8'));
  assert.equal(outlookBack.format, 'outlook-csv');
  const [first] = outlookBack.cards;
  assert.match(first.draft.notes!, /More from UniHub:\n/);
  assert.match(first.draft.notes!, /\nRelated \(Mother\): Erika Müller\n/, 'a relation without an Outlook column');
  assert.ok(first.draft.values.some(item => item.kind === 'phone' && item.value === '+49 171 5550004' && item.label === 'other'), 'a custom-labelled phone takes Other Phone');
  assert.match(first.draft.notes!, /Birthday: --03-15/, 'a year-less birthday has no Outlook column');
  assert.ok(first.draft.values.some(item => item.kind === 'phone' && item.value === '+49 40 5550002' && item.label === 'work_fax'));
  assert.ok(parseCsv(outlook.slice(1), ',').flat().every(cell => !/^[=+\-@\t\r]/.test(cell)));
});
