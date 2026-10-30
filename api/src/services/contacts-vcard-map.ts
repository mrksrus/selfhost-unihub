// vCard properties to the contact model (D6, F12). Every property UniHub
// shows becomes a typed field or a labelled value; every other property, and
// every parameter UniHub does not interpret, is kept so the export writes it
// back ("lossless" is the same meaning, not the same bytes).
//
// A single-value property (FN, N, ORG, TITLE, NOTE, BDAY, ANNIVERSARY) that
// carries more than its typed field holds (a parameter such as SORT-AS or
// LANGUAGE, an Apple group, a third ORG unit, a time on a birthday, text past
// the field's length) is also kept as it was: its "shadow". The writer emits
// the shadow instead of the typed field while the shadow still reads as the
// field's current value (singleTyped below), and drops it once the field was
// edited. A multi-value too long for its field, or past 100 of a kind, is kept
// whole instead of shown.
import type { ImportWarning, ContactValueKind } from '../contracts/contacts';
import type { ContactDraft, KeptPropertyDraft, ValueDraft } from './contacts';
import type { VCardCard, VCardProperty } from './contacts-vcard-read';
import { LABELS, VALUE_LIMITS, VALUES_PER_KIND, KEPT_PROPERTIES_MAX, displayName } from './contacts';
import { valueIdentity } from './contact-keys';

// The store's field bounds (services/contacts.ts input contract).
const TEXT_MAX = 255;
const STREET_MAX = 1000;
const CUSTOM_LABEL_MAX = 100;
const NOTES_MAX_BYTES = 65535;
const UID_MAX = 255;

/** A contact read from a file, ready for the store. */
interface ImportedCard {
  /** Counts from 1 in file order. */
  number: number;
  uid: string | null;
  draft: ContactDraft;
  /** The kept properties, in file order. */
  properties: KeptPropertyDraft[];
  /** An inline photo (never a URL, which is kept unfetched): base64 bytes, for the photo service. */
  photo: ImportedPhoto | null;
}

interface ImportedPhoto {
  media_type: string | null;
  data: string;
  /** The PHOTO property's other parameters and group, to keep it whole while there is no photo service. */
  params: Record<string, string[]>;
  group: string | null;
}

const warn = (card: number | null, property: string | null, code: string, message: string): ImportWarning => ({ card, property, code, message });

// ── Text ───────────────────────────────────────────────────────────────

/** vCard 3.0/4.0 unescaping, lenient: an unknown escape keeps its backslash. */
function unescapeText(raw: string) {
  const text = raw.includes('\r') ? raw.replace(/\r\n?/g, '\n') : raw;
  if (!text.includes('\\')) return text;
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== '\\' || index + 1 >= text.length) { out += char; continue; }
    const next = text[++index];
    if (next === 'n' || next === 'N') out += '\n';
    else if (next === '\\' || next === ',' || next === ';' || next === ':') out += next;
    else out += `\\${next}`;
  }
  return out;
}

/** Splits on `separator` where it is not escaped; the parts stay escaped. */
function splitEscaped(text: string, separator: ';' | ',') {
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\\' && index + 1 < text.length) { current += char + text[++index]; continue; }
    if (char === separator) { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  return parts;
}

const characters = (text: string) => Array.from(text);

/** Trimmed text within `max` characters; `cut` when something was dropped. */
function fitText(value: string | null | undefined, max = TEXT_MAX): { text: string | null; cut: boolean } {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return { text: null, cut: false };
  const chars = characters(trimmed);
  return chars.length > max ? { text: chars.slice(0, max).join('').trim(), cut: true } : { text: trimmed, cut: false };
}

/** Notes keep their inner whitespace and are bounded in bytes, cut at a character. */
function fitNotes(value: string | null | undefined): { text: string | null; cut: boolean } {
  const text = value ?? '';
  if (!text.trim()) return { text: null, cut: false };
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= NOTES_MAX_BYTES) return { text, cut: false };
  let end = NOTES_MAX_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), cut: true };
}

// ── Dates ──────────────────────────────────────────────────────────────

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

/** `YYYY-MM-DD` or `--MM-DD` as the store keeps it, or null when not a real date. */
function storedDate(year: number | null, month: number, day: number) {
  const valid = month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]
    && (year === null || (year >= 1 && year <= 9999 && (month !== 2 || day !== 29 || isLeapYear(year))));
  if (!valid) return null;
  const mmdd = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return year === null ? `--${mmdd}` : `${String(year).padStart(4, '0')}-${mmdd}`;
}

