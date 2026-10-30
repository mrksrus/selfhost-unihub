// The duplicate engine's rules on synthetic contacts (0.26.0 slice 5): which
// contacts are the same person, how sure, why, and what a merge would have
// to ask. The real-database test covers the routes around it.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { detectDuplicates, pairKey, groupId } = require('../dist/src/services/contact-duplicates') as typeof import('../src/services/contact-duplicates');
const { valueKey } = require('../dist/src/services/contact-keys') as typeof import('../src/services/contact-keys');
type Candidate = import('../src/services/contact-duplicates').CandidateContact;
type Confidence = import('../src/contracts/contacts').DuplicateConfidence;

let sequence = 0;
function contact(fields: Partial<Omit<Candidate, 'emails' | 'phones'>> & { emails?: string[]; phones?: string[] } = {}): Candidate {
  const id = fields.id || `c${String(++sequence).padStart(4, '0')}`;
  return {
    version: 1, created_at: `2026-01-01T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`, uid_hash: `hash-${id}`, display_name: null, first_name: '',
    middle_name: null, last_name: null, name_prefix: null, name_suffix: null, company: null, department: null, job_title: null, birthday: null,
    anniversary: null, is_favorite: false, photo: null, ...fields, id,
    emails: (fields.emails || []).map(value => ({ value, key: valueKey('email', value) })),
    phones: (fields.phones || []).map(value => ({ value, key: valueKey('phone', value) })),
  };
}
function detect(contacts: Candidate[], min: Confidence = 'low', { dismissed = [] as [string, string][], aliases = new Map<string, string>() } = {}) {
  return detectDuplicates({ contacts, min, aliases, dismissed: new Set(dismissed.map(([a, b]) => pairKey(a, b))) });
}
const ids = (group: { members: { id: string }[] }) => group.members.map(member => member.id).sort();

test('the same email or number under compatible names is high; email case, phone formats and accents do not matter', () => {
  const anna = contact({ first_name: 'Anna', last_name: 'Müller', emails: ['Anna@Example.com'] });
  const annaWork = contact({ first_name: 'anna', last_name: 'muller', emails: ['anna@example.com'] });
  const nameless = contact({ emails: [' ANNA@example.com '] });
  const bob = contact({ first_name: 'Bob', last_name: 'Beispiel', phones: ['+49 171 1234567'] });
  const bobHome = contact({ first_name: 'Bob', phones: ['0171/123-4567'] });
  const groups = detect([anna, annaWork, nameless, bob, bobHome]);
  const annaGroup = groups.find(group => group.members.some(member => member.id === anna.id))!;
  assert.deepEqual(ids(annaGroup), [anna.id, annaWork.id, nameless.id].sort());
  assert.equal(annaGroup.confidence, 'high');
  assert.ok(annaGroup.reasons.some(reason => reason.kind === 'email' && /anna@example\.com/i.test(reason.detail)));
  // "Jürgen" and "Jurgen": the same person, but the name to keep is a choice.
  assert.deepEqual(annaGroup.conflicts, ['name']);
  assert.equal(annaGroup.auto_merge, false, 'a conflict needs the review');
  assert.equal(annaGroup.members.find(member => member.id === anna.id)!.field_values.name, 'Anna Müller');
  const bobGroup = groups.find(group => group.members.some(member => member.id === bob.id))!;
  assert.deepEqual([ids(bobGroup), bobGroup.confidence, bobGroup.reasons.map(reason => reason.kind)], [[bob.id, bobHome.id].sort(), 'high', ['phone']]);
  assert.deepEqual(bobGroup.conflicts, []);
  assert.equal(bobGroup.auto_merge, true);
  assert.equal(bobGroup.members[0].id, bob.id, 'the more complete contact comes first (kept by default)');
});

