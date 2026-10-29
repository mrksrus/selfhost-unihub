// The contact store (F12): the one place that reads and writes contacts with
// their labelled values and kept properties, checks the input contract (D17)
// and answers the 3+3 projection old apps read (P-21). Routes, the import,
// merges and restore call it; none of them writes contact_values itself.
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type {
  Address, ContactRecord, ContactDetail, ContactValueKind, KeptProperty, LabelledValue, LegacyContactFields, MergedAway, PartialDate,
} from '../contracts/contacts';
import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, conflict, notFound } from '../http/errors';
import { escapeLike } from './sql';
import { withTransaction } from './transactions';
import { nameKey, valueKey } from './contact-keys';

// ── Input contract (D17) ───────────────────────────────────────────────

const LABELS: Readonly<Record<ContactValueKind, ReadonlySet<string>>> = {
  email: new Set(['', 'home', 'work', 'mobile', 'other', 'custom']),
  phone: new Set(['', 'mobile', 'home', 'work', 'main', 'home_fax', 'work_fax', 'other_fax', 'pager', 'work_mobile', 'work_pager',
    'callback', 'car', 'company_main', 'isdn', 'radio', 'telex', 'tty_tdd', 'assistant', 'mms', 'other', 'custom']),
  address: new Set(['', 'home', 'work', 'other', 'custom']),
  url: new Set(['', 'homepage', 'blog', 'profile', 'home', 'work', 'ftp', 'other', 'custom']),
  impp: new Set(['', 'home', 'work', 'other', 'custom']),
  related: new Set(['', 'assistant', 'brother', 'child', 'domestic_partner', 'father', 'friend', 'manager', 'mother', 'parent', 'partner',
    'referred_by', 'relative', 'sister', 'spouse', 'contact', 'acquaintance', 'met', 'co_worker', 'colleague', 'co_resident', 'neighbor',
    'sibling', 'kin', 'muse', 'crush', 'date', 'sweetheart', 'me', 'agent', 'emergency', 'other', 'custom']),
  nickname: new Set(['', 'other_name', 'maiden_name', 'short_name', 'initials', 'custom']),
  category: new Set(['']),
};
const VALUE_KINDS = Object.keys(LABELS) as ContactValueKind[];
const VALUE_LIMITS: Readonly<Record<ContactValueKind, number>> = { email: 255, phone: 64, address: 2048, url: 2048, impp: 2048, related: 2048, nickname: 255, category: 255 };
const KIND_NAMES: Readonly<Record<ContactValueKind, string>> = {
  email: 'Email', phone: 'Phone', address: 'Address', url: 'Web address', impp: 'Messaging address', related: 'Related person', nickname: 'Nickname', category: 'Category',
};
// The body keys of each shape; the contact's list fields by kind.
const LIST_KEYS: Readonly<Record<string, ContactValueKind>> = {
  emails: 'email', phones: 'phone', addresses: 'address', urls: 'url', impp: 'impp', related: 'related', nicknames: 'nickname', categories: 'category',
};
const FULL_KEYS = new Set(['version', 'name', 'organization', 'birthday', 'anniversary', 'kept_properties', ...Object.keys(LIST_KEYS)]);
const LEGACY_KEYS = new Set(['first_name', 'last_name', 'email', 'email2', 'email3', 'phone', 'phone2', 'phone3', 'company']);
const LEGACY_SLOTS = { email: ['email', 'email2', 'email3'], phone: ['phone', 'phone2', 'phone3'] } as const;
const TEXT_MAX = 255;
const STREET_MAX = 1000;
const CUSTOM_LABEL_MAX = 100;
const NOTES_MAX_BYTES = 65535;
const VALUES_PER_KIND = 100;
const KEPT_PROPERTIES_MAX = 500;
const KEPT_PROPERTIES_MAX_BYTES = 256 * 1024;
const ADDRESS_PARTS = ['po_box', 'extended', 'street', 'locality', 'region', 'postal_code', 'country'] as const;
const ADDRESS_PART_NAMES: Readonly<Record<typeof ADDRESS_PARTS[number], string>> = {
  po_box: 'Post office box', extended: 'Extended address', street: 'Street', locality: 'City', region: 'Region', postal_code: 'Postal code', country: 'Country',
};
const LEGACY_FIELD_NAMES: Readonly<Record<string, string>> = {
  first_name: 'First name', last_name: 'Last name', email: 'Email', email2: 'Second email', email3: 'Third email',
  phone: 'Phone', phone2: 'Second phone', phone3: 'Third phone', company: 'Company', job_title: 'Job title', notes: 'Notes',
};

type AddressPart = typeof ADDRESS_PARTS[number];
interface ValueDraft extends Partial<Record<AddressPart, string | null>> {
  id?: string | null;
  kind: ContactValueKind;
  label: string;
  custom_label: string | null;
  value: string;
  preferred: boolean;
  params?: unknown;
  vcard_group?: string | null;
}
/** A contact's content as it is written (the stored columns plus its values). */
interface ContactDraft {
  display_name: string | null;
  first_name: string;
  last_name: string | null;
  middle_name: string | null;
  name_prefix: string | null;
  name_suffix: string | null;
  company: string | null;
  department: string | null;
  job_title: string | null;
  birthday: string | null;
  anniversary: string | null;
  notes: string | null;
  is_favorite?: boolean;
  values: ValueDraft[];
}
/** A vCard property kept as parsed (the import's lossless remainder). */
interface KeptPropertyDraft {
  name: string;
  group?: string | null;
  params?: Record<string, string | string[]> | null;
  value: string;
  source_version?: string | null;
}
type LegacyFields = Record<keyof LegacyContactFields | 'job_title' | 'notes', string | null>;
type ParsedBody =
  | { shape: 'full'; draft: ContactDraft; version: number | null; clearKept: boolean }
  | { shape: 'legacy'; fields: LegacyFields };

