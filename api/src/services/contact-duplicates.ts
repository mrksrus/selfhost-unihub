// Duplicate detection (0.26.0 slice 5): the one owner of "which contacts are
// the same person". The duplicates view, "Merge all" and the merge review's
// conflicts read it; the browser keeps no copy of these rules. Nothing is
// stored but "Not the same person" decisions, so a result is never stale: it
// is computed on request from the contacts as they are.
import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type {
  ContactSingleField, DuplicateConfidence, DuplicateGroup, DuplicateMember, DuplicateReason,
} from '../contracts/contacts';
import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, notFound } from '../http/errors';
import { foldName, orderedNameTokens } from './contact-keys';
import { displayName } from './contacts';

const CONFIDENCE_RANK: Readonly<Record<DuplicateConfidence, number>> = { low: 1, medium: 2, high: 3 };
// A group over this many members is shown as "large, check carefully" and is never merged automatically.
const LARGE_GROUP = 10;
// A block (contacts sharing one email, number, name or name token) over this
// size yields only high-confidence pairs; over the second, none at all (a
// shared info@ address or a very common name would otherwise pair thousands).
const BLOCK_ALL_EDGES = 50;
const BLOCK_MAX = 500;
const REASONS_PER_GROUP = 50;
const DISMISS_MAX = 50;

/** One contact as the engine compares it: its single values, keys and the shown summary. */
interface CandidateContact {
  id: string;
  version: number;
  created_at: string;
  uid_hash: string;
  display_name: string | null;
  first_name: string;
  middle_name: string | null;
  last_name: string | null;
  name_prefix: string | null;
  name_suffix: string | null;
  company: string | null;
  department: string | null;
  job_title: string | null;
  birthday: string | null;
  anniversary: string | null;
  is_favorite: boolean;
  photo: { sha256: string; width: number; height: number } | null;
  emails: { value: string; key: string }[];
  phones: { value: string; key: string }[];
}

interface DetectionInput {
  contacts: readonly CandidateContact[];
  /** "Not the same person" pairs, as pairKey(a, b). */
  dismissed: ReadonlySet<string>;
  /** UID hashes of merged-away contacts and the contact they now belong to. */
  aliases: ReadonlyMap<string, string>;
  min: DuplicateConfidence;
}

interface Edge { a: string; b: string; confidence: DuplicateConfidence; reasons: DuplicateReason[] }

const pairKey = (a: string, b: string) => a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
const present = (value: string | null | undefined) => typeof value === 'string' && value.trim() !== '';

// Two numbers match on their last nine digits when both have nine or more,
// otherwise on all their digits: Android's identity() rule (ContactCard.kt).
const phoneMatchKey = (key: string) => key.replace(/\D/g, '').slice(-9);

function nameSource(contact: Pick<CandidateContact, 'first_name' | 'middle_name' | 'last_name' | 'display_name'>) {
  return { given: contact.first_name, middle: contact.middle_name, family: contact.last_name, display: contact.display_name };
}

type NameRelation = 'empty' | 'equal' | 'subset' | 'initial' | 'conflict';

// How two names relate: one or both empty, the same token set, one inside
// the other ("Anna Smith" in "Anna Maria Smith"), the same but for an initial
// ("J Smith" and "John Smith"), or different.
function nameRelation(a: readonly string[], b: readonly string[]): NameRelation {
  if (!a.length || !b.length) return 'empty';
  const setA = new Set(a); const setB = new Set(b);
  if (a.length === b.length && a.every(token => setB.has(token))) return 'equal';
  const [small, large] = a.length <= b.length ? [a, setB] : [b, setA];
  if (small.every(token => large.has(token))) return 'subset';
  const restA = a.filter(token => !setB.has(token));
  const restB = b.filter(token => !setA.has(token));
  const shared = a.filter(token => setB.has(token) && token.length > 1);
  if (shared.length && restA.length === restB.length) {
    const unused = [...restB];
    const initials = restA.every(token => {
      const index = unused.findIndex(other => (token.length === 1 && other.length > 1 && other.startsWith(token))
        || (other.length === 1 && token.length > 1 && token.startsWith(other)));
      return index >= 0 && unused.splice(index, 1).length === 1;
    });
    if (initials) return 'initial';
  }
  return 'conflict';
}

