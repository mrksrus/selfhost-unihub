#!/usr/bin/env node
// How long the duplicate engine takes for one person's contacts (0.26.0 plan:
// under 500 ms server time for 10,000 contacts with 30,000 values). Runs the
// engine of api/dist on synthetic contacts in memory; the two database reads
// of a real request come on top. Not a CI gate: run it on the NAS by hand.
//   npm --prefix api run build && node api/scripts/bench-contact-duplicates.cts [contacts] [runs]
'use strict';

const { detectDuplicates } = require('../dist/src/services/contact-duplicates') as typeof import('../src/services/contact-duplicates');
const { valueKey } = require('../dist/src/services/contact-keys') as typeof import('../src/services/contact-keys');
type Candidate = import('../src/services/contact-duplicates').CandidateContact;

const count = Number(process.argv[2]) || 10000;
const runs = Number(process.argv[3]) || 5;

// Deterministic: mulberry32.
let seed = 42;
const random = () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const given = ['Anna', 'Jürgen', 'Maria', 'John', 'Li', 'Fatima', 'Ole', 'Zoë', 'Pierre', 'Ana', 'Kim', 'Sam', 'Noah', 'Mia', 'Lena', 'Paul'];
const family = Array.from({ length: 1200 }, (_, index) => `Family${index}`);

const contacts: Candidate[] = Array.from({ length: count }, (_, index) => {
  // About one in twenty is a copy of an earlier contact: the same name with
  // its email, or another number in another format.
  const copyOf = index > 10 && random() < 0.05 ? Math.floor(random() * index) : -1;
  const person = copyOf >= 0 ? copyOf : index;
  const first = given[person % given.length];
  const last = family[Math.floor(person / given.length) % family.length];
  const emails = [`${first}.${last}.${person}@example.org`.toLowerCase(), ...(random() < 0.5 ? [`p${index}@example.net`] : [])];
  const phones = [copyOf >= 0 ? `0171 ${String(person).padStart(7, '0')}` : `+49 171 ${String(person).padStart(7, '0')}`, ...(random() < 0.3 ? [`030 ${index}`] : [])];
  return {
    id: `contact-${String(index).padStart(6, '0')}`, version: 1, created_at: '2026-01-01T00:00:00.000Z', uid_hash: `uid-${index}`,
    display_name: null, first_name: first, middle_name: null, last_name: last, name_prefix: null, name_suffix: null,
    company: random() < 0.3 ? 'Example AG' : null, department: null, job_title: null, birthday: null, anniversary: null, is_favorite: false, photo: null,
    emails: emails.map(value => ({ value, key: valueKey('email', value) })),
    phones: phones.map(value => ({ value, key: valueKey('phone', value) })),
  };
});
const values = contacts.reduce((sum, contact) => sum + contact.emails.length + contact.phones.length, 0);

for (const min of ['high', 'medium', 'low'] as const) {
  const times: number[] = [];
  let groups = 0;
  for (let run = 0; run < runs; run++) {
    const started = process.hrtime.bigint();
    groups = detectDuplicates({ contacts, dismissed: new Set(), aliases: new Map(), min }).length;
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  times.sort((a, b) => a - b);
  console.log(`${count} contacts, ${values} values, min=${min}: ${groups} groups, median ${times[Math.floor(times.length / 2)].toFixed(1)} ms, worst ${times[times.length - 1].toFixed(1)} ms`);
}
