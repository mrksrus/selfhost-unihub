// Contact import in two steps (D6 "shows likely duplicates before it
// writes"): stage a file (parse, match against the person's contacts and
// within the file, answer what would happen), then commit per-group
// decisions. The commit is a durable job: chunks of about 200 cards, each in
// one transaction together with its progress, so a retry after a lost answer
// or a restart writes nothing twice. A staged import expires after 24 hours.
//
// Matching is deliberately small and keyed on contact-keys.ts (same UID or
// alias, then shared email or phone, then the same name). The duplicate
// engine (contact-duplicates.ts) is the owner of confidence and reasons;
// matchCards is the one place to call it instead once it lands.
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type {
  ContactRecord, ContactSingleField, ContactValueKind, DuplicateConfidence, DuplicateReason, ImportCardSummary, ImportDecisionKind, ImportFormat,
  ImportGroup, ImportStatus, ImportSummary, ImportWarning, PartialDate,
} from '../contracts/contacts';
import type { ContactDraft, KeptPropertyDraft, ValueDraft } from './contacts';
import type { ImportedCard } from './contacts-vcard-map';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../state';
import { log } from '../log';
import { ApiError, badRequest, notFound } from '../http/errors';
import { withTransaction } from './transactions';
import { isModuleEnabled } from './module-settings';
import { getActiveRestoreSections } from './restore-locks';
import {
  displayName, draftNameKey, insertContact, loadContacts, replaceContact, uidHash, KEPT_PROPERTIES_MAX, KEPT_PROPERTIES_MAX_BYTES, VALUES_PER_KIND,
} from './contacts';
import { valueKey } from './contact-keys';
import { readVCards, looksLikeVCard, IMPORT_LIMITS } from './contacts-vcard-read';
import { mapVCard, fitNotes, ADDRESS_PARTS, FIELD_SOURCE } from './contacts-vcard-map';
import { readContactsCsv, looksLikeCsv } from './contacts-csv';
import { escapeText, partialDateText, stillAgrees } from './contacts-vcard-write';

const EXPIRY_HOURS = 24;
const CHUNK_CARDS = 200;
// A group larger than this is never merged by default (a shared office number).
const LARGE_GROUP = 10;
const SUMMARY_VALUES = 10;

function importsRoot() { return path.resolve(process.env.CONTACT_IMPORTS_ROOT || '/app/uploads/contacts/imports'); }
function stagedPath(userId: string, id: string) { return path.join(importsRoot(), userId, `${id}.json`); }
// A stored path is only used when it is the one this module would give.
function ownedPath(stored: unknown, userId: string, id: string) {
  const expected = stagedPath(userId, id);
  return stored === expected ? expected : null;
}

const warn = (card: number | null, property: string | null, code: string, message: string): ImportWarning => ({ card, property, code, message });

// ── Reading a file ─────────────────────────────────────────────────────

interface ParsedFile { format: ImportFormat; cards: ImportedCard[]; warnings: ImportWarning[] }

const VCARD_FORMATS: Readonly<Record<string, ImportFormat>> = { '2.1': 'vcard21', '3.0': 'vcard3', '4.0': 'vcard4' };

/**
 * The cards of a vCard or Google/Outlook CSV file. The content decides, not
 * the file name or the Content-Type.
 */
function parseContactsFile(bytes: Buffer): ParsedFile {
  if (looksLikeVCard(bytes)) {
    const read = readVCards(bytes);
    const warnings = [...read.warnings];
    const cards = read.cards.map(card => mapVCard(card, warnings)).filter((card): card is ImportedCard => !!card);
    const versions = read.cards.map(card => card.version).filter(Boolean) as string[];
    const version = versions.sort((a, b) => versions.filter(v => v === b).length - versions.filter(v => v === a).length)[0] || '3.0';
    return { format: VCARD_FORMATS[version], cards: cards.map(keepPhotoAsProperty), warnings };
  }
  if (looksLikeCsv(bytes)) {
    const read = readContactsCsv(bytes);
    return { format: read.format, cards: read.cards, warnings: read.warnings };
  }
  throw badRequest('IMPORT_UNSUPPORTED', 'UniHub reads vCard files (.vcf) and Google or Outlook CSV exports. This file is neither.');
}

/**
 * Photo seam. Until the photo service (contact-photos.ts setContactPhoto)
 * is wired in here, an inline photo stays on the contact as its original
 * PHOTO property, so nothing is lost and the export writes it back. With the
 * service, the commit hands `card.photo` to it after the chunk's transaction
 * and this conversion goes.
 */
function keepPhotoAsProperty(card: ImportedCard): ImportedCard {
  if (!card.photo) return card;
  const { media_type: media, data, params, group } = card.photo;
  const subtype = media ? media.split('/')[1]?.toUpperCase() : null;
  const property: KeptPropertyDraft = { name: 'PHOTO', group, params: { ...params, ENCODING: ['b'], ...(subtype ? { TYPE: [...(params.TYPE || []), subtype] } : {}) },
    value: data, source_version: null };
  return { ...card, properties: [property, ...card.properties], photo: null };
}

