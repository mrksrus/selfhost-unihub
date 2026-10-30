// Merging contacts, the 30-day undo and its purge (0.26.0 slice 6, F12). A
// merge never drops a value: every list value, kept property, unique note
// and category of every member stays on the survivor, and the single values
// the person did not choose stay in the bin for 30 days with the
// merged-away contacts. The bin (bin_items) is the generic one of 0.28 (D13,
// P-31); a merge puts its merged-away contacts there as one group, and the
// undo is a restore of that group.
//
// Bin payloads and the survivor's snapshot are the stored rows verbatim
// (ids, positions, import details, versions and times), because an undo puts
// back exactly what was there; the store's writes would renumber them.
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type {
  AutoMergeResult, ContactRecord, ContactSingleField, ContactValueKind, DuplicateGroup, MergeRecord, MergeResult, UndoMergeResult,
} from '../contracts/contacts';
import type { ContactDraft, ValueDraft } from './contacts';
import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, conflict, notFound } from '../http/errors';
import { withTransaction } from './transactions';
import { displayName, loadContacts, newUid, replaceContact, uidHash, KEPT_PROPERTIES_MAX, KEPT_PROPERTIES_MAX_BYTES, VALUES_PER_KIND } from './contacts';
import { contactIdList, findDuplicates, singleFieldConflicts, singleFieldValue } from './contact-duplicates';
import { getActiveRestoreSectionsByUser } from './restore-locks';
import { isModuleEnabled } from './module-settings';

const UNDO_DAYS = 30;
const MERGE_MAX = 50;
const AUTO_MERGE_MAX = 500;
const NOTES_MAX_BYTES = 65535;
const PAYLOAD_VERSION = 1;
const PURGE_BATCH = 500;
const CHOICE_FIELDS: readonly ContactSingleField[] = ['name', 'display_name', 'organization', 'department', 'job_title', 'birthday', 'anniversary', 'photo'];

// ── Stored rows, verbatim ──────────────────────────────────────────────

const CONTACT_COLUMNS = ['id', 'user_id', 'uid', 'uid_hash', 'version', 'display_name', 'first_name', 'last_name', 'middle_name', 'name_prefix', 'name_suffix',
  'company', 'department', 'job_title', 'birthday', 'anniversary', 'notes', 'is_favorite', 'name_key', 'created_at', 'updated_at'] as const;
const VALUE_COLUMNS = ['id', 'contact_id', 'user_id', 'kind', 'position', 'is_preferred', 'label', 'custom_label', 'value', 'value_key', 'po_box', 'extended',
  'street', 'locality', 'region', 'postal_code', 'country', 'params', 'vcard_group', 'legacy_slot', 'created_at', 'updated_at'] as const;
const PROPERTY_COLUMNS = ['id', 'contact_id', 'user_id', 'position', 'vcard_group', 'name', 'params', 'value', 'source_version', 'created_at'] as const;
const PHOTO_COLUMNS = ['contact_id', 'user_id', 'sha256', 'width', 'height', 'bytes', 'thumb_sha256', 'source', 'created_at'] as const;
const TIME_COLUMNS = new Set(['created_at', 'updated_at']);
const ADDRESS_PARTS = ['po_box', 'extended', 'street', 'locality', 'region', 'postal_code', 'country'] as const;

type StoredRow = Record<string, unknown>;
type ContactRow = StoredRow & {
  id: string; uid: string; uid_hash: string; version: number; display_name: string | null; first_name: string; last_name: string | null;
  middle_name: string | null; name_prefix: string | null; name_suffix: string | null; company: string | null; department: string | null;
  job_title: string | null; birthday: string | null; anniversary: string | null; notes: string | null; is_favorite: number | boolean | null;
};
type ValueRow = StoredRow & { id: string; kind: ValueDraft['kind']; position: number; is_preferred: number; label: string; custom_label: string | null; value: string; value_key: string; params: unknown; vcard_group: string | null };
type PropertyRow = StoredRow & { id: string; position: number; vcard_group: string | null; name: string; params: unknown; value: string; source_version: string | null };
type PhotoRow = StoredRow & { sha256: string; thumb_sha256: string; width: number; height: number };

/** One contact as stored: the row and its children. Payload version 1 of a bin item of type 'contact'. */
interface ContactSnapshot {
  contact: ContactRow;
  values: ValueRow[];
  properties: PropertyRow[];
  photo: PhotoRow | null;
}
/** A merged-away contact in the bin: its rows, the UID aliases it held and its "Not the same person" pairs. */
interface BinContactPayload extends ContactSnapshot {
  aliases: { uid_hash: string; uid: string; merge_id: string | null }[];
  dismissed_with: string[];
}
/** contact_merges.survivor_before: the survivor before the merge and the dismissals the merge gave it. */
interface SurvivorBefore extends ContactSnapshot {
  added_dismissals: [string, string][];
}

const placeholders = (items: readonly unknown[]) => items.map(() => '?').join(', ');

// Times travel through JSON as ISO text and go back as Dates (sessions are UTC).
function toStored(row: RowDataPacket): StoredRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
}
function sqlValue(column: string, value: unknown) {
  if (value == null) return null;
  if (TIME_COLUMNS.has(column)) return new Date(String(value));
  if (column === 'params' && typeof value === 'object') return JSON.stringify(value);
  return value as string | number;
}