interface Prepared {
  contact: CandidateContact;
  tokens: string[];
  ordered: string[];
  emails: Map<string, string>;
  phones: Map<string, string>;
  organization: string;
}

function prepare(contact: CandidateContact): Prepared {
  // The token set is contact-keys' nameTokens (the stored name_key), folded once.
  const ordered = [...new Set(orderedNameTokens(nameSource(contact)))];
  return {
    contact, tokens: [...ordered].sort(), ordered,
    emails: new Map(contact.emails.filter(email => email.key).map(email => [email.key, email.value])),
    phones: new Map(contact.phones.map(phone => [phoneMatchKey(phone.key), phone.value] as const).filter(([key]) => key.length >= 3)),
    organization: contact.company ? foldName(contact.company) : '',
  };
}

const shownName = (item: Prepared) => displayName(item.contact, []) || item.tokens.join(' ');

// The edge between two contacts with its confidence and reasons (plan slice 5):
// high for the same UID or alias, a shared email or number with compatible
// names, or the same full name with something else shared; medium for the
// same full name alone or a shared email or number under different names;
// low for a middle name, an initial or an equal single-word name.
function compare(a: Prepared, b: Prepared, aliases: ReadonlyMap<string, string>): Edge | null {
  const reasons: DuplicateReason[] = [];
  let rank = 0;
  const raise = (confidence: DuplicateConfidence) => { rank = Math.max(rank, CONFIDENCE_RANK[confidence]); };
  if (aliases.get(a.contact.uid_hash) === b.contact.id || aliases.get(b.contact.uid_hash) === a.contact.id) {
    // Not a value to show: the UID of a contact merged into the other one.
    reasons.push({ kind: 'uid', detail: '' });
    raise('high');
  }
  const relation = nameRelation(a.tokens, b.tokens);
  const compatible = relation === 'empty' || relation === 'equal' || relation === 'subset';
  const sharedEmails = [...a.emails.keys()].filter(key => b.emails.has(key));
  const sharedPhones = [...a.phones.keys()].filter(key => b.phones.has(key));
  for (const key of sharedEmails) reasons.push({ kind: 'email', detail: a.emails.get(key)! });
  for (const key of sharedPhones) reasons.push({ kind: 'phone', detail: a.phones.get(key)! });
  if (sharedEmails.length || sharedPhones.length) raise(compatible ? 'high' : 'medium');
  const fullName = relation === 'equal' && a.tokens.length >= 2;
  if (relation === 'equal') {
    const swapped = a.ordered.join(' ') !== b.ordered.join(' ');
    reasons.push({ kind: swapped ? 'name_order' : 'name', detail: shownName(a) });
  }
  if (fullName) {
    const sameOrganization = !!a.organization && a.organization === b.organization;
    if (sameOrganization) reasons.push({ kind: 'organization', detail: a.contact.company!.trim() });
    raise(sameOrganization || sharedEmails.length || sharedPhones.length ? 'high' : 'medium');
  } else if (!rank) {
    if (relation === 'equal') raise('low');
    else if (relation === 'subset' && Math.min(a.tokens.length, b.tokens.length) >= 2) { reasons.push({ kind: 'name_subset', detail: shownName(a) }); raise('low'); }
    else if (relation === 'initial') { reasons.push({ kind: 'initial', detail: shownName(a) }); raise('low'); }
  }
  if (!rank) return null;
  const confidence = (Object.keys(CONFIDENCE_RANK) as DuplicateConfidence[]).find(level => CONFIDENCE_RANK[level] === rank)!;
  return { a: a.contact.id, b: b.contact.id, confidence, reasons };
}