/**
 * A vCard date: 4.0 basic (19850315, --0315), ISO extended (1985-03-15,
 * --03-15), a date-time (the time is dropped: lossy), Apple's year-less form
 * (X-APPLE-OMIT-YEAR=1604 with 1604-03-15). Partial dates without a day and
 * text dates are not a field value.
 */
function parseVCardDate(raw: string, params: Record<string, string[]> = {}): { date: string | null; lossy: boolean } {
  const text = raw.trim();
  const timeAt = text.indexOf('T');
  const datePart = timeAt >= 0 ? text.slice(0, timeAt) : text;
  let match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(datePart);
  let year: number | null; let month: number; let day: number;
  if (match) [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^--(\d{2})-?(\d{2})$/.exec(datePart))) [year, month, day] = [null, Number(match[1]), Number(match[2])];
  else return { date: null, lossy: true };
  const omitYear = params['X-APPLE-OMIT-YEAR']?.[0];
  if (year !== null && omitYear && Number(omitYear) === year) year = null;
  const date = storedDate(year, month, day);
  return { date, lossy: date === null || timeAt >= 0 };
}

// ── Labels ─────────────────────────────────────────────────────────────

const token = (value: string) => value.trim().toLowerCase().replace(/^x-/, '').replace(/-/g, '_');

// Parameter tokens with no meaning beyond their kind's default; dropped.
const NOISE_TYPES: Partial<Record<ContactValueKind, ReadonlySet<string>>> = {
  email: new Set(['internet', 'x400']),
};

const SIMPLE_TYPES: Readonly<Record<ContactValueKind, Readonly<Record<string, string>>>> = {
  email: { cell: 'mobile', mobile: 'mobile', home: 'home', work: 'work', other: 'other' },
  phone: { main: 'main', home: 'home', work: 'work', car: 'car', isdn: 'isdn', textphone: 'tty_tdd', tty: 'tty_tdd', tty_tdd: 'tty_tdd', assistant: 'assistant',
    callback: 'callback', company_main: 'company_main', radio: 'radio', telex: 'telex', mms: 'mms', other: 'other', iphone: 'mobile' },
  address: { home: 'home', work: 'work', other: 'other' },
  url: { homepage: 'homepage', home_page: 'homepage', blog: 'blog', profile: 'profile', home: 'home', work: 'work', ftp: 'ftp', other: 'other' },
  impp: { home: 'home', personal: 'home', work: 'work', business: 'work', other: 'other' },
  related: Object.fromEntries([...LABELS.related].filter(label => label && label !== 'custom').map(label => [label, label])),
  nickname: { other_name: 'other_name', maiden_name: 'maiden_name', short_name: 'short_name', initials: 'initials' },
  category: {},
};

/** The label of a value from its TYPE tokens, and the tokens it used (normalised). */
function labelFromTypes(kind: ContactValueKind, types: readonly string[]): { label: string; used: Set<string> } {
  const tokens = new Set(types.map(token));
  const used = new Set<string>();
  const take = (...names: string[]) => { names.forEach(name => used.add(name)); };
  if (kind === 'phone') {
    const work = tokens.has('work'); const home = tokens.has('home');
    if (tokens.has('fax')) { take('fax'); if (home) { take('home'); return { label: 'home_fax', used }; } if (work) { take('work'); return { label: 'work_fax', used }; } return { label: 'other_fax', used }; }
    if (tokens.has('pager')) { take('pager'); if (work) { take('work'); return { label: 'work_pager', used }; } return { label: 'pager', used }; }
    const mobile = tokens.has('cell') ? 'cell' : tokens.has('mobile') ? 'mobile' : null;
    if (mobile) { take(mobile); if (work) { take('work'); return { label: 'work_mobile', used }; } return { label: 'mobile', used }; }
  }
  const table = SIMPLE_TYPES[kind];
  for (const name of tokens) {
    if (table[name]) { take(name); return { label: table[name], used }; }
  }
  return { label: '', used };
}

const APPLE_ALIASES: Readonly<Record<string, string>> = { homefax: 'home_fax', workfax: 'work_fax', otherfax: 'other_fax', homepage: 'homepage', iphone: 'mobile', mobile: 'mobile' };

