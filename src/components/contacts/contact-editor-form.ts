// The editor's form model: what the inputs hold, how a contact becomes a form
// and how the form becomes the API body (api/src/contracts/contacts.ts
// ContactInput). Kept apart from the components so it is testable on its own.
import type { Address, AddressInput, Contact, ContactInput, LabelledValue, LabelledValueInput, PartialDate } from '@/lib/contacts-api';
import { partialDateInput, type ListKind } from '@/lib/contact-fields';

export interface ValueDraft { key: string; id?: string; value: string; label: string; custom_label: string; preferred: boolean }
export interface AddressDraft {
  key: string; id?: string; label: string; custom_label: string; preferred: boolean;
  street: string; extended: string; po_box: string; locality: string; region: string; postal_code: string; country: string;
}
/** Month and day as chosen, year empty when unknown ("no year"). */
export interface DateDraft { year: string; month: string; day: string }

/** Fields that are shown only once chosen from "Add field", or when the contact has them. */
export type OptionalField = 'name_details' | 'nicknames' | 'department' | 'addresses' | 'birthday' | 'anniversary' | 'urls' | 'impp' | 'related' | 'categories';

export const OPTIONAL_FIELDS: { id: OptionalField; label: string }[] = [
  { id: 'name_details', label: 'Title, middle name, suffix' },
  { id: 'nicknames', label: 'Nickname' },
  { id: 'department', label: 'Department' },
  { id: 'addresses', label: 'Address' },
  { id: 'birthday', label: 'Birthday' },
  { id: 'anniversary', label: 'Anniversary' },
  { id: 'urls', label: 'Website' },
  { id: 'impp', label: 'Messaging' },
  { id: 'related', label: 'Related person' },
  { id: 'categories', label: 'Categories' },
];

export interface ContactForm {
  given: string; family: string; middle: string; prefix: string; suffix: string; display: string;
  company: string; department: string; job_title: string; notes: string;
  phones: ValueDraft[]; emails: ValueDraft[]; urls: ValueDraft[]; impp: ValueDraft[]; related: ValueDraft[]; nicknames: ValueDraft[];
  addresses: AddressDraft[];
  /** Each category whole, as stored: a comma is part of a name ("Friends, family"). */
  categories: string[];
  /** A category typed but not added yet; saving adds it. */
  categoryDraft: string;
  birthday: DateDraft; anniversary: DateDraft;
  shown: OptionalField[];
  photo: { kind: 'keep' } | { kind: 'remove' } | { kind: 'file'; file: File; url: string };
}

let keys = 0;
const nextKey = () => `k${++keys}`;

export const emptyValue = (label = ''): ValueDraft => ({ key: nextKey(), value: '', label, custom_label: '', preferred: false });
export const emptyAddress = (): AddressDraft => ({ key: nextKey(), label: 'home', custom_label: '', preferred: false, street: '', extended: '', po_box: '', locality: '', region: '', postal_code: '', country: '' });
const emptyDate = (): DateDraft => ({ year: '', month: '', day: '' });

export function emptyForm(): ContactForm {
  return {
    given: '', family: '', middle: '', prefix: '', suffix: '', display: '', company: '', department: '', job_title: '', notes: '',
    phones: [emptyValue()], emails: [emptyValue()], urls: [], impp: [], related: [], nicknames: [], addresses: [], categories: [], categoryDraft: '',
    birthday: emptyDate(), anniversary: emptyDate(), shown: [], photo: { kind: 'keep' },
  };
}

const text = (value: string | null | undefined) => value ?? '';
const draftOf = (entry: LabelledValue): ValueDraft => ({ key: nextKey(), id: entry.id, value: entry.value, label: entry.label, custom_label: text(entry.custom_label), preferred: entry.preferred });
const dateOf = (date: PartialDate | null): DateDraft => date ? { year: date.year ? String(date.year) : '', month: String(date.month), day: String(date.day) } : emptyDate();

/** The form of an existing contact; sections that hold a value are shown. */
export function formOf(contact: Contact): ContactForm {
  const list = (entries: LabelledValue[], keepOne: boolean) => entries.length ? entries.map(draftOf) : keepOne ? [emptyValue()] : [];
  const shown: OptionalField[] = [];
  const { name, organization } = contact;
  if ([name.middle, name.prefix, name.suffix, name.display].some(part => text(part).trim())) shown.push('name_details');
  if (contact.nicknames.length) shown.push('nicknames');
  if (text(organization.department).trim()) shown.push('department');
  if (contact.addresses.length) shown.push('addresses');
  if (contact.birthday) shown.push('birthday');
  if (contact.anniversary) shown.push('anniversary');
  if (contact.urls.length) shown.push('urls');
  if (contact.impp.length) shown.push('impp');
  if (contact.related.length) shown.push('related');
  if (contact.categories.length) shown.push('categories');
  return {
    given: text(name.given), family: text(name.family), middle: text(name.middle), prefix: text(name.prefix), suffix: text(name.suffix), display: text(name.display),
    company: text(organization.name), department: text(organization.department), job_title: text(contact.job_title), notes: text(contact.notes),
    phones: list(contact.phones, true), emails: list(contact.emails, true),
    urls: list(contact.urls, false), impp: list(contact.impp, false), related: list(contact.related, false), nicknames: list(contact.nicknames, false),
    addresses: contact.addresses.map((address: Address) => ({
      key: nextKey(), id: address.id, label: address.label, custom_label: text(address.custom_label), preferred: address.preferred,
      street: text(address.street), extended: text(address.extended), po_box: text(address.po_box), locality: text(address.locality),
      region: text(address.region), postal_code: text(address.postal_code), country: text(address.country),
    })),
    categories: [...contact.categories], categoryDraft: '',
    birthday: dateOf(contact.birthday), anniversary: dateOf(contact.anniversary),
    shown, photo: { kind: 'keep' },
  };
}