class UnionFind {
  private parent = new Map<string, string>();
  find(id: string): string {
    let root = id;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    let node = id;
    while (node !== root) { const next = this.parent.get(node) ?? root; this.parent.set(node, root); node = next; }
    return root;
  }
  union(a: string, b: string) { const [ra, rb] = [this.find(a), this.find(b)]; if (ra !== rb) this.parent.set(rb, ra); }
}

const NAME_PARTS = ['name_prefix', 'first_name', 'middle_name', 'last_name', 'name_suffix'] as const;
type SingleFieldSource = Pick<CandidateContact, typeof NAME_PARTS[number] | 'display_name' | 'company' | 'department' | 'job_title' | 'birthday' | 'anniversary'>
  & { photo: { sha256: string } | null };

/**
 * The value of a single-value field as compared and shown. The name is all
 * its parts with the written display name, so a choice of name takes them
 * together ('display_name' is never listed on its own).
 */
function singleFieldValue(contact: SingleFieldSource, field: ContactSingleField): string | null {
  const text = (value: string | null | undefined) => present(value) ? value!.trim() : null;
  switch (field) {
    case 'name': {
      // The parts as written, with a differing display name after them.
      const parts = NAME_PARTS.map(part => text(contact[part])).filter(Boolean).join(' ');
      const display = text(contact.display_name);
      if (!parts || !display || display === parts) return parts || display;
      return `${parts} (${display})`;
    }
    case 'display_name': return text(contact.display_name);
    case 'organization': return text(contact.company);
    case 'department': return text(contact.department);
    case 'job_title': return text(contact.job_title);
    case 'birthday': return text(contact.birthday);
    case 'anniversary': return text(contact.anniversary);
    case 'photo': return contact.photo?.sha256 ?? null;
  }
}

const COMPARED_FIELDS: readonly ContactSingleField[] = ['name', 'organization', 'department', 'job_title', 'birthday', 'anniversary', 'photo'];

// Two names conflict when one of their parts (or written display names)
// holds different text on both sides; a part only one side has fills in.
function namesConflict(members: readonly SingleFieldSource[]) {
  return ([...NAME_PARTS, 'display_name'] as const).some(part =>
    new Set(members.map(member => member[part]).filter(present).map(value => value!.trim())).size > 1);
}

/** The single-value fields the members hold different values in (the merge needs a choice for each). */
function singleFieldConflicts(members: readonly SingleFieldSource[]): ContactSingleField[] {
  return COMPARED_FIELDS.filter(field => field === 'name' ? namesConflict(members)
    : new Set(members.map(member => singleFieldValue(member, field)).filter((value): value is string => value !== null)).size > 1);
}

