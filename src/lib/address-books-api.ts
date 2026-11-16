// The browser's side of shared address books and the company directory
// (F11): the routes of api/src/contracts/address-books.ts with their shapes,
// and the query keys every book view shares. A book's contacts have the
// shape of the person's own (contacts-api.ts). The server decides who may
// read, edit or manage a book; `permission` on each book only says what to
// offer. The query client is per session, so nothing here crosses accounts.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ApiError, unwrap } from '@/lib/api-error';
import { ContactVersionConflict, type Contact, type ContactDetail, type ContactInput, type ImportSummary } from '@/lib/contacts-api';
import { binQueryKeys } from '@/lib/bin-api';
import type {
  AddressBookInput, AddressBookResponse, AddressBooksResponse, AdminAddressBook, AdminAddressBooksResponse, BookContactResponse,
  BookContactsResponse, BookShare, BookSharesResponse, CopyToBookResponse, RestoreAddressBookResponse, SetShareRequest, ShareCandidatesResponse,
} from '../../api/src/contracts/address-books';
import type { BinnedResponse } from '../../api/src/contracts/bin';

export type {
  AddressBook, AdminAddressBook, AlsoIn, BookPermission, BookShare, ManagedBook, SetShareRequest, ShareCandidatesResponse, SharePermission,
} from '../../api/src/contracts/address-books';

/** The company directory's id among the books. */
export const COMPANY_BOOK = 'company';

export const addressBooksQueryKeys = {
  all: ['address-books'] as const,
  list: ['address-books', 'list'] as const,
  book: (id: string) => ['address-books', 'book', id] as const,
  contacts: (id: string) => ['address-books', 'book', id, 'contacts'] as const,
  contact: (id: string, contactId: string) => ['address-books', 'book', id, 'contacts', contactId] as const,
  shares: (id: string) => ['address-books', 'book', id, 'shares'] as const,
  candidates: (id: string, query: string) => ['address-books', 'book', id, 'candidates', query] as const,
  admin: ['address-books', 'admin'] as const,
};

const required = <T,>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`The server sent no ${what}.`);
  return value;
};
const bookPath = (id: string, rest = '') => `/address-books/${encodeURIComponent(id)}${rest}`;

/** Every contact of a book, page by page as the server gives them. */
export async function fetchBookContacts(id: string, signal?: AbortSignal): Promise<Contact[]> {
  const contacts: Contact[] = [];
  for (let offset = 0; ;) {
    const page = required(unwrap(await api.get<BookContactsResponse>(bookPath(id, `/contacts?limit=2000&offset=${offset}`), { signal })), 'contacts');
    contacts.push(...page.contacts);
    if (!page.has_more) return contacts;
    if (!page.contacts.length) throw new Error('The book\'s contacts did not advance. Please refresh.');
    offset += page.contacts.length;
  }
}

async function sendBookContact(request: Promise<{ data?: BookContactResponse; error?: string; status?: number; [key: string]: unknown }>) {
  const response = await request;
  if (response.error && response.code === 'VERSION_CONFLICT' && response.contact) {
    throw new ContactVersionConflict({ error: response.error, status: response.status, contact: response.contact as Contact });
  }
  return required(unwrap(response)?.contact, 'contact');
}

/** A book contact's photo address; the etag makes a changed picture a new address. Company entries have none. */
export function bookContactPhotoUrl(bookId: string, contact: Pick<Contact, 'id' | 'photo'>, size: 'full' | 'thumb') {
  if (!contact.photo) return null;
  return api.getDownloadUrl(bookPath(bookId, `/contacts/${encodeURIComponent(contact.id)}/photo?size=${size}&v=${encodeURIComponent(contact.photo.etag)}`));
}

