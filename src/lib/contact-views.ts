import { Copy, History, Star, UserRound, UserX, Users } from 'lucide-react';
import { contactEmails, contactName, contactPhones, type Contact } from '@/lib/contacts-api';

export type ContactView = 'all' | 'favorites' | 'missing_name' | 'missing_details' | 'duplicates' | 'merged';

export const CONTACT_VIEWS: Record<ContactView, { label: string; icon: typeof Users; hint?: string }> = {
  all: { label: 'All contacts', icon: Users },
  favorites: { label: 'Favorites', icon: Star },
  missing_name: { label: 'Missing a name', icon: UserRound, hint: 'These have an email or phone number but no name.' },
  missing_details: { label: 'Name only', icon: UserX, hint: 'These have a name but no email or phone number.' },
  duplicates: { label: 'Possible duplicates', icon: Copy },
  merged: { label: 'Recently merged', icon: History },
};

/** Views that list contacts from the page's own list; the other two read their own routes. */
export const LIST_VIEWS: ContactView[] = ['all', 'favorites', 'missing_name', 'missing_details'];

export const isContactView = (value: string | null): value is ContactView => !!value && value in CONTACT_VIEWS;

const hasName = (contact: Contact) => [contact.name.given, contact.name.family, contact.name.middle, contact.name.display]
  .some(part => (part || '').trim());
const hasDetails = (contact: Contact) => contactEmails(contact).length > 0 || contactPhones(contact).length > 0;

const sortName = (contact: Contact) => contactName(contact).toLocaleLowerCase();

export function inContactView(contact: Contact, view: ContactView) {
  if (view === 'favorites') return contact.is_favorite;
  if (view === 'missing_name') return !hasName(contact) && hasDetails(contact);
  if (view === 'missing_details') return hasName(contact) && !hasDetails(contact);
  return view === 'all';
}

/** The text the quick filter searches: names, organisation, every address and number, categories. */
export function contactSearchText(contact: Contact) {
  return [
    contact.display_name, contact.name.given, contact.name.family, contact.name.middle, contact.name.prefix, contact.name.suffix,
    ...contact.nicknames.map(entry => entry.value), contact.organization.name, contact.organization.department, contact.job_title,
    ...contactEmails(contact), ...contactPhones(contact), ...contact.categories,
  ].filter(Boolean).join(' ').toLowerCase();
}

function matches(contact: Contact, query: string) {
  if (!query) return true;
  if (contactSearchText(contact).includes(query)) return true;
  // "0171 12" finds "+49 171 12…": digits against digits.
  const digits = /^[\d\s+\-()./]+$/.test(query) ? query.replace(/\D/g, '').replace(/^0+/, '') : '';
  return digits.length >= 3 && contactPhones(contact).some(number => number.replace(/\D/g, '').includes(digits));
}

/** The contacts of a view that match the search, in display order. */
export function filterContacts(contacts: Contact[], view: ContactView, search: string) {
  const query = search.trim().toLowerCase();
  return contacts.filter(contact => inContactView(contact, view) && matches(contact, query))
    .sort((a, b) => sortName(a).localeCompare(sortName(b)));
}

/** Section heading for a contact in an alphabetical list. */
export function contactLetter(contact: Contact) {
  const letter = contactName(contact).trim().charAt(0).toLocaleUpperCase();
  return /\p{L}/u.test(letter) ? letter : '#';
}
