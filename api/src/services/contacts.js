// ── vCard helpers (3.0, compatible with Google & Apple) ──────────
function escapeVCard(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function unescapeVCard(str) {
  if (!str) return '';
  return str.replace(/\\n/gi, '\n').replace(/\\;/g, ';').replace(/\\,/g, ',').replace(/\\\\/g, '\\');
}

function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function splitVCardComponents(value) {
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

function contactToVCard(c) {
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

function parseVCards(vcfData) {
  // Unfold continuation lines (RFC 2425 §5.8.1)
  const unfolded = vcfData.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const contacts = [];
  const blocks = unfolded.split(/(?=BEGIN:VCARD)/i);

  for (const block of blocks) {
    if (!block.trim().match(/^BEGIN:VCARD/i)) continue;
    if (!block.match(/END:VCARD/i)) continue;

    const contact = {
      first_name: '', last_name: null,
      email: null, email2: null, email3: null,
      phone: null, phone2: null, phone3: null,
      company: null, job_title: null, notes: null,
    };
    const emailValues = [];
    const phoneValues = [];

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

function normalizeContactEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeContactPhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function getContactEmails(contact) {
  return [contact.email, contact.email2, contact.email3].map(normalizeContactEmail).filter(Boolean);
}

function getContactPhones(contact) {
  return [contact.phone, contact.phone2, contact.phone3].map(normalizeContactPhone).filter(Boolean);
}

function getContactIdentityKeys(contact) {
  return [
    ...getContactEmails(contact).map(email => `e:${email}`),
    ...getContactPhones(contact).map(phone => `p:${phone}`),
  ];
}

function getPrimaryContactIdentityKey(contact) {
  return getContactIdentityKeys(contact)[0] || null;
}

function contactCompletenessScore(contact) {
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

function rankContactsForMerge(members) {
  return [...members].sort((a, b) => {
    const scoreDiff = contactCompletenessScore(b) - contactCompletenessScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
  });
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value != null && String(value).trim() !== '') return value;
  }
  return null;
}

function buildMergedContact(members) {
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

function getContactDisplayName(contact) {
  const first = (contact.first_name || '').trim();
  const last = (contact.last_name || '').trim();
  if (first || last) return [first, last].filter(Boolean).join(' ');
  return contact.email || contact.email2 || contact.email3 || contact.phone || contact.phone2 || contact.phone3 || 'No name';
}

function groupDuplicateContacts(contacts) {
  const parent = new Map();
  const byId = new Map();
  const keyOwner = new Map();

  const find = (id) => {
    const current = parent.get(id) || id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (a, b) => {
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

  const groups = new Map();
  for (const [id, contact] of byId.entries()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(contact);
  }

  return Array.from(groups.values()).filter((group) => group.length > 1);
}

module.exports = {
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