export const addressBooksApi = {
  /** Company first, then the books shared with the person or created by them. */
  list: async (signal?: AbortSignal) => required(unwrap(await api.get<AddressBooksResponse>('/address-books', { signal })), 'books').books,
  get: async (id: string, signal?: AbortSignal) => required(unwrap(await api.get<AddressBookResponse>(bookPath(id), { signal })), 'book').book,
  create: async (input: AddressBookInput) => required(unwrap(await api.post<AddressBookResponse>('/address-books', input)), 'book').book,
  rename: async (id: string, input: AddressBookInput) => required(unwrap(await api.put<AddressBookResponse>(bookPath(id), input)), 'book').book,
  /** Hidden at once; an administrator can restore it. */
  remove: async (id: string) => { unwrap(await api.delete(bookPath(id))); },

  shares: async (id: string, signal?: AbortSignal) => required(unwrap(await api.get<BookSharesResponse>(bookPath(id, '/shares'), { signal })), 'shares').shares,
  /** Gives, changes or (null) removes one share; answers the shares as they are now. */
  setShare: async (id: string, request: SetShareRequest): Promise<BookShare[]> => required(unwrap(await api.put<BookSharesResponse>(bookPath(id, '/shares'), request)), 'shares').shares,
  candidates: async (id: string, query: string, signal?: AbortSignal) =>
    required(unwrap(await api.get<ShareCandidatesResponse>(bookPath(id, `/share-candidates?q=${encodeURIComponent(query)}`), { signal })), 'candidates'),

  contacts: fetchBookContacts,
  contact: async (id: string, contactId: string, signal?: AbortSignal): Promise<ContactDetail> =>
    required(unwrap(await api.get<BookContactResponse>(bookPath(id, `/contacts/${encodeURIComponent(contactId)}`), { signal })), 'contact').contact,
  createContact: (id: string, contact: ContactInput) => sendBookContact(api.post<BookContactResponse>(bookPath(id, '/contacts'), contact)),
  updateContact: (id: string, contactId: string, contact: ContactInput) => sendBookContact(api.put<BookContactResponse>(bookPath(id, `/contacts/${encodeURIComponent(contactId)}`), contact)),
  /** Into the book's bin; the answer names the bin items for Undo. */
  removeContact: async (id: string, contactId: string) => unwrap(await api.delete<BinnedResponse>(bookPath(id, `/contacts/${encodeURIComponent(contactId)}`)))?.bin_item_ids ?? [],
  removeContacts: async (id: string, ids: string[]) => {
    const answer = unwrap(await api.post<{ deleted: number } & Partial<BinnedResponse>>(bookPath(id, '/contacts/bulk-delete'), { ids }));
    return { deleted: answer?.deleted ?? ids.length, binItemIds: answer?.bin_item_ids ?? [] };
  },
  setPhoto: async (id: string, contactId: string, file: Blob) => required(unwrap(
    await api.uploadBlob<BookContactResponse>(bookPath(id, `/contacts/${encodeURIComponent(contactId)}/photo`), file, file.type || 'application/octet-stream', 'PUT'))?.contact, 'contact'),
  removePhoto: async (id: string, contactId: string) => required(unwrap(await api.delete<BookContactResponse>(bookPath(id, `/contacts/${encodeURIComponent(contactId)}/photo`)))?.contact, 'contact'),

  /** Copies of the person's own contacts in the book (new ids and UIDs); the originals stay. */
  copy: async (id: string, ids: string[]) => required(unwrap(await api.post<CopyToBookResponse>(bookPath(id, '/copy'), { ids })), 'copy result'),
  /** Staged for review; commit with contactsApi.commitImport (no merge decisions in a book). */
  stageImport: async (id: string, file: File) => required(unwrap(await api.uploadBlob<ImportSummary>(bookPath(id, '/imports'), file, file.type || 'application/octet-stream')), 'import summary'),

  /** The person's choice of books for their phones: the ids (and `company`) that stay off. */
  setPhoneBooksOff: async (ids: string[]) => { unwrap(await api.put('/settings/values', { values: { contacts_phone_books_off: ids } })); },

  // Server › Shared books.
  adminList: async (signal?: AbortSignal): Promise<AdminAddressBook[]> => required(unwrap(await api.get<AdminAddressBooksResponse>('/admin/address-books', { signal })), 'books').books,
  adminRestore: async (id: string) => required(unwrap(await api.post<RestoreAddressBookResponse>(`/admin/address-books/${encodeURIComponent(id)}/restore`, {})), 'book').book,
};

export const addressBooksQueryOptions = queryOptions({
  queryKey: addressBooksQueryKeys.list,
  queryFn: ({ signal }) => addressBooksApi.list(signal),
  staleTime: 60 * 1000,
});

export const bookContactsQueryOptions = (id: string) => queryOptions({
  queryKey: addressBooksQueryKeys.contacts(id),
  queryFn: ({ signal }) => fetchBookContacts(id, signal),
  staleTime: 5 * 60 * 1000,
  refetchOnWindowFocus: false,
});

/**
 * Every visible book's contacts, Company first, for the composer's
 * suggestions; a book that cannot be read now is left out.
 */
export const sharedContactsQueryOptions = queryOptions({
  queryKey: [...addressBooksQueryKeys.all, 'every-contact'] as const,
  queryFn: async ({ signal }) => {
    const books = await addressBooksApi.list(signal);
    const pages = await Promise.all(books.map(book => fetchBookContacts(book.id, signal).then(contacts => ({ book, contacts }), error => {
      if (error instanceof ApiError && error.status && error.status < 500) return { book, contacts: [] as Contact[] };
      throw error;
    })));
    return pages;
  },
  staleTime: 5 * 60 * 1000,
  refetchOnWindowFocus: false,
});

/** After a book, share, its contacts or its bin changed, or the server's hint: every book view and the bins. */
export function invalidateBookQueries(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: addressBooksQueryKeys.all }),
    client.invalidateQueries({ queryKey: binQueryKeys.all }),
    // A personal contact's "Also in" names books.
    client.invalidateQueries({ queryKey: ['contacts', 'detail'] }),
  ]);
}