/** An Apple X-ABLabel: `_$!<HomeFAX>!$_` is a standard label, anything else a custom one. */
function labelFromApple(kind: ContactValueKind, text: string): { label: string; custom_label: string | null } {
  const match = /^_\$!<(.{1,64})>!\$_$/.exec(text.trim());
  const name = match ? match[1] : text.trim();
  const normalised = token(name).replace(/\s+/g, '_');
  const known = APPLE_ALIASES[normalised] && LABELS[kind].has(APPLE_ALIASES[normalised]) ? APPLE_ALIASES[normalised]
    : SIMPLE_TYPES[kind][normalised] ?? (LABELS[kind].has(normalised) && normalised !== 'custom' ? normalised : null);
  if (known) return { label: known, custom_label: null };
  const custom = fitText(name, CUSTOM_LABEL_MAX).text;
  return custom ? { label: 'custom', custom_label: custom } : { label: '', custom_label: null };
}

/** Android's `X-CUSTOM(CHARSET=UTF-8,ENCODING=QUOTED-PRINTABLE,=4B=69=64=73)` type: its last item is the label. */
function androidCustomLabel(type: string): string | null {
  const match = /^X-CUSTOM\((.*)\)$/i.exec(type.trim());
  if (!match) return null;
  const items = match[1].split(',');
  const label = items[items.length - 1] || '';
  const quoted = items.some(item => /^ENCODING=QUOTED-PRINTABLE$/i.test(item.trim()));
  if (!quoted) return label.trim() || null;
  const charset = items.find(item => /^CHARSET=/i.test(item.trim()))?.trim().slice(8) || 'utf-8';
  const bytes = Buffer.from(label.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
  try { return new TextDecoder(charset).decode(bytes).trim() || null; } catch { return bytes.toString('utf8').trim() || null; }
}

// ── Properties to values ───────────────────────────────────────────────

// Properties read as a labelled value of a kind (an X-ABLabel in their group labels them).
const VALUE_PROPERTIES: Readonly<Record<string, ContactValueKind>> = {
  EMAIL: 'email', TEL: 'phone', ADR: 'address', URL: 'url', IMPP: 'impp', RELATED: 'related', 'X-ABRELATEDNAMES': 'related',
};
// 3.0 messaging properties read as IMPP; the original is kept as well.
const IM_SCHEMES: Readonly<Record<string, string>> = {
  'X-JABBER': 'xmpp', 'X-GTALK': 'xmpp', 'X-GOOGLE-TALK': 'xmpp', 'X-SKYPE': 'skype', 'X-SKYPE-USERNAME': 'skype', 'X-AIM': 'aim', 'X-ICQ': 'icq',
  'X-MSN': 'msnim', 'X-YAHOO': 'ymsgr', 'X-QQ': 'qq', 'X-SIP': 'sip',
};
// Other spellings of an anniversary; read when there is no ANNIVERSARY, always kept.
const ANNIVERSARY_PROPERTIES = new Set(['X-ANNIVERSARY', 'X-EVOLUTION-ANNIVERSARY', 'X-ABDATE', 'X-ANDROID-CUSTOM']);
// Written by the export from the contact itself.
const DROPPED_PROPERTIES = new Set(['VERSION', 'PRODID', 'REV', 'BEGIN', 'END']);
const ADDRESS_PARTS = ['po_box', 'extended', 'street', 'locality', 'region', 'postal_code', 'country'] as const;

/** The address text the store shows (services/contacts.ts formatAddress). */
function formatAddress(parts: Partial<Record<typeof ADDRESS_PARTS[number], string | null>>) {
  const city = [parts.postal_code, parts.locality].filter(Boolean).join(' ');
  const text = [parts.po_box, parts.extended, parts.street, city, parts.region, parts.country].filter(Boolean).join('\n');
  return characters(text).slice(0, VALUE_LIMITS.address).join('');
}

const DEFAULT_VALUE_TYPES = new Set(['text', 'uri', 'date', 'date-and-or-time', 'date-time']);

/** Parameters left after the ones a field consumed; null when none. */
function leftover(params: Record<string, string[]>, { types = [] as string[], consumed = [] as string[] } = {}) {
  const rest: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(params)) {
    if (consumed.includes(key)) continue;
    if (key === 'VALUE' && values.every(value => DEFAULT_VALUE_TYPES.has(value.toLowerCase()))) continue;
    if (key === 'TYPE') { if (types.length) rest.TYPE = types; continue; }
    rest[key] = values;
  }
  return Object.keys(rest).length ? rest : null;
}

