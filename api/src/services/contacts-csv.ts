// Google and Outlook CSV contacts (D6): an RFC 4180 reader and writer and the
// two column layouts, in and out. The reader shares the vCard reader's
// encoding rules (BOM, else UTF-8 when it decodes cleanly, else
// windows-1252) and bounds. A column UniHub does not show is kept as an
// X-CSV-FIELD property labelled with its header, so a vCard export carries it.
//
// Google (contacts.google.com, the 2023+ export, and the older layout with
// "Given Name"/"Family Name"/"Group Membership"):
//   First/Given Name, Middle/Additional Name, Last/Family Name, Name Prefix,
//   Name Suffix, Nickname -> name and nicknames; Name -> display name
//   Phonetic First/Middle/Last Name -> X-PHONETIC-FIRST/MIDDLE/LAST-NAME (kept)
//   Organization Name/Title/Department (or Organization 1 - Name/Title/Department)
//   Birthday, Notes, Photo (a URL, kept as PHOTO, never fetched)
//   Labels / Group Membership -> categories; "* starred" is the favourite,
//     "* myContacts" is dropped, other "* x" system groups become "x"
//   E-mail N, Phone N, Website N, Relation N - Label/Type + Value
//   Address N - Label/Type, Formatted, Street, City, PO Box, Region,
//     Postal Code, Country, Extended Address
//   Event N - Label/Type + Value: "Anniversary" is the anniversary, others kept
//   IM N - Label/Type, Service, Value -> IMPP with the service's scheme
//   Custom Field N - Label/Type + Value -> kept
//   A cell may hold several values joined by " ::: "; a label "* Home" marks
//   the preferred value.
//
// Outlook (desktop export and Outlook.com; English or German headers): the
// fixed columns in OUTLOOK_COLUMNS below. Dates are M/D/YYYY with English
// headers and DD.MM.YYYY with German ones; 0/0/00 is empty. Categories are
// separated by ";".
//
// Export: Google CSV numbers its columns, so every value fits. Outlook's
// columns are fixed (3 emails, one column per phone type, 3 addresses);
// values beyond them go into Notes under "More from UniHub". A cell starting
// with = + - @, a tab or CR is written with a leading ' so a spreadsheet does
// not run it as a formula; this import strips exactly that.
import type { ContactValueKind, ImportFormat, ImportWarning, PartialDate } from '../contracts/contacts';
import type { KeptPropertyDraft, ValueDraft } from './contacts';
import type { ImportedCard } from './contacts-vcard-map';
import type { ExportContact } from './contacts-vcard-write';
import { badRequest } from '../http/errors';
import { IMPORT_LIMITS, byteEncoding, decoderFor, fileText } from './contacts-vcard-read';
import {
  boundValues, draftIsEmpty, emptyDraft, fitNotes, fitText, formatAddress, labelFromApple, storedDate, unescapeText, ADDRESS_PARTS,
} from './contacts-vcard-map';
import { escapeText, partialDateText } from './contacts-vcard-write';

const CSV_SOURCE = 'csv';
const MAX_COLUMNS = 1000;
const warn = (card: number | null, property: string | null, code: string, message: string): ImportWarning => ({ card, property, code, message });

// ── RFC 4180 ───────────────────────────────────────────────────────────

/** The delimiter of a header line: the most frequent of , ; and tab outside quotes. */
function detectDelimiter(text: string) {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && char in counts) counts[char]++;
  }
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',');
}

/**
 * Rows of CSV text: quoted fields may hold the delimiter, doubled quotes and
 * line breaks. Linear; a field over the line bound or a row past the card
 * bound refuses the file.
 */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStart = true;
  const endField = () => {
    if (field.length > IMPORT_LIMITS.lineBytes) throw badRequest('IMPORT_FIELD_TOO_LONG', `Row ${rows.length + 1} has a field longer than 1 MB.`);
    row.push(field); field = ''; fieldStart = true;
    if (row.length > MAX_COLUMNS) throw badRequest('IMPORT_TOO_MANY_COLUMNS', `The file has more than ${MAX_COLUMNS} columns.`);
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    if (rows.length > IMPORT_LIMITS.cards + 1) {
      throw badRequest('IMPORT_TOO_MANY_CARDS', `The file holds more than ${IMPORT_LIMITS.cards.toLocaleString('en')} contacts. Split it and import the parts.`);
    }
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && fieldStart) { quoted = true; fieldStart = false; continue; }
    fieldStart = false;
    if (char === delimiter) endField();
    else if (char === '\r') { if (text[index + 1] === '\n') index++; endRow(); }
    else if (char === '\n') endRow();
    else field += char;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

const FORMULA_START = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Undoes the export's formula defusing: a ' before = + - @ tab or CR. */
function undefuse(cell: string) {
  return cell.length > 1 && cell[0] === "'" && FORMULA_START.has(cell[1]) ? cell.slice(1) : cell;
}