/** Kept properties within the store's bounds (count and bytes); the rest are dropped with a warning. */
function boundKept(properties: readonly KeptPropertyDraft[], card: number, warnings: ImportWarning[]) {
  const kept: KeptPropertyDraft[] = [];
  let bytes = 0;
  let dropped = 0;
  for (const property of properties) {
    const size = Buffer.byteLength(property.value, 'utf8');
    if (kept.length >= KEPT_PROPERTIES_MAX || bytes + size > KEPT_PROPERTIES_MAX_BYTES) { dropped++; continue; }
    kept.push(property);
    bytes += size;
  }
  if (dropped) warnings.push(warn(card, null, 'KEPT_LIMIT', `${dropped} other detail${dropped === 1 ? '' : 's'} did not fit the 256 KB kept for each contact and ${dropped === 1 ? 'was' : 'were'} not kept`));
  return kept;
}

// ── Matching ───────────────────────────────────────────────────────────

interface CardMatch { kind: 'uid' | 'duplicate' | 'new'; confidence: DuplicateConfidence | null; existing: string[]; reasons: DuplicateReason[] }

interface ContactIndex {
  byUid: Map<string, string>;
  byKey: Map<string, Set<string>>;
  byName: Map<string, Set<string>>;
  names: Map<string, string>;
}

async function loadIndex(executor: SqlExecutor, userId: string): Promise<ContactIndex> {
  const [contacts] = await executor.execute<(RowDataPacket & { id: string; uid_hash: string; name_key: string })[]>(
    'SELECT id, uid_hash, name_key FROM contacts WHERE user_id = ?', [userId]);
  const [aliases] = await executor.execute<(RowDataPacket & { uid_hash: string; contact_id: string })[]>(
    'SELECT uid_hash, contact_id FROM contact_uid_aliases WHERE user_id = ?', [userId]);
  const [values] = await executor.execute<(RowDataPacket & { contact_id: string; kind: string; value_key: string })[]>(
    "SELECT contact_id, kind, value_key FROM contact_values WHERE user_id = ? AND kind IN ('email', 'phone') AND value_key <> ''", [userId]);
  const add = (map: Map<string, Set<string>>, key: string, id: string) => { const set = map.get(key) || new Set(); set.add(id); map.set(key, set); };
  const index: ContactIndex = { byUid: new Map(), byKey: new Map(), byName: new Map(), names: new Map() };
  for (const alias of aliases) index.byUid.set(alias.uid_hash, alias.contact_id);
  for (const contact of contacts) {
    index.byUid.set(contact.uid_hash, contact.id);
    index.names.set(contact.id, contact.name_key);
    if (contact.name_key) add(index.byName, contact.name_key, contact.id);
  }
  for (const value of values) add(index.byKey, `${value.kind}:${value.value_key}`, value.contact_id);
  return index;
}

const cardKeys = (draft: ContactDraft) => draft.values.filter(value => value.kind === 'email' || value.kind === 'phone')
  .map(value => ({ key: `${value.kind}:${valueKey(value.kind, value.value)}`, kind: value.kind as 'email' | 'phone', value: value.value }))
  .filter(item => !item.key.endsWith(':'));