async function snapshotContacts(cx: SqlExecutor, userId: string, ids: readonly string[]): Promise<Map<string, ContactSnapshot>> {
  const list = placeholders(ids);
  const [contacts] = await cx.execute<RowDataPacket[]>(`SELECT ${CONTACT_COLUMNS.join(', ')} FROM contacts WHERE user_id = ? AND id IN (${list})`, [userId, ...ids]);
  const [values] = await cx.execute<RowDataPacket[]>(`SELECT ${VALUE_COLUMNS.join(', ')} FROM contact_values WHERE user_id = ? AND contact_id IN (${list})
    ORDER BY contact_id, kind, position, id`, [userId, ...ids]);
  const [properties] = await cx.execute<RowDataPacket[]>(`SELECT ${PROPERTY_COLUMNS.join(', ')} FROM contact_properties WHERE user_id = ? AND contact_id IN (${list})
    ORDER BY contact_id, position, id`, [userId, ...ids]);
  const [photos] = await cx.execute<RowDataPacket[]>(`SELECT ${PHOTO_COLUMNS.join(', ')} FROM contact_photos WHERE user_id = ? AND contact_id IN (${list})`, [userId, ...ids]);
  const snapshots = new Map<string, ContactSnapshot>();
  for (const row of contacts) snapshots.set(row.id, { contact: toStored(row) as ContactRow, values: [], properties: [], photo: null });
  for (const row of values) snapshots.get(row.contact_id)?.values.push(toStored(row) as ValueRow);
  for (const row of properties) snapshots.get(row.contact_id)?.properties.push(toStored(row) as PropertyRow);
  for (const row of photos) { const snapshot = snapshots.get(row.contact_id); if (snapshot) snapshot.photo = toStored(row) as PhotoRow; }
  return snapshots;
}