function csvCell(value: string | null | undefined, delimiter: string) {
  let text = value ?? '';
  if (text && FORMULA_START.has(text[0])) text = `'${text}`;
  return /["\r\n]/.test(text) || text.includes(delimiter) || text.trim() !== text ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV text with a UTF-8 BOM (spreadsheet programs need it to read UTF-8), CRLF rows. */
function writeCsv(rows: readonly (readonly (string | null | undefined)[])[], delimiter = ',') {
  return `\uFEFF${rows.map(row => row.map(cell => csvCell(cell, delimiter)).join(delimiter)).join('\r\n')}\r\n`;
}

// ── Layouts ────────────────────────────────────────────────────────────

type OutlookTarget =
  | { field: 'given' | 'middle' | 'family' | 'prefix' | 'suffix' | 'company' | 'department' | 'job_title' | 'notes' | 'birthday' | 'anniversary' | 'categories' }
  | { kind: 'email' | 'nickname' | 'impp' }
  | { kind: 'phone' | 'url' | 'related'; label: string }
  | { address: 'work' | 'home' | 'other'; part: 'street' | 'street2' | 'street3' | 'locality' | 'region' | 'postal_code' | 'country' | 'po_box' };

// [English header, German header, target]. The order is the Outlook export's.
const OUTLOOK_COLUMNS: readonly [string, string, OutlookTarget][] = [
  ['First Name', 'Vorname', { field: 'given' }],
  ['Middle Name', 'Weitere Vornamen', { field: 'middle' }],
  ['Last Name', 'Nachname', { field: 'family' }],
  ['Title', 'Anrede', { field: 'prefix' }],
  ['Suffix', 'Suffix', { field: 'suffix' }],
  ['Nickname', 'Spitzname', { kind: 'nickname' }],
  ['E-mail Address', 'E-Mail-Adresse', { kind: 'email' }],
  ['E-mail 2 Address', 'E-Mail 2: Adresse', { kind: 'email' }],
  ['E-mail 3 Address', 'E-Mail 3: Adresse', { kind: 'email' }],
  ['Home Phone', 'Telefon privat', { kind: 'phone', label: 'home' }],
  ['Home Phone 2', 'Telefon privat 2', { kind: 'phone', label: 'home' }],
  ['Business Phone', 'Telefon geschäftlich', { kind: 'phone', label: 'work' }],
  ['Business Phone 2', 'Telefon geschäftlich 2', { kind: 'phone', label: 'work' }],
  ['Mobile Phone', 'Mobiltelefon', { kind: 'phone', label: 'mobile' }],
  ['Car Phone', 'Autotelefon', { kind: 'phone', label: 'car' }],
  ['Other Phone', 'Weiteres Telefon', { kind: 'phone', label: 'other' }],
  ['Primary Phone', 'Haupttelefon', { kind: 'phone', label: 'main' }],
  ['Pager', 'Pager', { kind: 'phone', label: 'pager' }],
  ['Business Fax', 'Fax geschäftlich', { kind: 'phone', label: 'work_fax' }],
  ['Home Fax', 'Fax privat', { kind: 'phone', label: 'home_fax' }],
  ['Other Fax', 'Weiteres Fax', { kind: 'phone', label: 'other_fax' }],
  ['Company Main Phone', 'Telefon Firma', { kind: 'phone', label: 'company_main' }],
  ['Callback', 'Rückmeldung', { kind: 'phone', label: 'callback' }],
  ['Radio Phone', 'Funktelefon', { kind: 'phone', label: 'radio' }],
  ['Telex', 'Telex', { kind: 'phone', label: 'telex' }],
  ['TTY/TDD Phone', 'Telefon für Hörbehinderte', { kind: 'phone', label: 'tty_tdd' }],
  ['ISDN', 'ISDN', { kind: 'phone', label: 'isdn' }],
  ["Assistant's Phone", 'Telefon Assistent', { kind: 'phone', label: 'assistant' }],
  ['IMAddress', 'Chatadresse', { kind: 'impp' }],
  ['Job Title', 'Position', { field: 'job_title' }],
  ['Department', 'Abteilung', { field: 'department' }],
  ['Company', 'Firma', { field: 'company' }],
  ["Manager's Name", 'Name des/der Vorgesetzten', { kind: 'related', label: 'manager' }],
  ["Assistant's Name", 'Name Assistent', { kind: 'related', label: 'assistant' }],
  ['Business Street', 'Straße geschäftlich', { address: 'work', part: 'street' }],
  ['Business Street 2', 'Straße geschäftlich 2', { address: 'work', part: 'street2' }],
  ['Business Street 3', 'Straße geschäftlich 3', { address: 'work', part: 'street3' }],
  ['Business City', 'Ort geschäftlich', { address: 'work', part: 'locality' }],
  ['Business State', 'Region geschäftlich', { address: 'work', part: 'region' }],
  ['Business Postal Code', 'Postleitzahl geschäftlich', { address: 'work', part: 'postal_code' }],
  ['Business Country/Region', 'Land/Region geschäftlich', { address: 'work', part: 'country' }],
  ['Business Address PO Box', 'Postfach geschäftlich', { address: 'work', part: 'po_box' }],
  ['Home Street', 'Straße privat', { address: 'home', part: 'street' }],
  ['Home Street 2', 'Straße privat 2', { address: 'home', part: 'street2' }],
  ['Home Street 3', 'Straße privat 3', { address: 'home', part: 'street3' }],
  ['Home City', 'Ort privat', { address: 'home', part: 'locality' }],
  ['Home State', 'Bundesland/Kanton privat', { address: 'home', part: 'region' }],
  ['Home Postal Code', 'Postleitzahl privat', { address: 'home', part: 'postal_code' }],
  ['Home Country/Region', 'Land/Region privat', { address: 'home', part: 'country' }],
  ['Home Address PO Box', 'Postfach privat', { address: 'home', part: 'po_box' }],
  ['Other Street', 'Weitere Straße', { address: 'other', part: 'street' }],
  ['Other Street 2', 'Weitere Straße 2', { address: 'other', part: 'street2' }],
  ['Other Street 3', 'Weitere Straße 3', { address: 'other', part: 'street3' }],
  ['Other City', 'Weiterer Ort', { address: 'other', part: 'locality' }],
  ['Other State', 'Weiteres/r Bundesland/Kanton', { address: 'other', part: 'region' }],
  ['Other Postal Code', 'Weitere Postleitzahl', { address: 'other', part: 'postal_code' }],
  ['Other Country/Region', 'Weiteres/e Land/Region', { address: 'other', part: 'country' }],
  ['Other Address PO Box', 'Weiteres Postfach', { address: 'other', part: 'po_box' }],
  ['Personal Web Page', 'Persönliche Webseite', { kind: 'url', label: 'home' }],
  ['Web Page', 'Webseite', { kind: 'url', label: '' }],
  ['Spouse', 'Partner', { kind: 'related', label: 'spouse' }],
  ['Children', 'Kinder', { kind: 'related', label: 'child' }],
  ['Referred By', 'Empfohlen von', { kind: 'related', label: 'referred_by' }],
  ['Birthday', 'Geburtstag', { field: 'birthday' }],
  ['Anniversary', 'Jahrestag', { field: 'anniversary' }],
  ['Categories', 'Kategorien', { field: 'categories' }],
  ['Notes', 'Notizen', { field: 'notes' }],
];
// Headers that say "Outlook" when present (case-insensitive), per language.
const OUTLOOK_EN = new Map(OUTLOOK_COLUMNS.map(([en, , target]) => [en.toLowerCase(), target]));
const OUTLOOK_DE = new Map(OUTLOOK_COLUMNS.map(([, de, target]) => [de.toLowerCase(), target]));
// Outlook columns that are only informational and stay out of the contact when empty or default.
const OUTLOOK_IGNORED = new Set(['e-mail type', 'e-mail 2 type', 'e-mail 3 type', 'e-mail display name', 'e-mail 2 display name', 'e-mail 3 display name',
  'e-mail-typ', 'e-mail 2: typ', 'e-mail 3: typ', 'e-mail: angezeigter name', 'e-mail 2: angezeigter name', 'e-mail 3: angezeigter name',
  'priority', 'priorität', 'sensitivity', 'vertraulichkeit', 'private', 'privat', 'gender', 'geschlecht', 'initials', 'initialen']);

const GOOGLE_NUMBERED = /^(E-mail|Phone|Address|Website|Relation|Event|IM|Custom Field|Organization) (\d{1,3}) - (.+)$/i;
const GOOGLE_HEADERS = new Set(['first name', 'given name', 'middle name', 'additional name', 'last name', 'family name', 'name', 'name prefix', 'name suffix',
  'nickname', 'labels', 'group membership', 'organization name', 'organization title', 'organization department', 'birthday', 'notes', 'photo', 'file as',
  'phonetic first name', 'phonetic middle name', 'phonetic last name']);

type CsvLayout = 'google' | 'outlook-en' | 'outlook-de';

/** The layout of a header row, or null. Google has numbered "… N - Value" columns; Outlook its fixed names. */
function detectLayout(header: readonly string[]): CsvLayout | null {
  const lower = header.map(cell => cell.trim().toLowerCase());
  const numbered = header.filter(cell => GOOGLE_NUMBERED.test(cell.trim())).length;
  const en = lower.filter(cell => OUTLOOK_EN.has(cell)).length;
  const de = lower.filter(cell => OUTLOOK_DE.has(cell)).length;
  const google = numbered + lower.filter(cell => GOOGLE_HEADERS.has(cell)).length;
  if (numbered > 0 && google >= 3) return 'google';
  if (de >= 3 && de > en) return 'outlook-de';
  if (en >= 3) return 'outlook-en';
  return null;
}

// ── Reading ────────────────────────────────────────────────────────────

const keptCsv = (header: string, value: string, name = 'X-CSV-FIELD'): KeptPropertyDraft => ({
  name, group: null, params: name === 'X-CSV-FIELD' ? { 'X-LABEL': [header] } : null, value: escapeText(value), source_version: CSV_SOURCE,
});

/** A CSV date: ISO (1985-03-15, --03-15), M/D/YYYY (English) or D.M.YYYY (German); 0/0/00 is empty. */
function csvDate(text: string, layout: CsvLayout): string | null {
  const value = text.trim();
  if (!value || /^0+[/.]0+[/.]0+$/.test(value)) return null;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  if (match) return storedDate(Number(match[1]), Number(match[2]), Number(match[3]));
  if ((match = /^--(\d{1,2})-(\d{1,2})$/.exec(value))) return storedDate(null, Number(match[1]), Number(match[2]));
  if ((match = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})?$/.exec(value)) && layout !== 'outlook-en') return storedDate(match[3] ? fullYear(match[3]) : null, Number(match[2]), Number(match[1]));
  if ((match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(value))) return storedDate(match[3] ? fullYear(match[3]) : null, Number(match[1]), Number(match[2]));
  return null;
}
const fullYear = (text: string) => (text.length === 4 ? Number(text) : Number(text) + (Number(text) > 30 ? 1900 : 2000));