test('names: order swapped, titles, "Last, First", ß and accents give one key; a shared office address under other names is medium', () => {
  const a = contact({ first_name: 'Jürgen', last_name: 'Müller', company: 'Example AG' });
  const b = contact({ display_name: 'Müller, Jürgen', company: 'example ag' });
  const c = contact({ first_name: 'Muller', last_name: 'Jurgen', name_prefix: 'Dr.' });
  const groups = detect([a, b, c], 'medium');
  assert.equal(groups.length, 1);
  assert.deepEqual(ids(groups[0]), [a.id, b.id, c.id].sort());
  // a-b share the organisation (high), c is linked by the name alone (medium).
  assert.equal(groups[0].confidence, 'medium', 'the weakest link decides');
  assert.ok(groups[0].reasons.some(reason => reason.kind === 'name_order' && (reason.a === c.id || reason.b === c.id)));
  assert.ok(groups[0].reasons.some(reason => reason.kind === 'organization'));
  // At min=high only the high link groups.
  const high = detect([a, b, c], 'high');
  assert.deepEqual(high.map(ids), [[a.id, b.id].sort()]);

  const straße = contact({ first_name: 'Klaus', last_name: 'Straße', emails: ['k@example.org'] });
  const strasse = contact({ first_name: 'klaus', last_name: 'STRASSE', phones: ['+43 1 5550000'] });
  assert.equal(detect([straße, strasse], 'medium')[0].confidence, 'medium', 'same full name alone');

  const office1 = contact({ first_name: 'Anna', last_name: 'Smith', emails: ['office@example.net'] });
  const office2 = contact({ first_name: 'Carl', last_name: 'Jones', emails: ['office@example.net'] });
  const office = detect([office1, office2], 'medium');
  assert.deepEqual([office.length, office[0].confidence, office[0].auto_merge], [1, 'medium', false]);
  assert.deepEqual(detect([office1, office2], 'high'), []);
});

test('low matches come as pairs: a middle name, an initial, an equal single name; unrelated names never match', () => {
  const full = contact({ first_name: 'Anna', middle_name: 'Maria', last_name: 'Smith' });
  const short = contact({ first_name: 'Anna', last_name: 'Smith' });
  const initial = contact({ display_name: 'J. Doe' });
  const john = contact({ first_name: 'John', last_name: 'Doe' });
  const mono1 = contact({ first_name: 'Cher' });
  const mono2 = contact({ display_name: 'cher' });
  const other = contact({ first_name: 'Anna', last_name: 'Jones' });
  const groups = detect([full, short, initial, john, mono1, mono2, other], 'low');
  const pairs = groups.map(group => [ids(group), group.confidence, group.reasons.map(reason => reason.kind)]);
  assert.deepEqual(pairs.sort(), [
    [[full.id, short.id].sort(), 'low', ['name_subset']],
    [[initial.id, john.id].sort(), 'low', ['initial']],
    [[mono1.id, mono2.id].sort(), 'low', ['name']],
  ].sort());
  assert.deepEqual(detect([full, short, initial, john, mono1, mono2, other], 'medium'), [], 'low matches only at min=low');
  // "Anna" alone is not a low match of every Anna.
  assert.deepEqual(detect([contact({ first_name: 'Anna' }), contact({ first_name: 'Anna', last_name: 'Smith' })], 'low'), []);
});

test('false-positive guards: phone suffix rule, short numbers, empty keys and different people', () => {
  // Nine or more digits compare on the last nine; shorter ones exactly.
  const long1 = contact({ first_name: 'P', last_name: 'One', phones: ['+49 30 123456789'] });
  const long2 = contact({ first_name: 'P', last_name: 'One', phones: ['030 123456789'] });
  const short1 = contact({ first_name: 'Q', last_name: 'Two', phones: ['12345678'] });
  const short2 = contact({ first_name: 'Q', last_name: 'Two', phones: ['+1 12345678'] });
  const groups = detect([long1, long2, short1, short2], 'high');
  assert.deepEqual(groups.map(ids), [[long1.id, long2.id].sort()]);
  // A number without digits and an empty email never join anyone.
  const blank1 = contact({ first_name: 'X', last_name: 'Ray', phones: ['n/a'], emails: [''] });
  const blank2 = contact({ first_name: 'Y', last_name: 'Zed', phones: ['none'], emails: [''] });
  assert.deepEqual(detect([blank1, blank2], 'low'), []);
});