const invalid = (message: string) => badRequest('INVALID_CONTACT', message);
// A lone UTF-16 surrogate cannot be stored as utf8mb4 (MariaDB would answer 500).
const LONE_SURROGATE = /\p{Cs}/u;
const characters = (text: string) => Array.from(text).length;

// Absent or null is empty; a string is trimmed (notes keep their inner
// whitespace); a finite number is its decimal text; anything else is refused.
function textInput(value: unknown, field: string, max: number, { notes = false } = {}): string | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(`${field} must be text`);
    value = String(value);
  }
  if (typeof value !== 'string') throw invalid(`${field} must be text`);
  if (LONE_SURROGATE.test(value)) throw invalid(`${field} contains invalid characters`);
  if (!value.trim()) return null;
  const text = notes ? value : value.trim();
  if (notes ? Buffer.byteLength(text, 'utf8') > max : characters(text) > max) {
    throw invalid(`${field} is too long (at most ${max} ${notes ? 'bytes' : 'characters'})`);
  }
  return text;
}

function booleanInput(value: unknown, field: string, fallback: boolean) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw invalid(`${field} must be true or false`);
  return value;
}

function objectInput(value: unknown, field: string): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

const isLeapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// `YYYY-MM-DD`, `--MM-DD` (no year; --02-29 is allowed) or { year?, month, day }.
function dateInput(value: unknown, field: string): string | null {
  if (value == null || value === '') return null;
  let year: number | null; let month: number; let day: number;
  if (typeof value === 'string') {
    const match = /^(?:(\d{4})|--)-?(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match || (!match[1] && !value.trim().startsWith('--'))) throw invalid(`${field} must be a date (YYYY-MM-DD or --MM-DD)`);
    [year, month, day] = [match[1] ? Number(match[1]) : null, Number(match[2]), Number(match[3])];
  } else if (typeof value === 'object' && !Array.isArray(value)) {
    const parts = value as Record<string, unknown>;
    if (![parts.month, parts.day].every(Number.isInteger) || !(parts.year == null || Number.isInteger(parts.year))) throw invalid(`${field} must be a date (YYYY-MM-DD or --MM-DD)`);
    [year, month, day] = [parts.year == null ? null : parts.year as number, parts.month as number, parts.day as number];
  } else throw invalid(`${field} must be a date (YYYY-MM-DD or --MM-DD)`);
  const valid = month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]
    && (year === null || (year >= 1 && year <= 9999 && (month !== 2 || day !== 29 || isLeapYear(year))));
  if (!valid) throw invalid(`${field} is not a real date`);
  const mmdd = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return year === null ? `--${mmdd}` : `${String(year).padStart(4, '0')}-${mmdd}`;
}

function labelInput(kind: ContactValueKind, item: Record<string, unknown>, field: string) {
  const raw = item.label == null ? '' : item.label;
  if (typeof raw !== 'string') throw invalid(`${field} label must be text`);
  const label = raw.trim().toLowerCase().replace(/-/g, '_');
  if (!LABELS[kind].has(label)) throw invalid(`${field} label "${raw.slice(0, 32)}" is not one of its labels`);
  if (label !== 'custom') return { label, custom_label: null };
  const custom = textInput(item.custom_label, `${field} custom label`, CUSTOM_LABEL_MAX);
  if (!custom) throw invalid(`${field} needs a custom label`);
  return { label, custom_label: custom };
}

function formatAddress(parts: Partial<Record<AddressPart, string | null>>) {
  const city = [parts.postal_code, parts.locality].filter(Boolean).join(' ');
  const text = [parts.po_box, parts.extended, parts.street, city, parts.region, parts.country].filter(Boolean).join('\n');
  return Array.from(text).slice(0, VALUE_LIMITS.address).join('');
}