const IM_SERVICES: Readonly<Record<string, string>> = { jabber: 'xmpp', xmpp: 'xmpp', 'google talk': 'xmpp', hangouts: 'xmpp', skype: 'skype', aim: 'aim', icq: 'icq',
  msn: 'msnim', yahoo: 'ymsgr', qq: 'qq', sip: 'sip' };

const splitMulti = (cell: string) => cell.split(' ::: ').map(part => part.trim()).filter(Boolean);
type DraftValue = ValueDraft & { source?: KeptPropertyDraft };

function labelled(kind: ContactValueKind, labelText: string, value: string, extra: Partial<ValueDraft> = {}): DraftValue {
  const preferred = labelText.trim().startsWith('* ');
  const text = preferred ? labelText.trim().slice(2) : labelText.trim();
  const { label, custom_label } = text ? labelFromApple(kind, text) : { label: '', custom_label: null };
  return { kind, value, label, custom_label, preferred, params: null, vcard_group: null, ...extra };
}

/**
 * A name, organisation, title or note cell for its field. A cell longer than
 * the field is cut for the field and kept whole as an other detail (exported
 * again), with a warning naming the card and the column, never the value.
 */
function fitCell(number: number, header: string, cell: string, properties: KeptPropertyDraft[], warnings: ImportWarning[], { notes = false } = {}) {
  const fitted = notes ? fitNotes(cell) : fitText(cell);
  if (fitted.cut) {
    properties.push(keptCsv(header, cell));
    warnings.push(warn(number, header, notes ? 'NOTE_CUT' : 'VALUE_CUT', notes
      ? 'The note is longer than 64 KB; the shown note was cut and the whole note was kept as an other detail'
      : 'A value longer than its field was cut; the whole value was kept as an other detail'));
  }
  return fitted.text;
}

