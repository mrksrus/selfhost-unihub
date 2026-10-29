// The contact model as the pages show it: label names per kind, how a value,
// an address or a partial date reads, and which values become links. Pure
// functions over the contract types; nothing here talks to the server.
import type {
  Address, AddressLabel, Contact, EmailLabel, ImppLabel, LabelledValue, NicknameLabel, PartialDate, PhoneLabel, RelatedLabel, UrlLabel,
} from '../../api/src/contracts/contacts';

/** The kinds the editor and the detail show as labelled lists (addresses have their own rows). */
export type ListKind = 'emails' | 'phones' | 'urls' | 'impp' | 'related' | 'nicknames';

interface KindText { singular: string; plural: string; add: string; placeholder: string; inputType: 'email' | 'tel' | 'url' | 'text' }

export const LIST_KINDS: Record<ListKind, KindText> = {
  phones: { singular: 'Phone', plural: 'Phone numbers', add: 'Add another phone number', placeholder: '+1 555 0100', inputType: 'tel' },
  emails: { singular: 'Email', plural: 'Email addresses', add: 'Add another email', placeholder: 'name@example.com', inputType: 'email' },
  urls: { singular: 'Website', plural: 'Websites', add: 'Add another website', placeholder: 'https://example.com', inputType: 'url' },
  impp: { singular: 'Messaging', plural: 'Messaging', add: 'Add another messaging address', placeholder: 'xmpp:name@example.com', inputType: 'text' },
  related: { singular: 'Related person', plural: 'Related people', add: 'Add another related person', placeholder: 'Name', inputType: 'text' },
  nicknames: { singular: 'Nickname', plural: 'Nicknames', add: 'Add another nickname', placeholder: 'Nickname', inputType: 'text' },
};

/** The label choices per kind, in menu order. '' is "no label" (values from before 0.26 have none). */
export const LABELS: { [K in ListKind | 'addresses']: readonly string[] } = {
  phones: ['mobile', 'home', 'work', 'main', 'work_mobile', 'home_fax', 'work_fax', 'other_fax', 'pager', 'work_pager', 'callback', 'car', 'company_main', 'isdn', 'radio', 'telex', 'tty_tdd', 'assistant', 'mms', 'other', 'custom'],
  emails: ['home', 'work', 'mobile', 'other', 'custom'],
  addresses: ['home', 'work', 'other', 'custom'],
  urls: ['homepage', 'blog', 'profile', 'home', 'work', 'ftp', 'other', 'custom'],
  impp: ['home', 'work', 'other', 'custom'],
  related: ['spouse', 'partner', 'domestic_partner', 'child', 'parent', 'mother', 'father', 'sibling', 'sister', 'brother', 'relative', 'kin', 'friend', 'colleague', 'co_worker', 'manager', 'assistant', 'agent', 'referred_by', 'emergency', 'contact', 'acquaintance', 'met', 'co_resident', 'neighbor', 'muse', 'crush', 'date', 'sweetheart', 'me', 'other', 'custom'],
  nicknames: ['short_name', 'other_name', 'maiden_name', 'initials', 'custom'],
};

const LABEL_TEXT: Record<string, string> = {
  '': '', home: 'Home', work: 'Work', mobile: 'Mobile', main: 'Main', other: 'Other', custom: 'Custom',
  home_fax: 'Home fax', work_fax: 'Work fax', other_fax: 'Fax', pager: 'Pager', work_mobile: 'Work mobile', work_pager: 'Work pager',
  callback: 'Callback', car: 'Car', company_main: 'Company main', isdn: 'ISDN', radio: 'Radio', telex: 'Telex', tty_tdd: 'TTY/TDD',
  assistant: 'Assistant', mms: 'MMS',
  homepage: 'Homepage', blog: 'Blog', profile: 'Profile', ftp: 'FTP',
  brother: 'Brother', child: 'Child', domestic_partner: 'Domestic partner', father: 'Father', friend: 'Friend', manager: 'Manager', mother: 'Mother',
  parent: 'Parent', partner: 'Partner', referred_by: 'Referred by', relative: 'Relative', sister: 'Sister', spouse: 'Spouse', contact: 'Contact',
  acquaintance: 'Acquaintance', met: 'Met', co_worker: 'Co-worker', colleague: 'Colleague', co_resident: 'Lives with', neighbor: 'Neighbour',
  sibling: 'Sibling', kin: 'Kin', muse: 'Muse', crush: 'Crush', date: 'Date', sweetheart: 'Sweetheart', me: 'Me', agent: 'Agent', emergency: 'Emergency contact',
  other_name: 'Other name', maiden_name: 'Maiden name', short_name: 'Short name', initials: 'Initials',
};

/** How a label reads: "Work", a custom text, or the kind's name when the value has no label. */
export function labelText(value: Pick<LabelledValue, 'label' | 'custom_label'>, fallback = '') {
  if (value.label === 'custom') return (value.custom_label || '').trim() || 'Custom';
  return LABEL_TEXT[value.label] || value.label || fallback;
}

export type AnyLabel = EmailLabel | PhoneLabel | AddressLabel | UrlLabel | ImppLabel | RelatedLabel | NicknameLabel;