// The member that a merge keeps by default: the most complete one, then a
// favourite, then the oldest.
function completeness(contact: CandidateContact) {
  return contact.emails.length + contact.phones.length
    + [contact.first_name, contact.last_name, contact.middle_name, contact.company, contact.department, contact.job_title, contact.birthday, contact.anniversary].filter(present).length
    + (contact.photo ? 1 : 0);
}
function survivorOrder(a: CandidateContact, b: CandidateContact) {
  return completeness(b) - completeness(a) || Number(b.is_favorite) - Number(a.is_favorite)
    || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

/** A group's id: a hash of its sorted member ids and versions, so an action on an outdated group answers 409. */
function groupId(members: readonly Pick<CandidateContact, 'id' | 'version'>[]) {
  const text = [...members].sort((a, b) => a.id.localeCompare(b.id)).map(member => `${member.id}:${member.version}`).join(',');
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function member(contact: CandidateContact, conflicts: readonly ContactSingleField[]): DuplicateMember {
  return {
    id: contact.id, version: contact.version,
    display_name: displayName(contact, [...contact.emails.map(email => ({ kind: 'email', value: email.value })), ...contact.phones.map(phone => ({ kind: 'phone', value: phone.value }))]),
    organization: present(contact.company) ? contact.company!.trim() : null,
    emails: contact.emails.map(email => email.value),
    phones: contact.phones.map(phone => phone.value),
    photo: contact.photo ? { etag: contact.photo.sha256, width: contact.photo.width, height: contact.photo.height } : null,
    field_values: Object.fromEntries(conflicts.map(field => [field, singleFieldValue(contact, field)])),
  };
}

/**
 * The duplicate groups among one person's contacts (pure; no database).
 * Groups are the connected contacts over edges of at least `min` (low edges
 * never join a group: a low match is shown as a pair). A group's confidence
 * is its bottleneck: high only when high edges alone connect it.
 */
function detectDuplicates({ contacts, dismissed, aliases, min }: DetectionInput): DuplicateGroup[] {
  const prepared = new Map(contacts.map(contact => [contact.id, prepare(contact)]));
  const minRank = CONFIDENCE_RANK[min];
  // Candidate pairs come only from blocks; `true` once a pair met in a block
  // small enough for every confidence.
  const candidates = new Map<string, boolean>();
  const blocks = new Map<string, string[]>();
  const add = (key: string, id: string) => { const list = blocks.get(key); if (list) { if (list[list.length - 1] !== id) list.push(id); } else blocks.set(key, [id]); };
  for (const item of prepared.values()) {
    const { id } = item.contact;
    for (const key of item.emails.keys()) add(`e:${key}`, id);
    for (const key of item.phones.keys()) add(`p:${key}`, id);
    if (item.tokens.length) add(`n:${item.tokens.join(' ')}`, id);
    if (min === 'low') for (const token of item.tokens) if (token.length > 1) add(`t:${token}`, id);
    const holder = aliases.get(item.contact.uid_hash);
    if (holder && holder !== id && prepared.has(holder)) candidates.set(pairKey(id, holder), true);
  }
  for (const [key, ids] of blocks) {
    if (ids.length < 2 || ids.length > BLOCK_MAX) continue;
    const all = ids.length <= BLOCK_ALL_EDGES;
    // A name-token block only proposes low matches, which a large block never yields.
    if (!all && key.startsWith('t:')) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const pair = pairKey(ids[i], ids[j]);
      if (all || !candidates.has(pair)) candidates.set(pair, all || candidates.get(pair) === true);
    }
  }
  const edges: Edge[] = [];
  for (const [pair, all] of candidates) {
    if (dismissed.has(pair)) continue;
    const [a, b] = pair.split('\u0000');
    const edge = compare(prepared.get(a)!, prepared.get(b)!, aliases);
    if (!edge || CONFIDENCE_RANK[edge.confidence] < minRank) continue;
    if (!all && edge.confidence !== 'high') continue;
    edges.push(edge);
  }

  const joining = edges.filter(edge => edge.confidence !== 'low');
  const groupsOf = new UnionFind();
  const highOf = new UnionFind();
  for (const edge of joining) {
    groupsOf.union(edge.a, edge.b);
    if (edge.confidence === 'high') highOf.union(edge.a, edge.b);
  }
  const membersOf = new Map<string, string[]>();
  for (const edge of joining) for (const id of [edge.a, edge.b]) {
    const root = groupsOf.find(id);
    const list = membersOf.get(root) || [];
    if (!list.includes(id)) list.push(id);
    membersOf.set(root, list);
  }
  const edgesOf = new Map<string, Edge[]>();
  for (const edge of joining) { const root = groupsOf.find(edge.a); edgesOf.set(root, [...(edgesOf.get(root) || []), edge]); }

  const build = (ids: readonly string[], groupEdges: readonly Edge[], confidence: DuplicateConfidence): DuplicateGroup => {
    const people = ids.map(id => prepared.get(id)!.contact).sort(survivorOrder);
    const conflicts = singleFieldConflicts(people);
    const large = people.length > LARGE_GROUP;
    let containsDismissed = false;
    for (let i = 0; i < people.length && !containsDismissed; i++) for (let j = i + 1; j < people.length; j++) {
      if (dismissed.has(pairKey(people[i].id, people[j].id))) { containsDismissed = true; break; }
    }
    return {
      id: groupId(people), confidence, large,
      members: people.map(person => member(person, conflicts)),
      reasons: groupEdges.flatMap(edge => edge.reasons.map(reason => ({ ...reason, a: edge.a, b: edge.b }))).slice(0, REASONS_PER_GROUP),
      conflicts,
      // A group holding a "Not the same person" pair (joined through a third
      // contact) always goes through the review.
      auto_merge: confidence === 'high' && !large && !conflicts.length && !containsDismissed,
    };
  };

  const groups: DuplicateGroup[] = [];
  for (const [root, ids] of membersOf) {
    const highRoot = highOf.find(ids[0]);
    const confidence: DuplicateConfidence = ids.every(id => highOf.find(id) === highRoot) ? 'high' : 'medium';
    groups.push(build(ids, edgesOf.get(root) || [], confidence));
  }
  // Low matches as pairs, unless a stronger group already holds both.
  for (const edge of edges) {
    if (edge.confidence !== 'low') continue;
    if (groupsOf.find(edge.a) === groupsOf.find(edge.b)) continue;
    groups.push(build([edge.a, edge.b], [edge], 'low'));
  }
  return groups.sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]
    || a.members[0].display_name.localeCompare(b.members[0].display_name) || a.id.localeCompare(b.id));
}

