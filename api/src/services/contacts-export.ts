// Contact export (D6): vCard 4.0 (the default), vCard 3.0, Google CSV and
// Outlook CSV, for all of a person's contacts or a selection. Owner-scoped:
// ids that are not the person's are left out.
import type { RowDataPacket } from 'mysql2/promise';
import type { ExportFormat } from '../contracts/contacts';
import type { KeptPropertyDraft } from './contacts';
import type { ExportContact } from './contacts-vcard-write';
import { db } from '../state';
import { badRequest, notFound } from '../http/errors';
import { loadContacts } from './contacts';
import { writeVCards } from './contacts-vcard-write';
import { writeGoogleCsv, writeOutlookCsv } from './contacts-csv';

const EXPORT_FORMATS: readonly ExportFormat[] = ['vcard4', 'vcard3', 'google-csv', 'outlook-csv'];
const CHUNK = 1000;

function exportFormat(value: unknown): ExportFormat {
  if (value === undefined || value === null || value === '') return 'vcard4';
  if (typeof value !== 'string' || !EXPORT_FORMATS.includes(value as ExportFormat)) {
    throw badRequest('INVALID_EXPORT_FORMAT', `format must be one of ${EXPORT_FORMATS.join(', ')}`);
  }
  return value as ExportFormat;
}

const placeholders = (items: readonly unknown[]) => items.map(() => '?').join(', ');
const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value ?? null);

/** Contacts with their kept properties and the import details of their values. */
async function exportContacts(userId: string, ids: readonly string[]): Promise<ExportContact[]> {
  const out: ExportContact[] = [];
  for (let start = 0; start < ids.length; start += CHUNK) {
    const slice = ids.slice(start, start + CHUNK);
    const contacts = await loadContacts(db, userId, slice);
    if (!contacts.length) continue;
    const owned = contacts.map(contact => contact.id);
    const [values] = await db.execute<(RowDataPacket & { id: string; params: unknown; vcard_group: string | null })[]>(
      `SELECT id, params, vcard_group FROM contact_values WHERE user_id = ? AND contact_id IN (${placeholders(owned)}) AND (params IS NOT NULL OR vcard_group IS NOT NULL)`,
      [userId, ...owned]);
    const extras = new Map(values.map(row => [row.id, { params: json(row.params), group: row.vcard_group }]));
    const [kept] = await db.execute<(RowDataPacket & { contact_id: string; name: string; vcard_group: string | null; params: unknown; value: string; source_version: string | null })[]>(
      `SELECT contact_id, name, vcard_group, params, value, source_version FROM contact_properties WHERE user_id = ? AND contact_id IN (${placeholders(owned)})
       ORDER BY contact_id, position, id`, [userId, ...owned]);
    const keptBy = new Map<string, KeptPropertyDraft[]>();
    for (const row of kept) {
      const list = keptBy.get(row.contact_id) || [];
      list.push({ name: row.name, group: row.vcard_group, params: json(row.params), value: row.value, source_version: row.source_version });
      keptBy.set(row.contact_id, list);
    }
    // Photo seam: the stored photo (contact-photos.ts contactPhotoFile) is passed as `photo` once wired.
    for (const contact of contacts) out.push({ contact, extras, properties: keptBy.get(contact.id) || [], photo: null });
  }
  return out;
}

const FILES: Readonly<Record<ExportFormat, { filename: string; contentType: string }>> = {
  vcard4: { filename: 'contacts.vcf', contentType: 'text/vcard; charset=utf-8' },
  vcard3: { filename: 'contacts.vcf', contentType: 'text/vcard; charset=utf-8' },
  'google-csv': { filename: 'contacts-google.csv', contentType: 'text/csv; charset=utf-8' },
  'outlook-csv': { filename: 'contacts-outlook.csv', contentType: 'text/csv; charset=utf-8' },
};

/** The export file of all contacts (ids null) or of the given ones, in name order. */
async function buildExport(userId: string, format: ExportFormat, ids: readonly string[] | null) {
  const [rows] = await db.execute<(RowDataPacket & { id: string })[]>(
    'SELECT id FROM contacts WHERE user_id = ? ORDER BY first_name, last_name, id', [userId]);
  const wanted = ids ? new Set(ids) : null;
  const ordered = rows.map(row => row.id).filter(id => !wanted || wanted.has(id));
  if (!ordered.length) throw notFound('NO_CONTACTS', 'No contacts to export');
  const contacts = await exportContacts(userId, ordered);
  const body = format === 'vcard4' ? writeVCards(contacts, '4.0') : format === 'vcard3' ? writeVCards(contacts, '3.0')
    : format === 'google-csv' ? writeGoogleCsv(contacts) : writeOutlookCsv(contacts);
  return { body: Buffer.from(body, 'utf8'), count: contacts.length, ...FILES[format] };
}

export { buildExport, exportContacts, exportFormat, EXPORT_FORMATS };
