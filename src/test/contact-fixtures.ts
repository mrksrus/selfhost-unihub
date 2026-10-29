// Synthetic contacts in the shape the contacts API answers (api/src/contracts/contacts.ts).
import type { Contact, DuplicateGroup, LabelledValue } from '@/lib/contacts-api';

type Patch = Partial<Omit<Contact, 'name' | 'organization' | 'emails' | 'phones'>> & {
  name?: Partial<Contact['name']>;
  organization?: Partial<Contact['organization']>;
  emails?: (string | Partial<LabelledValue>)[];
  phones?: (string | Partial<LabelledValue>)[];
};

const value = (entry: string | Partial<LabelledValue>, index: number): LabelledValue =>
  typeof entry === 'string' ? { id: `v${index}`, value: entry, label: '', custom_label: null, preferred: false }
    : { id: `v${index}`, value: '', label: '', custom_label: null, preferred: false, ...entry };

/** A contact record; `display_name` and the legacy projection follow the given parts unless overridden. */
export function contact(id: string, patch: Patch = {}): Contact {
  const name = { display: null, given: null, family: null, middle: null, prefix: null, suffix: null, ...patch.name };
  const organization = { name: null, department: null, ...patch.organization };
  const emails = (patch.emails ?? []).map(value) as Contact['emails'];
  const phones = (patch.phones ?? []).map(value) as Contact['phones'];
  const display = name.display || [name.given, name.middle, name.family].filter(Boolean).join(' ') || organization.name || emails[0]?.value || phones[0]?.value || '';
  const base: Contact = {
    id, uid: `urn:uuid:${id}`, version: 1, display_name: display, name, organization, job_title: null, birthday: null, anniversary: null, notes: null,
    is_favorite: false, emails, phones, addresses: [], urls: [], impp: [], related: [], nicknames: [], categories: [], photo: null, kept_properties: 0,
    created_at: '2026-06-01T09:00:00.000Z', updated_at: '2026-06-01T09:00:00.000Z',
    first_name: name.given || '', last_name: name.family, company: organization.name,
    email: emails[0]?.value ?? null, email2: emails[1]?.value ?? null, email3: emails[2]?.value ?? null,
    phone: phones[0]?.value ?? null, phone2: phones[1]?.value ?? null, phone3: phones[2]?.value ?? null,
  };
  return { ...base, ...patch, emails, phones, name, organization, display_name: patch.display_name ?? display };
}

export function duplicateGroup(id: string, members: Contact[], patch: Partial<DuplicateGroup> = {}): DuplicateGroup {
  return {
    id, confidence: 'high', large: false,
    members: members.map(member => ({ id: member.id, version: member.version, display_name: member.display_name, organization: member.organization.name,
      emails: member.emails.map(entry => entry.value), phones: member.phones.map(entry => entry.value), photo: member.photo })),
    reasons: [], conflicts: [], ...patch,
  };
}