function valuesInput(kind: ContactValueKind, list: unknown): ValueDraft[] {
  const field = KIND_NAMES[kind];
  if (list == null) return [];
  if (!Array.isArray(list)) throw invalid(`${field} values must be a list`);
  const drafts: ValueDraft[] = [];
  for (const entry of list) {
    if (entry == null || entry === '') continue;
    const item = typeof entry === 'string' || typeof entry === 'number' ? { value: entry } : entry;
    if (typeof item !== 'object' || Array.isArray(item)) throw invalid(`${field} must be text`);
    const source = item as Record<string, unknown>;
    const id = typeof source.id === 'string' && source.id.length <= 36 ? source.id : null;
    let draft: ValueDraft;
    if (kind === 'address') {
      const parts = Object.fromEntries(ADDRESS_PARTS.map(part => [part,
        textInput(source[part], ADDRESS_PART_NAMES[part], part === 'street' ? STREET_MAX : TEXT_MAX)])) as Record<AddressPart, string | null>;
      // A free-text address without parts is kept as its street.
      if (!ADDRESS_PARTS.some(part => parts[part])) parts.street = textInput(source.value, ADDRESS_PART_NAMES.street, STREET_MAX);
      if (!ADDRESS_PARTS.some(part => parts[part])) continue;
      draft = { id, kind, ...labelInput(kind, source, field), value: formatAddress(parts), preferred: booleanInput(source.preferred, `${field} preferred`, false), ...parts };
    } else {
      const value = textInput(source.value, field, VALUE_LIMITS[kind]);
      if (!value) continue;
      draft = { id, kind, ...(kind === 'category' ? { label: '', custom_label: null } : labelInput(kind, source, field)), value,
        preferred: kind === 'category' ? false : booleanInput(source.preferred, `${field} preferred`, false) };
    }
    drafts.push(draft);
  }
  if (drafts.length > VALUES_PER_KIND) throw invalid(`At most ${VALUES_PER_KIND} values per field (${field})`);
  return drafts;
}

function fullDraft(input: Record<string, unknown>): ContactDraft {
  const name = objectInput(input.name, 'Name');
  const organization = objectInput(input.organization, 'Organisation');
  return {
    display_name: textInput(name.display, 'Display name', TEXT_MAX),
    first_name: textInput(name.given, 'First name', TEXT_MAX) || '',
    last_name: textInput(name.family, 'Last name', TEXT_MAX),
    middle_name: textInput(name.middle, 'Middle name', TEXT_MAX),
    name_prefix: textInput(name.prefix, 'Name prefix', TEXT_MAX),
    name_suffix: textInput(name.suffix, 'Name suffix', TEXT_MAX),
    company: textInput(organization.name, 'Organisation', TEXT_MAX),
    department: textInput(organization.department, 'Department', TEXT_MAX),
    job_title: textInput(input.job_title, 'Job title', TEXT_MAX),
    birthday: dateInput(input.birthday, 'Birthday'),
    anniversary: dateInput(input.anniversary, 'Anniversary'),
    notes: textInput(input.notes, 'Notes', NOTES_MAX_BYTES, { notes: true }),
    ...(input.is_favorite === undefined ? {} : { is_favorite: booleanInput(input.is_favorite, 'Favorite', false) }),
    values: VALUE_KINDS.flatMap(kind => valuesInput(kind, input[Object.keys(LIST_KEYS).find(key => LIST_KEYS[key] === kind)!])),
  };
}

function legacyFields(input: Record<string, unknown>): LegacyFields {
  return Object.fromEntries(Object.entries(LEGACY_FIELD_NAMES).map(([field, label]) => [field,
    textInput(input[field], label, field.startsWith('phone') ? VALUE_LIMITS.phone : field.startsWith('email') ? VALUE_LIMITS.email : field === 'notes' ? NOTES_MAX_BYTES : TEXT_MAX,
      { notes: field === 'notes' })])) as LegacyFields;
}

// The two shapes of a create or update body. Unknown top-level keys are
// ignored (as in 0.23); a body holding keys of both shapes is refused.
function parseContactBody(body: unknown, { create }: { create: boolean }): ParsedBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Contact fields are required');
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input).filter(key => input[key] !== undefined);
  const full = keys.some(key => FULL_KEYS.has(key));
  if (full && keys.some(key => LEGACY_KEYS.has(key))) throw invalid('Send either the contact fields or the older flat fields, not both');
  if (!full) {
    const fields = legacyFields(input);
    // Unchanged for hand-written 0.23 clients (D17).
    if (create && !fields.first_name) throw invalid('First name is required');
    return { shape: 'legacy', fields };
  }
  const draft = fullDraft(input);
  if (create && !draft.display_name && !draft.first_name && !draft.last_name && !draft.middle_name && !draft.company
      && !draft.values.some(value => value.kind === 'email' || value.kind === 'phone')) {
    throw invalid('A contact needs a name, an organisation, an email or a phone number');
  }
  let version: number | null = null;
  if (input.version != null) {
    if (!Number.isSafeInteger(input.version) || (input.version as number) < 1) throw invalid('version must be a positive whole number');
    version = input.version as number;
  }
  if (input.kept_properties !== undefined && input.kept_properties !== 'clear') throw invalid('kept_properties can only be "clear"');
  return { shape: 'full', draft, version, clearKept: input.kept_properties === 'clear' };
}

// If-Match: "3", W/"3" or 3.
function versionFromHeader(header: unknown): number | null {
  if (typeof header !== 'string' || !header.trim()) return null;
  const match = /^(?:W\/)?"?(\d{1,9})"?$/.exec(header.trim());
  if (!match) throw invalid('If-Match must name the contact version, for example "3"');
  return Number(match[1]);
}

// ── Reading ────────────────────────────────────────────────────────────

type ContactRow = RowDataPacket & {
  id: string; user_id: string; uid: string; version: number; display_name: string | null; first_name: string; last_name: string | null;
  middle_name: string | null; name_prefix: string | null; name_suffix: string | null; company: string | null; department: string | null;
  job_title: string | null; birthday: string | null; anniversary: string | null; notes: string | null; is_favorite: number | boolean | null;
  created_at: Date | string; updated_at: Date | string;
};
type ValueRow = RowDataPacket & ValueDraft & { id: string; contact_id: string; position: number; is_preferred: number; value_key: string };
type PhotoRow = RowDataPacket & { contact_id: string; sha256: string; width: number; height: number };

