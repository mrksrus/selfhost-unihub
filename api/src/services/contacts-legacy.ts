// The 0.25 vCard import and export, kept working on the new model until the
// vCard pipeline with preview (stream B) replaces them and deletes this file.
// Unlike 0.25 they keep every email and phone: nothing is capped at three.
// The 0.25 automatic merge is gone: services/contact-merge.ts replaces it.
import type { ContactRecord } from '../contracts/contacts';
import type { ContactDraft, ValueDraft } from './contacts';
import { db } from '../state';
import { withTransaction } from './transactions';
import { insertContact, loadContacts, uidHash, VALUE_LIMITS, VALUES_PER_KIND } from './contacts';
import { valueKey } from './contact-keys';
import type { RowDataPacket } from 'mysql2/promise';

const TEXT_MAX = 255;

function escapeVCard(text: string | null | undefined) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function unescapeVCard(text: string) {
  return text.replace(/\\n/gi, '\n').replace(/\\;/g, ';').replace(/\\,/g, ',').replace(/\\\\/g, '\\');
}

// Splits a structured value (N, ORG) on unescaped semicolons.
function splitComponents(value: string) {
  const parts: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of value) {
    if (escaped) { current += `\\${char}`; escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === ';') { parts.push(current); current = ''; continue; }
    current += char;
  }
  if (escaped) current += '\\';
  parts.push(current);
  return parts.map(unescapeVCard);
}