/** The display name as the server derives it, for contacts built in the page before they are saved. */
export function deriveDisplayName(contact: Pick<Contact, 'name' | 'organization' | 'emails' | 'phones'>) {
  const { name } = contact;
  return (name.display || '').trim()
    || [name.given, name.middle, name.family].map(part => (part || '').trim()).filter(Boolean).join(' ')
    || (contact.organization.name || '').trim()
    || contact.emails.find(entry => entry.value.trim())?.value.trim()
    || contact.phones.find(entry => entry.value.trim())?.value.trim()
    || '';
}

export const contactName = (contact: Pick<Contact, 'display_name'>) => contact.display_name.trim() || 'No name';

export function contactInitials(contact: Pick<Contact, 'display_name' | 'name' | 'emails' | 'phones'>) {
  const first = (text: string | null | undefined) => (text || '').trim().charAt(0);
  const parts = first(contact.name.given) + first(contact.name.family);
  if (parts) return parts.toUpperCase();
  const words = contact.display_name.trim().split(/\s+/).filter(Boolean);
  if (words.length && !words[0].includes('@') && !/^[+\d]/.test(words[0])) return (first(words[0]) + (words.length > 1 ? first(words[words.length - 1]) : '')).toUpperCase();
  if (contact.emails.length) return contact.emails[0].value.trim().charAt(0).toUpperCase() || '?';
  return contact.phones.length ? '#' : '?';
}

/** The value a list shows first: the preferred one, else the first. */
export function preferredValue<T extends LabelledValue>(list: T[]): T | undefined {
  return list.find(entry => entry.preferred && entry.value.trim()) ?? list.find(entry => entry.value.trim());
}

/** Phone, email or nothing: the row subtitle and the merge summaries. */
export function primaryDetail(contact: Pick<Contact, 'emails' | 'phones'>) {
  return preferredValue(contact.phones)?.value.trim() || preferredValue(contact.emails)?.value.trim() || '';
}

export const contactRole = (contact: Pick<Contact, 'job_title' | 'organization'>) =>
  [contact.job_title, contact.organization.department, contact.organization.name].map(part => (part || '').trim()).filter(Boolean).join(', ');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "14 March 1990" or "14 March" when the year is unknown. */
export function formatPartialDate(date: PartialDate | null | undefined) {
  if (!date) return '';
  const month = MONTHS[date.month - 1] || String(date.month);
  return date.year ? `${date.day} ${month} ${date.year}` : `${date.day} ${month}`;
}

/** The wire form of a partial date: `YYYY-MM-DD` or `--MM-DD`. */
export function partialDateInput(date: PartialDate | null) {
  if (!date) return null;
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.year ? String(date.year).padStart(4, '0') : '-'}-${two(date.month)}-${two(date.day)}`;
}

/** The address as lines for display, from its parts (the server's `value` is the same text in one line). */
export function addressLines(address: Address) {
  const street = [address.po_box && `PO Box ${address.po_box}`, address.extended, address.street].map(part => (part || '').trim()).filter(Boolean);
  const town = [address.postal_code, address.locality].map(part => (part || '').trim()).filter(Boolean).join(' ');
  return [...street, town, (address.region || '').trim(), (address.country || '').trim()].filter(Boolean);
}

const LINK_SCHEMES = /^(https?|mailto|tel|sip|xmpp):/i;

/** A web or messaging value becomes a link only with a scheme the browser can hand on safely; everything else stays text. */
export function safeHref(value: string) {
  const text = value.trim();
  if (LINK_SCHEMES.test(text)) return text;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(text)) return `https://${text}`;
  return null;
}

export const telHref = (number: string) => `tel:${number.replace(/[\s().-]/g, '')}`;

/** The link that opens a map search for an address, without sending anything until it is followed. */
export const mapHref = (address: Address) => `geo:0,0?q=${encodeURIComponent(addressLines(address).join(', '))}`;

/** Names of the single-value fields a merge or import may have to choose between. */
export const SINGLE_FIELD_TEXT = {
  name: 'Name', display_name: 'Display name', organization: 'Organisation', department: 'Department', job_title: 'Job title',
  birthday: 'Birthday', anniversary: 'Anniversary', photo: 'Photo',
} as const;

/** Why two contacts look alike, as a sentence. */
export function reasonText(reason: { kind: string; detail: string }) {
  switch (reason.kind) {
    case 'uid': return 'Same contact identity';
    case 'email': return `Same email ${reason.detail}`;
    case 'phone': return `Same number ${reason.detail}`;
    case 'name': return `Same name ${reason.detail}`.trim();
    case 'name_order': return 'Same name, order swapped';
    case 'name_subset': return `Name contained in the other (${reason.detail})`;
    case 'initial': return `Initial matches (${reason.detail})`;
    case 'organization': return `Same organisation ${reason.detail}`.trim();
    default: return reason.detail;
  }
}

/** A group "Merge all" may take: high confidence, not large, nothing to choose. */
export const mergesWithoutChoice = (group: { confidence: string; large: boolean; conflicts: unknown[] }) =>
  group.confidence === 'high' && !group.large && group.conflicts.length === 0;