// ── Reading the contacts ───────────────────────────────────────────────

type CandidateRow = RowDataPacket & Omit<CandidateContact, 'is_favorite' | 'photo' | 'emails' | 'phones' | 'created_at'> & { is_favorite: number | null; created_at: Date | string | null };

const CANDIDATE_COLUMNS = 'id, version, created_at, uid_hash, display_name, first_name, middle_name, last_name, name_prefix, name_suffix, company, department, job_title, birthday, anniversary, is_favorite';

/** The contacts of one person in the engine's shape; `ids` limits them (a merge's members). */
async function loadCandidates(executor: SqlExecutor, userId: string, ids?: readonly string[]): Promise<CandidateContact[]> {
  if (ids && !ids.length) return [];
  const list = ids ? ids.map(() => '?').join(', ') : '';
  const filter = ids ? ` AND contact_id IN (${list})` : '';
  const params = ids ? [userId, ...ids] : [userId];
  const [rows] = await executor.execute<CandidateRow[]>(`SELECT ${CANDIDATE_COLUMNS} FROM contacts WHERE user_id = ?${ids ? ` AND id IN (${list})` : ''}`, params);
  const [values] = await executor.execute<(RowDataPacket & { contact_id: string; kind: 'email' | 'phone'; value: string; value_key: string })[]>(
    `SELECT contact_id, kind, value, value_key FROM contact_values WHERE user_id = ? AND kind IN ('email', 'phone')${filter} ORDER BY contact_id, kind, position, id`, params);
  const [photos] = await executor.execute<(RowDataPacket & { contact_id: string; sha256: string; width: number; height: number })[]>(
    `SELECT contact_id, sha256, width, height FROM contact_photos WHERE user_id = ?${filter}`, params);
  const valuesBy = new Map<string, typeof values>();
  for (const value of values) valuesBy.set(value.contact_id, [...(valuesBy.get(value.contact_id) || []), value]);
  const photoBy = new Map(photos.map(photo => [photo.contact_id, photo]));
  return rows.map(row => {
    const own = valuesBy.get(row.id) || [];
    const photo = photoBy.get(row.id);
    return {
      id: row.id, version: Number(row.version), created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
      uid_hash: row.uid_hash, display_name: row.display_name, first_name: row.first_name || '', middle_name: row.middle_name, last_name: row.last_name,
      name_prefix: row.name_prefix, name_suffix: row.name_suffix, company: row.company, department: row.department, job_title: row.job_title,
      birthday: row.birthday, anniversary: row.anniversary, is_favorite: !!row.is_favorite,
      photo: photo ? { sha256: photo.sha256, width: Number(photo.width), height: Number(photo.height) } : null,
      emails: own.filter(value => value.kind === 'email').map(value => ({ value: value.value, key: value.value_key })),
      phones: own.filter(value => value.kind === 'phone').map(value => ({ value: value.value, key: value.value_key })),
    };
  });
}