// Names are compatible when either is unknown or one's words are all in the
// other ("jurgen muller" and "jurgen karl muller"); keys are sorted word sets.
function compatible(a: string, b: string) {
  if (!a || !b || a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const words = new Set(long.split(' '));
  return short.split(' ').every(word => words.has(word));
}

/** One card against the existing contacts. */
function matchCard(card: ImportedCard, index: ContactIndex): CardMatch {
  if (card.uid) {
    const id = index.byUid.get(uidHash(card.uid));
    if (id) return { kind: 'uid', confidence: 'high', existing: [id], reasons: [{ kind: 'uid', detail: card.uid }] };
  }
  const name = draftNameKey(card.draft);
  const high = new Map<string, DuplicateReason[]>();
  const medium = new Map<string, DuplicateReason[]>();
  for (const { key, kind, value } of cardKeys(card.draft)) {
    for (const id of index.byKey.get(key) || []) {
      const target = compatible(name, index.names.get(id) || '') ? high : medium;
      target.set(id, [...(target.get(id) || []), { kind, detail: value }]);
    }
  }
  const best = high.size ? high : medium;
  if (best.size) {
    const ids = [...best.keys()].sort((a, b) => best.get(b)!.length - best.get(a)!.length).slice(0, 5);
    return { kind: 'duplicate', confidence: high.size ? 'high' : 'medium', existing: ids, reasons: best.get(ids[0])! };
  }
  // The same name alone (two words or more) is at most medium and never merged by default.
  if (name.includes(' ')) {
    const ids = [...(index.byName.get(name) || [])].slice(0, 5);
    if (ids.length) return { kind: 'duplicate', confidence: 'medium', existing: ids, reasons: [{ kind: 'name', detail: name }] };
  }
  return { kind: 'new', confidence: null, existing: [], reasons: [] };
}

/** Cards that are the same person within the file: same UID, or a shared email or phone with compatible names. */
function fileGroups(cards: readonly ImportedCard[]) {
  const parent = cards.map((_, at) => at);
  const find = (at: number): number => { while (parent[at] !== at) { parent[at] = parent[parent[at]]; at = parent[at]; } return at; };
  const union = (a: number, b: number) => { const [x, y] = [find(a), find(b)]; if (x !== y) parent[Math.max(x, y)] = Math.min(x, y); };
  const firstBy = new Map<string, number>();
  cards.forEach((card, at) => {
    const name = draftNameKey(card.draft);
    const keys = [...(card.uid ? [`uid:${uidHash(card.uid)}`] : []), ...cardKeys(card.draft).map(item => item.key)];
    for (const key of keys) {
      const other = firstBy.get(key);
      if (other === undefined) { firstBy.set(key, at); continue; }
      if (key.startsWith('uid:') || compatible(name, draftNameKey(cards[other].draft))) union(at, other);
    }
  });
  const groups = new Map<number, number[]>();
  cards.forEach((_, at) => { const root = find(at); groups.set(root, [...(groups.get(root) || []), at]); });
  return [...groups.values()];
}

// ── Merging (shared by the preview's conflicts and the commit) ──────────

/** A stored contact as a draft whose values keep their rows (and import details). */
function recordDraft(record: ContactRecord): ContactDraft {
  const list = (kind: ContactValueKind, items: readonly { id?: string; value: string; label: string; custom_label?: string | null; preferred: boolean }[]) =>
    items.map(item => ({ id: item.id, kind, value: item.value, label: item.label, custom_label: item.custom_label ?? null, preferred: item.preferred }));
  return {
    display_name: record.name.display, first_name: record.name.given || '', last_name: record.name.family, middle_name: record.name.middle,
    name_prefix: record.name.prefix, name_suffix: record.name.suffix, company: record.organization.name, department: record.organization.department,
    job_title: record.job_title, birthday: partialDateText(record.birthday), anniversary: partialDateText(record.anniversary), notes: record.notes,
    is_favorite: record.is_favorite,
    values: [
      ...list('email', record.emails), ...list('phone', record.phones),
      ...record.addresses.map(item => ({ ...list('address', [item])[0], ...Object.fromEntries(ADDRESS_PARTS.map(part => [part, item[part]])) })),
      ...list('url', record.urls), ...list('impp', record.impp), ...list('related', record.related), ...list('nickname', record.nicknames),
      ...record.categories.map(value => ({ kind: 'category' as const, value, label: '', custom_label: null, preferred: false })),
    ],
  };
}

const NAME_FIELDS = ['first_name', 'middle_name', 'last_name', 'name_prefix', 'name_suffix'] as const;
const SINGLE_FIELDS: readonly [ContactSingleField, keyof ContactDraft][] = [
  ['display_name', 'display_name'], ['organization', 'company'], ['department', 'department'], ['job_title', 'job_title'], ['birthday', 'birthday'], ['anniversary', 'anniversary'],
];
const PROPERTY_FOR_KIND: Readonly<Record<ContactValueKind, string>> = {
  email: 'EMAIL', phone: 'TEL', address: 'ADR', url: 'URL', impp: 'IMPP', related: 'RELATED', nickname: 'NICKNAME', category: 'CATEGORIES',
};
const keptKey = (property: KeptPropertyDraft) => JSON.stringify([property.name, (property.group || '').toLowerCase(), property.value, property.params ?? null]);

/** A value that no longer fits its kind's 100, as the vCard property it would be. */
function valueAsKept(value: ValueDraft): KeptPropertyDraft {
  const text = value.kind === 'address' ? ADDRESS_PARTS.map(part => escapeText(value[part] || '')).join(';') : escapeText(value.value);
  return { name: PROPERTY_FOR_KIND[value.kind], group: value.vcard_group ?? null, params: (value.params as Record<string, string[]> | null) ?? null, value: text, source_version: null };
}

/**
 * Merges a card into `base` (merge-union, F12): every value of the card that
 * the contact lacks is added (an equal value keeps the contact's label), an
 * empty single value is filled, a differing one keeps the contact's and is
 * reported, notes are joined, kept properties are added once. The card's
 * vCard groups are renamed where the contact already uses them.
 */
function mergeCard(base: ContactDraft, kept: KeptPropertyDraft[], card: ImportedCard) {
  const conflicts = new Set<ContactSingleField>();
  const incoming = card.draft;
  const baseNamed = NAME_FIELDS.some(field => base[field]);
  const incomingNamed = NAME_FIELDS.some(field => incoming[field]);
  if (!baseNamed && incomingNamed) for (const field of NAME_FIELDS) (base as unknown as Record<string, unknown>)[field] = incoming[field] ?? (field === 'first_name' ? '' : null);
  else if (baseNamed && incomingNamed && NAME_FIELDS.some(field => (base[field] || '') !== (incoming[field] || ''))) conflicts.add('name');
  for (const [field, column] of SINGLE_FIELDS) {
    const [mine, theirs] = [base[column] as string | null, incoming[column] as string | null];
    if (!mine && theirs) (base as unknown as Record<string, unknown>)[column] = theirs;
    else if (mine && theirs && mine !== theirs) conflicts.add(field);
  }
  if (incoming.notes && !(base.notes || '').includes(incoming.notes.trim())) base.notes = fitNotes(base.notes ? `${base.notes}\n\n${incoming.notes}` : incoming.notes).text;
  if (incoming.is_favorite) base.is_favorite = true;
  // Rename the card's groups that the contact already uses (item1 → item1-2),
  // unless everything in the card's group is already in the contact's (the same card again).
  const used = new Set([...base.values.map(value => value.vcard_group), ...kept.map(property => property.group)].filter(Boolean).map(group => group!.toLowerCase()));
  const valueKeyIn = (value: ValueDraft) => `${value.kind}\u0000${valueKey(value.kind, value.value) || value.value.trim().toLowerCase()}\u0000${(value.vcard_group || '').toLowerCase()}`;
  const present = new Set([...base.values.map(valueKeyIn), ...kept.map(keptKey)]);
  const sameGroup = (key: string) => incoming.values.filter(value => value.vcard_group?.toLowerCase() === key).every(value => present.has(valueKeyIn(value)))
    && card.properties.filter(property => property.group?.toLowerCase() === key).every(property => present.has(keptKey(property)));
  const renamed = new Map<string, string>();
  const groupOf = (group: string | null | undefined) => {
    if (!group) return group ?? null;
    const key = group.toLowerCase();
    if (!used.has(key) || sameGroup(key)) return group;
    if (!renamed.has(key)) {
      // vcard_group holds 64 characters.
      const stem = group.slice(0, 56);
      let n = 2; while (used.has(`${stem.toLowerCase()}-${n}`)) n++;
      renamed.set(key, `${stem}-${n}`); used.add(`${stem.toLowerCase()}-${n}`);
    }
    return renamed.get(key)!;
  };
  const seen = new Set(base.values.map(value => `${value.kind}\u0000${valueKey(value.kind, value.value) || value.value.trim().toLowerCase()}`));
  const counts = new Map<ContactValueKind, number>();
  for (const value of base.values) counts.set(value.kind, (counts.get(value.kind) || 0) + 1);
  const overflow: KeptPropertyDraft[] = [];
  for (const value of incoming.values) {
    const key = `${value.kind}\u0000${valueKey(value.kind, value.value) || value.value.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const moved = { ...value, id: undefined, vcard_group: groupOf(value.vcard_group) };
    if ((counts.get(value.kind) || 0) >= VALUES_PER_KIND) { overflow.push(valueAsKept(moved)); continue; }
    counts.set(value.kind, (counts.get(value.kind) || 0) + 1);
    base.values.push(moved);
  }
  const keys = new Set(kept.map(keptKey));
  for (const property of [...card.properties.map(property => ({ ...property, group: groupOf(property.group) })), ...overflow]) {
    if (keys.has(keptKey(property))) continue;
    keys.add(keptKey(property));
    kept.push(property);
  }
  return conflicts;
}

// ── Staging ────────────────────────────────────────────────────────────

/** The staged file: the cards and the groups the summary showed. */
interface StagedImport {
  format: ImportFormat;
  cards: ImportedCard[];
  groups: { id: string; cards: number[]; existing_ids: string[]; default_decision: ImportDecisionKind }[];
}

const datePart = (stored: string | null): PartialDate | null => {
  const match = stored ? /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(stored) : null;
  return match ? { year: match[1] ? Number(match[1]) : null, month: Number(match[2]), day: Number(match[3]) } : null;
};

function cardSummary(card: ImportedCard): ImportCardSummary {
  const { draft } = card;
  const of = (kind: ContactValueKind) => draft.values.filter(value => value.kind === kind).slice(0, SUMMARY_VALUES).map(value => value.value);
  return {
    card: card.number,
    display_name: displayName(draft, draft.values),
    name: { display: draft.display_name, given: draft.first_name || null, family: draft.last_name, middle: draft.middle_name, prefix: draft.name_prefix, suffix: draft.name_suffix },
    organization: { name: draft.company, department: draft.department },
    job_title: draft.job_title, birthday: datePart(draft.birthday), anniversary: datePart(draft.anniversary),
    emails: of('email'), phones: of('phone'),
    has_photo: !!card.photo || card.properties.some(property => property.name === 'PHOTO'),
  };
}

// Equal content: the shown fields, every value with its label, and as many kept properties.
function signature(draft: ContactDraft, keptCount: number) {
  const values = draft.values.map(value => [value.kind, valueKey(value.kind, value.value) || value.value, value.label, value.custom_label || '', value.preferred ? 1 : 0].join('\u0001')).sort();
  return JSON.stringify([draft.display_name || null, draft.first_name || '', ...NAME_FIELDS.slice(1).map(field => draft[field] || null), draft.company || null,
    draft.department || null, draft.job_title || null, draft.birthday || null, draft.anniversary || null, (draft.notes || '').trim(), values, keptCount]);
}

async function existingKept(executor: SqlExecutor, userId: string, contactId: string): Promise<KeptPropertyDraft[]> {
  const [rows] = await executor.execute<(RowDataPacket & { name: string; vcard_group: string | null; params: unknown; value: string; source_version: string | null })[]>(
    'SELECT name, vcard_group, params, value, source_version FROM contact_properties WHERE user_id = ? AND contact_id = ? ORDER BY position, id', [userId, contactId]);
  return rows.map(row => ({ name: row.name, group: row.vcard_group, params: typeof row.params === 'string' ? JSON.parse(row.params) : (row.params as KeptPropertyDraft['params']) ?? null,
    value: row.value, source_version: row.source_version }));
}

// How many kept properties an export of each contact writes: a field's old
// copy that no longer agrees is not one. One query per thousand contacts.
async function writtenKeptCounts(userId: string, contacts: readonly ContactRecord[]) {
  const counts = new Map<string, number>();
  const withKept = contacts.filter(contact => contact.kept_properties > 0);
  for (let start = 0; start < withKept.length; start += 1000) {
    const slice = withKept.slice(start, start + 1000);
    const byId = new Map(slice.map(contact => [contact.id, contact]));
    const [rows] = await db.execute<(RowDataPacket & { contact_id: string; name: string; vcard_group: string | null; params: unknown; value: string; source_version: string | null })[]>(
      `SELECT contact_id, name, vcard_group, params, value, source_version FROM contact_properties WHERE user_id = ? AND contact_id IN (${slice.map(() => '?').join(', ')})`,
      [userId, ...slice.map(contact => contact.id)]);
    for (const row of rows) {
      const property: KeptPropertyDraft = { name: row.name, group: row.vcard_group, params: typeof row.params === 'string' ? JSON.parse(row.params) : (row.params as KeptPropertyDraft['params']) ?? null,
        value: row.value, source_version: row.source_version };
      if (property.source_version !== FIELD_SOURCE || stillAgrees(property, byId.get(row.contact_id)!)) counts.set(row.contact_id, (counts.get(row.contact_id) || 0) + 1);
    }
  }
  return counts;
}

/** Matches the cards and builds the groups the person decides on. */
async function matchCards(userId: string, cards: readonly ImportedCard[]) {
  const index = await loadIndex(db, userId);
  const matches = cards.map(card => matchCard(card, index));
  const targets = [...new Set(matches.flatMap(match => match.existing.slice(0, 1)))];
  const loaded = await loadContacts(db, userId, targets);
  const existing = new Map(loaded.map(contact => [contact.id, contact]));
  const writtenKept = await writtenKeptCounts(userId, loaded);
  const groups: (ImportGroup & { cardIndexes: number[] })[] = [];
  for (const members of fileGroups(cards)) {
    const memberMatches = members.map(at => matches[at]);
    const uid = memberMatches.find(match => match.kind === 'uid');
    const high = memberMatches.find(match => match.confidence === 'high');
    const medium = memberMatches.find(match => match.confidence === 'medium');
    const chosen = uid || high || (members.length > 1 ? null : medium) || null;
    let match: ImportGroup['match'] = uid ? 'uid' : chosen || members.length > 1 ? 'duplicate' : 'new';
    let confidence: DuplicateConfidence | null = uid || high || members.length > 1 ? 'high' : medium ? 'medium' : null;
    const existingIds = chosen ? chosen.existing : [];
    const reasons = chosen ? chosen.reasons : members.length > 1 ? [{ kind: 'name' as const, detail: 'Several contacts in the file' }] : [];
    let conflicts: ContactSingleField[] = [];
    const target = existingIds[0] ? existing.get(existingIds[0]) : undefined;
    if (target || members.length > 1) {
      const base = target ? recordDraft(target) : structuredClone(cards[members[0]].draft);
      const kept: KeptPropertyDraft[] = [];
      const found = new Set<ContactSingleField>();
      for (const at of target ? members : members.slice(1)) for (const field of mergeCard(base, kept, cards[at])) found.add(field);
      conflicts = [...found];
      if (target && members.length === 1 && signature(cards[members[0]].draft, cards[members[0]].properties.length) === signature(recordDraft(target), writtenKept.get(target.id) || 0)) {
        match = 'identical';
        confidence = 'high';
      }
    }
    const large = members.length > LARGE_GROUP;
    const default_decision: ImportDecisionKind = match === 'identical' ? 'skip'
      : !large && (match === 'uid' || (match === 'duplicate' && confidence === 'high')) ? 'merge' : 'add';
    groups.push({
      id: `g${groups.length + 1}`, cards: members.map(at => cards[at].number), match, confidence, existing_ids: existingIds, reasons, conflicts, default_decision,
      ...(match === 'new' ? {} : { summaries: members.map(at => cardSummary(cards[at])) }), cardIndexes: members,
    });
  }
  return groups;
}

/** Step 1: parse and match the uploaded file, stage it, and answer what would happen. Writes no contact. */
async function stageImport(userId: string, upload: { path: string; size: number }): Promise<ImportSummary> {
  if (upload.size > IMPORT_LIMITS.fileBytes) throw badRequest('IMPORT_TOO_LARGE', 'The file is larger than 64 MB.');
  await sweepContactImports().catch(error => log.error('contacts', 'Could not sweep expired contact imports', error));
  const bytes = await fs.promises.readFile(upload.path);
  const parsed = parseContactsFile(bytes);
  if (!parsed.cards.length) throw badRequest('IMPORT_EMPTY', 'No contacts were found in the file.');
  const warnings = [...parsed.warnings];
  for (const card of parsed.cards) card.properties = boundKept(card.properties, card.number, warnings);
  const groups = await matchCards(userId, parsed.cards);
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 3600 * 1000);
  const staged: StagedImport = { format: parsed.format, cards: parsed.cards,
    groups: groups.map(group => ({ id: group.id, cards: group.cards, existing_ids: group.existing_ids, default_decision: group.default_decision })) };
  const file = stagedPath(userId, id);
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(file, JSON.stringify(staged), { mode: 0o600, flag: 'wx' });
  const count = (matches: ImportGroup['match'][]) => groups.filter(group => matches.includes(group.match)).reduce((sum, group) => sum + group.cards.length, 0);
  const summary: ImportSummary = {
    id, format: parsed.format, expires_at: expiresAt.toISOString(),
    counts: { cards: parsed.cards.length, new: count(['new']), present: count(['uid', 'identical']), duplicates: count(['duplicate']) },
    groups: groups.map(({ cardIndexes: _unused, ...group }) => group),
    warnings,
    sample_names: parsed.cards.slice(0, 5).map(card => displayName(card.draft, card.draft.values)),
  };
  try {
    await db.execute(`INSERT INTO contact_imports (id, user_id, status, format, file_path, summary, progress, expires_at)
      VALUES (?, ?, 'staged', ?, ?, ?, 0, ?)`,
    [id, userId, parsed.format, file, JSON.stringify({ counts: summary.counts, groups: groups.length, warnings: warnings.length }), sqlDate(expiresAt)]);
  } catch (error) {
    await fs.promises.rm(file, { force: true }).catch(() => {});
    throw error;
  }
  log.info('contacts', 'Contact import staged', { cards: parsed.cards.length, groups: groups.length, warnings: warnings.length });
  return summary;
}

const sqlDate = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');

// ── Commit ─────────────────────────────────────────────────────────────

interface CommitState {
  decisions: Record<string, ImportDecisionKind>;
  next: number;
  added: number;
  merged: number;
  skipped: number;
  kept_conflicts: { contact_id: string; field: ContactSingleField }[];
  warnings: ImportWarning[];
  error?: { code: string; message: string } | null;
}

type ImportRow = RowDataPacket & { id: string; user_id: string; status: string; file_path: string | null; result: unknown; progress: number; expires_at: Date | string };

const DECISIONS = new Set<ImportDecisionKind>(['add', 'merge', 'skip']);
const running = new Set<string>();
const parseResult = (value: unknown): CommitState | null => {
  if (value == null) return null;
  try { return (typeof value === 'string' ? JSON.parse(value) : value) as CommitState; } catch { return null; }
};
const toDate = (value: Date | string) => (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`));

function statusOf(row: ImportRow): ImportStatus {
  const state = parseResult(row.result);
  const expired = toDate(row.expires_at).getTime() <= Date.now() && (row.status === 'staged' || row.status === 'failed');
  return {
    id: row.id,
    state: expired ? 'expired' : row.status as ImportStatus['state'],
    progress: Math.min(1, Number(row.progress) / 100),
    expires_at: toDate(row.expires_at).toISOString(),
    result: state ? { added: state.added, merged: state.merged, skipped: state.skipped, kept_conflicts: state.kept_conflicts, warnings: state.warnings } : null,
    error: row.status === 'failed' ? state?.error ?? { code: 'IMPORT_FAILED', message: 'The import stopped. Import again to continue.' } : null,
  };
}

async function importRow(userId: string, id: string, executor: SqlExecutor = db) {
  const [[row]] = await executor.execute<ImportRow[]>(
    'SELECT id, user_id, status, file_path, result, progress, expires_at FROM contact_imports WHERE id = ? AND user_id = ?', [id, userId]);
  if (!row) throw notFound('IMPORT_NOT_FOUND', 'This import does not exist or has expired.');
  return row;
}

/** GET /api/contacts/imports/:id. A commit the server lost (a restart) resumes here. */
async function importStatus(userId: string, id: string): Promise<ImportStatus> {
  const row = await importRow(userId, id);
  if (row.status === 'committing' && !running.has(id)) startCommit(userId, id);
  return statusOf(row);
}

function decisionsInput(body: unknown, staged: StagedImport['groups']): Record<string, ImportDecisionKind> {
  const list = (body as { decisions?: unknown } | null)?.decisions;
  if (list !== undefined && !Array.isArray(list)) throw badRequest('INVALID_IMPORT_DECISIONS', 'decisions must be a list');
  const known = new Map(staged.map(group => [group.id, group]));
  const decisions: Record<string, ImportDecisionKind> = Object.fromEntries(staged.map(group => [group.id, group.default_decision]));
  for (const entry of (list || []) as unknown[]) {
    const { group_id: groupId, decision } = (entry || {}) as { group_id?: unknown; decision?: unknown };
    if (typeof groupId !== 'string' || !known.has(groupId)) throw badRequest('INVALID_IMPORT_DECISIONS', 'A decision names a group this import does not have');
    if (typeof decision !== 'string' || !DECISIONS.has(decision as ImportDecisionKind)) throw badRequest('INVALID_IMPORT_DECISIONS', 'A decision must be add, merge or skip');
    decisions[groupId] = decision as ImportDecisionKind;
  }
  return decisions;
}

async function readStaged(userId: string, id: string, stored: unknown): Promise<StagedImport> {
  const file = ownedPath(stored, userId, id);
  if (!file) throw new ApiError(410, 'IMPORT_EXPIRED', 'This import has expired. Choose the file again.');
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as StagedImport;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(410, 'IMPORT_EXPIRED', 'This import has expired. Choose the file again.');
    throw error;
  }
}

