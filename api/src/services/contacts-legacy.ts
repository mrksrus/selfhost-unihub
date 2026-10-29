// The 0.25 vCard import and export and the automatic duplicate merge, kept
// working on the new model until their replacements land (stream B: the
// vCard pipeline with preview; stream D: duplicates, merge review and undo),
// which then delete this file and its routes. Unlike 0.25 they keep every
// email and phone: nothing is capped at three.
import type { ContactRecord } from '../contracts/contacts';
import type { ContactDraft, ValueDraft } from './contacts';
import { db } from '../state';
import { withTransaction } from './transactions';
import { insertContact, loadContacts, replaceContact, VALUE_LIMITS, VALUES_PER_KIND } from './contacts';
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
function parseVCards(vcfData: string): ContactDraft[] {
  const unfolded = vcfData.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const drafts: ContactDraft[] = [];
  for (const block of unfolded.split(/(?=BEGIN:VCARD)/i)) {
    if (!/^BEGIN:VCARD/i.test(block.trim()) || !/END:VCARD/i.test(block)) continue;
    const draft: ContactDraft = { display_name: null, first_name: '', last_name: null, middle_name: null, name_prefix: null, name_suffix: null,
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
  let imported = 0;
  const errors: string[] = [];
  let skipped = 0;
  for (const draft of parsed) {
    const keys = identityKeys(draft.values);
    if (keys.some(key => known.has(key))) { skipped++; continue; }
    try {
      await withTransaction(cx => insertContact(cx, userId, draft));
      imported++;
      keys.forEach(key => known.add(key));
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

function completeness(contact: ContactRecord) {
  return [contact.name.given, contact.name.family, contact.organization.name, contact.job_title, contact.notes].filter(Boolean).length
    + 2 * (contact.emails.length + contact.phones.length) + (contact.is_favorite ? 2 : 0);
}

function groupDuplicates(contacts: readonly ContactRecord[]) {
  const parent = new Map(contacts.map(contact => [contact.id, contact.id]));
  const find = (id: string): string => { const up = parent.get(id)!; if (up === id) return id; const root = find(up); parent.set(id, root); return root; };
  const owner = new Map<string, string>();
  for (const contact of contacts) {
    for (const key of identityKeys([...contact.emails.map(item => ({ kind: 'email' as const, value: item.value })), ...contact.phones.map(item => ({ kind: 'phone' as const, value: item.value }))])) {
      const first = owner.get(key);
      if (first) { const [a, b] = [find(first), find(contact.id)]; if (a !== b) parent.set(b, a); } else owner.set(key, contact.id);
    }
  }
  const groups = new Map<string, ContactRecord[]>();
  for (const contact of contacts) { const root = find(contact.id); groups.set(root, [...(groups.get(root) || []), contact]); }
  return [...groups.values()].filter(group => group.length > 1)
    .map(group => [...group].sort((a, b) => completeness(b) - completeness(a) || Date.parse(a.created_at) - Date.parse(b.created_at)));
}

async function userContacts(userId: string) {
  const [rows] = await db.execute<(RowDataPacket & { id: string })[]>('SELECT id FROM contacts WHERE user_id = ?', [userId]);
  return loadContacts(db, userId, rows.map(row => row.id));
}

const summary = (contact: ContactRecord) => ({ id: contact.id, name: contact.display_name || 'No name', email: contact.emails[0]?.value ?? null, phone: contact.phones[0]?.value ?? null });

async function previewMerge(userId: string) {
  const groups = groupDuplicates(await userContacts(userId));
  const preview = groups.map(([keep, ...remove]) => ({ key: `${keep.emails[0] ? 'e:' + keep.emails[0].value.toLowerCase() : keep.id}`, size: remove.length + 1, keep: summary(keep), remove: remove.map(summary) }))
    .sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));
  return { groups: groups.length, to_remove: groups.reduce((sum, group) => sum + group.length - 1, 0), merge_target_count: groups.length, preview };
}

const firstOf = <T>(...values: (T | null | undefined)[]) => values.find(value => value != null && String(value).trim() !== '') ?? null;

// Each group in its own transaction, as in 0.25, but the survivor keeps the
// union of every member's values; the others are deleted.
async function mergeDuplicates(userId: string) {
  const groups = groupDuplicates(await userContacts(userId));
  let merged = 0; let removed = 0;
  for (const [primary, ...others] of groups) {
    const members = [primary, ...others];
    const seen = new Set<string>();
    const values: ValueDraft[] = [];
    for (const member of members) {
      const lists: [ValueDraft['kind'], { id?: string; value: string; label: string; custom_label?: string | null; preferred: boolean }[]][] = [
        ['email', member.emails], ['phone', member.phones], ['address', member.addresses], ['url', member.urls], ['impp', member.impp],
        ['related', member.related], ['nickname', member.nicknames], ['category', member.categories.map(value => ({ value, label: '', preferred: false }))]];
      for (const [kind, list] of lists) for (const item of list) {
        const key = `${kind}:${valueKey(kind, item.value)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        values.push({ ...(item as object), id: member === primary ? item.id : null, kind, label: item.label, custom_label: item.custom_label ?? null, value: item.value, preferred: item.preferred });
      }
    }
    const notes = [...new Set(members.map(member => member.notes?.trim()).filter((note): note is string => !!note))].join('\n\n');
    const draft: ContactDraft = {
      display_name: firstOf(primary.name.display, ...others.map(other => other.name.display)),
      first_name: firstOf(primary.name.given, ...others.map(other => other.name.given)) || '',
      last_name: firstOf(primary.name.family, ...others.map(other => other.name.family)),
      middle_name: firstOf(primary.name.middle, ...others.map(other => other.name.middle)),
      name_prefix: primary.name.prefix, name_suffix: primary.name.suffix,
      company: firstOf(primary.organization.name, ...others.map(other => other.organization.name)),
      department: firstOf(primary.organization.department, ...others.map(other => other.organization.department)),
      job_title: firstOf(primary.job_title, ...others.map(other => other.job_title)),
      birthday: null, anniversary: null,
      notes: notes ? Buffer.from(notes, 'utf8').subarray(0, 65535).toString('utf8').replace(/\uFFFD$/, '') : null,
      is_favorite: members.some(member => member.is_favorite),
      values,
    };
    const toDate = (date: ContactRecord['birthday']) => date ? (date.year ? `${String(date.year).padStart(4, '0')}` : '-') + `-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}` : null;
    draft.birthday = firstOf(toDate(primary.birthday), ...others.map(other => toDate(other.birthday)));
    draft.anniversary = firstOf(toDate(primary.anniversary), ...others.map(other => toDate(other.anniversary)));
    const outcome = await withTransaction(async cx => {
      // A survivor changed or deleted since the listing leaves its group as it is.
      const [[current]] = await cx.execute<(RowDataPacket & { version: number })[]>('SELECT version FROM contacts WHERE id = ? AND user_id = ? FOR UPDATE', [primary.id, userId]);
      if (!current || Number(current.version) !== primary.version) return null;
      await replaceContact(cx, userId, primary.id, draft, { expectedVersion: null });
      const ids = others.map(other => other.id);
      const [deleted] = await cx.execute<import('mysql2/promise').ResultSetHeader>(`DELETE FROM contacts WHERE user_id = ? AND id IN (${ids.map(() => '?').join(', ')})`, [userId, ...ids]);
      return deleted.affectedRows || 0;
    });
    if (outcome === null) continue;
    merged++; removed += outcome;
  }
  return { merged, removed, groups: groups.length };
}

export { parseVCards, importVCards, exportVCards, contactToVCard, decodeQuotedPrintable, previewMerge, mergeDuplicates };