/** One Google row to a card; null when the row holds nothing. */
function googleCard(number: number, header: readonly string[], row: readonly string[], warnings: ImportWarning[]): ImportedCard | null {
  const draft = emptyDraft();
  const properties: KeptPropertyDraft[] = [];
  const values: DraftValue[] = [];
  const numbered = new Map<string, Map<number, Record<string, string>>>();
  let display: string | null = null;
  let favorite = false;
  header.forEach((rawHeader, column) => {
    const cell = undefuse(row[column] ?? '').trim();
    if (!cell) return;
    const headerText = rawHeader.trim();
    const match = GOOGLE_NUMBERED.exec(headerText);
    if (match) {
      const kind = match[1].toLowerCase();
      const entries = numbered.get(kind) || new Map<number, Record<string, string>>();
      const entry = entries.get(Number(match[2])) || {};
      entry[match[3].trim().toLowerCase()] = cell;
      entries.set(Number(match[2]), entry);
      numbered.set(kind, entries);
      return;
    }
    const fit = (options?: { notes: boolean }) => fitCell(number, headerText, cell, properties, warnings, options);
    switch (headerText.toLowerCase()) {
      case 'first name': case 'given name': draft.first_name = fit() || ''; return;
      case 'middle name': case 'additional name': draft.middle_name = fit(); return;
      case 'last name': case 'family name': draft.last_name = fit(); return;
      case 'name': display = fit(); return;
      case 'name prefix': draft.name_prefix = fit(); return;
      case 'name suffix': draft.name_suffix = fit(); return;
      case 'nickname': for (const nickname of splitMulti(cell)) values.push(labelled('nickname', '', nickname)); return;
      case 'organization name': draft.company = fit(); return;
      case 'organization title': draft.job_title = fit(); return;
      case 'organization department': draft.department = fit(); return;
      case 'birthday': draft.birthday = csvDate(cell, 'google'); if (!draft.birthday) properties.push(keptCsv(headerText, cell)); return;
      case 'notes': draft.notes = fit({ notes: true }); return;
      case 'photo': properties.push({ name: 'PHOTO', group: null, params: { VALUE: ['uri'] }, value: cell, source_version: CSV_SOURCE }); return;
      case 'labels': case 'group membership':
        for (const group of splitMulti(cell)) {
          if (/^\*\s*starred$/i.test(group)) favorite = true;
          else if (!/^\*\s*my\s*contacts$/i.test(group)) values.push(labelled('category', '', group.replace(/^\*\s*/, '')));
        }
        return;
      case 'phonetic first name': properties.push(keptCsv(headerText, cell, 'X-PHONETIC-FIRST-NAME')); return;
      case 'phonetic middle name': properties.push(keptCsv(headerText, cell, 'X-PHONETIC-MIDDLE-NAME')); return;
      case 'phonetic last name': properties.push(keptCsv(headerText, cell, 'X-PHONETIC-LAST-NAME')); return;
      default: properties.push(keptCsv(headerText, cell));
    }
  });
  const sorted = (kind: string) => [...(numbered.get(kind)?.entries() || [])].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
  const label = (entry: Record<string, string>) => entry.label ?? entry.type ?? '';
  const simple = (source: string, kind: ContactValueKind) => {
    for (const entry of sorted(source)) for (const value of splitMulti(entry.value || '')) values.push(labelled(kind, label(entry), value));
  };
  simple('e-mail', 'email');
  simple('phone', 'phone');
  simple('website', 'url');
  simple('relation', 'related');
  for (const entry of sorted('address')) {
    const parts: Record<typeof ADDRESS_PARTS[number], string | null> = {
      po_box: entry['po box'] || null, extended: entry['extended address'] || null, street: entry.street || null, locality: entry.city || null,
      region: entry.region || null, postal_code: entry['postal code'] || null, country: entry.country || null,
    };
    if (!ADDRESS_PARTS.some(part => parts[part])) parts.street = entry.formatted || null;
    if (ADDRESS_PARTS.some(part => parts[part])) values.push(labelled('address', label(entry), formatAddress(parts), parts));
  }
  for (const entry of sorted('im')) {
    const scheme = IM_SERVICES[(entry.service || '').trim().toLowerCase()];
    for (const value of splitMulti(entry.value || '')) values.push(labelled('impp', label(entry), scheme && !/^[a-z][a-z0-9+.-]*:/i.test(value) ? `${scheme}:${value}` : value));
  }
  for (const entry of sorted('event')) {
    const date = csvDate(entry.value || '', 'google');
    if (/anniversary/i.test(label(entry)) && date && !draft.anniversary) draft.anniversary = date;
    else if (entry.value) properties.push(keptCsv(`Event${label(entry) ? ` (${label(entry)})` : ''}`, entry.value));
  }
  for (const entry of sorted('custom field')) if (entry.value) properties.push(keptCsv(label(entry) || 'Custom field', entry.value));
  const [organization] = sorted('organization');
  if (organization) {
    const fit = (part: string, header: string) => (part ? fitCell(number, header, part, properties, warnings) : null);
    draft.company ||= fit(organization.name, 'Organization 1 - Name');
    draft.job_title ||= fit(organization.title, 'Organization 1 - Title');
    draft.department ||= fit(organization.department, 'Organization 1 - Department');
  }
  return finishCard(number, draft, values, properties, display, favorite, warnings);
}