/**
 * Step 2: POST /api/contacts/imports/:id/commit. Claims the import, records
 * the decisions and starts the commit; answers at once (poll the status).
 * Committing again changes nothing; a failed import resumes.
 */
async function commitImport(userId: string, id: string, body: unknown): Promise<ImportStatus> {
  const row = await importRow(userId, id);
  const current = statusOf(row);
  if (current.state === 'expired') throw new ApiError(410, 'IMPORT_EXPIRED', 'This import has expired. Choose the file again.');
  if (row.status === 'committed') return current;
  if (row.status === 'committing') { if (!running.has(id)) startCommit(userId, id); return current; }
  const staged = await readStaged(userId, id, row.file_path);
  const previous = parseResult(row.result);
  // A failed import resumes with the decisions it started with.
  const state: CommitState = previous?.decisions ? { ...previous, error: null }
    : { decisions: decisionsInput(body, staged.groups), next: 0, added: 0, merged: 0, skipped: 0, kept_conflicts: [], warnings: [] };
  const [claimed] = await db.execute<ResultSetHeader>(`UPDATE contact_imports SET status = 'committing', result = ?
    WHERE id = ? AND user_id = ? AND status IN ('staged', 'failed') AND expires_at > UTC_TIMESTAMP()`, [JSON.stringify(state), id, userId]);
  if (claimed.affectedRows) startCommit(userId, id);
  return statusOf(await importRow(userId, id));
}