/**
 * The source of a property kept because a field was read from it: a shadow,
 * an anniversary's other spelling, a 3.0 messaging property. The writer
 * writes it only while the field still says the same (contacts-vcard-write.ts
 * stillAgrees), so an edit in UniHub is never undone by an old copy.
 */
const FIELD_SOURCE = 'field';

/** A property as kept: 2.1 newlines escaped as in 3.0/4.0, base64 values as `ENCODING=b`. */
function keptFrom(property: VCardProperty, sourceVersion: string | null): KeptPropertyDraft {
  const params: Record<string, string[]> = { ...property.params };
  if (property.binary) params.ENCODING = ['b'];
  const value = property.binary ? property.value : property.value.replace(/\r\n|\r|\n/g, '\\n');
  return { name: property.name, group: property.group, params: Object.keys(params).length ? params : null, value, source_version: sourceVersion };
}

/** The typed value of a single-value property, as the import stores it; the writer compares a shadow with this. */
function singleTyped(name: string, value: string, params: Record<string, string[]> = {}): string | null {
  switch (name) {
    case 'FN': case 'TITLE': return fitText(unescapeText(value)).text;
    case 'NOTE': return fitNotes(unescapeText(value)).text;
    case 'N': return splitEscaped(value, ';').slice(0, 5).map(part => fitText(unescapeText(part)).text ?? '').concat(['', '', '', '', '']).slice(0, 5).join('\u001f');
    case 'ORG': return splitEscaped(value, ';').slice(0, 2).map(part => fitText(unescapeText(part)).text ?? '').concat(['', '']).slice(0, 2).join('\u001f');
    case 'BDAY': case 'ANNIVERSARY': return parseVCardDate(unescapeText(value), params).date;
    default: return null;
  }
}

const SINGLE_PROPERTIES = new Set(['FN', 'N', 'ORG', 'TITLE', 'NOTE', 'BDAY', 'ANNIVERSARY']);

const MEDIA_TYPES: Readonly<Record<string, string>> = { JPEG: 'image/jpeg', JPG: 'image/jpeg', PNG: 'image/png', GIF: 'image/gif', WEBP: 'image/webp', HEIC: 'image/heic', HEIF: 'image/heif', AVIF: 'image/avif', BMP: 'image/bmp', TIFF: 'image/tiff' };

function photoFrom(property: VCardProperty): ImportedPhoto | null {
  const params = { ...property.params };
  if (property.binary) {
    const typeIndex = (params.TYPE || []).findIndex(type => MEDIA_TYPES[type.toUpperCase()]);
    const media = typeIndex >= 0 ? MEDIA_TYPES[params.TYPE[typeIndex].toUpperCase()] : null;
    if (typeIndex >= 0) params.TYPE = params.TYPE.filter((_, index) => index !== typeIndex);
    if (params.TYPE && !params.TYPE.length) delete params.TYPE;
    return property.binary.length ? { media_type: media, data: property.value, params, group: property.group } : null;
  }
  const value = property.value.trim();
  const match = /^data:([^,;]*)((?:;[^,;]*)*),/i.exec(value.slice(0, 256));
  if (!match || !/;base64/i.test(match[2])) return null;
  const data = value.slice(match[0].length).replace(/\s+/g, '');
  delete params.VALUE;
  if (params.MEDIATYPE) delete params.MEDIATYPE;
  return data ? { media_type: match[1].toLowerCase() || null, data, params, group: property.group } : null;
}

function imppValue(scheme: string, value: string) {
  const text = value.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `${scheme}:${text}`;
}

const emptyDraft = (): ContactDraft => ({
  display_name: null, first_name: '', last_name: null, middle_name: null, name_prefix: null, name_suffix: null,
  company: null, department: null, job_title: null, birthday: null, anniversary: null, notes: null, values: [],
});

/** True when a draft holds nothing the page would show. */
function draftIsEmpty(draft: ContactDraft) {
  return !draft.display_name && !draft.first_name && !draft.last_name && !draft.middle_name && !draft.name_prefix && !draft.name_suffix
    && !draft.company && !draft.department && !draft.job_title && !draft.birthday && !draft.anniversary && !draft.notes && !draft.values.length;
}