/** A new contact prefilled from a link (?action=new&name=&email=). */
export function formForNew(name?: string, email?: string): ContactForm {
  const form = emptyForm();
  if (name) {
    const parts = name.trim().split(/\s+/);
    form.given = parts[0] ?? '';
    form.family = parts.slice(1).join(' ');
  }
  if (email) form.emails = [{ ...emptyValue(), value: email }];
  return form;
}

export const LIST_FIELDS: ListKind[] = ['phones', 'emails', 'urls', 'impp', 'related', 'nicknames'];

const valueInput = (entry: ValueDraft): LabelledValueInput => ({
  id: entry.id ?? null, value: entry.value.trim(), label: entry.label, custom_label: entry.label === 'custom' ? entry.custom_label.trim() : null, preferred: entry.preferred,
});
const addressInput = (address: AddressDraft): AddressInput => ({
  id: address.id ?? null, label: address.label, custom_label: address.label === 'custom' ? address.custom_label.trim() : null, preferred: address.preferred,
  street: address.street.trim() || null, extended: address.extended.trim() || null, po_box: address.po_box.trim() || null, locality: address.locality.trim() || null,
  region: address.region.trim() || null, postal_code: address.postal_code.trim() || null, country: address.country.trim() || null,
});
const addressFilled = (address: AddressDraft) => [address.street, address.extended, address.po_box, address.locality, address.region, address.postal_code, address.country].some(part => part.trim());

/** The date a draft describes, null when empty, or an error when half filled. */
export function dateOfDraft(draft: DateDraft): { date: PartialDate | null; error?: string } {
  const month = Number(draft.month), day = Number(draft.day);
  const year = draft.year.trim() ? Number(draft.year) : null;
  if (!draft.month && !draft.day && year === null) return { date: null };
  if (!draft.month || !draft.day) return { date: null, error: 'Choose a month and a day; the year may stay empty.' };
  if (!Number.isInteger(day) || day < 1 || day > 31 || (year !== null && (!Number.isInteger(year) || year < 1 || year > 9999))) return { date: null, error: 'That is not a date.' };
  const daysInMonth = new Date(Date.UTC(year ?? 2000, month, 0)).getUTCDate();
  if (day > daysInMonth) return { date: null, error: 'That is not a date.' };
  return { date: { year, month, day } };
}

/** Problems the server would refuse, named before anything is sent. */
export function validate(form: ContactForm): Partial<Record<'identity' | 'birthday' | 'anniversary' | 'labels', string>> {
  const errors: Partial<Record<'identity' | 'birthday' | 'anniversary' | 'labels', string>> = {};
  const identity = [form.given, form.family, form.middle, form.display, form.company].some(part => part.trim())
    || form.emails.some(entry => entry.value.trim()) || form.phones.some(entry => entry.value.trim());
  if (!identity) errors.identity = 'Add a name, an organisation, an email or a phone number.';
  for (const field of ['birthday', 'anniversary'] as const) {
    const { error } = dateOfDraft(form[field]);
    if (error) errors[field] = error;
  }
  const customWithoutText = [...LIST_FIELDS.flatMap(kind => form[kind]), ...form.addresses].some(entry => entry.label === 'custom' && !entry.custom_label.trim() && ('value' in entry ? entry.value.trim() : true));
  if (customWithoutText) errors.labels = 'Give every custom label a name.';
  return errors;
}

/**
 * The categories to save: the stored ones exactly as they were (the person
 * only adds or removes whole ones), plus a typed one not added yet, as one.
 */
export function categoriesOf(form: Pick<ContactForm, 'categories' | 'categoryDraft'>) {
  const typed = form.categoryDraft.trim();
  return typed && !form.categories.includes(typed) ? [...form.categories, typed] : form.categories;
}

/** The body of POST or PUT /api/contacts: empty inputs are left out, so the server stores nothing for them. */
export function toInput(form: ContactForm, version?: number): ContactInput {
  const named = (value: string) => value.trim() || null;
  const list = (entries: ValueDraft[]) => entries.filter(entry => entry.value.trim()).map(valueInput);
  return {
    ...(version !== undefined ? { version } : {}),
    name: { given: named(form.given), family: named(form.family), middle: named(form.middle), prefix: named(form.prefix), suffix: named(form.suffix), display: named(form.display) },
    organization: { name: named(form.company), department: named(form.department) },
    job_title: named(form.job_title),
    notes: form.notes.trim() ? form.notes : null,
    birthday: partialDateInput(dateOfDraft(form.birthday).date),
    anniversary: partialDateInput(dateOfDraft(form.anniversary).date),
    emails: list(form.emails), phones: list(form.phones), urls: list(form.urls), impp: list(form.impp), related: list(form.related), nicknames: list(form.nicknames),
    addresses: form.addresses.filter(addressFilled).map(addressInput),
    categories: categoriesOf(form),
  };
}