function startCommit(userId: string, id: string) {
  if (running.has(id)) return;
  running.add(id);
  runCommit(userId, id)
    .catch(async error => {
      log.error('contacts', 'Contact import failed', { code: (error as { code?: string })?.code ?? 'unknown' });
      await setFailed(userId, id, { code: 'IMPORT_FAILED', message: 'The import stopped. Import again to continue where it stopped.' }).catch(() => {});
    })
    .finally(() => running.delete(id));
}

async function setFailed(userId: string, id: string, error: { code: string; message: string }) {
  await withTransaction(async cx => {
    const [[row]] = await cx.execute<ImportRow[]>("SELECT result FROM contact_imports WHERE id = ? AND user_id = ? AND status = 'committing' FOR UPDATE", [id, userId]);
    if (!row) return;
    const state = { ...parseResult(row.result), error };
    await cx.execute("UPDATE contact_imports SET status = 'failed', result = ? WHERE id = ? AND user_id = ?", [JSON.stringify(state), id, userId]);
  });
}

/** Contacts module and restore lock, before every chunk (a restore may start mid-import). */
async function commitBlocked(userId: string) {
  if (!await isModuleEnabled(userId, 'contacts')) return { code: 'MODULE_DISABLED', message: 'The Contacts module was turned off. Turn it on and import again to continue.' };
  if ((await getActiveRestoreSections(userId)).has('contacts')) return { code: 'RESTORE_IN_PROGRESS', message: 'A restore of contacts is running. Import again when it has finished.' };
  return null;
}