const CONTACT_COLUMNS = 'c.id, c.user_id, c.uid, c.version, c.display_name, c.first_name, c.last_name, c.middle_name, c.name_prefix, c.name_suffix, c.company, c.department, c.job_title, c.birthday, c.anniversary, c.notes, c.is_favorite, c.created_at, c.updated_at';
const VALUE_COLUMNS = 'id, contact_id, kind, position, is_preferred, label, custom_label, value, value_key, po_box, extended, street, locality, region, postal_code, country, params, vcard_group';

function partialDate(stored: string | null): PartialDate | null {
  const match = stored ? /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(stored) : null;
  return match ? { year: match[1] ? Number(match[1]) : null, month: Number(match[2]), day: Number(match[3]) } : null;
}
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : String(value);

function labelled(row: ValueRow): LabelledValue {
  return { id: row.id, value: row.value, label: row.label, custom_label: row.custom_label ?? null, preferred: !!row.is_preferred };
}

function displayName(row: Pick<ContactRow, 'display_name' | 'first_name' | 'middle_name' | 'last_name' | 'company'>, values: readonly { kind: string; value: string }[]) {
  return row.display_name
    || [row.first_name, row.middle_name, row.last_name].filter(part => part && part.trim()).join(' ')
    || row.company
    || values.find(value => value.kind === 'email')?.value.trim()
    || values.find(value => value.kind === 'phone')?.value.trim()
    || '';
}

// The first three values by position, for the 3+3 apps; a contact known
// only by its display name shows it as the first name.
function legacyProjection(row: ContactRow, values: readonly ValueRow[]): LegacyContactFields {
  const first = (kind: 'email' | 'phone') => values.filter(value => value.kind === kind).slice(0, 3).map(value => value.value);
  const [emails, phones] = [first('email'), first('phone')];
  return {
    first_name: row.first_name || (!row.last_name && row.display_name) || '',
    last_name: row.last_name, company: row.company,
    email: emails[0] ?? null, email2: emails[1] ?? null, email3: emails[2] ?? null,
    phone: phones[0] ?? null, phone2: phones[1] ?? null, phone3: phones[2] ?? null,
  };
}

function presentContact(row: ContactRow, values: readonly ValueRow[], keptCount: number, photo: PhotoRow | undefined): ContactRecord {
  const of = (kind: ContactValueKind) => values.filter(value => value.kind === kind);
  return {
    id: row.id, uid: row.uid, version: Number(row.version),
    display_name: displayName(row, values),
    name: { display: row.display_name, given: row.first_name || null, family: row.last_name, middle: row.middle_name, prefix: row.name_prefix, suffix: row.name_suffix },
    organization: { name: row.company, department: row.department },
    job_title: row.job_title,
    birthday: partialDate(row.birthday), anniversary: partialDate(row.anniversary),
    notes: row.notes, is_favorite: !!row.is_favorite,
    emails: of('email').map(labelled) as ContactRecord['emails'],
    phones: of('phone').map(labelled) as ContactRecord['phones'],
    addresses: of('address').map(value => ({ ...labelled(value), ...Object.fromEntries(ADDRESS_PARTS.map(part => [part, value[part] ?? null])) }) as Address),
    urls: of('url').map(labelled) as ContactRecord['urls'],
    impp: of('impp').map(labelled) as ContactRecord['impp'],
    related: of('related').map(labelled) as ContactRecord['related'],
    nicknames: of('nickname').map(labelled) as ContactRecord['nicknames'],
    categories: of('category').map(value => value.value),
    photo: photo ? { etag: photo.sha256, width: Number(photo.width), height: Number(photo.height) } : null,
    kept_properties: keptCount,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
    ...legacyProjection(row, values),
  } as ContactRecord;
}

const placeholders = (items: readonly unknown[]) => items.map(() => '?').join(', ');

// The contacts of `rows` with their values, kept-property counts and photos,
// in the order given. All lookups are scoped to the owner.
async function hydrate(executor: SqlExecutor, userId: string, rows: readonly ContactRow[]): Promise<ContactRecord[]> {
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  const [values] = await executor.execute<ValueRow[]>(`SELECT ${VALUE_COLUMNS} FROM contact_values WHERE user_id = ? AND contact_id IN (${placeholders(ids)})
    ORDER BY contact_id, kind, position, id`, [userId, ...ids]);
  const [kept] = await executor.execute<(RowDataPacket & { contact_id: string; n: number | string })[]>(`SELECT contact_id, COUNT(*) AS n FROM contact_properties
    WHERE user_id = ? AND contact_id IN (${placeholders(ids)}) GROUP BY contact_id`, [userId, ...ids]);
  const [photos] = await executor.execute<PhotoRow[]>(`SELECT contact_id, sha256, width, height FROM contact_photos WHERE user_id = ? AND contact_id IN (${placeholders(ids)})`, [userId, ...ids]);
  const valuesBy = new Map<string, ValueRow[]>();
  for (const value of values) { const list = valuesBy.get(value.contact_id) || []; list.push(value); valuesBy.set(value.contact_id, list); }
  const keptBy = new Map(kept.map(row => [row.contact_id, Number(row.n)]));
  const photoBy = new Map(photos.map(row => [row.contact_id, row]));
  return rows.map(row => presentContact(row, valuesBy.get(row.id) || [], keptBy.get(row.id) || 0, photoBy.get(row.id)));
}