// Quoted-printable decoded as UTF-8 bytes (0.25 mapped each byte to a character).
function decodeQuotedPrintable(text: string) {
  const bytes: number[] = [];
  const source = text.replace(/=\r?\n/g, '');
  for (let index = 0; index < source.length; index++) {
    const hex = source.slice(index + 1, index + 3);
    if (source[index] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); index += 2; }
    else bytes.push(...Buffer.from(source[index], 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

const PHONE_TYPES: Readonly<Record<string, string>> = { CELL: 'mobile', HOME: 'home', WORK: 'work', PAGER: 'pager', MAIN: 'main' };
const PHONE_LABEL_TYPES: Readonly<Record<string, string>> = { mobile: 'CELL', home: 'HOME', work: 'WORK', pager: 'PAGER', main: 'MAIN', home_fax: 'HOME,FAX', work_fax: 'WORK,FAX', other_fax: 'FAX' };

function cut(text: string, max: number) {
  return Array.from(text).slice(0, max).join('');
}

/** The cards of a vCard file as contact drafts; a card with an over-long field keeps the card and loses the tail of that field. */
function parseVCards(vcfData: string): (ContactDraft & { uid: string | null })[] {
  const unfolded = vcfData.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const drafts: (ContactDraft & { uid: string | null })[] = [];
  for (const block of unfolded.split(/(?=BEGIN:VCARD)/i)) {
    if (!/^BEGIN:VCARD/i.test(block.trim()) || !/END:VCARD/i.test(block)) continue;
    const draft: ContactDraft & { uid: string | null } = { uid: null, display_name: null, first_name: '', last_name: null, middle_name: null, name_prefix: null, name_suffix: null,
      company: null, department: null, job_title: null, birthday: null, anniversary: null, notes: null, values: [] };
    let formatted: string | null = null;
    for (const line of block.split('\n')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const head = line.slice(0, colon).toUpperCase();
      let raw = line.slice(colon + 1).trim();
      const name = head.split(';')[0].replace(/^[^.]*\./, '');
      if (head.includes('ENCODING=QUOTED-PRINTABLE')) raw = decodeQuotedPrintable(raw);
      const value = unescapeVCard(raw).trim();
      const types = head.split(';').slice(1).flatMap(param => param.replace(/^TYPE=/, '').split(','));
      switch (name) {
        case 'N': {
          const [family, given, middle, prefix, suffix] = splitComponents(raw).map(part => part.trim() || null);
          Object.assign(draft, { last_name: family, first_name: given || '', middle_name: middle, name_prefix: prefix, name_suffix: suffix });
          break;
        }
        case 'FN': formatted = value || null; break;
        case 'EMAIL': if (value) draft.values.push({ kind: 'email', label: types.includes('WORK') ? 'work' : types.includes('HOME') ? 'home' : '', custom_label: null, value, preferred: types.includes('PREF') }); break;
        case 'TEL': if (value) draft.values.push({ kind: 'phone', label: types.map(type => PHONE_TYPES[type]).find(Boolean) || '', custom_label: null, value, preferred: types.includes('PREF') }); break;
        case 'ORG': { const [company, department] = splitComponents(raw).map(part => part.trim() || null); draft.company = company; draft.department = department ?? null; break; }
        case 'TITLE': draft.job_title = value || null; break;
        case 'NOTE': draft.notes = value || null; break;
        case 'UID': draft.uid = value ? cut(value, TEXT_MAX) : null; break;
      }
    }
    if (!draft.first_name && !draft.last_name && formatted) draft.display_name = formatted;
    for (const field of ['display_name', 'last_name', 'middle_name', 'name_prefix', 'name_suffix', 'company', 'department', 'job_title'] as const) {
      if (draft[field]) draft[field] = cut(draft[field]!, TEXT_MAX);
    }
    draft.first_name = cut(draft.first_name, TEXT_MAX);
    if (draft.notes) {
      const bytes = Buffer.from(draft.notes, 'utf8');
      let end = Math.min(bytes.length, 65535);
      while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      draft.notes = bytes.subarray(0, end).toString('utf8');
    }
    const seen = new Set<string>();
    draft.values = draft.values.filter(item => {
      const key = `${item.kind}:${valueKey(item.kind, item.value)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(item => ({ ...item, value: cut(item.value, VALUE_LIMITS[item.kind]) }));
    for (const kind of ['email', 'phone'] as const) {
      const ofKind = draft.values.filter(item => item.kind === kind);
      if (ofKind.length > VALUES_PER_KIND) draft.values = draft.values.filter(item => item.kind !== kind || ofKind.indexOf(item) < VALUES_PER_KIND);
    }
    if (draft.first_name || draft.last_name || draft.display_name || draft.values.length) drafts.push(draft);
  }
  return drafts;
}

const identityKeys = (values: readonly Pick<ValueDraft, 'kind' | 'value'>[]) => values
  .filter(item => item.kind === 'email' || item.kind === 'phone')
  .map(item => `${item.kind}:${valueKey(item.kind, item.value)}`).filter(key => !key.endsWith(':'));

async function importVCards(userId: string, vcfData: string) {
  const parsed = parseVCards(vcfData);
  if (!parsed.length) throw Object.assign(new Error('No valid contacts found in the file. Make sure it is a .vcf (vCard) file.'), { status: 400 });
  const [existing] = await db.execute<(RowDataPacket & { kind: 'email' | 'phone'; value: string })[]>(
    "SELECT kind, value FROM contact_values WHERE user_id = ? AND kind IN ('email', 'phone')", [userId]);
  const known = new Set(identityKeys(existing));
  const [uids] = await db.execute<(RowDataPacket & { uid_hash: string })[]>(
    'SELECT uid_hash FROM contacts WHERE user_id = ? UNION SELECT uid_hash FROM contact_uid_aliases WHERE user_id = ?', [userId, userId]);
  const knownUids = new Set(uids.map(row => row.uid_hash));
  let imported = 0;
  const errors: string[] = [];
  let skipped = 0;
  for (const { uid, ...draft } of parsed) {
    const keys = identityKeys(draft.values);
    // A card keeps its own UID; one already here (or merged into a contact) is the same contact.
    const hash = uid ? uidHash(uid) : null;
    if (keys.some(key => known.has(key)) || (hash && knownUids.has(hash))) { skipped++; continue; }
    try {
      await withTransaction(cx => insertContact(cx, userId, draft, uid ? { uid } : {}));
      imported++;
      keys.forEach(key => known.add(key));
      if (hash) knownUids.add(hash);
    } catch {
      errors.push(`Failed to import "${[draft.first_name, draft.last_name].filter(Boolean).join(' ') || draft.display_name || 'a card'}"`);
    }
  }
  return {
    message: `Imported ${imported} of ${parsed.length} contacts${skipped ? ` (${skipped} skipped as duplicates)` : ''}`,
    imported, total: parsed.length, skipped: skipped || undefined, errors: errors.length ? errors : undefined,
  };
}

function contactToVCard(contact: ContactRecord) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `UID:${escapeVCard(contact.uid)}`];
  const { name } = contact;
  lines.push(`N:${[name.family, name.given, name.middle, name.prefix, name.suffix].map(escapeVCard).join(';')}`);
  lines.push(`FN:${escapeVCard(contact.display_name || 'Unnamed Contact')}`);
  for (const email of contact.emails) lines.push(`EMAIL;TYPE=INTERNET${['home', 'work'].includes(email.label) ? `,${email.label.toUpperCase()}` : ''}${email.preferred ? ',PREF' : ''}:${escapeVCard(email.value)}`);
  for (const phone of contact.phones) {
    const type = PHONE_LABEL_TYPES[phone.label];
    lines.push(`TEL${type || phone.preferred ? `;TYPE=${[type, phone.preferred ? 'PREF' : ''].filter(Boolean).join(',')}` : ''}:${escapeVCard(phone.value)}`);
  }
  if (contact.organization.name || contact.organization.department) lines.push(`ORG:${escapeVCard(contact.organization.name)}${contact.organization.department ? `;${escapeVCard(contact.organization.department)}` : ''}`);
  if (contact.job_title) lines.push(`TITLE:${escapeVCard(contact.job_title)}`);
  if (contact.notes) lines.push(`NOTE:${escapeVCard(contact.notes)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

async function exportVCards(userId: string) {
  const [rows] = await db.execute<(RowDataPacket & { id: string })[]>('SELECT id FROM contacts WHERE user_id = ? ORDER BY first_name ASC, id ASC', [userId]);
  const contacts = await loadContacts(db, userId, rows.map(row => row.id));
  return contacts.map(contactToVCard).join('\r\n');
}

// ── The automatic merge of 0.25 ─────────────────────────────────────────

export { parseVCards, importVCards, exportVCards, contactToVCard, decodeQuotedPrintable };
