import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { RouteRequest, ApiError } from '../types';
import crypto from 'crypto';
import { db } from '../state';
import { escapeLike } from '../services/sql';
import {
  contactToVCard,
  parseVCards,
  getContactIdentityKeys,
  groupDuplicateContacts,
  rankContactsForMerge,
  getPrimaryContactIdentityKey,
  getContactDisplayName,
  normalizeContactInput,
  boundContactFields,
  mergeDuplicateGroups,
} from '../services/contacts';

type Request = RouteRequest & { url: string; params: Record<string, string> };
type Contact = Parameters<typeof contactToVCard>[0] & { id: string };
interface Input {
  first_name?: string;
  last_name?: string;
  email?: string;
  email2?: string;
  email3?: string;
  phone?: string;
  phone2?: string;
  phone3?: string;
  company?: string;
  job_title?: string;
  notes?: string;
  ids?: unknown;
  contact?: unknown;
  vcf_data?: unknown;
  is_favorite?: unknown;
}

// Bounds one SQL statement; the bulk body limits in request-handler.ts fit this many IDs.
const BULK_MAX_IDS = 5000;
const BULK_UPDATE_FIELDS = new Set(['company', 'job_title']);
const MAX_FIELD_LENGTH = 255;

function bulkIdsError(ids: unknown) {
  if (!Array.isArray(ids) || ids.length === 0) return 'ids array is required';
  if (ids.length > BULK_MAX_IDS) return `At most ${BULK_MAX_IDS} contacts at a time`;
  if (!ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 64)) return 'ids must be contact IDs';
  return null;
}

