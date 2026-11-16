import type { RouteRequest } from '../types';
import type { UploadBody } from '../http/route';
import type {
  AddressBookResponse, AddressBooksResponse, AdminAddressBooksResponse, BookContactResponse, BookContactsResponse, BookImportResponse, BookSharesResponse,
  CopyToBookResponse, DeleteAddressBookResponse, PhoneBooksResponse, RestoreAddressBookResponse, ShareCandidatesResponse,
} from '../contracts/address-books';
import fs from 'node:fs';
import { ApiError, badRequest } from '../http/errors';
import { defineRoutes } from '../http/route';
import {
  adminBooks, assertBook, bookShares, bookWrite, copyToBook, createBook, deleteBook, getBook, listBooks, phoneBooks, renameBook, restoreBook, setShare, shareCandidates,
} from '../services/address-books';
import { COMPANY, companyContact, companyContacts } from '../services/directory';
import { createContact, getContact, listContacts, updateContact } from '../services/contacts';
import { moveContactsToBin } from '../services/contact-merge';
import { CONTACT_PHOTO_MAX_BYTES, contactPhotoFile, removeContactPhoto, setContactPhoto } from '../services/contact-photos';
import { stageImport } from '../services/contacts-import';
import { IMPORT_LIMITS } from '../services/contacts-vcard-read';

// Shared address books (F4): the books, their shares and their contacts.
// Every route asks the access service (services/address-books.ts) before
// anything happens and again inside the write's transaction. A book's
// contacts are the contact store's with the book as owner, never reachable
// through /api/contacts. All of it is the Contacts module's; no personal
// restore touches a book, so no route names a restore section.
type Request = RouteRequest & { url: string; params: Record<string, string> };