const LOAD_CHUNK = 1000;

async function loadContacts(executor: SqlExecutor, userId: string, ids: readonly string[]): Promise<ContactRecord[]> {
  if (!ids.length) return [];
  if (ids.length > LOAD_CHUNK) {
    const loaded: ContactRecord[] = [];
    for (let start = 0; start < ids.length; start += LOAD_CHUNK) loaded.push(...await loadContacts(executor, userId, ids.slice(start, start + LOAD_CHUNK)));
    return loaded;
  }
  const [rows] = await executor.execute<ContactRow[]>(`SELECT ${CONTACT_COLUMNS} FROM contacts c WHERE c.user_id = ? AND c.id IN (${placeholders(ids)})`, [userId, ...ids]);
  const byId = new Map(rows.map(row => [row.id, row]));
  return hydrate(executor, userId, ids.map(id => byId.get(id)).filter((row): row is ContactRow => !!row));
}

async function getContact(userId: string, id: string, executor: SqlExecutor = db): Promise<ContactDetail> {
  const [contact] = await loadContacts(executor, userId, [id]);
  if (!contact) throw notFound('CONTACT_NOT_FOUND', 'Contact not found');
  const [properties] = await executor.execute<(RowDataPacket & { name: string; vcard_group: string | null; params: unknown; value: string })[]>(
    'SELECT name, vcard_group, params, value FROM contact_properties WHERE user_id = ? AND contact_id = ? ORDER BY position, id', [userId, id]);
  return { ...contact, properties: properties.map((row): KeptProperty => ({ name: row.name, group: row.vcard_group, params: parseJson(row.params), value: row.value })) };
}

function parseJson(value: unknown) {
  if (value == null) return null;
  if (typeof value !== 'string') return value as KeptProperty['params'];
  try { return JSON.parse(value); } catch { return null; }
}

// Digits of a query that looks like a phone number, without the trunk or
// international zeros, so "0171 12" finds "+49 171 12…".
function phoneQueryDigits(q: string) {
  if (!/^[\d\s+\-()./]+$/.test(q)) return null;
  const digits = q.replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 3 ? digits : null;
}

/**
 * The search condition on contacts aliased `c`: name parts and the whole
 * name, display name, organisation, department, emails, nicknames,
 * categories and phone numbers (as written, and by digits). Accents and case
 * follow the column collation. Shared by the list and global search.
 */
function contactSearchCondition(q: string) {
  const like = `%${escapeLike(q)}%`;
  const parts = ['c.first_name LIKE ?', 'c.last_name LIKE ?', 'c.middle_name LIKE ?', "CONCAT_WS(' ', NULLIF(c.first_name, ''), c.middle_name, c.last_name) LIKE ?",
    'c.display_name LIKE ?', 'c.company LIKE ?', 'c.department LIKE ?',
    "EXISTS (SELECT 1 FROM contact_values sv WHERE sv.contact_id = c.id AND sv.kind IN ('email', 'phone', 'nickname', 'category') AND sv.value LIKE ?)"];
  const params = Array(parts.length).fill(like);
  const digits = phoneQueryDigits(q);
  if (digits) {
    parts.push("EXISTS (SELECT 1 FROM contact_values sp WHERE sp.contact_id = c.id AND sp.kind = 'phone' AND sp.value_key LIKE ?)");
    params.push(`%${digits}%`);
  }
  return { sql: `(${parts.join(' OR ')})`, params: params as string[] };
}

const HAS_NAME = "(c.first_name <> '' OR COALESCE(c.last_name, '') <> '' OR COALESCE(c.middle_name, '') <> '' OR COALESCE(c.display_name, '') <> '')";
const HAS_ADDRESS = "EXISTS (SELECT 1 FROM contact_values ga WHERE ga.contact_id = c.id AND ga.kind IN ('email', 'phone'))";

interface ListQuery { q?: string; group?: string; limit?: number; offset?: number; includeMerged?: boolean }

async function listContacts(userId: string, { q = '', group = 'all', limit = 2000, offset = 0, includeMerged = false }: ListQuery, executor: SqlExecutor = db) {
  let where = 'c.user_id = ?';
  const params: string[] = [userId];
  if (group === 'name_only') where += ` AND ${HAS_NAME} AND NOT ${HAS_ADDRESS}`;
  else if (group === 'number_or_email_only') where += ` AND ${HAS_ADDRESS} AND NOT ${HAS_NAME}`;
  if (q) { const search = contactSearchCondition(q); where += ` AND ${search.sql}`; params.push(...search.params); }
  // LIMIT as literals (mysql2 refuses placeholders there); both bounded by the caller.
  const [rows] = await executor.execute<ContactRow[]>(`SELECT ${CONTACT_COLUMNS} FROM contacts c WHERE ${where}
    ORDER BY c.is_favorite DESC, c.first_name ASC, c.last_name ASC, c.id ASC LIMIT ${limit + 1} OFFSET ${offset}`, params);
  const contacts = await hydrate(executor, userId, rows.slice(0, limit));
  return { contacts, has_more: rows.length > limit, offset, ...(includeMerged ? { merged: await recentMerges(executor, userId) } : {}) };
}

