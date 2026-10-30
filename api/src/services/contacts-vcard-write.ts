// Contacts to vCard 4.0 (RFC 6350, the default) or 3.0 (RFC 2426, "for older
// apps"), with nothing UniHub-specific (P-30): every value with its label and
// remaining parameters, custom labels as Apple's itemN.X-ABLabel, and every
// kept property written back. Reading it again with contacts-vcard-map.ts
// gives the same contact (the round-trip test holds both to that).
import type { ContactRecord, LabelledValue, Address, PartialDate, ContactValueKind } from '../contracts/contacts';
import type { KeptPropertyDraft } from './contacts';
import { MEDIA_TYPES, SINGLE_PROPERTIES, singleTyped, anniversaryFrom, unescapeText, FIELD_SOURCE, IM_SCHEMES, ANNIVERSARY_PROPERTIES } from './contacts-vcard-map';

type WriteVersion = '4.0' | '3.0';

/** What the export knows about a contact beyond its record. */
interface ExportContact {
  contact: ContactRecord;
  /** Import details of values by value id: remaining parameters and the vCard group. */
  extras: ReadonlyMap<string, { params: Record<string, string | string[]> | null; group: string | null }>;
  properties: readonly KeptPropertyDraft[];
  /** The stored photo, when the photo service has one. */
  photo?: { data: Buffer; media_type: string } | null;
}

// ── Lines ──────────────────────────────────────────────────────────────

/** Folds a content line at 75 octets without splitting a UTF-8 sequence. */
function fold(line: string) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > limit) { out.push(current); current = ' '; bytes = 1; limit = 75; }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n');
}

const escapeText = (text: string) => text.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const escapeUri = (text: string) => text.replace(/\r\n|\r|\n/g, '\\n');
const structured = (parts: readonly (string | null | undefined)[]) => parts.map(part => escapeText(part ?? '')).join(';');

