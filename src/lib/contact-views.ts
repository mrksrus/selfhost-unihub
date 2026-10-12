import { Copy, Star, UserRound, UserX, Users } from 'lucide-react';
import { contactEmails, contactName, contactPhones, type Contact } from '@/lib/contacts-api';

export type ContactView = 'all' | 'favorites' | 'missing_name' | 'missing_details' | 'duplicates';

export const CONTACT_VIEWS: Record<ContactView, { label: string; icon: typeof Users; hint?: string }> = {
  all: { label: 'All contacts', icon: Users },
  favorites: { label: 'Favorites', icon: Star },
  missing_name: { label: 'Missing a name', icon: UserRound, hint: 'These have an email or phone number but no name.' },
  missing_details: { label: 'Name only', icon: UserX, hint: 'These have a name but no email or phone number.' },
  duplicates: { label: 'Possible duplicates', icon: Copy, hint: 'Contacts that share an email, phone number or name, grouped together.' },
};

export const isContactView = (value: string | null): value is ContactView => !!value && value in CONTACT_VIEWS;

const hasName = (contact: Contact) => Boolean((contact.first_name || '').trim() || (contact.last_name || '').trim());
const hasDetails = (contact: Contact) => contactEmails(contact).length > 0 || contactPhones(contact).length > 0;

// The key two contacts must share to count as possible duplicates: first email,
// else first phone number, else the name.
function duplicateKey(contact: Contact) {
  const email = contactEmails(contact)[0]?.toLowerCase();
  if (email) return `e:${email}`;
  const phone = contactPhones(contact).map(value => value.replace(/[^\d+]/g, '')).find(Boolean);
  if (phone) return `p:${phone}`;
  const first = (contact.first_name || '').trim().toLowerCase();
  const last = (contact.last_name || '').trim().toLowerCase();
  return first || last ? `n:${first}|${last}` : null;
}

/** Duplicate group key and size for every contact that has a possible duplicate. */
export function findDuplicates(contacts: Contact[]) {
  const groups = new Map<string, Contact[]>();
  for (const contact of contacts) {
    const key = duplicateKey(contact);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) || []), contact]);
  }
  const byId = new Map<string, { key: string; size: number }>();
  for (const [key, members] of groups) {
    if (members.length > 1) for (const member of members) byId.set(member.id, { key, size: members.length });
  }
  return byId;
}

export type Duplicates = ReturnType<typeof findDuplicates>;

const sortName = (contact: Contact) => contactName(contact).toLocaleLowerCase();

export function inContactView(contact: Contact, view: ContactView, duplicates: Duplicates) {
  if (view === 'favorites') return contact.is_favorite;
  if (view === 'missing_name') return !hasName(contact) && hasDetails(contact);
  if (view === 'missing_details') return hasName(contact) && !hasDetails(contact);
  if (view === 'duplicates') return duplicates.has(contact.id);
  return true;
}

function matches(contact: Contact, query: string) {
  if (!query) return true;
  return [contact.first_name, contact.last_name, contact.company, ...contactEmails(contact), ...contactPhones(contact)]
    .filter(Boolean).join(' ').toLowerCase().includes(query);
}

/** The contacts of a view that match the search, in display order. */
export function filterContacts(contacts: Contact[], view: ContactView, search: string, duplicates: Duplicates) {
  const query = search.trim().toLowerCase();
  const list = contacts.filter(contact => inContactView(contact, view, duplicates) && matches(contact, query));
  return list.sort((a, b) => {
    if (view === 'duplicates') {
      const byGroup = (duplicates.get(a.id)?.key || '').localeCompare(duplicates.get(b.id)?.key || '');
      if (byGroup) return byGroup;
    }
    return sortName(a).localeCompare(sortName(b));
  });
}

/** Section heading for a contact in an alphabetical list. */
export function contactLetter(contact: Contact) {
  const letter = contactName(contact).trim().charAt(0).toLocaleUpperCase();
  return /\p{L}/u.test(letter) ? letter : '#';
}