// Contacts merged away in the last 30 days and not brought back, so a phone
// removes its copies instead of adding them again.
async function recentMerges(executor: SqlExecutor, userId: string): Promise<MergedAway[]> {
  const [rows] = await executor.execute<(RowDataPacket & { survivor_id: string; merged_ids: unknown; created_at: Date | string })[]>(
    `SELECT survivor_id, merged_ids, created_at FROM contact_merges WHERE user_id = ? AND undone_at IS NULL AND created_at > UTC_TIMESTAMP() - INTERVAL 30 DAY ORDER BY created_at, id`, [userId]);
  return rows.flatMap(row => {
    const ids = parseJson(row.merged_ids);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').map(id => ({ id, into: row.survivor_id, at: iso(row.created_at) })) : [];
  });
}

// ── Writing ────────────────────────────────────────────────────────────

const newUid = (id: string) => `urn:uuid:${id}`;
const uidHash = (uid: string) => crypto.createHash('sha256').update(uid, 'utf8').digest('hex');

function draftNameKey(draft: Pick<ContactDraft, 'first_name' | 'middle_name' | 'last_name' | 'display_name'>) {
  return nameKey({ given: draft.first_name, middle: draft.middle_name, family: draft.last_name, display: draft.display_name });
}

// Writes the values of the given kinds as listed: rows of those kinds not in
// the list go, the rest are written again at their new positions. A draft id
// that names one of this contact's rows of the same kind keeps that row's id
// and its import details (params, group); any other id is replaced.
async function writeValues(cx: SqlExecutor, userId: string, contactId: string, kinds: readonly ContactValueKind[], drafts: readonly ValueDraft[]) {
  const [existing] = await cx.execute<ValueRow[]>(`SELECT ${VALUE_COLUMNS} FROM contact_values WHERE user_id = ? AND contact_id = ?`, [userId, contactId]);
  const own = new Map(existing.map(row => [row.id, row]));
  if (kinds.length) await cx.execute(`DELETE FROM contact_values WHERE user_id = ? AND contact_id = ? AND kind IN (${placeholders(kinds)})`, [userId, contactId, ...kinds]);
  const positions = new Map<ContactValueKind, number>();
  const used = new Set<string>();
  const rows = drafts.map(draft => {
    const stored = draft.id ? own.get(draft.id) : undefined;
    const keep = stored && stored.kind === draft.kind && !used.has(stored.id) ? stored : undefined;
    const id = keep ? keep.id : crypto.randomUUID();
    used.add(id);
    const position = positions.get(draft.kind) || 0;
    positions.set(draft.kind, position + 1);
    const params = draft.params !== undefined ? draft.params : parseJson(keep?.params);
    return [id, contactId, userId, draft.kind, position, draft.preferred ? 1 : 0, draft.label, draft.custom_label, draft.value, valueKey(draft.kind, draft.value),
      ...ADDRESS_PARTS.map(part => draft[part] ?? null), params == null ? null : JSON.stringify(params),
      draft.vcard_group !== undefined ? draft.vcard_group : keep?.vcard_group ?? null];
  });
  await insertRows(cx, `contact_values (id, contact_id, user_id, kind, position, is_preferred, label, custom_label, value, value_key, ${ADDRESS_PARTS.join(', ')}, params, vcard_group)`, rows);
}

// Multi-row INSERTs through execute(), in slices that keep the placeholder count bounded.
async function insertRows(cx: SqlExecutor, target: string, rows: readonly unknown[][]) {
  for (let start = 0; start < rows.length; start += 100) {
    const slice = rows.slice(start, start + 100);
    await cx.execute(`INSERT INTO ${target} VALUES ${slice.map(row => `(${placeholders(row)})`).join(', ')}`, slice.flat() as (string | number | null)[]);
  }
}

async function writeKeptProperties(cx: SqlExecutor, userId: string, contactId: string, properties: readonly KeptPropertyDraft[]) {
  if (properties.length > KEPT_PROPERTIES_MAX) throw invalid(`At most ${KEPT_PROPERTIES_MAX} kept properties per contact`);
  if (properties.reduce((sum, property) => sum + Buffer.byteLength(property.value, 'utf8'), 0) > KEPT_PROPERTIES_MAX_BYTES) throw invalid('The kept properties of a contact exceed 256 KB');
  await insertRows(cx, 'contact_properties (id, contact_id, user_id, position, vcard_group, name, params, value, source_version)', properties.map((property, position) => [
    crypto.randomUUID(), contactId, userId, position, property.group ?? null, property.name, property.params == null ? null : JSON.stringify(property.params), property.value, property.source_version ?? null,
  ]));
}

const CONTENT_COLUMNS = ['display_name', 'first_name', 'last_name', 'middle_name', 'name_prefix', 'name_suffix', 'company', 'department', 'job_title', 'birthday', 'anniversary', 'notes'] as const;

interface InsertOptions { id?: string; uid?: string; properties?: readonly KeptPropertyDraft[] }

