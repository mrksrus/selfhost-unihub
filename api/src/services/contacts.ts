import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { StoredFlag } from '../types';
import { db } from '../state';
import { withTransaction } from './transactions';

type ContactField = 'first_name' | 'last_name' | 'email' | 'email2' | 'email3' | 'phone' | 'phone2' | 'phone3' | 'company' | 'job_title' | 'notes';
interface Contact extends Partial<Record<ContactField, string | null>> {
  id?: string;
  is_favorite?: StoredFlag;
  created_at?: string | number | Date | null;
}
type NormalizedContact = { first_name: string } & Record<Exclude<ContactField, 'first_name'>, string | null>;

const CONTACT_FIELDS: readonly ContactField[] = ['first_name', 'last_name', 'email', 'email2', 'email3', 'phone', 'phone2', 'phone3', 'company', 'job_title', 'notes'];
// Column sizes from docker/mariadb/schema.sql. VARCHAR counts characters; the
// TEXT column `notes` counts bytes. MariaDB in strict mode refuses longer
// values with "Data too long", which would surface as a 500.
const CONTACT_FIELD_LIMITS: Record<ContactField, number> = {
  first_name: 100, last_name: 100,
  email: 255, email2: 255, email3: 255,
  phone: 50, phone2: 50, phone3: 50,
  company: 255, job_title: 255,
  notes: 65535,
};
const CONTACT_FIELD_LABELS: Record<ContactField, string> = {
  first_name: 'First name', last_name: 'Last name',
  email: 'Email', email2: 'Second email', email3: 'Third email',
  phone: 'Phone', phone2: 'Second phone', phone3: 'Third phone',
  company: 'Company', job_title: 'Job title', notes: 'Notes',
};

function fitsContactColumn(field: ContactField, value: string) {
  return field === 'notes' ? Buffer.byteLength(value, 'utf8') <= CONTACT_FIELD_LIMITS.notes : Array.from(value).length <= CONTACT_FIELD_LIMITS[field];
}

// Cuts to the column size without splitting a character (or, for the TEXT
// column, a multi-byte sequence), for sources such as vCard imports where
// refusing the whole card would lose more than the tail of one field.
function boundContactField(field: ContactField, value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (fitsContactColumn(field, trimmed)) return trimmed;
  if (field !== 'notes') return Array.from(trimmed).slice(0, CONTACT_FIELD_LIMITS[field]).join('');
  const bytes = Buffer.from(trimmed, 'utf8');
  let end = CONTACT_FIELD_LIMITS.notes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function boundContactFields<T extends Contact>(contact: T): Omit<T, ContactField> & NormalizedContact {
  const bounded: Record<string, unknown> = { ...(contact as Contact) };
  for (const field of CONTACT_FIELDS) bounded[field] = boundContactField(field, contact[field]);
  bounded.first_name = bounded.first_name || '';
  return bounded as Omit<T, ContactField> & NormalizedContact;
}

// Validates a create/update body at the boundary: every field is optional text,
// trimmed, empty becomes null, and nothing longer than its column gets through.
// Email fields are not checked for a format: phones, vCards and older entries
// hold whatever was typed, and refusing it would stop that contact from syncing.
// A number is stored as its text, as before; notes keep their own whitespace.
function normalizeContactInput(body: unknown, { requireFirstName = true } = {}): { fields: NormalizedContact } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Contact fields are required' };
  const input = body as Record<string, unknown>;
  const fields = {} as Record<ContactField, string | null>;
  for (const field of CONTACT_FIELDS) {
    const value = input[field];
    if (value == null) { fields[field] = null; continue; }
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return { error: `${CONTACT_FIELD_LABELS[field]} must be text` };
    const text = String(value);
    if (!text.trim()) { fields[field] = null; continue; }
    const stored = field === 'notes' ? text : text.trim();
    if (!fitsContactColumn(field, stored)) return { error: `${CONTACT_FIELD_LABELS[field]} is too long (at most ${CONTACT_FIELD_LIMITS[field]} ${field === 'notes' ? 'bytes' : 'characters'})` };
    fields[field] = stored;
  }
  if (requireFirstName && !fields.first_name) return { error: 'First name is required' };
  return { fields: { ...fields, first_name: fields.first_name || '' } };
}