export = {
  // Contacts endpoints
  'GET /api/contacts': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const q = (url.searchParams.get('q') || '').trim();
      const group = url.searchParams.get('group') || 'all';
      const limitNum = parseInt(url.searchParams.get('limit') || '2000', 10);
      const limit = Number.isInteger(limitNum) && limitNum >= 1 ? Math.min(limitNum, 2000) : 2000;

      const offsetNum = Number.parseInt(url.searchParams.get('offset') || '0', 10);
      const offset = Number.isSafeInteger(offsetNum) && offsetNum >= 0 ? Math.min(offsetNum, 10000000) : 0;

      // Only select fields needed on the contacts screen to reduce payload size.
      let query = 'SELECT id, user_id, first_name, last_name, email, email2, email3, phone, phone2, phone3, company, job_title, notes, avatar_url, is_favorite FROM contacts WHERE user_id = ?';
      const params = [userId];

      // Group filter: name_only = has name but no email/phone; number_or_email_only = has email/phone but no name
      if (group === 'name_only') {
        query += " AND (TRIM(COALESCE(first_name,'')) != '' OR TRIM(COALESCE(last_name,'')) != '')";
        query += " AND (TRIM(COALESCE(email,'')) = '' AND TRIM(COALESCE(email2,'')) = '' AND TRIM(COALESCE(email3,'')) = '' AND TRIM(COALESCE(phone,'')) = '' AND TRIM(COALESCE(phone2,'')) = '' AND TRIM(COALESCE(phone3,'')) = '')";
      } else if (group === 'number_or_email_only') {
        query += " AND (TRIM(COALESCE(email,'')) != '' OR TRIM(COALESCE(email2,'')) != '' OR TRIM(COALESCE(email3,'')) != '' OR TRIM(COALESCE(phone,'')) != '' OR TRIM(COALESCE(phone2,'')) != '' OR TRIM(COALESCE(phone3,'')) != '')";
        query += " AND TRIM(COALESCE(first_name,'')) = '' AND TRIM(COALESCE(last_name,'')) = ''";
      }

      // Server-side search (indexed fields + phone/company for quick find)
      if (q.length > 0) {
        const like = `%${escapeLike(q)}%`;
        query += ' AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR email2 LIKE ? OR email3 LIKE ? OR phone LIKE ? OR phone2 LIKE ? OR phone3 LIKE ? OR company LIKE ?)';
        params.push(like, like, like, like, like, like, like, like, like);
      }

      // LIMIT as literal (mysql2 stmt_execute rejects placeholder for LIMIT); value validated 1–2000
      query += ` ORDER BY is_favorite DESC, first_name ASC, last_name ASC, id ASC LIMIT ${limit + 1} OFFSET ${offset}`;

      const [rows] = await db.execute<(RowDataPacket & Contact)[]>(query, params);
      const contacts = Array.isArray(rows) ? rows : [];
      return { contacts: contacts.slice(0, limit), has_more: contacts.length > limit, offset };
    } catch (error) {
      console.error('[GET /api/contacts] Error:', (error as ApiError).message || error);
      return { error: 'Failed to get contacts', status: 500 };
    }
  },

  'POST /api/contacts': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const parsed = normalizeContactInput(body, { requireFirstName: true });
    if ('error' in parsed) return { error: parsed.error, status: 400 };
    const { fields } = parsed;

    try {
      const contactId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO contacts (id, user_id, first_name, last_name, email, email2, email3, phone, phone2, phone3, company, job_title, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          contactId,
          userId,
          fields.first_name,
          fields.last_name,
          fields.email,
          fields.email2,
          fields.email3,
          fields.phone,
          fields.phone2,
          fields.phone3,
          fields.company,
          fields.job_title,
          fields.notes,
        ]
      );

      const [contacts] = await db.execute<(RowDataPacket & Contact)[]>('SELECT * FROM contacts WHERE id = ?', [contactId]);
      return { contact: contacts[0] };
    } catch (error) {
      return { error: 'Failed to create contact', status: 500 };
    }
  },

  'PUT /api/contacts/:id': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const parsed = normalizeContactInput(body, { requireFirstName: true });
    if ('error' in parsed) return { error: parsed.error, status: 400 };
    const { fields } = parsed;

    try {
      const id = req.params.id;

      // mysql2 connects with FOUND_ROWS, so an unchanged row still counts as matched.
      const [result] = await db.execute<ResultSetHeader>(
        'UPDATE contacts SET first_name = ?, last_name = ?, email = ?, email2 = ?, email3 = ?, phone = ?, phone2 = ?, phone3 = ?, company = ?, job_title = ?, notes = ? WHERE id = ? AND user_id = ?',
        [
          fields.first_name,
          fields.last_name,
          fields.email,
          fields.email2,
          fields.email3,
          fields.phone,
          fields.phone2,
          fields.phone3,
          fields.company,
          fields.job_title,
          fields.notes,
          id,
          userId,
        ]
      );
      if (!result.affectedRows) return { error: 'Contact not found', status: 404 };

      const [contacts] = await db.execute<(RowDataPacket & Contact)[]>('SELECT * FROM contacts WHERE id = ? AND user_id = ?', [id, userId]);
      return { contact: contacts[0] };
    } catch (error) {
      return { error: 'Failed to update contact', status: 500 };
    }
  },

  'DELETE /api/contacts/:id': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const id = req.params.id;
      await db.execute('DELETE FROM contacts WHERE id = ? AND user_id = ?', [id, userId]);
      return { message: 'Contact deleted' };
    } catch (error) {
      return { error: 'Failed to delete contact', status: 500 };
    }
  },

  'POST /api/contacts/bulk-delete': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { ids } = body;
    const idsError = bulkIdsError(ids);
    if (idsError) return { error: idsError, status: 400 };

    try {
      const placeholders = (ids as string[]).map(() => '?').join(',');
      const [result] = await db.execute<ResultSetHeader>(
        `DELETE FROM contacts WHERE user_id = ? AND id IN (${placeholders})`,
        [userId, ...(ids as string[])]
      );
      const deleted = result.affectedRows || 0;
      return { message: `${deleted} contact(s) deleted`, deleted };
    } catch (error) {
      return { error: 'Failed to delete contacts', status: 500 };
    }
  },

  'POST /api/contacts/bulk-update': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { ids, contact } = body;
    const idsError = bulkIdsError(ids);
    if (idsError) return { error: idsError, status: 400 };
    if (!contact || typeof contact !== 'object' || Array.isArray(contact)) return { error: 'contact object is required', status: 400 };
    const entries = Object.entries(contact);
    if (entries.length === 0) return { error: 'Nothing to update', status: 400 };
    const columns: string[] = [];
    const values: (string | null)[] = [];
    for (const [field, value] of entries) {
      if (!BULK_UPDATE_FIELDS.has(field)) return { error: `${field} cannot be changed for many contacts at once`, status: 400 };
      if (value !== null && typeof value !== 'string') return { error: `${field} must be text`, status: 400 };
      const trimmed = value?.trim() || null;
      if (trimmed && trimmed.length > MAX_FIELD_LENGTH) return { error: `${field} is too long`, status: 400 };
      columns.push(`${field} = ?`);
      values.push(trimmed);
    }

    try {
      const placeholders = (ids as string[]).map(() => '?').join(',');
      const [result] = await db.execute<ResultSetHeader>(
        `UPDATE contacts SET ${columns.join(', ')} WHERE user_id = ? AND id IN (${placeholders})`,
        [...values, userId, ...(ids as string[])]
      );
      return { updated: result.affectedRows || 0 };
    } catch (error) {
      return { error: 'Failed to update contacts', status: 500 };
    }
  },

  'POST /api/contacts/merge-duplicates': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const { merged, removed, groups } = await mergeDuplicateGroups(userId);

      if (groups === 0) {
        return { merged: 0, removed: 0, groups: 0, message: 'No duplicates detected.' };
      }

      return {
        merged,
        removed,
        groups,
        message: `Merged ${merged} duplicate group(s), removed ${removed} duplicate contact(s).`,
      };
    } catch (error) {
      console.error('Merge duplicates error:', error);
      return { error: 'Failed to merge duplicates', status: 500 };
    }
  },

  'POST /api/contacts/merge-duplicates/preview': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const [rows] = await db.execute<(RowDataPacket & Contact)[]>(
        `SELECT id, first_name, last_name, email, email2, email3, phone, phone2, phone3, company, job_title, notes, is_favorite, created_at
         FROM contacts
         WHERE user_id = ?`,
        [userId]
      );

      const duplicateGroups = groupDuplicateContacts(rows || []);
      const previewGroups = [];
      let toRemove = 0;

      for (const members of duplicateGroups) {
        toRemove += members.length - 1;
        const [primary, ...others] = rankContactsForMerge(members);
        previewGroups.push({
          key: getPrimaryContactIdentityKey(primary) || primary.id!,
          size: members.length,
          keep: {
            id: primary.id!,
            name: getContactDisplayName(primary),
            email: primary.email || primary.email2 || primary.email3 || null,
            phone: primary.phone || primary.phone2 || primary.phone3 || null,
          },
          remove: others.map((c) => ({
            id: c.id,
            name: getContactDisplayName(c),
            email: c.email || c.email2 || c.email3 || null,
            phone: c.phone || c.phone2 || c.phone3 || null,
          })),
        });
      }

      previewGroups.sort((a, b) => b.size - a.size || a.key!.localeCompare(b.key!));
      return {
        groups: duplicateGroups.length,
        to_remove: toRemove,
        merge_target_count: duplicateGroups.length,
        preview: previewGroups,
      };
    } catch (error) {
      console.error('Merge duplicates preview error:', error);
      return { error: 'Failed to preview duplicate merge', status: 500 };
    }
  },

  'GET /api/contacts/export': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const [contacts] = await db.execute<(RowDataPacket & Contact)[]>(
        'SELECT * FROM contacts WHERE user_id = ? ORDER BY first_name ASC',
        [userId]
      );

      if (contacts.length === 0) {
        return { error: 'No contacts to export', status: 404 };
      }

      const vcf = contacts.map(contactToVCard).join('\r\n');
      return { __raw: vcf, __contentType: 'text/vcard', __filename: 'contacts.vcf' };
    } catch (error) {
      console.error('Export error:', error);
      return { error: 'Failed to export contacts', status: 500 };
    }
  },

  'POST /api/contacts/import': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { vcf_data } = body;
    if (!vcf_data || typeof vcf_data !== 'string') {
      return { error: 'Missing vcf_data field', status: 400 };
    }

    try {
      const parsed = parseVCards(vcf_data);

      if (parsed.length === 0) {
        return { error: 'No valid contacts found in the file. Make sure it is a .vcf (vCard) file.', status: 400 };
      }

      // 1) Within-file dedupe: keep first occurrence of each identity key (file often has same card 2–3x)
      const seenInFile = new Set();
      const dedupedFromFile = [];
      for (const c of parsed) {
        const keys = getContactIdentityKeys(c);
        const primaryKey = keys[0];
        if (primaryKey && keys.some((key) => seenInFile.has(key))) continue;
        keys.forEach((key) => seenInFile.add(key));
        dedupedFromFile.push(c);
      }

      // 2) Load existing contact keys for this user so we don’t re-import duplicates
      const [existingRows] = await db.execute<(RowDataPacket & Contact)[]>(
        'SELECT email, email2, email3, phone, phone2, phone3, first_name, last_name FROM contacts WHERE user_id = ?',
        [userId]
      );
      const existingKeys = new Set((existingRows || []).flatMap(getContactIdentityKeys));

      let imported = 0;
      const errors = [];

      for (const c of dedupedFromFile) {
        const keys = getContactIdentityKeys(c);
        if (keys.some((key) => existingKeys.has(key))) continue; // already in DB, skip
        try {
          // A card with an over-long field keeps the card and loses the tail of that field.
          const bounded = boundContactFields(c);
          const contactId = crypto.randomUUID();
          await db.execute(
            'INSERT INTO contacts (id, user_id, first_name, last_name, email, email2, email3, phone, phone2, phone3, company, job_title, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              contactId,
              userId,
              bounded.first_name,
              bounded.last_name,
              bounded.email,
              bounded.email2,
              bounded.email3,
              bounded.phone,
              bounded.phone2,
              bounded.phone3,
              bounded.company,
              bounded.job_title,
              bounded.notes,
            ]
          );
          imported++;
          keys.forEach((key) => existingKeys.add(key)); // avoid inserting twice if file has same identity again
        } catch (err) {
          const name = [c.first_name!, c.last_name].filter(Boolean).join(' ');
          errors.push(`Failed to import "${name}": ${(err as Error).message}`);
        }
      }

      const skipped = dedupedFromFile.length - imported - errors.length;
      return {
        message: `Imported ${imported} of ${parsed.length} contacts${skipped > 0 ? ` (${skipped} skipped as duplicates)` : ''}`,
        imported,
        total: parsed.length,
        skipped: skipped > 0 ? skipped : undefined,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      console.error('Import error:', error);
      return { error: 'Failed to import contacts', status: 500 };
    }
  },

  'PUT /api/contacts/:id/favorite': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const id = req.params.id;
      const { is_favorite } = body;
      await db.execute(
        'UPDATE contacts SET is_favorite = ? WHERE id = ? AND user_id = ?',
        [is_favorite ? 1 : 0, id, userId]
      );
      return { message: 'Favorite status updated' };
    } catch (error) {
      return { error: 'Failed to update favorite', status: 500 };
    }
  },
};