/** One Outlook row to a card. */
function outlookCard(number: number, header: readonly string[], row: readonly string[], layout: CsvLayout, warnings: ImportWarning[]): ImportedCard | null {
  const draft = emptyDraft();
  const properties: KeptPropertyDraft[] = [];
  const values: DraftValue[] = [];
  const addresses: Record<string, Record<string, string>> = {};
  const columns = layout === 'outlook-de' ? OUTLOOK_DE : OUTLOOK_EN;
  header.forEach((rawHeader, column) => {
    const cell = undefuse(row[column] ?? '').trim();
    if (!cell) return;
    const headerText = rawHeader.trim();
    const target = columns.get(headerText.toLowerCase());
    if (!target) {
      if (!OUTLOOK_IGNORED.has(headerText.toLowerCase())) properties.push(keptCsv(headerText, cell));
      return;
    }
    if ('field' in target) {
      const fit = (options?: { notes: boolean }) => fitCell(number, headerText, cell, properties, warnings, options);
      switch (target.field) {
        case 'given': draft.first_name = fit() || ''; return;
        case 'middle': draft.middle_name = fit(); return;
        case 'family': draft.last_name = fit(); return;
        case 'prefix': draft.name_prefix = fit(); return;
        case 'suffix': draft.name_suffix = fit(); return;
        case 'company': draft.company = fit(); return;
        case 'department': draft.department = fit(); return;
        case 'job_title': draft.job_title = fit(); return;
        case 'notes': draft.notes = fit({ notes: true }); return;
        case 'birthday': case 'anniversary': {
          const date = csvDate(cell, layout);
          if (date) draft[target.field] = date; else if (!/^0+[/.]0+[/.]0+$/.test(cell)) properties.push(keptCsv(headerText, cell));
          return;
        }
        case 'categories': for (const category of cell.split(';').map(part => part.trim()).filter(Boolean)) values.push(labelled('category', '', category)); return;
      }
    }
    if ('address' in target) { (addresses[target.address] ||= {})[target.part] = cell; return; }
    if (target.kind === 'related' && target.label === 'child') {
      for (const child of cell.split(/[;,]/).map(part => part.trim()).filter(Boolean)) values.push({ ...labelled('related', '', child), label: 'child' });
      return;
    }
    values.push({ ...labelled(target.kind, '', cell), label: 'label' in target ? target.label : '' });
  });
  for (const block of ['work', 'home', 'other'] as const) {
    const source = addresses[block];
    if (!source) continue;
    const parts: Record<typeof ADDRESS_PARTS[number], string | null> = {
      po_box: source.po_box || null, extended: null, street: [source.street, source.street2, source.street3].filter(Boolean).join('\n') || null,
      locality: source.locality || null, region: source.region || null, postal_code: source.postal_code || null, country: source.country || null,
    };
    values.push({ ...labelled('address', '', formatAddress(parts), parts), label: block });
  }
  return finishCard(number, draft, values, properties, null, false, warnings);
}