// ── vCard helpers (3.0, compatible with Google & Apple) ──────────
function escapeVCard(str: string | null | undefined) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function unescapeVCard(str: string | null | undefined) {
  if (!str) return '';
  return str.replace(/\\n/gi, '\n').replace(/\\;/g, ';').replace(/\\,/g, ',').replace(/\\\\/g, '\\');
}

function decodeQuotedPrintable(str: string) {
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function splitVCardComponents(value: unknown) {
  const parts = [];
  let current = '';
  let escaped = false;
  for (const char of String(value || '')) {
    if (escaped) {
      current += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === ';') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  parts.push(current);
  return parts;
}

function contactToVCard(c: Contact) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  const ln = escapeVCard(c.last_name || '');
  const fn = escapeVCard(c.first_name || '');
  const fallbackName = c.email || c.email2 || c.email3 || c.phone || c.phone2 || c.phone3 || 'Unnamed Contact';
  const fullName = [c.first_name, c.last_name].filter(Boolean).join(' ') || fallbackName;
  lines.push(`N:${ln};${fn};;;`);
  lines.push(`FN:${escapeVCard(fullName)}`);
  const emails = [c.email, c.email2, c.email3].filter((v) => v && String(v).trim() !== '');
  const phones = [c.phone, c.phone2, c.phone3].filter((v) => v && String(v).trim() !== '');
  for (const email of emails) lines.push(`EMAIL;TYPE=INTERNET:${escapeVCard(email)}`);
  for (const phone of phones) lines.push(`TEL;TYPE=CELL:${escapeVCard(phone)}`);
  if (c.company)   lines.push(`ORG:${escapeVCard(c.company)}`);
  if (c.job_title) lines.push(`TITLE:${escapeVCard(c.job_title)}`);
  if (c.notes)     lines.push(`NOTE:${escapeVCard(c.notes)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

function parseVCards(vcfData: string): Contact[] {
  // Unfold continuation lines (RFC 2425 §5.8.1)
  const unfolded = vcfData.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const contacts: Contact[] = [];
  const blocks = unfolded.split(/(?=BEGIN:VCARD)/i);

  for (const block of blocks) {
    if (!block.trim().match(/^BEGIN:VCARD/i)) continue;
    if (!block.match(/END:VCARD/i)) continue;

    const contact: Contact = {
      first_name: '', last_name: null,
      email: null, email2: null, email3: null,
      phone: null, phone2: null, phone3: null,
      company: null, job_title: null, notes: null,
    };
    const emailValues: string[] = [];
    const phoneValues: string[] = [];

    for (const line of block.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const propFull = line.substring(0, colonIdx).toUpperCase();
      let rawValue = line.substring(colonIdx + 1).trim();
      const propName = propFull.split(';')[0];

      // Handle quoted-printable encoding (used by some Apple exports)
      if (propFull.includes('ENCODING=QUOTED-PRINTABLE')) {
        rawValue = decodeQuotedPrintable(rawValue);
      }

      const value = unescapeVCard(rawValue);

      switch (propName) {
        case 'N': {
          const parts = splitVCardComponents(rawValue).map(unescapeVCard);
          contact.last_name = parts[0] || null;
          contact.first_name = parts[1] || '';
          break;
        }
        case 'FN':
          // Only use FN as fallback if N wasn't parsed
          if (!contact.first_name) {
            const parts = value.split(' ');
            contact.first_name = parts[0] || '';
            contact.last_name = parts.slice(1).join(' ') || null;
          }
          break;
        case 'EMAIL':
          if (value) emailValues.push(value);
          break;
        case 'TEL':
          if (value) phoneValues.push(value);
          break;
        case 'ORG':
          contact.company = splitVCardComponents(rawValue).map(unescapeVCard)[0] || null;
          break;
        case 'TITLE':
          contact.job_title = value || null;
          break;
        case 'NOTE':
          contact.notes = value || null;
          break;
      }
    }

    const uniqueEmails = Array.from(new Set(emailValues.map((v) => String(v).trim()).filter(Boolean))).slice(0, 3);
    const uniquePhones = Array.from(new Set(phoneValues.map((v) => String(v).trim()).filter(Boolean))).slice(0, 3);
    [contact.email, contact.email2, contact.email3] = [uniqueEmails[0] || null, uniqueEmails[1] || null, uniqueEmails[2] || null];
    [contact.phone, contact.phone2, contact.phone3] = [uniquePhones[0] || null, uniquePhones[1] || null, uniquePhones[2] || null];

    // Keep valid vCards that contain at least one useful identity field.
    if (contact.first_name || contact.last_name || contact.email || contact.phone) {
      if (!contact.first_name && contact.last_name) {
        contact.first_name = contact.last_name;
        contact.last_name = null;
      }
      contacts.push(contact);
    }
  }

  return contacts;
}

function normalizeContactEmail(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function normalizeContactPhone(value: unknown) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function getContactEmails(contact: Contact) {
  return [contact.email, contact.email2, contact.email3].map(normalizeContactEmail).filter(Boolean);
}

function getContactPhones(contact: Contact) {
  return [contact.phone, contact.phone2, contact.phone3].map(normalizeContactPhone).filter(Boolean);
}

function getContactIdentityKeys(contact: Contact) {
  return [
    ...getContactEmails(contact).map(email => `e:${email}`),
    ...getContactPhones(contact).map(phone => `p:${phone}`),
  ];
}

function getPrimaryContactIdentityKey(contact: Contact) {
  return getContactIdentityKeys(contact)[0] || null;
}

function contactCompletenessScore(contact: Contact) {
  let score = 0;
  if ((contact.first_name || '').trim()) score++;
  if ((contact.last_name || '').trim()) score++;
  score += getContactEmails(contact).length * 2;
  score += getContactPhones(contact).length * 2;
  if ((contact.company || '').trim()) score++;
  if ((contact.job_title || '').trim()) score++;
  if ((contact.notes || '').trim()) score++;
  if (contact.is_favorite) score += 2;
  return score;
}

function rankContactsForMerge<T extends Contact>(members: readonly T[]): T[] {
  return [...members].sort((a, b) => {
    const scoreDiff = contactCompletenessScore(b) - contactCompletenessScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
  });
}

function firstNonEmpty<T>(...values: readonly (T | null | undefined)[]): T | null {
  for (const value of values) {
    if (value != null && String(value).trim() !== '') return value;
  }
  return null;
}

function buildMergedContact<T extends Contact>(members: readonly T[]) {
  const [primary, ...others] = rankContactsForMerge(members);
  const mergedNotes = Array.from(
    new Set(
      [primary.notes, ...others.map((contact) => contact.notes)]
        .filter((note) => note != null && String(note).trim() !== '')
        .map((note) => String(note).trim())
    )
  ).join('\n\n');
  const mergedEmails = Array.from(new Set(members.flatMap((contact) => [contact.email, contact.email2, contact.email3].map((value) => String(value || '').trim()).filter(Boolean)))).slice(0, 3);
  const mergedPhones = Array.from(new Set(members.flatMap((contact) => [contact.phone, contact.phone2, contact.phone3].map((value) => String(value || '').trim()).filter(Boolean)))).slice(0, 3);

  return {
    primary,
    others,
    mergedContact: {
      first_name: firstNonEmpty(primary.first_name, ...others.map((contact) => contact.first_name), ''),
      last_name: firstNonEmpty(primary.last_name, ...others.map((contact) => contact.last_name)),
      email: mergedEmails[0] || null,
      email2: mergedEmails[1] || null,
      email3: mergedEmails[2] || null,
      phone: mergedPhones[0] || null,
      phone2: mergedPhones[1] || null,
      phone3: mergedPhones[2] || null,
      company: firstNonEmpty(primary.company, ...others.map((contact) => contact.company)),
      job_title: firstNonEmpty(primary.job_title, ...others.map((contact) => contact.job_title)),
      notes: mergedNotes || null,
      is_favorite: members.some((contact) => Boolean(contact.is_favorite)),
    },
  };
}

function getContactDisplayName(contact: Contact) {
  const first = (contact.first_name || '').trim();
  const last = (contact.last_name || '').trim();
  if (first || last) return [first, last].filter(Boolean).join(' ');
  return contact.email || contact.email2 || contact.email3 || contact.phone || contact.phone2 || contact.phone3 || 'No name';
}

function groupDuplicateContacts<T extends Contact>(contacts: readonly T[] | null | undefined): T[][] {
  const parent = new Map<string, string>();
  const byId = new Map<string, T>();
  const keyOwner = new Map<string, string>();

  const find = (id: string): string => {
    const current = parent.get(id) || id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const contact of contacts || []) {
    if (!contact.id) continue;
    parent.set(contact.id, contact.id);
    byId.set(contact.id, contact);
  }

  for (const contact of contacts || []) {
    if (!contact.id) continue;
    for (const key of getContactIdentityKeys(contact)) {
      const existingId = keyOwner.get(key);
      if (existingId) {
        union(existingId, contact.id);
      } else {
        keyOwner.set(key, contact.id);
      }
    }
  }

  const groups = new Map<string, T[]>();
  for (const [id, contact] of byId.entries()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(contact);
  }

  return Array.from(groups.values()).filter((group) => group.length > 1);
}

// Each duplicate group is merged in its own transaction: the primary row's
// update and the deletion of the others commit together, so an interruption
// leaves the group either merged or untouched, never half-merged with wrong
// counts. A group whose primary vanished since the listing is skipped.
async function mergeDuplicateGroups(userId: string, executor: Pick<Pool, 'execute' | 'getConnection'> = db) {
  const [rows] = await executor.execute<(RowDataPacket & Contact)[]>(
    `SELECT id, first_name, last_name, email, email2, email3, phone, phone2, phone3, company, job_title, notes, is_favorite, created_at
     FROM contacts
     WHERE user_id = ?`,
    [userId]
  );
  const duplicateGroups = groupDuplicateContacts(rows || []);
  let merged = 0;
  let removed = 0;

  for (const members of duplicateGroups) {
    const { primary, others, mergedContact } = buildMergedContact(members);
    const deleteIds = others.map((other) => other.id!);
    const outcome = await withTransaction(async (cx) => {
      const [updated] = await cx.execute<ResultSetHeader>(
        `UPDATE contacts
         SET first_name = ?, last_name = ?, email = ?, email2 = ?, email3 = ?, phone = ?, phone2 = ?, phone3 = ?, company = ?, job_title = ?, notes = ?, is_favorite = ?
         WHERE id = ? AND user_id = ?`,
        [
          mergedContact.first_name || '',
          mergedContact.last_name,
          mergedContact.email,
          mergedContact.email2,
          mergedContact.email3,
          mergedContact.phone,
          mergedContact.phone2,
          mergedContact.phone3,
          mergedContact.company,
          mergedContact.job_title,
          mergedContact.notes,
          mergedContact.is_favorite ? 1 : 0,
          primary.id!,
          userId,
        ]
      );
      if (!updated.affectedRows || deleteIds.length === 0) return null;
      const placeholders = deleteIds.map(() => '?').join(',');
      const [deleted] = await cx.execute<ResultSetHeader>(
        `DELETE FROM contacts WHERE user_id = ? AND id IN (${placeholders})`,
        [userId, ...deleteIds]
      );
      return deleted.affectedRows || 0;
    }, executor);
    if (outcome === null) continue;
    removed += outcome;
    merged++;
  }

  return { merged, removed, groups: duplicateGroups.length };
}

export {
  CONTACT_FIELD_LIMITS,
  normalizeContactInput,
  boundContactFields,
  mergeDuplicateGroups,
  escapeVCard,
  unescapeVCard,
  decodeQuotedPrintable,
  splitVCardComponents,
  contactToVCard,
  parseVCards,
  normalizeContactEmail,
  normalizeContactPhone,
  getContactEmails,
  getContactPhones,
  getContactIdentityKeys,
  getPrimaryContactIdentityKey,
  contactCompletenessScore,
  rankContactsForMerge,
  firstNonEmpty,
  buildMergedContact,
  getContactDisplayName,
  groupDuplicateContacts,
};