async function runCommit(userId: string, id: string) {
  const row = await importRow(userId, id);
  const staged = await readStaged(userId, id, row.file_path);
  const cardsByNumber = new Map(staged.cards.map(card => [card.number, card]));
  for (;;) {
    const blocked = await commitBlocked(userId);
    if (blocked) { await setFailed(userId, id, blocked); return; }
    const outcome = await withTransaction(async cx => {
      const [[locked]] = await cx.execute<ImportRow[]>('SELECT status, result FROM contact_imports WHERE id = ? AND user_id = ? FOR UPDATE', [id, userId]);
      if (!locked || locked.status !== 'committing') return 'stop';
      const state = parseResult(locked.result)!;
      let end = state.next;
      let size = 0;
      while (end < staged.groups.length && (size === 0 || size + staged.groups[end].cards.length <= CHUNK_CARDS)) size += staged.groups[end++].cards.length;
      for (let at = state.next; at < end; at++) {
        const group = staged.groups[at];
        await applyGroup(cx, userId, group, state.decisions[group.id] ?? group.default_decision, group.cards.map(number => cardsByNumber.get(number)!).filter(Boolean), state);
      }
      state.next = end;
      const done = end >= staged.groups.length;
      const progress = staged.groups.length ? Math.floor((end / staged.groups.length) * 100) : 100;
      await cx.execute(`UPDATE contact_imports SET result = ?, progress = ?${done ? ", status = 'committed', committed_at = UTC_TIMESTAMP()" : ''} WHERE id = ? AND user_id = ?`,
        [JSON.stringify(state), progress, id, userId]);
      return done ? 'done' : 'more';
    });
    if (outcome === 'stop') return;
    if (outcome === 'done') {
      await fs.promises.rm(stagedPath(userId, id), { force: true }).catch(() => {});
      const [[final]] = await db.execute<ImportRow[]>('SELECT result FROM contact_imports WHERE id = ? AND user_id = ?', [id, userId]);
      const state = parseResult(final?.result);
      log.info('contacts', 'Contact import committed', { added: state?.added, merged: state?.merged, skipped: state?.skipped });
      return;
    }
  }
}