function finishCard(number: number, draft: ReturnType<typeof emptyDraft>, values: DraftValue[], properties: KeptPropertyDraft[], display: string | null,
  favorite: boolean, warnings: ImportWarning[]): ImportedCard | null {
  // A value too long to show keeps its column as an other detail.
  const withSource = values.map(value => ({ ...value, source: keptCsv(value.kind, value.value) }));
  const bounded = boundValues(withSource, number, warnings);
  draft.values = bounded.values;
  properties.push(...bounded.overflow);
  if (display) {
    const parts = [draft.first_name, draft.middle_name, draft.last_name].filter(Boolean).join(' ');
    if (display !== parts) draft.display_name = display;
  }
  if (favorite) draft.is_favorite = true;
  if (draftIsEmpty(draft)) {
    if (properties.length) warnings.push(warn(number, null, 'CARD_EMPTY', 'The contact has no name or other detail UniHub shows; it was skipped'));
    return null;
  }
  return { number, uid: null, draft, properties, photo: null };
}

interface CsvReadResult { format: ImportFormat; cards: ImportedCard[]; warnings: ImportWarning[]; encoding: string }

/** Reads a Google or Outlook CSV file; refuses any other layout plainly. */
function readContactsCsv(input: Buffer): CsvReadResult {
  if (input.length > IMPORT_LIMITS.fileBytes) throw badRequest('IMPORT_TOO_LARGE', 'The file is larger than 64 MB.');
  const { bytes, encoding } = fileText(input);
  const text = decoderFor(byteEncoding(encoding))!.decode(bytes);
  const rows = parseCsv(text, detectDelimiter(text));
  if (!rows.length) throw badRequest('IMPORT_EMPTY', 'The file holds no contacts.');
  const [header, ...data] = rows;
  const layout = detectLayout(header);
  if (!layout) {
    throw badRequest('IMPORT_UNKNOWN_LAYOUT', 'UniHub reads vCard files and Google or Outlook CSV exports (with English or German column names). This CSV file has other columns.');
  }
  const warnings: ImportWarning[] = [];
  const cards: ImportedCard[] = [];
  data.forEach((row, index) => {
    const card = layout === 'google' ? googleCard(index + 1, header, row, warnings) : outlookCard(index + 1, header, row, layout, warnings);
    if (card) cards.push(card);
  });
  return { format: layout === 'google' ? 'google-csv' : 'outlook-csv', cards, warnings, encoding };
}

/** True when the start of the file looks like a CSV header (no BEGIN:VCARD). */
function looksLikeCsv(input: Buffer) {
  const { bytes, encoding } = fileText(input.subarray(0, 64 * 1024));
  const head = decoderFor(byteEncoding(encoding))!.decode(bytes);
  const firstLine = head.split(/\r\n|\r|\n/, 1)[0];
  return /[,;\t]/.test(firstLine);
}

// ── Writing ────────────────────────────────────────────────────────────

const words = (label: string) => label.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
const googleLabel = (item: { label: string; custom_label?: string | null; preferred?: boolean }) => {
  const text = item.label === 'custom' ? item.custom_label || '' : item.label === 'homepage' ? 'Home Page' : item.label ? words(item.label) : '';
  return item.preferred ? `* ${text}` : text;
};
const googleDate = (date: PartialDate | null) => partialDateText(date) ?? '';
const keptText = (property: KeptPropertyDraft) => unescapeText(property.value);