/**
 * Bounds a draft's values the way the store does: a value too long for its
 * kind or past 100 of a kind is moved to `keep` (when it came from a file
 * property) instead of being cut. Duplicates of a kind (by normalised key)
 * are dropped. Used for vCard and CSV cards alike.
 */
function boundValues(values: readonly (ValueDraft & { source?: KeptPropertyDraft })[], number: number, warnings: ImportWarning[]) {
  const kept: ValueDraft[] = [];
  const overflow: KeptPropertyDraft[] = [];
  const seen = new Set<string>();
  const counts = new Map<ContactValueKind, number>();
  for (const { source, ...value } of values) {
    const key = valueIdentity(value.kind, value.value);
    if (seen.has(key)) continue;
    seen.add(key);
    const count = counts.get(value.kind) || 0;
    const tooLong = characters(value.value).length > VALUE_LIMITS[value.kind]
      || ADDRESS_PARTS.some(part => value[part] && characters(value[part]!).length > (part === 'street' ? STREET_MAX : TEXT_MAX));
    if (tooLong || count >= VALUES_PER_KIND) {
      if (source) overflow.push(source);
      warnings.push(warn(number, source?.name ?? null, tooLong ? 'VALUE_KEPT' : 'VALUES_KEPT',
        tooLong ? 'A value too long to show was kept as an other detail' : `More than ${VALUES_PER_KIND} values of one kind; the rest were kept as other details`));
      continue;
    }
    counts.set(value.kind, count + 1);
    kept.push(value);
  }
  return { values: kept, overflow };
}

/**
 * One card to the contact model. Returns null (with a warning) for a card
 * that holds nothing UniHub shows.
 */