async function uidTaken(cx: SqlExecutor, userId: string, uid: string) {
  const hash = uidHash(uid);
  const [rows] = await cx.execute<RowDataPacket[]>(`SELECT 1 FROM contacts WHERE user_id = ? AND uid_hash = ?
    UNION ALL SELECT 1 FROM contact_uid_aliases WHERE user_id = ? AND uid_hash = ? LIMIT 1`, [userId, hash, userId, hash]);
  return rows.length > 0;
}

async function addCard(cx: SqlExecutor, userId: string, card: ImportedCard, state: CommitState) {
  const uid = card.uid && !await uidTaken(cx, userId, card.uid) ? card.uid : undefined;
  const id = await insertContact(cx, userId, card.draft, { ...(uid ? { uid } : {}), properties: boundKept(card.properties, card.number, state.warnings) });
  state.added++;
  return id;
}

// A merged card's UID finds the contact again on the next import (26-08).
async function addAlias(cx: SqlExecutor, userId: string, uid: string | null, contactId: string) {
  if (!uid || await uidTaken(cx, userId, uid)) return;
  await cx.execute('INSERT IGNORE INTO contact_uid_aliases (user_id, uid_hash, uid, contact_id) VALUES (?, ?, ?, ?)', [userId, uidHash(uid), uid, contactId]);
}