/** Inserts a contact with its values (and kept properties) on `cx`; returns its id. The caller owns the transaction. */
async function insertContact(cx: SqlExecutor, userId: string, draft: ContactDraft, { id = crypto.randomUUID(), uid = newUid(id), properties = [] }: InsertOptions = {}) {
  await cx.execute(`INSERT INTO contacts (id, user_id, uid, uid_hash, version, ${CONTENT_COLUMNS.join(', ')}, is_favorite, name_key)
    VALUES (?, ?, ?, ?, 1, ${placeholders(CONTENT_COLUMNS)}, ?, ?)`,
  [id, userId, uid, uidHash(uid), ...CONTENT_COLUMNS.map(column => draft[column]), draft.is_favorite ? 1 : 0, draftNameKey(draft)]);
  await writeValues(cx, userId, id, [], draft.values);
  await writeKeptProperties(cx, userId, id, properties);
  return id;
}

async function lockContact(cx: SqlExecutor, userId: string, id: string) {
  const [[row]] = await cx.execute<ContactRow[]>(`SELECT ${CONTACT_COLUMNS} FROM contacts c WHERE c.id = ? AND c.user_id = ? FOR UPDATE`, [id, userId]);
  if (!row) throw notFound('CONTACT_NOT_FOUND', 'Contact not found');
  return row;
}

async function versionConflict(cx: SqlExecutor, userId: string, id: string) {
  const [current] = await loadContacts(cx, userId, [id]);
  return conflict('VERSION_CONFLICT', 'This contact was changed elsewhere. Load it again and repeat your change.', { contact: current });
}

interface ReplaceOptions { expectedVersion: number | null; clearKept?: boolean; properties?: readonly KeptPropertyDraft[] }

/**
 * Replaces a contact's content and values on `cx` when its version is still
 * `expectedVersion` (null skips the check, for merges and imports that hold
 * the row locked themselves). Kept properties stay unless cleared or given.
 */
async function replaceContact(cx: SqlExecutor, userId: string, id: string, draft: ContactDraft, { expectedVersion, clearKept = false, properties }: ReplaceOptions) {
  const row = await lockContact(cx, userId, id);
  if (expectedVersion !== null && Number(row.version) !== expectedVersion) throw await versionConflict(cx, userId, id);
  await cx.execute(`UPDATE contacts SET ${CONTENT_COLUMNS.map(column => `${column} = ?`).join(', ')}, is_favorite = ?, name_key = ?, version = version + 1
    WHERE id = ? AND user_id = ?`,
  [...CONTENT_COLUMNS.map(column => draft[column]), (draft.is_favorite ?? !!row.is_favorite) ? 1 : 0, draftNameKey(draft), id, userId]);
  await writeValues(cx, userId, id, VALUE_KINDS, draft.values);
  if (clearKept || properties) {
    await cx.execute('DELETE FROM contact_properties WHERE user_id = ? AND contact_id = ?', [userId, id]);
    await writeKeptProperties(cx, userId, id, properties || []);
  }
}

// Fits one kind's first three values to what an old app sent: values it kept
// keep their rows (and labels), new ones take the places of the removed ones,
// and every value from the fourth on stays where it was.
function legacyList(kind: 'email' | 'phone', stored: readonly ValueRow[], sent: readonly string[]): ValueDraft[] {
  const projected = stored.slice(0, 3);
  const rest = stored.slice(3);
  const unused = [...projected];
  const take = (match: (row: ValueRow) => boolean) => {
    const index = unused.findIndex(match);
    return index < 0 ? undefined : unused.splice(index, 1)[0];
  };
  // Exact text first, so a value sent twice reuses both rows; then the same
  // normalised value written differently ("Anna@Example.com").
  const exact = sent.map(value => take(candidate => candidate.value === value));
  const head = sent.map((value, index): ValueDraft => {
    const row = exact[index] || take(candidate => candidate.value_key === valueKey(kind, value));
    return row ? { ...asDraft(row), value } : { kind, label: '', custom_label: null, value, preferred: false };
  });
  return [...head, ...rest.map(asDraft)];
}

function asDraft(row: ValueRow): ValueDraft {
  return { id: row.id, kind: row.kind, label: row.label, custom_label: row.custom_label ?? null, value: row.value, preferred: !!row.is_preferred,
    ...Object.fromEntries(ADDRESS_PARTS.map(part => [part, row[part] ?? null])), params: parseJson(row.params), vcard_group: row.vcard_group ?? null };
}

const legacyValues = (fields: LegacyFields, kind: 'email' | 'phone') => LEGACY_SLOTS[kind].map(slot => fields[slot]).filter((value): value is string => !!value);