const BULK_MAX_IDS = 5000;
const CONTACT_BODY_LIMIT = 512 * 1024;
const BULK_BODY_LIMIT = 250000;
const PHOTO_HEADERS = { 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' };

const route = { auth: 'user' as const, module: 'contacts', restoreSection: null };
const owner = (req: Request) => ({ bookId: req.params.id });
const query = (req: Request) => new URL(req.url, 'http://unihub.invalid').searchParams;

function bulkIds(input: unknown): string[] {
  const ids = (input as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > BULK_MAX_IDS || !ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
    throw badRequest('INVALID_INPUT', `Expected { ids: [...] } with 1 to ${BULK_MAX_IDS} contacts.`);
  }
  return ids as string[];
}

// A stale update answers with the contact as it is now, as /api/contacts does.
async function versioned<T>(work: () => Promise<T>) {
  try { return await work(); } catch (error) {
    const details = (error as ApiError).details as { contact?: unknown } | undefined;
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT' && details?.contact) return { error: error.message, status: error.status, code: error.code, contact: details.contact };
    throw error;
  }
}

export = defineRoutes({
  'GET /api/address-books': { ...route, handler: async (_req: Request, userId: string) => {
    return { books: await listBooks(userId) } satisfies AddressBooksResponse;
  } },
  // The Android app's list of books to keep (X-Background-Sync: 1): MODULE_DISABLED under the phone rule.
  'GET /api/address-books/phone': { ...route, gates: 'background-sync', handler: async (_req: Request, userId: string) => {
    return { books: await phoneBooks(userId) } satisfies PhoneBooksResponse;
  } },
  'POST /api/address-books': { ...route, body: { limit: 4096 }, handler: async (_req: Request, userId: string, body: unknown) => {
    return { book: await createBook(userId, body) } satisfies AddressBookResponse;
  } },
  'GET /api/address-books/:id': { ...route, handler: async (req: Request, userId: string) => {
    return { book: await getBook(userId, req.params.id) } satisfies AddressBookResponse;
  } },
  'PUT /api/address-books/:id': { ...route, body: { limit: 4096 }, handler: async (req: Request, userId: string, body: unknown) => {
    return { book: await renameBook(userId, req.params.id, body) } satisfies AddressBookResponse;
  } },
  // Hidden at once, deleted nothing for good: an administrator restores it.
  'DELETE /api/address-books/:id': { ...route, handler: async (req: Request, userId: string) => {
    return { ...await deleteBook(userId, req.params.id) } satisfies DeleteAddressBookResponse;
  } },

  'GET /api/address-books/:id/shares': { ...route, handler: async (req: Request, userId: string) => {
    return { shares: await bookShares(userId, req.params.id) } satisfies BookSharesResponse;
  } },
  'PUT /api/address-books/:id/shares': { ...route, body: { limit: 1024 }, handler: async (req: Request, userId: string, body: unknown) => {
    return { shares: await setShare(userId, req.params.id, body) } satisfies BookSharesResponse;
  } },
  'GET /api/address-books/:id/share-candidates': { ...route, handler: async (req: Request, userId: string) => {
    return { ...await shareCandidates(userId, req.params.id, query(req).get('q') ?? '') } satisfies ShareCandidatesResponse;
  } },

  // Read by the Android app's sync too (X-Background-Sync: 1).
  'GET /api/address-books/:id/contacts': { ...route, gates: 'background-sync', handler: async (req: Request, userId: string) => {
    await assertBook(userId, req.params.id, 'read');
    const params = query(req);
    const limit = Number.parseInt(params.get('limit') || '2000', 10);
    const offset = Number.parseInt(params.get('offset') || '0', 10);
    const page = {
      q: (params.get('q') || '').trim(),
      limit: Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 2000) : 2000,
      offset: Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, 10000000) : 0,
    };
    const answer = req.params.id === COMPANY ? await companyContacts(page) : await listContacts(owner(req), page);
    return { ...answer } satisfies BookContactsResponse;
  } },
  'POST /api/address-books/:id/contacts': { ...route, body: { limit: CONTACT_BODY_LIMIT }, handler: async (req: Request, userId: string, body: unknown) => {
    await assertBook(userId, req.params.id, 'edit');
    const created = await createContact(owner(req), body, bookWrite(userId, req.params.id));
    return { contact: await getContact(owner(req), created.id) } satisfies BookContactResponse;
  } },
  'GET /api/address-books/:id/contacts/:contactId': { ...route, handler: async (req: Request, userId: string) => {
    await assertBook(userId, req.params.id, 'read');
    if (req.params.id === COMPANY) return { contact: await companyContact(req.params.contactId) } satisfies BookContactResponse;
    return { contact: await getContact(owner(req), req.params.contactId) } satisfies BookContactResponse;
  } },
  'PUT /api/address-books/:id/contacts/:contactId': { ...route, body: { limit: CONTACT_BODY_LIMIT }, handler: async (req: Request, userId: string, body: unknown) => versioned(async () => {
    await assertBook(userId, req.params.id, 'edit');
    await updateContact(owner(req), req.params.contactId, body, req.headers['if-match'], bookWrite(userId, req.params.id));
    return { contact: await getContact(owner(req), req.params.contactId) } satisfies BookContactResponse;
  }) },
  // Into the book's bin.
  'DELETE /api/address-books/:id/contacts/:contactId': { ...route, handler: async (req: Request, userId: string) => {
    await assertBook(userId, req.params.id, 'edit');
    const { deleted, binItemIds } = await moveContactsToBin(owner(req), [req.params.contactId], bookWrite(userId, req.params.id));
    if (!deleted) return { error: 'Contact not found', status: 404, code: 'CONTACT_NOT_FOUND' };
    return { message: 'Contact moved to the bin', bin_item_ids: binItemIds };
  } },
  'POST /api/address-books/:id/contacts/bulk-delete': { ...route, body: { limit: BULK_BODY_LIMIT }, handler: async (req: Request, userId: string, body: unknown) => {
    const ids = bulkIds(body);
    await assertBook(userId, req.params.id, 'edit');
    const { deleted, binItemIds } = await moveContactsToBin(owner(req), ids, bookWrite(userId, req.params.id));
    return { message: `${deleted} contact(s) moved to the bin`, deleted, bin_item_ids: binItemIds };
  } },

  'GET /api/address-books/:id/contacts/:contactId/photo': { ...route, gates: 'background-sync', handler: async (req: Request, userId: string) => {
    const size = query(req).get('size') || 'full';
    if (size !== 'full' && size !== 'thumb') return { error: 'size must be full or thumb', status: 400, code: 'INVALID_INPUT' };
    await assertBook(userId, req.params.id, 'read');
    const file = await contactPhotoFile(owner(req), req.params.contactId, size);
    return {
      __raw: await fs.promises.readFile(file.path),
      __contentType: 'image/jpeg', __disposition: 'inline', __filename: 'photo.jpg',
      __etag: file.etag, __headers: PHOTO_HEADERS,
    };
  } },
  'PUT /api/address-books/:id/contacts/:contactId/photo': { ...route, body: { kind: 'upload', limit: CONTACT_PHOTO_MAX_BYTES }, handler: async (req: Request, userId: string, body: unknown) => {
    await assertBook(userId, req.params.id, 'edit');
    await setContactPhoto(owner(req), req.params.contactId, { path: (body as UploadBody).path }, 'upload', bookWrite(userId, req.params.id));
    return { contact: await getContact(owner(req), req.params.contactId) } satisfies BookContactResponse;
  } },
  // Removing a photo deletes it for good: the acting person's bin.delete rule.
  'DELETE /api/address-books/:id/contacts/:contactId/photo': { ...route, destructive: ['bin.delete'], handler: async (req: Request, userId: string) => {
    await assertBook(userId, req.params.id, 'edit');
    await removeContactPhoto(owner(req), req.params.contactId, userId, bookWrite(userId, req.params.id));
    return { contact: await getContact(owner(req), req.params.contactId) } satisfies BookContactResponse;
  } },

  'POST /api/address-books/:id/copy': { ...route, body: { limit: BULK_BODY_LIMIT }, handler: async (req: Request, userId: string, body: unknown) => {
    return { ...await copyToBook(userId, req.params.id, body) } satisfies CopyToBookResponse;
  } },
  // Staged for the person's review; committed through POST /api/contacts/imports/:id/commit.
  'POST /api/address-books/:id/imports': { ...route, body: { kind: 'upload', limit: IMPORT_LIMITS.fileBytes }, handler: async (req: Request, userId: string, body: unknown) => {
    await assertBook(userId, req.params.id, 'edit');
    return { ...await stageImport(userId, body as UploadBody, req.params.id) } satisfies BookImportResponse;
  } },

  // Server › Shared books: every book, deleted ones too, for administrators.
  'GET /api/admin/address-books': { auth: 'admin', permission: 'contacts.books.manage', module: null, handler: async () => {
    return { books: await adminBooks() } satisfies AdminAddressBooksResponse;
  } },
  'POST /api/admin/address-books/:id/restore': { auth: 'admin', permission: 'contacts.books.manage', module: null, restoreSection: null, handler: async (req: Request) => {
    return { book: await restoreBook(req.params.id) } satisfies RestoreAddressBookResponse;
  } },
});