/**
 * One group's decision inside the chunk's transaction. A merge into an
 * existing contact that was deleted since the preview adds instead. The
 * merged contact's previous state is not yet put in the bin: that is the
 * merge service's (contact-merge.ts) once it offers it to the import.
 */
async function applyGroup(cx: SqlExecutor, userId: string, group: StagedImport['groups'][number], decision: ImportDecisionKind, cards: ImportedCard[], state: CommitState) {
  if (!cards.length) return;
  if (decision === 'skip') { state.skipped += cards.length; return; }
  if (decision === 'add') { for (const card of cards) await addCard(cx, userId, card, state); return; }
  let targetId: string | null = null;
  let rest = cards;
  if (group.existing_ids[0]) {
    const [[exists]] = await cx.execute<RowDataPacket[]>('SELECT id FROM contacts WHERE id = ? AND user_id = ? FOR UPDATE', [group.existing_ids[0], userId]);
    if (exists) targetId = group.existing_ids[0];
    else state.warnings.push(warn(cards[0].number, null, 'MERGE_TARGET_GONE', 'The contact to merge into was deleted meanwhile; the card was added'));
  }
  if (!targetId) {
    targetId = await addCard(cx, userId, cards[0], state);
    rest = cards.slice(1);
    if (!rest.length) return;
  }
  const [record] = await loadContacts(cx, userId, [targetId]);
  const draft = recordDraft(record);
  const kept = await existingKept(cx, userId, targetId);
  for (const card of rest) {
    for (const field of mergeCard(draft, kept, card)) state.kept_conflicts.push({ contact_id: targetId, field });
    state.merged++;
  }
  await replaceContact(cx, userId, targetId, draft, { expectedVersion: null, properties: boundKept(kept, rest[0].number, state.warnings) });
  for (const card of rest) await addAlias(cx, userId, card.uid, targetId);
}

// ── Expiry ─────────────────────────────────────────────────────────────

/**
 * Removes expired imports and their staged files, and staged files without a
 * row (a crash between writing the file and the row). An import still
 * committing is left a day past its expiry before it counts as abandoned.
 * For the worker owner's periodic sweep; staging also calls it.
 */
async function sweepContactImports({ executor = db as SqlExecutor, orphanAgeMs = (EXPIRY_HOURS + 1) * 3600 * 1000 } = {}) {
  const [rows] = await executor.execute<(RowDataPacket & { id: string; user_id: string; file_path: string | null })[]>(
    `SELECT id, user_id, file_path FROM contact_imports
     WHERE (expires_at < UTC_TIMESTAMP() AND status <> 'committing') OR expires_at < UTC_TIMESTAMP() - INTERVAL 1 DAY LIMIT 500`);
  for (const row of rows) {
    const file = ownedPath(row.file_path, row.user_id, row.id);
    if (file) await fs.promises.rm(file, { force: true }).catch(() => {});
    await executor.execute('DELETE FROM contact_imports WHERE id = ? AND user_id = ?', [row.id, row.user_id]);
  }
  let orphans = 0;
  const root = importsRoot();
  const users = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const user of users) {
    if (!user.isDirectory()) continue;
    const directory = path.join(root, user.name);
    for (const name of await fs.promises.readdir(directory).catch(() => [] as string[])) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : null;
      const file = path.join(directory, name);
      const stat = await fs.promises.lstat(file).catch(() => null);
      if (!stat || !stat.isFile() || Date.now() - stat.mtimeMs < orphanAgeMs) continue;
      const [[known]] = id ? await executor.execute<RowDataPacket[]>('SELECT 1 FROM contact_imports WHERE id = ? AND user_id = ?', [id, user.name]) : [[undefined]];
      if (known) continue;
      await fs.promises.rm(file, { force: true }).catch(() => {});
      orphans++;
    }
  }
  return { expired: rows.length, orphans };
}

export { stageImport, commitImport, importStatus, sweepContactImports, parseContactsFile, matchCards, mergeCard, recordDraft, CHUNK_CARDS, EXPIRY_HOURS };
export type { StagedImport };