// RFC 6868 caret encoding inside a quoted parameter value.
function paramValue(value: string) {
  if (!/[",;:\n^]/.test(value) && value.trim() === value) return value;
  return `"${value.replace(/\^/g, '^^').replace(/\r\n|\r|\n/g, '^n').replace(/"/g, "^'")}"`;
}

type Params = Record<string, string[]>;

function normaliseParams(params: Record<string, string | string[]> | null | undefined): Params {
  const out: Params = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) continue;
    const values = (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string');
    out[key.toUpperCase()] = values;
  }
  return out;
}

function contentLine(group: string | null, name: string, params: Params, value: string) {
  const head = (group ? `${group}.` : '') + name + Object.entries(params)
    .filter(([, values]) => values.length)
    .map(([key, values]) => `;${key}=${values.map(paramValue).join(',')}`).join('');
  return fold(`${head}:${value}`);
}

// ── Labels ─────────────────────────────────────────────────────────────

const PHONE_TYPES: Readonly<Record<string, string[]>> = {
  mobile: ['cell'], home: ['home'], work: ['work'], main: ['main'], home_fax: ['home', 'fax'], work_fax: ['work', 'fax'], other_fax: ['fax'],
  pager: ['pager'], work_mobile: ['work', 'cell'], work_pager: ['work', 'pager'], callback: ['x-callback'], car: ['car'], company_main: ['x-company-main'],
  isdn: ['isdn'], radio: ['x-radio'], telex: ['x-telex'], tty_tdd: ['textphone'], assistant: ['x-assistant'], mms: ['x-mms'], other: ['other'],
};
const PLAIN_TYPES: Readonly<Partial<Record<ContactValueKind, ReadonlySet<string>>>> = {
  email: new Set(['home', 'work', 'other']), address: new Set(['home', 'work', 'other']), url: new Set(['home', 'work', 'other']),
  impp: new Set(['home', 'work', 'other']),
  related: new Set(['contact', 'acquaintance', 'friend', 'met', 'co_worker', 'colleague', 'co_resident', 'neighbor', 'child', 'parent', 'sibling', 'spouse',
    'kin', 'muse', 'crush', 'date', 'sweetheart', 'me', 'agent', 'emergency']),
};
// Apple's own relation labels, for 3.0's X-ABRELATEDNAMES.
const APPLE_RELATIONS = new Set(['mother', 'father', 'parent', 'brother', 'sister', 'child', 'friend', 'spouse', 'partner', 'assistant', 'manager', 'other']);

function labelTypes(kind: ContactValueKind, label: string): string[] {
  if (!label || label === 'custom') return [];
  if (kind === 'phone') return PHONE_TYPES[label] || [];
  if (kind === 'email' && label === 'mobile') return ['cell'];
  const dashed = label.replace(/_/g, '-');
  return PLAIN_TYPES[kind]?.has(label) ? [dashed] : [`x-${dashed}`];
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// ── Dates ──────────────────────────────────────────────────────────────

function storedDate(date: PartialDate | null) {
  if (!date) return null;
  const mmdd = `${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
  return date.year ? `${String(date.year).padStart(4, '0')}-${mmdd}` : `--${mmdd}`;
}

function vcardDate(date: PartialDate, version: WriteVersion): { value: string; params: Params } {
  const [mm, dd] = [String(date.month).padStart(2, '0'), String(date.day).padStart(2, '0')];
  if (version === '4.0') return { value: date.year ? `${String(date.year).padStart(4, '0')}${mm}${dd}` : `--${mm}${dd}`, params: {} };
  // 3.0 has no year-less date; Apple's form is the one its readers know.
  return date.year ? { value: `${String(date.year).padStart(4, '0')}-${mm}-${dd}`, params: {} } : { value: `1604-${mm}-${dd}`, params: { 'X-APPLE-OMIT-YEAR': ['1604'] } };
}

const revision = (updatedAt: string, version: WriteVersion) => {
  const date = new Date(updatedAt);
  const iso = (Number.isNaN(date.getTime()) ? new Date() : date).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return version === '4.0' ? iso.replace(/[-:]/g, '') : iso;
};

// ── Kept properties ────────────────────────────────────────────────────

/** The typed value a shadow stands for, as contacts-vcard-map.ts singleTyped computes it. */
function typedOf(contact: ContactRecord, name: string): string | null {
  const join = (parts: (string | null | undefined)[]) => parts.map(part => part ?? '').join('\u001f');
  switch (name) {
    case 'FN': return contact.display_name || null;
    case 'N': return join([contact.name.family, contact.name.given, contact.name.middle, contact.name.prefix, contact.name.suffix]);
    case 'ORG': return join([contact.organization.name, contact.organization.department]);
    case 'TITLE': return contact.job_title;
    case 'NOTE': return contact.notes;
    case 'BDAY': return storedDate(contact.birthday);
    case 'ANNIVERSARY': return storedDate(contact.anniversary);
    default: return null;
  }
}

/**
 * Whether a property kept for a field (source 'field': a shadow, an
 * anniversary's other spelling, a 3.0 messaging property) still says what
 * the contact says. One that no longer does was edited away in UniHub and is
 * not written, so an export never brings back a value the person removed.
 */
function stillAgrees(property: KeptPropertyDraft, contact: ContactRecord) {
  const params = normaliseParams(property.params);
  if (SINGLE_PROPERTIES.has(property.name)) {
    const typed = typedOf(contact, property.name);
    return typed !== null && singleTyped(property.name, property.value, params) === typed;
  }
  if (ANNIVERSARY_PROPERTIES.has(property.name)) {
    const date = anniversaryFrom({ name: property.name, value: property.value, params }, 'anniversary');
    return date !== null && date === storedDate(contact.anniversary);
  }
  const scheme = IM_SCHEMES[property.name];
  if (scheme) {
    const text = unescapeText(property.value).trim();
    const value = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `${scheme}:${text}`;
    return contact.impp.some(item => item.value === value);
  }
  return true;
}

const BINARY_PROPERTIES = new Set(['PHOTO', 'LOGO', 'SOUND', 'KEY']);
// The first subtype of each media type is its usual name (JPEG, not JPG).
const SUBTYPES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(MEDIA_TYPES).reverse().map(([subtype, media]) => [media, subtype]));

/** A kept property in the target version's form for inline data (4.0 data: URIs, 3.0 ENCODING=b). */
function keptLine(property: KeptPropertyDraft, version: WriteVersion) {
  const params = normaliseParams(property.params);
  let value = property.value;
  const encoding = (params.ENCODING?.[0] || '').toLowerCase();
  if (version === '4.0' && (encoding === 'b' || encoding === 'base64')) {
    const types = params.TYPE || [];
    const media = types.map(type => MEDIA_TYPES[type.toUpperCase()]).find(Boolean) || params.MEDIATYPE?.[0] || 'application/octet-stream';
    params.TYPE = types.filter(type => !MEDIA_TYPES[type.toUpperCase()]);
    delete params.ENCODING; delete params.MEDIATYPE;
    value = `data:${media};base64,${value}`;
  } else if (version === '3.0' && BINARY_PROPERTIES.has(property.name) && /^data:[^,]*;base64,/i.test(value.slice(0, 256))) {
    const comma = value.indexOf(',');
    const media = value.slice(5, value.indexOf(';')).toLowerCase();
    value = value.slice(comma + 1);
    params.ENCODING = ['b'];
    if (SUBTYPES[media]) params.TYPE = [...(params.TYPE || []), SUBTYPES[media]];
    delete params.VALUE;
  }
  return contentLine(property.group ?? null, property.name, params, value);
}

// ── Cards ──────────────────────────────────────────────────────────────

/** One contact as a vCard (CRLF lines, folded, without a trailing line break). */
function writeVCard({ contact, extras, properties, photo }: ExportContact, version: WriteVersion): string {
  const lines: string[] = ['BEGIN:VCARD', `VERSION:${version}`];
  const kept = [...properties];
  // A shadow replaces the line the field would give; the first that agrees wins.
  const shadowFor = (name: string) => {
    const index = kept.findIndex(property => property.name === name && property.source_version === FIELD_SOURCE && stillAgrees(property, contact));
    return index < 0 ? null : kept.splice(index, 1)[0];
  };
  const single = (name: string, generate: () => string | null) => {
    const shadow = shadowFor(name);
    if (shadow) { lines.push(keptLine(shadow, version)); return; }
    const line = generate();
    if (line) lines.push(line);
  };
  const usedGroups = new Set([...properties.map(property => property.group?.toLowerCase()), ...[...extras.values()].map(extra => extra.group?.toLowerCase())].filter(Boolean));
  let nextGroup = 1;
  const freshGroup = () => { while (usedGroups.has(`item${nextGroup}`)) nextGroup++; usedGroups.add(`item${nextGroup}`); return `item${nextGroup}`; };

  const valueLine = (kind: ContactValueKind, name: string, item: LabelledValue, value: string, extraParams: Params = {}) => {
    const extra = item.id ? extras.get(item.id) : undefined;
    const params = { ...normaliseParams(extra?.params), ...extraParams };
    const types = [...labelTypes(kind, item.label)];
    for (const type of params.TYPE || []) if (!types.some(existing => existing.toLowerCase() === type.toLowerCase())) types.push(type);
    if (!item.preferred) delete params.PREF;
    if (item.preferred && version === '3.0') { delete params.PREF; types.push('pref'); }
    const ordered: Params = {};
    if (types.length) ordered.TYPE = types;
    if (item.preferred && version === '4.0') ordered.PREF = params.PREF?.length ? params.PREF : ['1'];
    for (const [key, values] of Object.entries(params)) if (key !== 'TYPE' && key !== 'PREF') ordered[key] = values;
    let group = extra?.group ?? null;
    const label = item.label === 'custom' && item.custom_label ? item.custom_label : null;
    if (label && !group) group = freshGroup();
    lines.push(contentLine(group, name, ordered, value));
    if (label) lines.push(contentLine(group, 'X-ABLabel', {}, escapeText(label)));
  };

  if (contact.uid) lines.push(contentLine(null, 'UID', {}, escapeUri(contact.uid)));
  single('FN', () => contentLine(null, 'FN', {}, escapeText(contact.display_name || '')));
  const { name } = contact;
  single('N', () => (version === '3.0' || [name.family, name.given, name.middle, name.prefix, name.suffix].some(Boolean)
    ? contentLine(null, 'N', {}, structured([name.family, name.given, name.middle, name.prefix, name.suffix])) : null));
  for (const item of contact.nicknames) valueLine('nickname', 'NICKNAME', item, escapeText(item.value));
  if (photo) {
    for (let index = kept.length - 1; index >= 0; index--) if (kept[index].name === 'PHOTO') kept.splice(index, 1);
    const data = photo.data.toString('base64');
    lines.push(version === '4.0' ? contentLine(null, 'PHOTO', {}, `data:${photo.media_type};base64,${data}`)
      : contentLine(null, 'PHOTO', { ENCODING: ['b'], TYPE: [SUBTYPES[photo.media_type] || 'JPEG'] }, data));
  }
  if (contact.birthday) {
    const date = contact.birthday;
    single('BDAY', () => { const { value, params } = vcardDate(date, version); return contentLine(null, 'BDAY', params, value); });
  }
  if (contact.anniversary) {
    const date = contact.anniversary;
    single('ANNIVERSARY', () => {
      const { value, params } = vcardDate(date, version);
      if (version === '4.0') return contentLine(null, 'ANNIVERSARY', params, value);
      // 3.0 has no ANNIVERSARY; Apple and Evolution read X-ANNIVERSARY.
      return contentLine(null, 'X-ANNIVERSARY', {}, date.year ? value : `--${value.slice(5)}`);
    });
  }
  for (const item of contact.addresses as Address[]) {
    valueLine('address', 'ADR', item, structured([item.po_box, item.extended, item.street, item.locality, item.region, item.postal_code, item.country]));
  }
  for (const item of contact.phones) valueLine('phone', 'TEL', item, escapeText(item.value));
  for (const item of contact.emails) valueLine('email', 'EMAIL', item, escapeText(item.value));
  for (const item of contact.impp) valueLine('impp', 'IMPP', item, escapeUri(item.value));
  single('ORG', () => (contact.organization.name || contact.organization.department
    ? contentLine(null, 'ORG', {}, structured(contact.organization.department ? [contact.organization.name, contact.organization.department] : [contact.organization.name])) : null));
  single('TITLE', () => (contact.job_title ? contentLine(null, 'TITLE', {}, escapeText(contact.job_title)) : null));
  for (const item of contact.related) {
    const uri = /^[a-z][a-z0-9+.-]*:\S*$/i.test(item.value.trim());
    if (version === '4.0') { valueLine('related', 'RELATED', item, uri ? escapeUri(item.value) : escapeText(item.value), uri ? {} : { VALUE: ['text'] }); continue; }
    // 3.0 has no RELATED: Apple's X-ABRELATEDNAMES with its label.
    const label = item.label === 'custom' ? item.custom_label : item.label ? (APPLE_RELATIONS.has(item.label) ? `_$!<${capitalise(item.label)}>!$_` : capitalise(item.label.replace(/_/g, ' '))) : null;
    valueLine('related', 'X-ABRELATEDNAMES', label ? { ...item, label: 'custom', custom_label: label } : item, escapeText(item.value));
  }
  if (contact.categories.length) lines.push(contentLine(null, 'CATEGORIES', {}, contact.categories.map(escapeText).join(',')));
  single('NOTE', () => (contact.notes ? contentLine(null, 'NOTE', {}, escapeText(contact.notes)) : null));
  for (const item of contact.urls) valueLine('url', 'URL', item, escapeUri(item.value));
  for (const property of kept) {
    if (property.source_version === FIELD_SOURCE && !stillAgrees(property, contact)) continue;
    lines.push(keptLine(property, version));
  }
  lines.push(`REV:${revision(contact.updated_at, version)}`, 'END:VCARD');
  // An anniversary's other spelling may equal the line the field gave (3.0).
  return [...new Set(lines)].join('\r\n');
}

/** Contacts as one vCard file, CRLF line ends, UTF-8. */
function writeVCards(contacts: readonly ExportContact[], version: WriteVersion) {
  return contacts.map(contact => `${writeVCard(contact, version)}\r\n`).join('');
}

export { writeVCard, writeVCards, stillAgrees, fold, escapeText, labelTypes, storedDate as partialDateText };
export type { ExportContact, WriteVersion };
