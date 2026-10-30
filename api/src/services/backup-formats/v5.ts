// Data schema 5 (0.26.0): contacts carry their values as contact_values rows,
// a uid and the vCard name fields; photos are content-addressed files.
// Archives up to schema 4 carry the fixed 3+3 fields on each contact row.
// They become values here, exactly as upgrade step 22 copies them: the
// non-empty slots in their order, verbatim, without a label, each holding its
// place in what old apps see (legacy_slot 1 to 3). Each value's id
// is a UUIDv5 of the contact id, kind and position, so converting the same
// archive again yields the same rows. avatar_url was never filled and is
// dropped; a contact without a uid gets urn:uuid:<id>, as upgrade 22 gives it.
import type { BackupPayload, BackupRow } from '../../types';
import crypto from 'node:crypto';
import { readV4 } from './v4';

const LEGACY_SLOTS = { email: ['email', 'email2', 'email3'], phone: ['phone', 'phone2', 'phone3'] } as const;
const LEGACY_FIELDS = [...LEGACY_SLOTS.email, ...LEGACY_SLOTS.phone, 'avatar_url'];
// Fixed namespace of the converted value ids (RFC 9562 name-based, SHA-1).
const VALUE_ID_NAMESPACE = 'b5f0c6a2-3c1e-5d7a-9a43-6e2f1c0d8b71';

function uuidV5(name: string, namespace = VALUE_ID_NAMESPACE) {
  const hash = crypto.createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(name, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function convertLegacyContacts(data: BackupPayload['data']) {
  const contacts = Array.isArray(data.contacts) ? data.contacts as BackupRow[] : [];
  if (!contacts.length) return;
  const values = Array.isArray(data.contact_values) ? data.contact_values as BackupRow[] : [];
  const converted: BackupRow[] = [];
  for (const contact of contacts) {
    const id = typeof contact.id === 'string' ? contact.id : '';
    for (const kind of ['email', 'phone'] as const) {
      const slots = LEGACY_SLOTS[kind].map(slot => contact[slot]).filter((value): value is string => typeof value === 'string' && value.trim() !== '');
      slots.forEach((value, position) => converted.push({ id: uuidV5(`${id}\n${kind}\n${position}`), contact_id: id, user_id: contact.user_id,
        kind, position, is_preferred: 0, label: '', custom_label: null, value, legacy_slot: position + 1 }));
    }
    for (const field of LEGACY_FIELDS) delete contact[field];
    if (typeof contact.uid !== 'string' || !contact.uid.trim()) contact.uid = `urn:uuid:${id}`;
  }
  data.contact_values = [...values, ...converted];
}

// A schema 5 archive has no fixed fields (validation refuses them), so the
// conversion changes nothing there.
function readV5<T extends BackupPayload>(backup: T): T {
  readV4(backup);
  convertLegacyContacts(backup.data);
  return backup;
}

export { readV5, uuidV5 };