/** Google CSV: as many numbered columns as the contact with the most values needs. */
function writeGoogleCsv(contacts: readonly ExportContact[]) {
  const max = (pick: (entry: ExportContact) => number) => Math.max(0, ...contacts.map(pick));
  const custom = (entry: ExportContact) => entry.properties.filter(property => property.name !== 'PHOTO' && !property.name.startsWith('X-PHONETIC-') && property.source_version !== 'field');
  const counts = {
    email: max(entry => entry.contact.emails.length), phone: max(entry => entry.contact.phones.length), address: max(entry => entry.contact.addresses.length),
    relation: max(entry => entry.contact.related.length), website: max(entry => entry.contact.urls.length), event: max(entry => (entry.contact.anniversary ? 1 : 0)),
    im: max(entry => entry.contact.impp.length), custom: max(entry => custom(entry).length),
  };
  const numbered = (name: string, count: number, fields: string[]) => Array.from({ length: count }, (_, index) => fields.map(field => `${name} ${index + 1} - ${field}`)).flat();
  const header = ['First Name', 'Middle Name', 'Last Name', 'Phonetic First Name', 'Phonetic Middle Name', 'Phonetic Last Name', 'Name Prefix', 'Name Suffix',
    'Nickname', 'File As', 'Organization Name', 'Organization Title', 'Organization Department', 'Birthday', 'Notes', 'Photo', 'Labels',
    ...numbered('E-mail', counts.email, ['Label', 'Value']), ...numbered('Phone', counts.phone, ['Label', 'Value']),
    ...numbered('Address', counts.address, ['Label', 'Formatted', 'Street', 'City', 'PO Box', 'Region', 'Postal Code', 'Country', 'Extended Address']),
    ...numbered('Relation', counts.relation, ['Label', 'Value']), ...numbered('Website', counts.website, ['Label', 'Value']),
    ...numbered('Event', counts.event, ['Label', 'Value']), ...numbered('IM', counts.im, ['Label', 'Service', 'Value']),
    ...numbered('Custom Field', counts.custom, ['Label', 'Value'])];
  const pad = <T>(list: readonly T[], count: number, cells: (item: T) => string[], width: number) =>
    Array.from({ length: count }, (_, index) => (list[index] ? cells(list[index]) : Array(width).fill(''))).flat();
  const rows = contacts.map(entry => {
    const { contact } = entry;
    const phonetic = (part: string) => entry.properties.find(property => property.name === `X-PHONETIC-${part}-NAME`);
    const photo = entry.properties.find(property => property.name === 'PHOTO' && /^https?:/i.test(property.value));
    const named = contact.name.given || contact.name.middle || contact.name.family;
    return [
      contact.name.given || (!named && !contact.organization.name ? contact.name.display || '' : ''), contact.name.middle ?? '', contact.name.family ?? '',
      ...['FIRST', 'MIDDLE', 'LAST'].map(part => { const property = phonetic(part); return property ? keptText(property) : ''; }),
      contact.name.prefix ?? '', contact.name.suffix ?? '', contact.nicknames.map(item => item.value).join(' ::: '), '',
      contact.organization.name ?? '', contact.job_title ?? '', contact.organization.department ?? '', googleDate(contact.birthday), contact.notes ?? '',
      photo ? photo.value : '',
      [...contact.categories, '* myContacts', ...(contact.is_favorite ? ['* starred'] : [])].join(' ::: '),
      ...pad(contact.emails, counts.email, item => [googleLabel(item), item.value], 2),
      ...pad(contact.phones, counts.phone, item => [googleLabel(item), item.value], 2),
      ...pad(contact.addresses, counts.address, item => [googleLabel(item), item.value, item.street ?? '', item.locality ?? '', item.po_box ?? '', item.region ?? '',
        item.postal_code ?? '', item.country ?? '', item.extended ?? ''], 9),
      ...pad(contact.related, counts.relation, item => [googleLabel(item), item.value], 2),
      ...pad(contact.urls, counts.website, item => [googleLabel(item), item.value], 2),
      ...pad(contact.anniversary ? [contact.anniversary] : [], counts.event, date => ['Anniversary', googleDate(date)], 2),
      ...pad(contact.impp, counts.im, item => [googleLabel(item), '', item.value], 3),
      ...pad(custom(entry), counts.custom, property => [property.name === 'X-CSV-FIELD' ? String((property.params?.['X-LABEL'] as string[] | undefined)?.[0] ?? '') : property.name,
        keptText(property)], 2),
    ];
  });
  return writeCsv([header, ...rows]);
}

const OUTLOOK_HEADER = OUTLOOK_COLUMNS.map(([en]) => en);
// Phone labels without an Outlook column of their own.
const OUTLOOK_PHONE_LABEL: Readonly<Record<string, string>> = { work_mobile: 'mobile', work_pager: 'pager', mms: 'other', custom: 'other', '': 'other' };
const outlookDate = (date: PartialDate) => `${date.month}/${date.day}/${date.year}`;