async function loadDismissed(executor: SqlExecutor, userId: string) {
  const [rows] = await executor.execute<(RowDataPacket & { contact_a: string; contact_b: string })[]>(
    'SELECT contact_a, contact_b FROM contact_duplicate_dismissals WHERE user_id = ?', [userId]);
  return new Set(rows.map(row => pairKey(row.contact_a, row.contact_b)));
}

async function loadAliases(executor: SqlExecutor, userId: string) {
  const [rows] = await executor.execute<(RowDataPacket & { uid_hash: string; contact_id: string })[]>(
    'SELECT uid_hash, contact_id FROM contact_uid_aliases WHERE user_id = ?', [userId]);
  return new Map(rows.map(row => [row.uid_hash, row.contact_id]));
}

function parseConfidence(value: unknown, fallback: DuplicateConfidence = 'medium'): DuplicateConfidence {
  if (value == null || value === '') return fallback;
  if (value !== 'low' && value !== 'medium' && value !== 'high') throw badRequest('INVALID_DUPLICATES_QUERY', 'min must be low, medium or high');
  return value;
}

/** GET /api/contacts/duplicates: the groups of at least `min` confidence. */
async function findDuplicates(userId: string, min: DuplicateConfidence, executor: SqlExecutor = db): Promise<DuplicateGroup[]> {
  const [contacts, dismissed, aliases] = [await loadCandidates(executor, userId), await loadDismissed(executor, userId), await loadAliases(executor, userId)];
  return detectDuplicates({ contacts, dismissed, aliases, min });
}

function contactIdList(value: unknown, { min, max }: { min: number; max: number }): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id || id.length > 64)) throw badRequest('INVALID_CONTACT_IDS', 'contact_ids must be a list of contact IDs');
  const ids = [...new Set(value as string[])];
  if (ids.length < min) throw badRequest('INVALID_CONTACT_IDS', `Name at least ${min} different contacts`);
  if (ids.length > max) throw badRequest('INVALID_CONTACT_IDS', `At most ${max} contacts at a time`);
  return ids;
}

/** "Not the same person": stores every pair of the given contacts, which must all be the person's own. */
async function dismissDuplicates(userId: string, body: unknown, executor: SqlExecutor = db) {
  const ids = contactIdList((body as { contact_ids?: unknown } | null)?.contact_ids, { min: 2, max: DISMISS_MAX });
  const [rows] = await executor.execute<(RowDataPacket & { id: string })[]>(`SELECT id FROM contacts WHERE user_id = ? AND id IN (${ids.map(() => '?').join(', ')})`, [userId, ...ids]);
  if (rows.length !== ids.length) throw notFound('CONTACT_NOT_FOUND', 'Contact not found');
  const pairs: string[][] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push(ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]]);
  await executor.execute(`INSERT INTO contact_duplicate_dismissals (contact_a, contact_b, user_id) VALUES ${pairs.map(() => '(?, ?, ?)').join(', ')}
    ON DUPLICATE KEY UPDATE user_id = user_id`, pairs.flatMap(([a, b]) => [a, b, userId]));
  return { dismissed: pairs.length };
}

export {
  detectDuplicates,
  findDuplicates,
  dismissDuplicates,
  loadCandidates,
  singleFieldConflicts,
  singleFieldValue,
  nameRelation,
  parseConfidence,
  contactIdList,
  groupId,
  pairKey,
  phoneMatchKey,
  LARGE_GROUP,
};
export type { CandidateContact, SingleFieldSource };