test('dismissed pairs, UID aliases, large groups and big blocks', () => {
  const a = contact({ first_name: 'Ida', last_name: 'Example', emails: ['ida@example.org'] });
  const b = contact({ first_name: 'Ida', last_name: 'Example', emails: ['ida@example.org'] });
  const c = contact({ first_name: 'Ida', last_name: 'Example', phones: ['+44 20 7946 0000'] });
  const d = contact({ first_name: 'Ida', last_name: 'Example', phones: ['020 7946 0000'], emails: ['ida@example.org'] });
  assert.deepEqual(detect([a, b], 'low', { dismissed: [[a.id, b.id]] }), [], '"Not the same person" removes the edge');
  // Joined through a third contact, the group stays but is never merged automatically.
  const joined = detect([a, b, d], 'high', { dismissed: [[a.id, b.id]] });
  assert.deepEqual([joined.length, ids(joined[0]), joined[0].auto_merge], [1, [a.id, b.id, d.id].sort(), false]);
  assert.equal(detect([a, b, c, d], 'high')[0].auto_merge, true);

  // A contact carrying the UID of one merged into another: high, by the alias.
  const survivor = contact({ first_name: 'Kim', last_name: 'Kay' });
  const reimported = contact({ first_name: 'Kimberly', last_name: 'Other', uid_hash: 'hash-old' });
  const aliased = detect([survivor, reimported], 'high', { aliases: new Map([['hash-old', survivor.id]]) });
  assert.deepEqual([ids(aliased[0]), aliased[0].reasons.map(reason => reason.kind)], [[survivor.id, reimported.id].sort(), ['uid']]);

  // Eleven contacts sharing an email and name: large, never in "Merge all".
  const team = Array.from({ length: 11 }, () => contact({ first_name: 'Team', last_name: 'Inbox', emails: ['team@example.org'] }));
  const large = detect(team, 'high');
  assert.deepEqual([large.length, large[0].large, large[0].auto_merge, large[0].members.length], [1, true, false, 11]);

  // 60 different people on one shared address: only high pairs from that block (none here).
  const shared = Array.from({ length: 60 }, (_, index) => contact({ first_name: `Person${index}`, last_name: `Family${index}`, emails: ['info@example.org'] }));
  assert.deepEqual(detect(shared, 'medium'), []);
});

test('conflicts list each differing single value; a group id changes with any version', () => {
  const a = contact({ first_name: 'Eve', last_name: 'Example', emails: ['eve@example.org'], company: 'A GmbH', birthday: '1990-01-02', photo: { sha256: 'aa', width: 1, height: 1 } });
  const b = contact({ first_name: 'Eve', last_name: 'Example', emails: ['eve@example.org'], company: 'B GmbH', birthday: '1990-01-02', job_title: 'Chemist', photo: { sha256: 'bb', width: 1, height: 1 } });
  const [group] = detect([a, b], 'high');
  assert.deepEqual(group.conflicts, ['organization', 'photo'], 'equal values and values only one side has are no conflict');
  assert.deepEqual(group.members.map(member => member.field_values.organization).sort(), ['A GmbH', 'B GmbH']);
  assert.equal(group.id, groupId([a, b]));
  assert.notEqual(group.id, groupId([a, { ...b, version: 2 }]));
});

// Review (Sol): 200 identical contacts took 12.7 s of the single API
// process. A large block now proposes only the pairs that can be high.
test('dense groups: hundreds of copies of one person are grouped well within a second, and big blocks still find their high pairs', () => {
  const timed = (contacts: Candidate[], min: Confidence) => { const start = process.hrtime.bigint(); const groups = detect(contacts, min); return { groups, ms: Number(process.hrtime.bigint() - start) / 1e6 }; };
  const copies = Array.from({ length: 400 }, () => contact({ first_name: 'Dora', last_name: 'Dense', emails: ['dora@example.org'], phones: ['+49 171 5550123'] }));
  for (const min of ['low', 'medium', 'high'] as const) {
    const { groups, ms } = timed(copies, min);
    assert.deepEqual([groups.length, groups[0].members.length, groups[0].confidence, groups[0].large, groups[0].reasons.length <= 50], [1, 400, 'high', true, true]);
    assert.ok(ms < 1000, `${min}: ${ms} ms`);
  }
  // The same person with a different number each time: still one high group, through the shared address.
  const numbered = Array.from({ length: 300 }, (_, index) => contact({ first_name: 'Nora', last_name: 'Numbered', emails: ['nora@example.org'], phones: [`+49 171 55${String(index).padStart(5, '0')}`] }));
  const one = timed(numbered, 'medium');
  assert.deepEqual([one.groups.length, one.groups[0].members.length, one.groups[0].confidence], [1, 300, 'high']);
  assert.ok(one.ms < 1000, `${one.ms} ms`);
  // A shared address under compatible names (a middle name, a missing family name) joins them across the big block.
  const variants = Array.from({ length: 120 }, (_, index) => contact({ first_name: 'Vera', middle_name: index % 3 === 0 ? 'Maria' : null, last_name: index % 3 === 2 ? null : 'Variant',
    emails: ['vera@example.org'] }));
  const joined = detect(variants, 'high');
  assert.deepEqual([joined.length, joined[0].members.length], [1, 120]);
});