async function insertStored(cx: SqlExecutor, table: string, columns: readonly string[], rows: readonly StoredRow[]) {
  for (let start = 0; start < rows.length; start += 100) {
    const slice = rows.slice(start, start + 100);
    await cx.execute(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${slice.map(() => `(${placeholders(columns)})`).join(', ')}`,
      slice.flatMap(row => columns.map(column => sqlValue(column, row[column]))) as (string | number | Date | null)[]);
  }
}

// Child rows keep their ids unless another row took one meanwhile.
async function freeIds(cx: SqlExecutor, table: string, rows: readonly StoredRow[]) {
  if (!rows.length) return rows;
  const ids = rows.map(row => String(row.id));
  const [taken] = await cx.execute<(RowDataPacket & { id: string })[]>(`SELECT id FROM ${table} WHERE id IN (${placeholders(ids)})`, ids);
  const used = new Set(taken.map(row => row.id));
  return rows.map(row => used.has(String(row.id)) ? { ...row, id: crypto.randomUUID() } : row);
}

/** Writes a snapshot's children onto `contactId` (its own rows of those tables are already gone). */
async function insertChildren(cx: SqlExecutor, contactId: string, snapshot: ContactSnapshot) {
  await insertStored(cx, 'contact_values', VALUE_COLUMNS, await freeIds(cx, 'contact_values', snapshot.values.map(row => ({ ...row, contact_id: contactId }))));
  await insertStored(cx, 'contact_properties', PROPERTY_COLUMNS, await freeIds(cx, 'contact_properties', snapshot.properties.map(row => ({ ...row, contact_id: contactId }))));
  if (snapshot.photo) await insertStored(cx, 'contact_photos', PHOTO_COLUMNS, [{ ...snapshot.photo, contact_id: contactId }]);
}

function parseJson<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value !== 'string') return value as T;
  try { return JSON.parse(value) as T; } catch { return null; }
}

const snapshotName = (snapshot: ContactSnapshot) => displayName(snapshot.contact, snapshot.values);

// ── Building the merged contact ────────────────────────────────────────

type Choices = Partial<Record<ContactSingleField, string>>;

function asFieldSource(snapshot: ContactSnapshot) {
  return { ...snapshot.contact, photo: snapshot.photo };
}

const filled = (value: string | null | undefined) => typeof value === 'string' && value.trim() !== '';

// A value seen twice (same kind and normalised key) is kept once, in the
// first member's place; an empty label takes the other's label.
function valueIdentity(row: Pick<ValueRow, 'kind' | 'value' | 'value_key'>) {
  return `${row.kind}\u0000${row.value_key || `raw:${row.value.trim().toLowerCase()}`}`;
}

type GroupNames = Map<ContactSnapshot, Map<string, string>>;

// vCard groups (Apple's item1.EMAIL with item1.X-ABLabel) tie a label to its
// value. A later member's group that an earlier member already uses gets a
// new name (item1 → item1-2), so the merged contact never ties one member's
// label to another member's value, unless everything in that group is
// already there (the same card twice), which keeps its name.
function renameGroups(ordered: readonly ContactSnapshot[]): GroupNames {
  const names: GroupNames = new Map();
  const used = new Set<string>();
  const presentValues = new Set<string>();
  const presentProperties = new Set<string>();
  const valueInGroup = (row: ValueRow, group: string | null) => `${valueIdentity(row)}\u0000${(group || '').toLowerCase()}`;
  const remember = (member: ContactSnapshot, rename: (group: string | null) => string | null) => {
    for (const row of member.values) { const group = rename(row.vcard_group); if (group) used.add(group.toLowerCase()); presentValues.add(valueInGroup(row, group)); }
    for (const row of member.properties) { const group = rename(row.vcard_group); if (group) used.add(group.toLowerCase()); presentProperties.add(propertyIdentity({ ...row, vcard_group: group })); }
  };
  remember(ordered[0], group => group ?? null);
  for (const member of ordered.slice(1)) {
    const renamed = new Map<string, string>();
    const groups = new Map<string, string>();
    for (const row of [...member.values, ...member.properties]) if (row.vcard_group && !groups.has(row.vcard_group.toLowerCase())) groups.set(row.vcard_group.toLowerCase(), row.vcard_group);
    for (const [key, group] of groups) {
      if (!used.has(key)) continue;
      const same = member.values.filter(row => row.vcard_group?.toLowerCase() === key).every(row => presentValues.has(valueInGroup(row, row.vcard_group)))
        && member.properties.filter(row => row.vcard_group?.toLowerCase() === key).every(row => presentProperties.has(propertyIdentity(row)));
      if (same) continue;
      // vcard_group holds 64 characters.
      const stem = group.slice(0, 56);
      let n = 2;
      while (used.has(`${stem.toLowerCase()}-${n}`) || [...groups.keys()].includes(`${stem.toLowerCase()}-${n}`)) n++;
      renamed.set(key, `${stem}-${n}`);
      used.add(`${stem.toLowerCase()}-${n}`);
    }
    names.set(member, renamed);
    remember(member, group => (group ? renamed.get(group.toLowerCase()) ?? group : null));
  }
  return names;
}

const groupOf = (names: GroupNames, member: ContactSnapshot, group: string | null | undefined) =>
  group ? names.get(member)?.get(group.toLowerCase()) ?? group : null;

// The survivor's values keep their rows, positions and places for old apps
// (legacy_slot); the other members' values follow in member order as new
// rows, and the store gives them a free place for old apps where one is left.
function unionValues(members: readonly ContactSnapshot[], survivorId: string, names: GroupNames = new Map()): ValueDraft[] {
  const drafts = new Map<string, ValueDraft>();
  const next = new Map<string, number>();
  const survivor = members.find(member => member.contact.id === survivorId)!;
  for (const row of survivor.values) next.set(row.kind, Math.max(next.get(row.kind) ?? 0, Number(row.position) + 1));
  for (const member of [survivor, ...members.filter(item => item !== survivor)]) {
    const own = member === survivor;
    for (const row of member.values) {
      const identity = valueIdentity(row);
      const seen = drafts.get(identity);
      if (seen) {
        if (!seen.label && row.label) Object.assign(seen, { label: row.label, custom_label: row.custom_label ?? null });
        seen.preferred = seen.preferred || !!row.is_preferred;
        continue;
      }
      let position = Number(row.position);
      if (!own) {
        position = next.get(row.kind) ?? 0;
        next.set(row.kind, position + 1);
      }
      drafts.set(identity, {
        // The survivor's own rows keep their ids; the others become new rows.
        id: own ? row.id : null, position,
        kind: row.kind, label: row.label, custom_label: row.custom_label ?? null, value: row.value, preferred: !!row.is_preferred,
        ...Object.fromEntries(ADDRESS_PARTS.map(part => [part, (row[part] as string | null) ?? null])),
        params: parseJson(row.params), vcard_group: groupOf(names, member, row.vcard_group),
      });
    }
  }
  return [...drafts.values()];
}

const propertyIdentity = (row: Pick<PropertyRow, 'name' | 'vcard_group' | 'params' | 'value'>) =>
  JSON.stringify([row.name.toUpperCase(), row.vcard_group ?? null, canonical(parseJson(row.params)), row.value]);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}

interface MergePlan {
  draft: ContactDraft;
  /** Kept properties of the other members the survivor lacks, and notes past the column's size. */
  extraProperties: { name: string; vcard_group: string | null; params: unknown; value: string; source_version: string | null }[];
  photoFrom: ContactSnapshot | null;
}

function planMerge(members: readonly ContactSnapshot[], survivor: ContactSnapshot, choices: Choices): MergePlan {
  const ordered = [survivor, ...members.filter(member => member !== survivor)];
  const chosen = (field: ContactSingleField) => {
    const id = choices[field];
    return id ? ordered.find(member => member.contact.id === id)! : null;
  };
  const first = (column: keyof ContactRow & string) => {
    const owner = ordered.find(member => filled(member.contact[column] as string | null));
    return owner ? (owner.contact[column] as string) : null;
  };
  const single = (field: ContactSingleField, column: keyof ContactRow & string) => {
    const owner = chosen(field);
    return owner ? (owner.contact[column] as string | null) : first(column);
  };

  // A chosen name takes all its parts and its display name together.
  const nameOwner = chosen('name');
  const name = nameOwner
    ? { display_name: nameOwner.contact.display_name, first_name: nameOwner.contact.first_name || '', last_name: nameOwner.contact.last_name, middle_name: nameOwner.contact.middle_name,
      name_prefix: nameOwner.contact.name_prefix, name_suffix: nameOwner.contact.name_suffix }
    : { display_name: first('display_name'), first_name: first('first_name') || '', last_name: first('last_name'), middle_name: first('middle_name'),
      name_prefix: first('name_prefix'), name_suffix: first('name_suffix') };

  // Unique notes in order; what does not fit the notes field stays as a NOTE property.
  const seenNotes = new Set<string>();
  const kept: string[] = [];
  const overflow: string[] = [];
  let bytes = 0;
  for (const member of ordered) {
    const note = member.contact.notes;
    if (!note || !note.trim() || seenNotes.has(note.trim())) continue;
    seenNotes.add(note.trim());
    const size = Buffer.byteLength(note, 'utf8') + (kept.length ? 2 : 0);
    if (bytes + size <= NOTES_MAX_BYTES) { kept.push(note); bytes += size; } else overflow.push(note);
  }

  const names = renameGroups(ordered);
  const known = new Set(survivor.properties.map(propertyIdentity));
  const extraProperties: MergePlan['extraProperties'] = [];
  for (const member of ordered.slice(1)) {
    for (const row of member.properties) {
      const group = groupOf(names, member, row.vcard_group);
      const identity = propertyIdentity({ ...row, vcard_group: group });
      if (known.has(identity)) continue;
      known.add(identity);
      extraProperties.push({ name: row.name, vcard_group: group, params: parseJson(row.params), value: row.value, source_version: row.source_version ?? null });
    }
  }
  for (const note of overflow) extraProperties.push({ name: 'NOTE', vcard_group: null, params: null, value: note, source_version: '4.0' });

  return {
    draft: {
      ...name,
      company: single('organization', 'company'),
      department: single('department', 'department'),
      job_title: single('job_title', 'job_title'),
      birthday: single('birthday', 'birthday'),
      anniversary: single('anniversary', 'anniversary'),
      notes: kept.length ? kept.join('\n\n') : null,
      is_favorite: ordered.some(member => !!member.contact.is_favorite),
      values: unionValues(ordered, survivor.contact.id, names),
    },
    extraProperties,
    photoFrom: chosen('photo') || ordered.find(member => member.photo) || null,
  };
}

// ── Limits ─────────────────────────────────────────────────────────────

const KIND_PLURALS: Readonly<Record<ContactValueKind, string>> = {
  email: 'email addresses', phone: 'phone numbers', address: 'addresses', url: 'web addresses', impp: 'messaging addresses',
  related: 'related people', nickname: 'nicknames', category: 'categories',
};

/**
 * A merged contact must stay within what the store accepts and a restore
 * reads back: at most 100 values of each kind (after de-duplication) and
 * 500 other details in 256 KB. A merge past that is refused, never cut:
 * the person removes values first, or keeps the contacts apart.
 */
function checkMergeLimits(plan: MergePlan, survivor: ContactSnapshot) {
  const counts = new Map<ContactValueKind, number>();
  for (const value of plan.draft.values) counts.set(value.kind, (counts.get(value.kind) || 0) + 1);
  const kinds = [...counts].filter(([, count]) => count > VALUES_PER_KIND).map(([kind]) => kind);
  const kept = [...survivor.properties, ...plan.extraProperties];
  const keptOver = kept.length > KEPT_PROPERTIES_MAX || kept.reduce((sum, property) => sum + Buffer.byteLength(property.value, 'utf8'), 0) > KEPT_PROPERTIES_MAX_BYTES;
  if (!kinds.length && !keptOver) return;
  const what = [...kinds.map(kind => `${VALUES_PER_KIND} ${KIND_PLURALS[kind]}`), ...(keptOver ? [`${KEPT_PROPERTIES_MAX} other details (256 KB)`] : [])];
  throw badRequest('TOO_MANY_VALUES', `Together these contacts have more than ${what.join(' or ')}, more than one contact can hold. Remove some first, or keep them apart.`,
    { kinds, kept_properties: keptOver });
}

// ── Merge ──────────────────────────────────────────────────────────────

interface MergeInput {
  ids: string[];
  survivorId: string;
  choices: Choices;
  /** null: the caller holds the contacts in its own transaction (an import). */
  versions: Record<string, number> | null;
  /**
   * 'keep-survivor' (imports): a differing single value without a choice
   * keeps the survivor's, else the first member's that has one, instead of
   * answering CHOICE_REQUIRED.
   */
  resolve?: 'keep-survivor';
}

function parseMergeRequest(body: unknown): MergeInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_MERGE', 'A merge needs contact_ids and versions');
  const input = body as Record<string, unknown>;
  const ids = contactIdList(input.contact_ids, { min: 2, max: MERGE_MAX });
  const survivorId = input.survivor_id == null ? ids[0] : input.survivor_id;
  if (typeof survivorId !== 'string' || !ids.includes(survivorId)) throw badRequest('INVALID_MERGE', 'survivor_id must be one of contact_ids');
  const versions = input.versions;
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) throw badRequest('INVALID_MERGE', 'versions must name the version of each contact');
  const versionOf: Record<string, number> = {};
  for (const id of ids) {
    const version = (versions as Record<string, unknown>)[id];
    if (!Number.isSafeInteger(version) || (version as number) < 1) throw badRequest('INVALID_MERGE', 'versions must name the version of each contact');
    versionOf[id] = version as number;
  }
  const choices: Choices = {};
  if (input.choices != null) {
    if (typeof input.choices !== 'object' || Array.isArray(input.choices)) throw badRequest('INVALID_MERGE', 'choices must map fields to contact IDs');
    for (const [field, id] of Object.entries(input.choices as Record<string, unknown>)) {
      if (id == null) continue;
      if (!CHOICE_FIELDS.includes(field as ContactSingleField)) throw badRequest('INVALID_MERGE', `${field.slice(0, 32)} is not a field to choose`);
      if (typeof id !== 'string' || !ids.includes(id)) throw badRequest('INVALID_MERGE', `The choice for ${field} must be one of contact_ids`);
      choices[field as ContactSingleField] = id;
    }
  }
  return { ids, survivorId, choices, versions: versionOf };
}

async function staleMerge(cx: SqlExecutor, userId: string, ids: readonly string[]) {
  const contacts = await loadContacts(cx, userId, ids);
  return conflict('VERSION_CONFLICT', 'These contacts were changed since you looked at them. Check them again and repeat the merge.', { contacts });
}

/**
 * Merges the contacts in one transaction: locks them (in id order, so two
 * overlapping merges wait for each other instead of deadlocking), checks
 * their versions and the choices, writes the survivor, puts the others in
 * the bin, keeps their UIDs as aliases of the survivor and moves their
 * "Not the same person" pairs onto it. No file is touched.
 */
async function mergeLocked(cx: SqlExecutor, userId: string, { ids, survivorId, choices, versions, resolve }: MergeInput) {
  const sorted = [...ids].sort();
  const [locked] = await cx.execute<(RowDataPacket & { id: string; version: number })[]>(
    `SELECT id, version FROM contacts WHERE user_id = ? AND id IN (${placeholders(sorted)}) ORDER BY id FOR UPDATE`, [userId, ...sorted]);
  if (locked.length !== ids.length) {
    if (!locked.length) throw notFound('CONTACT_NOT_FOUND', 'Contact not found');
    throw await staleMerge(cx, userId, ids);
  }
  if (versions && locked.some(row => Number(row.version) !== versions[row.id])) throw await staleMerge(cx, userId, ids);

  const snapshots = await snapshotContacts(cx, userId, ids);
  const members = ids.map(id => snapshots.get(id)!);
  const survivor = snapshots.get(survivorId)!;
  // A choice counts only where values differ ('display_name' stands for the
  // name); where they do not, every member with a value holds the same one.
  const conflicts = singleFieldConflicts(members.map(asFieldSource));
  const decided: Choices = {};
  for (const field of conflicts) {
    const id = choices[field] ?? (field === 'name' ? choices.display_name : undefined);
    if (!id) continue;
    if (singleFieldValue(asFieldSource(snapshots.get(id)!), field) === null) throw badRequest('INVALID_MERGE', `The contact chosen for ${field} has no value there`);
    decided[field] = id;
  }
  const missing = conflicts.filter(field => !decided[field]);
  if (missing.length && resolve === 'keep-survivor') {
    for (const field of missing) {
      const owner = [survivor, ...members.filter(member => member !== survivor)].find(member => singleFieldValue(asFieldSource(member), field) !== null);
      if (owner) decided[field] = owner.contact.id;
    }
  } else if (missing.length) throw badRequest('CHOICE_REQUIRED', 'Choose which contact\'s value to keep for each field that differs.', { conflicts: missing });

  const plan = planMerge(members, survivor, decided);
  // Refused before anything is written, so a caller's transaction stays usable.
  checkMergeLimits(plan, survivor);
  await replaceContact(cx, userId, survivorId, plan.draft, { expectedVersion: null });
  if (plan.extraProperties.length) {
    const [[{ next }]] = await cx.execute<(RowDataPacket & { next: number })[]>(
      'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM contact_properties WHERE user_id = ? AND contact_id = ?', [userId, survivorId]);
    await insertStored(cx, 'contact_properties', PROPERTY_COLUMNS.filter(column => column !== 'created_at'), plan.extraProperties.map((property, index) => ({
      ...property, id: crypto.randomUUID(), contact_id: survivorId, user_id: userId, position: Number(next) + index,
    })));
  }
  if (plan.photoFrom && plan.photoFrom !== survivor) {
    await cx.execute('DELETE FROM contact_photos WHERE user_id = ? AND contact_id = ?', [userId, survivorId]);
    await insertStored(cx, 'contact_photos', PHOTO_COLUMNS.filter(column => column !== 'created_at'), [{ ...plan.photoFrom.photo!, contact_id: survivorId }]);
  }
  const [[after]] = await cx.execute<(RowDataPacket & { version: number })[]>('SELECT version FROM contacts WHERE user_id = ? AND id = ?', [userId, survivorId]);

  const mergeId = crypto.randomUUID();
  const others = members.filter(member => member !== survivor);
  const otherIds = others.map(member => member.contact.id);

  // "Not the same person" pairs of the merged-away contacts with contacts
  // outside the group now hold for the survivor.
  const [pairs] = await cx.execute<(RowDataPacket & { contact_a: string; contact_b: string })[]>(
    `SELECT contact_a, contact_b FROM contact_duplicate_dismissals WHERE user_id = ? AND (contact_a IN (${placeholders(ids)}) OR contact_b IN (${placeholders(ids)}))`,
    [userId, ...ids, ...ids]);
  // Each merged-away contact's pairs are kept in its bin item, those inside
  // the group too, so an undo brings every one back.
  const group = new Set(ids);
  const dismissedWith = new Map<string, string[]>(otherIds.map(id => [id, []]));
  const survivorPairs = new Set<string>();
  for (const pair of pairs) {
    for (const [self, other] of [[pair.contact_a, pair.contact_b], [pair.contact_b, pair.contact_a]]) {
      if (self === survivorId && !group.has(other)) survivorPairs.add(other);
      dismissedWith.get(self)?.push(other);
    }
  }
  const added: [string, string][] = [];
  for (const other of new Set([...dismissedWith.values()].flat())) {
    if (group.has(other) || survivorPairs.has(other)) continue;
    added.push(survivorId < other ? [survivorId, other] : [other, survivorId]);
  }
  if (added.length) {
    await cx.execute(`INSERT INTO contact_duplicate_dismissals (contact_a, contact_b, user_id) VALUES ${added.map(() => '(?, ?, ?)').join(', ')}
      ON DUPLICATE KEY UPDATE user_id = user_id`, added.flatMap(([a, b]) => [a, b, userId]));
  }

  // The UIDs that pointed at the merged-away contacts, and their own UIDs, now name the survivor.
  const [aliases] = await cx.execute<(RowDataPacket & { uid_hash: string; uid: string; merge_id: string | null; contact_id: string })[]>(
    `SELECT uid_hash, uid, merge_id, contact_id FROM contact_uid_aliases WHERE user_id = ? AND contact_id IN (${placeholders(otherIds)})`, [userId, ...otherIds]);
  if (aliases.length) {
    await cx.execute(`UPDATE contact_uid_aliases SET contact_id = ? WHERE user_id = ? AND contact_id IN (${placeholders(otherIds)})`, [survivorId, userId, ...otherIds]);
  }

  const before: SurvivorBefore = { ...survivor, added_dismissals: added };
  await cx.execute(`INSERT INTO contact_merges (id, user_id, survivor_id, merged_ids, survivor_before, survivor_version_after, created_at, purge_after)
    VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL ${UNDO_DAYS} DAY)`,
  [mergeId, userId, survivorId, JSON.stringify(otherIds), JSON.stringify(before), Number(after.version)]);
  // A survivor photo the merge replaced must stay on disk for the undo: the
  // photo sweep keeps what a bin item's file_refs name, so the group's first
  // item names it too.
  const replacedPhoto = plan.photoFrom && plan.photoFrom !== survivor && survivor.photo ? [survivor.photo.sha256, survivor.photo.thumb_sha256] : [];
  for (const [index, member] of others.entries()) {
    const payload: BinContactPayload = {
      ...member,
      aliases: aliases.filter(alias => alias.contact_id === member.contact.id).map(alias => ({ uid_hash: alias.uid_hash, uid: alias.uid, merge_id: alias.merge_id })),
      dismissed_with: dismissedWith.get(member.contact.id) || [],
    };
    const own = member.photo ? [member.photo.sha256, member.photo.thumb_sha256] : [];
    const files = [...own, ...(index === 0 ? replacedPhoto : [])];
    await cx.execute(`INSERT INTO bin_items (id, user_id, module, item_type, item_id, title, reason, group_id, payload, payload_version, file_refs, deleted_at, purge_after)
      VALUES (?, ?, 'contacts', 'contact', ?, ?, 'merged', ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL ${UNDO_DAYS} DAY)`,
    [crypto.randomUUID(), userId, member.contact.id, Array.from(snapshotName(member)).slice(0, 255).join(''), mergeId, JSON.stringify(payload), PAYLOAD_VERSION,
      files.length ? JSON.stringify(files) : null]);
    await cx.execute(`INSERT INTO contact_uid_aliases (user_id, uid_hash, uid, contact_id, merge_id) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE contact_id = VALUES(contact_id), merge_id = VALUES(merge_id)`,
    [userId, member.contact.uid_hash, member.contact.uid, survivorId, mergeId]);
  }
  await cx.execute(`DELETE FROM contacts WHERE user_id = ? AND id IN (${placeholders(otherIds)})`, [userId, ...otherIds]);
  return { mergeId, mergedIds: otherIds, conflicts };
}

async function mergeContacts(userId: string, body: unknown): Promise<MergeResult> {
  const input = parseMergeRequest(body);
  const { mergeId, mergedIds } = await withTransaction(cx => mergeLocked(cx, userId, input));
  const [contact] = await loadContacts(db, userId, [input.survivorId]);
  return { merge_id: mergeId, contact: contact as ContactRecord, merged_ids: mergedIds };
}

/**
 * "Merge all high-confidence": each listed group that is still the same and
 * has `auto_merge`, each in its own transaction, keeping its first member.
 */
async function autoMerge(userId: string, body: unknown): Promise<AutoMergeResult> {
  const input = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (input.min !== undefined && input.min !== 'high') throw badRequest('INVALID_MERGE', 'Only high-confidence groups are merged automatically');
  const groupIds = input.group_ids;
  if (!Array.isArray(groupIds) || !groupIds.length || groupIds.some(id => typeof id !== 'string' || !id || id.length > 64)) {
    throw badRequest('INVALID_MERGE', 'group_ids must list duplicate groups');
  }
  if (groupIds.length > AUTO_MERGE_MAX) throw badRequest('INVALID_MERGE', `At most ${AUTO_MERGE_MAX} groups at a time`);
  // The groups as they are now: high-only groups first, then the wider ones
  // (a listed group the person saw at min=medium may be one of either).
  const high = new Map((await findDuplicates(userId, 'high')).map(group => [group.id, group]));
  let wider: Map<string, DuplicateGroup> | null = null;
  const results: AutoMergeResult['results'] = [];
  for (const groupId of [...new Set(groupIds as string[])]) {
    const group = high.get(groupId);
    if (!group) {
      wider ||= new Map((await findDuplicates(userId, 'medium')).map(item => [item.id, item]));
      results.push({ group_id: groupId, status: wider.has(groupId) ? 'needs_choice' : 'changed' });
      continue;
    }
    if (!group.auto_merge) { results.push({ group_id: groupId, status: 'needs_choice' }); continue; }
    try {
      const ids = group.members.map(person => person.id);
      const versions = Object.fromEntries(group.members.map(person => [person.id, person.version]));
      const { mergeId } = await withTransaction(cx => mergeLocked(cx, userId, { ids, survivorId: ids[0], choices: {}, versions }));
      results.push({ group_id: groupId, status: 'merged', merge_id: mergeId });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'VERSION_CONFLICT' || code === 'CONTACT_NOT_FOUND') { results.push({ group_id: groupId, status: 'changed' }); continue; }
      if (code === 'CHOICE_REQUIRED') { results.push({ group_id: groupId, status: 'needs_choice' }); continue; }
      if (code === 'TOO_MANY_VALUES') { results.push({ group_id: groupId, status: 'too_many_values' }); continue; }
      throw error;
    }
  }
  return { results };
}

// ── Recently merged and undo ───────────────────────────────────────────

type MergeRow = RowDataPacket & { id: string; survivor_id: string; merged_ids: unknown; survivor_before: string; survivor_version_after: number;
  created_at: Date | string; purge_after: Date | string; undone_at: Date | string | null; expired: number };

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

async function listMerges(userId: string, executor: SqlExecutor = db): Promise<MergeRecord[]> {
  const [merges] = await executor.execute<MergeRow[]>(`SELECT id, survivor_id, created_at, purge_after, undone_at FROM contact_merges
    WHERE user_id = ? AND purge_after > UTC_TIMESTAMP() ORDER BY created_at DESC, id LIMIT 500`, [userId]);
  if (!merges.length) return [];
  const ids = merges.map(merge => merge.id);
  const [items] = await executor.execute<(RowDataPacket & { group_id: string; item_id: string; title: string })[]>(
    `SELECT group_id, item_id, title FROM bin_items WHERE user_id = ? AND item_type = 'contact' AND group_id IN (${placeholders(ids)}) ORDER BY deleted_at, id`, [userId, ...ids]);
  const survivors = new Map((await loadContacts(executor, userId, [...new Set(merges.map(merge => merge.survivor_id))])).map(contact => [contact.id, contact.display_name]));
  return merges.map(merge => ({
    id: merge.id, survivor_id: merge.survivor_id, survivor_name: survivors.get(merge.survivor_id) ?? '',
    merged: items.filter(item => item.group_id === merge.id).map(item => ({ id: item.item_id, display_name: item.title })),
    created_at: iso(merge.created_at), purge_after: iso(merge.purge_after), undone_at: merge.undone_at ? iso(merge.undone_at) : null,
  }));
}

async function undoLocked(cx: SqlExecutor, userId: string, mergeId: string): Promise<UndoMergeResult> {
  const [[merge]] = await cx.execute<MergeRow[]>(`SELECT id, survivor_id, survivor_before, survivor_version_after, undone_at, purge_after <= UTC_TIMESTAMP() AS expired
    FROM contact_merges WHERE id = ? AND user_id = ? FOR UPDATE`, [mergeId, userId]);
  if (!merge) throw notFound('MERGE_NOT_FOUND', 'Merge not found');
  if (merge.undone_at) throw conflict('ALREADY_UNDONE', 'This merge was already undone.');
  if (Number(merge.expired)) throw conflict('UNDO_EXPIRED', 'This merge is older than 30 days and can no longer be undone.');
  const [items] = await cx.execute<(RowDataPacket & { id: string; payload: string })[]>(
    `SELECT id, payload FROM bin_items WHERE user_id = ? AND group_id = ? AND item_type = 'contact' AND restored_at IS NULL ORDER BY deleted_at, id FOR UPDATE`, [userId, mergeId]);
  const [[survivor]] = await cx.execute<(RowDataPacket & { version: number })[]>('SELECT version FROM contacts WHERE id = ? AND user_id = ? FOR UPDATE', [merge.survivor_id, userId]);

  const restoredIds: string[] = [];
  const newIds = new Map<string, string>();
  const restoredPairs: [string, string[]][] = [];
  for (const item of items) {
    const payload = parseJson<BinContactPayload>(item.payload);
    if (!payload?.contact) throw new Error(`Bin item ${item.id} has no contact payload`);
    const original = payload.contact;
    // A restore may have brought the contact back meanwhile: the copy from
    // the bin then comes back beside it, under a new id and, if the UID is
    // taken, a new UID.
    const [[idTaken]] = await cx.execute<RowDataPacket[]>('SELECT id FROM contacts WHERE id = ?', [original.id]);
    const id = idTaken ? crypto.randomUUID() : original.id;
    const [[uidTaken]] = await cx.execute<RowDataPacket[]>('SELECT id FROM contacts WHERE user_id = ? AND uid_hash = ?', [userId, original.uid_hash]);
    const uid = uidTaken ? newUid(id) : original.uid;
    await insertStored(cx, 'contacts', CONTACT_COLUMNS, [{ ...original, id, user_id: userId, uid, uid_hash: uidTaken ? uidHash(uid) : original.uid_hash }]);
    await insertChildren(cx, id, payload);
    // The UIDs it held as aliases come back to it from the survivor.
    const held = (payload.aliases || []).map(alias => alias.uid_hash);
    if (held.length) {
      await cx.execute(`UPDATE contact_uid_aliases SET contact_id = ? WHERE user_id = ? AND contact_id = ? AND uid_hash IN (${placeholders(held)})`,
        [id, userId, merge.survivor_id, ...held]);
    }
    newIds.set(original.id, id);
    restoredPairs.push([id, payload.dismissed_with || []]);
    restoredIds.push(id);
  }
  // "Not the same person" pairs come back once every contact of the group is back.
  for (const [id, others] of restoredPairs) {
    const targets = [...new Set(others.map(other => newIds.get(other) ?? other))].filter(other => other !== id);
    if (!targets.length) continue;
    const [present] = await cx.execute<(RowDataPacket & { id: string })[]>(`SELECT id FROM contacts WHERE user_id = ? AND id IN (${placeholders(targets)})`, [userId, ...targets]);
    if (!present.length) continue;
    await cx.execute(`INSERT INTO contact_duplicate_dismissals (contact_a, contact_b, user_id) VALUES ${present.map(() => '(?, ?, ?)').join(', ')}
      ON DUPLICATE KEY UPDATE user_id = user_id`, present.flatMap(row => [id < row.id ? id : row.id, id < row.id ? row.id : id, userId]));
  }

  const before = parseJson<SurvivorBefore>(merge.survivor_before);
  let survivorRestored = false;
  if (survivor && before?.contact) {
    for (const [a, b] of before.added_dismissals || []) {
      await cx.execute('DELETE FROM contact_duplicate_dismissals WHERE user_id = ? AND contact_a = ? AND contact_b = ?', [userId, a, b]);
    }
    // Unchanged since the merge: it goes back to how it was, as a new version.
    if (Number(survivor.version) === Number(merge.survivor_version_after)) {
      const columns = CONTACT_COLUMNS.filter(column => !['id', 'user_id', 'uid', 'uid_hash', 'version', 'created_at', 'updated_at'].includes(column));
      await cx.execute(`UPDATE contacts SET ${columns.map(column => `${column} = ?`).join(', ')}, version = version + 1 WHERE id = ? AND user_id = ?`,
        [...columns.map(column => sqlValue(column, before.contact[column])), merge.survivor_id, userId] as (string | number | Date | null)[]);
      for (const table of ['contact_values', 'contact_properties', 'contact_photos']) {
        await cx.execute(`DELETE FROM ${table} WHERE user_id = ? AND contact_id = ?`, [userId, merge.survivor_id]);
      }
      await insertChildren(cx, merge.survivor_id, before);
      survivorRestored = true;
    }
  }
  await cx.execute('DELETE FROM contact_uid_aliases WHERE user_id = ? AND merge_id = ?', [userId, mergeId]);
  // The contacts live again; their copies in the bin and the survivor's
  // snapshot are not kept beside them.
  await cx.execute(`UPDATE bin_items SET restored_at = UTC_TIMESTAMP(), payload = '{}', file_refs = NULL WHERE user_id = ? AND group_id = ?`, [userId, mergeId]);
  await cx.execute(`UPDATE contact_merges SET undone_at = UTC_TIMESTAMP(), survivor_before = '{}' WHERE id = ? AND user_id = ?`, [mergeId, userId]);

  const name = before?.contact ? snapshotName(before) : '';
  return {
    restored_ids: restoredIds,
    survivor_restored: survivorRestored,
    message: survivorRestored ? 'The contacts are back as they were before the merge.'
      : survivor ? `Kept the later changes to ${name || 'the merged contact'}; the restored contacts are back as they were.`
        : 'The restored contacts are back as they were; the merged contact was deleted since.',
  };
}

async function undoMerge(userId: string, mergeId: string): Promise<UndoMergeResult> {
  return withTransaction(cx => undoLocked(cx, userId, mergeId));
}

// ── Purge (worker owner) ───────────────────────────────────────────────

interface PurgeOptions {
  now?: Date;
  executor?: SqlExecutor;
  /** Per user: false while the Contacts module is off, so its bin waits too. */
  moduleEnabled?: (userId: string) => Promise<boolean>;
  /** Stops between users (the worker lost its lock or shuts down). */
  active?: () => boolean;
}

/**
 * Deletes the contacts bin items and merge records past their purge time,
 * as the retention job of the worker owner (contacts.purgeBin). It skips the
 * people whose contacts are being restored or whose Contacts module is off.
 * The aliases stay: a later import still finds the survivor.
 */
async function purgeExpiredMerges({ now = new Date(), executor = db, moduleEnabled = userId => isModuleEnabled(userId, 'contacts'), active = () => true }: PurgeOptions = {}) {
  const [due] = await executor.execute<(RowDataPacket & { user_id: string })[]>(`SELECT user_id FROM bin_items WHERE module = 'contacts' AND purge_after IS NOT NULL AND purge_after <= ?
    UNION SELECT user_id FROM contact_merges WHERE purge_after <= ?`, [now, now]);
  if (!due.length) return { items: 0, merges: 0 };
  const restoring = await getActiveRestoreSectionsByUser(executor);
  let items = 0; let merges = 0;
  for (const { user_id: userId } of due) {
    if (!active()) break;
    if (restoring.get(userId)?.has('contacts') || !await moduleEnabled(userId)) continue;
    for (;;) {
      const [expired] = await executor.execute<(RowDataPacket & { id: string })[]>(
        `SELECT id FROM contact_merges WHERE user_id = ? AND purge_after <= ? ORDER BY purge_after, id LIMIT ${PURGE_BATCH}`, [userId, now]);
      if (!expired.length) break;
      const ids = expired.map(row => row.id);
      await executor.execute(`UPDATE contact_uid_aliases SET merge_id = NULL WHERE user_id = ? AND merge_id IN (${placeholders(ids)})`, [userId, ...ids]);
      const [removed] = await executor.execute<ResultSetHeader>(`DELETE FROM contact_merges WHERE user_id = ? AND id IN (${placeholders(ids)})`, [userId, ...ids]);
      merges += removed.affectedRows || 0;
      if (expired.length < PURGE_BATCH) break;
    }
    for (;;) {
      const [removed] = await executor.execute<ResultSetHeader>(`DELETE FROM bin_items WHERE user_id = ? AND module = 'contacts' AND purge_after IS NOT NULL AND purge_after <= ?
        ORDER BY purge_after, id LIMIT ${PURGE_BATCH}`, [userId, now]);
      items += removed.affectedRows || 0;
      if ((removed.affectedRows || 0) < PURGE_BATCH) break;
    }
  }
  return { items, merges };
}

/**
 * Photo hashes the bin and the merge records still need, for the photo
 * sweeper: a merged-away contact's photo and a survivor's photo before the
 * merge stay on disk until their undo window ends.
 */
async function photosHeldForUndo(userId: string, executor: SqlExecutor = db): Promise<Set<string>> {
  const [items] = await executor.execute<(RowDataPacket & { file_refs: unknown })[]>(
    "SELECT file_refs FROM bin_items WHERE user_id = ? AND module = 'contacts' AND restored_at IS NULL AND file_refs IS NOT NULL", [userId]);
  const [merges] = await executor.execute<(RowDataPacket & { survivor_before: string })[]>(
    'SELECT survivor_before FROM contact_merges WHERE user_id = ? AND undone_at IS NULL', [userId]);
  const held = new Set<string>();
  for (const item of items) for (const hash of parseJson<string[]>(item.file_refs) || []) if (typeof hash === 'string') held.add(hash);
  for (const merge of merges) {
    const photo = parseJson<SurvivorBefore>(merge.survivor_before)?.photo;
    if (photo) { held.add(photo.sha256); held.add(photo.thumb_sha256); }
  }
  return held;
}

export {
  mergeContacts,
  mergeLocked,
  autoMerge,
  listMerges,
  undoMerge,
  purgeExpiredMerges,
  photosHeldForUndo,
  parseMergeRequest,
  UNDO_DAYS,
};
export type { BinContactPayload, SurvivorBefore, ContactSnapshot };