/**
 * Outlook CSV (English desktop layout). Its columns are fixed; what does not
 * fit (a fourth email, a second mobile number, a year-less birthday …) is
 * written into Notes under "More from UniHub". Kept properties are not
 * written: Outlook has no place for them.
 */
function writeOutlookCsv(contacts: readonly ExportContact[]) {
  const index = new Map(OUTLOOK_HEADER.map((name, at) => [name, at]));
  const rows = contacts.map(({ contact }) => {
    const row: string[] = Array(OUTLOOK_HEADER.length).fill('');
    const more: string[] = [];
    const set = (column: string, value: string | null | undefined) => { if (value) row[index.get(column)!] = value; };
    const free = (columns: readonly string[]) => columns.find(column => !row[index.get(column)!]);
    const named = contact.name.given || contact.name.middle || contact.name.family;
    set('First Name', contact.name.given || (!named && !contact.organization.name ? contact.display_name : ''));
    set('Middle Name', contact.name.middle); set('Last Name', contact.name.family); set('Title', contact.name.prefix); set('Suffix', contact.name.suffix);
    set('Company', contact.organization.name); set('Department', contact.organization.department); set('Job Title', contact.job_title);
    contact.nicknames.forEach((item, at) => (at === 0 ? set('Nickname', item.value) : more.push(`Nickname: ${item.value}`)));
    contact.emails.forEach((item, at) => (at < 3 ? set(['E-mail Address', 'E-mail 2 Address', 'E-mail 3 Address'][at], item.value) : more.push(`Email${labelSuffix(item)}: ${item.value}`)));
    const phoneColumns = (label: string) => {
      const wanted = OUTLOOK_PHONE_LABEL[label] ?? label;
      return OUTLOOK_COLUMNS.filter(([, , target]) => 'kind' in target && target.kind === 'phone' && 'label' in target && target.label === wanted).map(([en]) => en);
    };
    for (const item of contact.phones) {
      const column = free(phoneColumns(item.label)) || free(['Other Phone']);
      if (column) set(column, item.value); else more.push(`Phone${labelSuffix(item)}: ${item.value}`);
    }
    for (const item of contact.addresses) {
      const block = item.label === 'work' ? 'Business' : item.label === 'home' ? 'Home' : 'Other';
      const target = [block, 'Other'].find(name => !['Street', 'City', 'State', 'Postal Code', 'Country/Region', 'Address PO Box'].some(part => row[index.get(`${name} ${part}`)!]));
      if (!target) { more.push(`Address${labelSuffix(item)}: ${item.value.replace(/\n/g, ', ')}`); continue; }
      set(`${target} Street`, [item.extended, item.street].filter(Boolean).join('\n')); set(`${target} City`, item.locality); set(`${target} State`, item.region);
      set(`${target} Postal Code`, item.postal_code); set(`${target} Country/Region`, item.country); set(`${target} Address PO Box`, item.po_box);
    }
    for (const item of contact.urls) {
      const column = free(item.label === 'home' || item.label === 'homepage' ? ['Personal Web Page', 'Web Page'] : ['Web Page', 'Personal Web Page']);
      if (column) set(column, item.value); else more.push(`Web address${labelSuffix(item)}: ${item.value}`);
    }
    contact.impp.forEach((item, at) => (at === 0 ? set('IMAddress', item.value) : more.push(`Messaging${labelSuffix(item)}: ${item.value}`)));
    const children: string[] = [];
    for (const item of contact.related) {
      const column = ({ spouse: 'Spouse', manager: "Manager's Name", assistant: "Assistant's Name", referred_by: 'Referred By' } as Record<string, string>)[item.label];
      if (item.label === 'child') children.push(item.value);
      else if (column && free([column])) set(column, item.value);
      else more.push(`Related${labelSuffix(item)}: ${item.value}`);
    }
    set('Children', children.join('; '));
    for (const [field, column, name] of [['birthday', 'Birthday', 'Birthday'], ['anniversary', 'Anniversary', 'Anniversary']] as const) {
      const date = contact[field];
      if (date?.year) set(column, outlookDate(date)); else if (date) more.push(`${name}: ${partialDateText(date)}`);
    }
    set('Categories', contact.categories.join(';'));
    const notes = [contact.notes, more.length ? `More from UniHub:\n${more.join('\n')}` : null].filter(Boolean).join('\n\n');
    set('Notes', notes);
    return row;
  });
  return writeCsv([OUTLOOK_HEADER, ...rows]);
}

function labelSuffix(item: { label: string; custom_label?: string | null }) {
  const text = item.label === 'custom' ? item.custom_label : item.label ? words(item.label) : null;
  return text ? ` (${text})` : '';
}

export { readContactsCsv, looksLikeCsv, parseCsv, detectDelimiter, detectLayout, writeCsv, writeGoogleCsv, writeOutlookCsv, csvDate, undefuse, OUTLOOK_COLUMNS };
export type { CsvReadResult, CsvLayout };
