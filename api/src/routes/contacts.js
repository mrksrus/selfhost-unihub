const crypto = require('crypto');
const { db } = require('../state');
const {
  contactToVCard,
  parseVCards,
  getContactIdentityKeys,
  groupDuplicateContacts,
  buildMergedContact,
  rankContactsForMerge,
  getPrimaryContactIdentityKey,
  getContactDisplayName,
} = require('../services/contacts');


module.exports = {
  // Contacts endpoints
  'GET /api/contacts': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const q = (url.searchParams.get('q') || '').trim();
      const group = url.searchParams.get('group') || 'all';
      const limitNum = parseInt(url.searchParams.get('limit') || '2000', 10);
      const limit = Number.isInteger(limitNum) && limitNum >= 1 ? Math.min(limitNum, 2000) : 2000;

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
        const like = `%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
        query += ' AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR email2 LIKE ? OR email3 LIKE ? OR phone LIKE ? OR phone2 LIKE ? OR phone3 LIKE ? OR company LIKE ?)';
        params.push(like, like, like, like, like, like, like, like, like);
      }

      // LIMIT as literal (mysql2 stmt_execute rejects placeholder for LIMIT); value validated 1–2000
      query += ` ORDER BY is_favorite DESC, first_name ASC, last_name ASC LIMIT ${limit}`;

      const [rows] = await db.execute(query, params);
      const contacts = Array.isArray(rows) ? rows : [];
      return { contacts };
    } catch (error) {
      console.error('[GET /api/contacts] Error:', error.message || error);
      return { error: 'Failed to get contacts', status: 500 };
    }
  },

  'POST /api/contacts': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { first_name, last_name, email, email2, email3, phone, phone2, phone3, company, job_title, notes } = body;
    if (!first_name || !first_name.trim()) {
      return { error: 'First name is required', status: 400 };
    }

    try {
      const contactId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO contacts (id, user_id, first_name, last_name, email, email2, email3, phone, phone2, phone3, company, job_title, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          contactId,
          userId,
          first_name.trim(),
          last_name || null,
          email || null,
          email2 || null,
          email3 || null,
          phone || null,
          phone2 || null,
          phone3 || null,
          company || null,
          job_title || null,
          notes || null,
        ]
      );
      
      const [contacts] = await db.execute('SELECT * FROM contacts WHERE id = ?', [contactId]);
      return { contact: contacts[0] };
    } catch (error) {
      return { error: 'Failed to create contact', status: 500 };
    }
  },
  
  'PUT /api/contacts/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { first_name, last_name, email, email2, email3, phone, phone2, phone3, company, job_title, notes } = body;
    const firstName = first_name != null ? String(first_name).trim() : '';

    try {
      const id = req.url.split('/').pop();
      
      await db.execute(
        'UPDATE contacts SET first_name = ?, last_name = ?, email = ?, email2 = ?, email3 = ?, phone = ?, phone2 = ?, phone3 = ?, company = ?, job_title = ?, notes = ? WHERE id = ? AND user_id = ?',
        [
          firstName,
          last_name || null,
          email || null,
          email2 || null,
          email3 || null,
          phone || null,
          phone2 || null,
          phone3 || null,
          company || null,
          job_title || null,
          notes || null,
          id,
          userId,
        ]
      );
      
      const [contacts] = await db.execute('SELECT * FROM contacts WHERE id = ? AND user_id = ?', [id, userId]);
      return { contact: contacts[0] };
    } catch (error) {
      return { error: 'Failed to update contact', status: 500 };
    }
  },
  
  'DELETE /api/contacts/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const id = req.url.split('/').pop();
      await db.execute('DELETE FROM contacts WHERE id = ? AND user_id = ?', [id, userId]);
      return { message: 'Contact deleted' };
    } catch (error) {
      return { error: 'Failed to delete contact', status: 500 };
    }
  },

  'POST /api/contacts/bulk-delete': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { ids } = body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return { error: 'ids array is required', status: 400 };
    }

    try {
      const placeholders = ids.map(() => '?').join(',');
      const [result] = await db.execute(
        `DELETE FROM contacts WHERE user_id = ? AND id IN (${placeholders})`,
        [userId, ...ids]
      );
      const deleted = result.affectedRows || 0;
      return { message: `${deleted} contact(s) deleted`, deleted };
    } catch (error) {
      return { error: 'Failed to delete contacts', status: 500 };
    }
  },

  'POST /api/contacts/merge-duplicates': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const [rows] = await db.execute(
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
        await db.execute(
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
            primary.id,
            userId,
          ]
        );

        const deleteIds = others.map((o) => o.id);
        if (deleteIds.length > 0) {
          const placeholders = deleteIds.map(() => '?').join(',');
          const [result] = await db.execute(
            `DELETE FROM contacts WHERE user_id = ? AND id IN (${placeholders})`,
            [userId, ...deleteIds]
          );
          removed += result.affectedRows || 0;
          merged++;
        }
      }

      if (duplicateGroups.length === 0) {
        return { merged: 0, removed: 0, groups: 0, message: 'No duplicates detected.' };
      }

      return {
        merged,
        removed,
        groups: duplicateGroups.length,
        message: `Merged ${merged} duplicate group(s), removed ${removed} duplicate contact(s).`,
      };
    } catch (error) {
      console.error('Merge duplicates error:', error);
      return { error: 'Failed to merge duplicates', status: 500 };
    }
  },

  'POST /api/contacts/merge-duplicates/preview': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const [rows] = await db.execute(
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
          key: getPrimaryContactIdentityKey(primary) || primary.id,
          size: members.length,
          keep: {
            id: primary.id,
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

      previewGroups.sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));
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

  'GET /api/contacts/export': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const [contacts] = await db.execute(
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

  'POST /api/contacts/import': async (req, userId, body) => {
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
      const [existingRows] = await db.execute(
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
          const contactId = crypto.randomUUID();
          await db.execute(
            'INSERT INTO contacts (id, user_id, first_name, last_name, email, email2, email3, phone, phone2, phone3, company, job_title, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              contactId,
              userId,
              c.first_name,
              c.last_name,
              c.email,
              c.email2,
              c.email3,
              c.phone,
              c.phone2,
              c.phone3,
              c.company,
              c.job_title,
              c.notes,
            ]
          );
          imported++;
          keys.forEach((key) => existingKeys.add(key)); // avoid inserting twice if file has same identity again
        } catch (err) {
          const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
          errors.push(`Failed to import "${name}": ${err.message}`);
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

  'PUT /api/contacts/:id/favorite': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const parts = req.url.split('?')[0].split('/');
      const id = parts[parts.length - 2];
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