function mapVCard(card: VCardCard, warnings: ImportWarning[]): ImportedCard | null {
  const version = card.version;
  const number = card.number;
  const draft = emptyDraft();
  const properties: KeptPropertyDraft[] = [];
  const values: (ValueDraft & { source?: KeptPropertyDraft })[] = [];
  let uid: string | null = null;
  let photo: ImportedPhoto | null = null;
  let fn: string | null = null;
  let anniversaryFallback: string | null = null;
  const alternates: { kept: KeptPropertyDraft; date: string }[] = [];
  const seenSingle = new Set<string>();
  const keep = (property: VCardProperty, field = false) => { properties.push(keptFrom(property, field ? FIELD_SOURCE : version)); };

  // Apple labels a value through a group: item1.TEL + item1.X-ABLabel. A label
  // is read (and not kept) when its group holds exactly one value property.
  const groups = new Map<string, number[]>();
  card.properties.forEach((property, index) => {
    if (!property.group) return;
    const key = property.group.toLowerCase();
    groups.set(key, [...(groups.get(key) || []), index]);
  });
  const appleLabel = new Map<number, string>();
  const consumed = new Set<number>();
  for (const members of groups.values()) {
    const labels = members.filter(index => card.properties[index].name === 'X-ABLABEL');
    const valued = members.filter(index => VALUE_PROPERTIES[card.properties[index].name] || IM_SCHEMES[card.properties[index].name]);
    if (labels.length === 1 && valued.length === 1) {
      appleLabel.set(valued[0], card.properties[labels[0]].value);
      consumed.add(labels[0]);
    }
  }

  // A value's label, preference and remaining parameters.
  const describe = (kind: ContactValueKind, property: VCardProperty, index: number) => {
    const types = property.params.TYPE || [];
    const custom = types.map(androidCustomLabel).find(Boolean) || null;
    const plainTypes = types.filter(type => !/^X-CUSTOM\(/i.test(type));
    const { label: typeLabel, used } = labelFromTypes(kind, plainTypes);
    const pref = property.params.PREF?.[0];
    const preferred = pref !== undefined || plainTypes.some(type => token(type) === 'pref');
    const noise = NOISE_TYPES[kind];
    const restTypes = plainTypes.filter(type => !used.has(token(type)) && token(type) !== 'pref' && !noise?.has(token(type)));
    let label = typeLabel; let customLabel: string | null = null;
    const apple = appleLabel.get(index);
    if (apple !== undefined) ({ label, custom_label: customLabel } = labelFromApple(kind, apple));
    else if (custom) { const fitted = fitText(custom, CUSTOM_LABEL_MAX).text; if (fitted) { label = 'custom'; customLabel = fitted; } }
    const params = leftover(property.params, { types: restTypes, consumed: pref === '1' || pref === undefined ? ['PREF'] : [] });
    if (kind === 'related' && params?.VALUE) { delete params.VALUE; }
    return { label, custom_label: customLabel, preferred, params: params && Object.keys(params).length ? params : null, vcard_group: property.group };
  };

  for (const [index, property] of card.properties.entries()) {
    if (consumed.has(index) || DROPPED_PROPERTIES.has(property.name)) continue;
    const name = property.name;
    const text = () => unescapeText(property.value);
    const first = SINGLE_PROPERTIES.has(name) && !seenSingle.has(name);
    if (first) seenSingle.add(name);
    // A single property that holds more than its field is kept too (its shadow).
    const shadow = (lossy: boolean, consumedParams: string[] = []) => {
      if (lossy || property.group || leftover(property.params, { types: property.params.TYPE || [], consumed: consumedParams })) keep(property, true);
    };
    switch (name) {
      case 'FN': {
        if (!first) { keep(property); continue; }
        const fitted = fitText(text());
        fn = fitted.text;
        shadow(fitted.cut);
        continue;
      }
      case 'N': {
        if (!first) { keep(property); continue; }
        const parts = splitEscaped(property.value, ';');
        const fitted = parts.slice(0, 5).map(part => fitText(unescapeText(part)));
        [draft.last_name, draft.first_name, draft.middle_name, draft.name_prefix, draft.name_suffix] = [
          fitted[0]?.text ?? null, fitted[1]?.text ?? '', fitted[2]?.text ?? null, fitted[3]?.text ?? null, fitted[4]?.text ?? null];
        shadow(parts.length > 5 || fitted.some(part => part.cut));
        continue;
      }
      case 'ORG': {
        if (!first) { keep(property); continue; }
        const parts = splitEscaped(property.value, ';');
        const [company, department] = [fitText(unescapeText(parts[0] || '')), fitText(unescapeText(parts[1] || ''))];
        [draft.company, draft.department] = [company.text, department.text];
        shadow(parts.length > 2 || company.cut || department.cut);
        continue;
      }
      case 'TITLE': {
        if (!first) { keep(property); continue; }
        const fitted = fitText(text());
        draft.job_title = fitted.text;
        shadow(fitted.cut);
        continue;
      }
      case 'NOTE': {
        if (!first) { keep(property); continue; }
        const fitted = fitNotes(text());
        draft.notes = fitted.text;
        if (fitted.cut) warnings.push(warn(number, name, 'NOTE_CUT', 'The note is longer than 64 KB; the shown note was cut'));
        shadow(fitted.cut);
        continue;
      }
      case 'BDAY': case 'ANNIVERSARY': {
        const textual = (property.params.VALUE || []).some(value => value.toLowerCase() === 'text');
        const parsed = textual ? { date: null, lossy: true } : parseVCardDate(text(), property.params);
        if (!first || !parsed.date) { keep(property); continue; }
        if (name === 'BDAY') draft.birthday = parsed.date; else draft.anniversary = parsed.date;
        shadow(parsed.lossy, ['X-APPLE-OMIT-YEAR']);
        continue;
      }
      case 'UID': {
        const value = text().trim();
        if (uid === null && value && characters(value).length <= UID_MAX) uid = value;
        else if (value && uid === null) warnings.push(warn(number, name, 'UID_TOO_LONG', 'The contact\'s UID is longer than 255 characters; it gets a new one'));
        continue;
      }
      case 'PHOTO': {
        if (!photo) {
          photo = photoFrom(property);
          if (photo) continue;
        }
        keep(property);
        continue;
      }
      case 'NICKNAME': case 'CATEGORIES': {
        const kind: ContactValueKind = name === 'NICKNAME' ? 'nickname' : 'category';
        const described = kind === 'nickname' ? describe(kind, property, index) : { label: '', custom_label: null, preferred: false, params: null, vcard_group: null };
        const source = keptFrom(property, version);
        for (const item of splitEscaped(property.value, ',')) {
          const value = unescapeText(item).trim();
          if (value) values.push({ kind, value, ...described, source });
        }
        continue;
      }
    }
    const kind = VALUE_PROPERTIES[name];
    const scheme = IM_SCHEMES[name];
    if (kind || scheme) {
      const valueKind: ContactValueKind = kind || 'impp';
      const source = keptFrom(property, version);
      const described = describe(valueKind, property, index);
      if (valueKind === 'address') {
        const parts = splitEscaped(property.value, ';');
        const fields = Object.fromEntries(ADDRESS_PARTS.map((part, at) => [part, (unescapeText(parts[at] || '').trim()) || null])) as Record<typeof ADDRESS_PARTS[number], string | null>;
        if (ADDRESS_PARTS.some(part => fields[part])) values.push({ kind: 'address', value: formatAddress(fields), ...fields, ...described, source });
        else if (described.params) keep(property);
        continue;
      }
      let value = text().trim();
      if (valueKind === 'phone' && /^tel:/i.test(value)) value = value.slice(4);
      if (scheme) value = imppValue(scheme, value);
      if (valueKind === 'phone' && described.params?.VALUE) delete described.params.VALUE;
      if (described.params && !Object.keys(described.params).length) described.params = null;
      if (value) values.push({ kind: valueKind, value, ...described, source });
      // The 3.0 messaging properties stay as they were for older readers.
      if (scheme) keep(property, true);
      continue;
    }
    if (ANNIVERSARY_PROPERTIES.has(name)) {
      const date = anniversaryFrom(property, appleLabel.get(index) ?? groupLabel(card, property));
      if (anniversaryFallback === null) anniversaryFallback = date;
      keep(property);
      if (date) alternates.push({ kept: properties[properties.length - 1], date });
      continue;
    }
    keep(property);
  }

  if (!draft.anniversary && anniversaryFallback) draft.anniversary = anniversaryFallback;
  // Another spelling of the anniversary the contact shows follows the field; one with another date is an ordinary kept property.
  for (const { kept, date } of alternates) if (date === draft.anniversary) kept.source_version = FIELD_SOURCE;
  const bounded = boundValues(values, number, warnings);
  draft.values = bounded.values;
  properties.push(...bounded.overflow);
  // FN is the display name only where it differs from what the parts give.
  const derived = displayName({ display_name: null, first_name: draft.first_name, middle_name: draft.middle_name, last_name: draft.last_name, company: draft.company }, draft.values);
  draft.display_name = fn && fn !== derived ? fn : null;
  if (draftIsEmpty(draft)) {
    warnings.push(warn(number, null, 'CARD_EMPTY', 'The contact has no name or other detail UniHub shows; it was skipped'));
    return null;
  }
  if (properties.length > KEPT_PROPERTIES_MAX) {
    warnings.push(warn(number, null, 'KEPT_LIMIT', `More than ${KEPT_PROPERTIES_MAX} other details; the rest were not kept`));
    properties.length = KEPT_PROPERTIES_MAX;
  }
  return { number, uid, draft, properties, photo };
}

// The X-ABLabel of a property's group, when the group has one.
function groupLabel(card: VCardCard, property: VCardProperty) {
  if (!property.group) return undefined;
  const group = property.group.toLowerCase();
  return card.properties.find(other => other.name === 'X-ABLABEL' && other.group?.toLowerCase() === group)?.value;
}

/** An anniversary from Apple, Evolution or Android spellings, or null. */
function anniversaryFrom(property: Pick<VCardProperty, 'name' | 'value' | 'params'>, label: string | undefined): string | null {
  if (property.name === 'X-ANDROID-CUSTOM') {
    // vnd.android.cursor.item/contact_event;<date>;<type>;<label>…; type 1 is an anniversary.
    const parts = splitEscaped(property.value, ';').map(unescapeText);
    return parts[0] === 'vnd.android.cursor.item/contact_event' && parts[2] === '1' ? parseVCardDate(parts[1] || '').date : null;
  }
  if (property.name === 'X-ABDATE' && !/anniversary/i.test(label || '')) return null;
  return parseVCardDate(unescapeText(property.value), property.params).date;
}

export {
  mapVCard, anniversaryFrom, boundValues, FIELD_SOURCE, IM_SCHEMES, ANNIVERSARY_PROPERTIES, draftIsEmpty, emptyDraft, formatAddress, singleTyped, parseVCardDate, storedDate, fitText, fitNotes,
  unescapeText, splitEscaped, labelFromTypes, labelFromApple, keptFrom, token, MEDIA_TYPES, SINGLE_PROPERTIES, ADDRESS_PARTS,
  TEXT_MAX, STREET_MAX, CUSTOM_LABEL_MAX, NOTES_MAX_BYTES,
};
export type { ImportedCard, ImportedPhoto };