// A flat 3+3 body applied as a diff (P-21): names, company, title and notes
// as given, the emails and phones fitted into the first three places.
async function applyLegacyUpdate(cx: SqlExecutor, userId: string, id: string, fields: LegacyFields) {
  const row = await lockContact(cx, userId, id);
  const [stored] = await cx.execute<ValueRow[]>(`SELECT ${VALUE_COLUMNS} FROM contact_values WHERE user_id = ? AND contact_id = ? AND kind IN ('email', 'phone')
    ORDER BY kind, position, id`, [userId, id]);
  const projection = legacyProjection(row, stored);
  // A name the app sends back as listed leaves the name parts as they are.
  const renamed = (fields.first_name || '') !== projection.first_name || (fields.last_name || null) !== (projection.last_name || null);
  const names = renamed ? { first_name: fields.first_name || '', last_name: fields.last_name, display_name: null } : { first_name: row.first_name, last_name: row.last_name, display_name: row.display_name };
  const company = (fields.company || null) === (projection.company || null) ? row.company : fields.company;
  const values = (['email', 'phone'] as const).flatMap(kind => legacyList(kind, stored.filter(value => value.kind === kind), legacyValues(fields, kind)));
  await cx.execute(`UPDATE contacts SET first_name = ?, last_name = ?, display_name = ?, company = ?, job_title = ?, notes = ?, name_key = ?, version = version + 1
    WHERE id = ? AND user_id = ?`,
  [names.first_name, names.last_name, names.display_name, company, fields.job_title, fields.notes,
    draftNameKey({ ...names, middle_name: row.middle_name }), id, userId]);
  await writeValues(cx, userId, id, ['email', 'phone'], values);
}

function legacyDraft(fields: LegacyFields): ContactDraft {
  return {
    display_name: null, first_name: fields.first_name || '', last_name: fields.last_name, middle_name: null, name_prefix: null, name_suffix: null,
    company: fields.company, department: null, job_title: fields.job_title, birthday: null, anniversary: null, notes: fields.notes,
    values: (['email', 'phone'] as const).flatMap(kind => legacyValues(fields, kind).map(value => ({ kind, label: '', custom_label: null, value, preferred: false }))),
  };
}

// ── Route operations ───────────────────────────────────────────────────

async function createContact(userId: string, body: unknown) {
  const parsed = parseContactBody(body, { create: true });
  const draft = parsed.shape === 'full' ? parsed.draft : legacyDraft(parsed.fields);
  const id = await withTransaction(cx => insertContact(cx, userId, draft));
  return (await loadContacts(db, userId, [id]))[0];
}

async function updateContact(userId: string, id: string, body: unknown, ifMatch: unknown) {
  const parsed = parseContactBody(body, { create: false });
  if (parsed.shape === 'full') {
    const expectedVersion = parsed.version ?? versionFromHeader(ifMatch);
    if (expectedVersion === null) throw badRequest('VERSION_REQUIRED', 'Send the contact version (version or If-Match) with a full update');
    await withTransaction(cx => replaceContact(cx, userId, id, parsed.draft, { expectedVersion, clearKept: parsed.clearKept }));
  } else {
    await withTransaction(cx => applyLegacyUpdate(cx, userId, id, parsed.fields));
  }
  const [contact] = await loadContacts(db, userId, [id]);
  if (!contact) throw notFound('CONTACT_NOT_FOUND', 'Contact not found');
  return contact;
}

async function setFavorite(userId: string, id: string, favorite: boolean) {
  await db.execute('UPDATE contacts SET is_favorite = ?, version = version + 1 WHERE id = ? AND user_id = ?', [favorite ? 1 : 0, id, userId]);
}

async function deleteContacts(userId: string, ids: readonly string[]) {
  if (!ids.length) return 0;
  const [result] = await db.execute<ResultSetHeader>(`DELETE FROM contacts WHERE user_id = ? AND id IN (${placeholders(ids)})`, [userId, ...ids]);
  return result.affectedRows || 0;
}

const BULK_COLUMNS: Readonly<Record<string, { column: string; name: string }>> = {
  company: { column: 'company', name: 'Organisation' }, department: { column: 'department', name: 'Department' }, job_title: { column: 'job_title', name: 'Job title' },
};

async function bulkUpdateContacts(userId: string, ids: readonly string[], change: unknown) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw invalid('contact object is required');
  const entries = Object.entries(change as Record<string, unknown>);
  if (!entries.length) throw invalid('Nothing to update');
  const sets: string[] = []; const values: (string | null)[] = [];
  for (const [field, value] of entries) {
    const target = BULK_COLUMNS[field];
    if (!target) throw invalid(`${field} cannot be changed for many contacts at once`);
    if (value !== null && typeof value !== 'string') throw invalid(`${field} must be text`);
    sets.push(`${target.column} = ?`);
    values.push(textInput(value, target.name, TEXT_MAX));
  }
  const [result] = await db.execute<ResultSetHeader>(`UPDATE contacts SET ${sets.join(', ')}, version = version + 1 WHERE user_id = ? AND id IN (${placeholders(ids)})`,
    [...values, userId, ...ids]);
  return result.affectedRows || 0;
}

export {
  parseContactBody,
  versionFromHeader,
  contactSearchCondition,
  phoneQueryDigits,
  displayName,
  listContacts,
  loadContacts,
  getContact,
  createContact,
  updateContact,
  setFavorite,
  deleteContacts,
  bulkUpdateContacts,
  insertContact,
  replaceContact,
  applyLegacyUpdate,
  writeValues,
  writeKeptProperties,
  legacyDraft,
  uidHash,
  newUid,
  draftNameKey,
  LABELS,
  VALUE_KINDS,
  VALUE_LIMITS,
  VALUES_PER_KIND,
  KEPT_PROPERTIES_MAX,
  KEPT_PROPERTIES_MAX_BYTES,
};
export type { ContactDraft, ValueDraft, KeptPropertyDraft, LegacyFields, ParsedBody };
