// Request and response shapes of shared address books (0.31, F4, F11).
// A book belongs to the organisation. Whoever creates one manages it; an
// administrator (contacts.books.manage) manages every book. A manager shares
// it with people and groups for reading or editing: an administrator with
// anyone, a group or Everyone, a member with the groups they belong to and
// the active people in those groups. Book contacts have the shape of a
// person's own contacts (contracts/contacts.ts) but are never listed or
// accepted by /api/contacts. The company directory is the read-only book
// with the id `company` (contracts/directory.ts). The frontend imports these
// as types only.
//
// Errors, besides those of every route: 404 BOOK_NOT_FOUND for a book the
// caller cannot see (or a deleted one); 403 BOOK_FORBIDDEN for one they can
// see but not change in that way; 403 SHARE_OUT_OF_REACH for a share beyond
// the caller's reach; 400 BOOK_NAME_INVALID, BOOK_DESCRIPTION_INVALID,
// SHARE_INVALID; 400 SHARE_IS_CREATOR for a change of the creator's own
// management; 404 CONTACT_NOT_FOUND for a contact not in the book.
import type { ContactRecord, ContactDetail, ImportSummary } from './contacts';
import type { Principal } from './organisation';

/** What a person may do with a book; a higher one includes the lower. */
export type BookPermission = 'read' | 'edit' | 'manage';
/** What a share gives; managing comes from creating the book or administering. */
export type SharePermission = 'read' | 'edit';

export interface AddressBook {
  /** A UUID, or `company` for the company directory. */
  id: string;
  name: string;
  description: string | null;
  /** The caller's permission. */
  permission: BookPermission;
  contact_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * GET /api/address-books: Company first, then the books shared with the
 * caller (directly, through a group or Everyone) and those they created, by
 * name. An administrator's other books are only under Server › Shared books.
 */
export interface AddressBooksResponse { books: AddressBook[] }

/** POST /api/address-books (any signed-in person); PUT /api/address-books/:id (manage). */
export interface AddressBookInput { name: string; description?: string | null }

/** GET /api/address-books/:id (read), and the answer of create and rename. */
export interface AddressBookResponse { book: AddressBook }

/** DELETE /api/address-books/:id (manage): hidden at once; an administrator restores it; purged with its contacts after the bin's time. */
export interface DeleteAddressBookResponse { deleted: true }

// --- Shares ----------------------------------------------------------------------

export interface BookShare {
  principal: Principal;
  /** The person's or group's name; "Everyone" for everyone. */
  name: string;
  /** A person's address; null for a group or everyone. */
  email: string | null;
  /** `manage` only for the person who created the book. */
  permission: BookPermission;
}

/** GET /api/address-books/:id/shares (manage). */
export interface BookSharesResponse { shares: BookShare[] }

/**
 * PUT /api/address-books/:id/shares (manage): gives, changes or (null)
 * removes one principal's share. Giving or raising one is checked against
 * the caller's reach; lowering or removing one is not. Answers the shares.
 */
export interface SetShareRequest { principal: Principal; permission: SharePermission | null }

/** GET /api/address-books/:id/share-candidates?q= (manage): within the caller's reach, at most 20 people and 20 groups. */
export interface ShareCandidatesResponse {
  people: { id: string; email: string; full_name: string | null }[];
  groups: { id: string; name: string }[];
  /** Whether the caller may share with everyone. */
  everyone: boolean;
}

// --- The book's contacts ---------------------------------------------------------

/**
 * GET /api/address-books/:id/contacts?q=&limit=1..2000&offset= (read),
 * also for the Android app's sync (X-Background-Sync: 1). Book contacts
 * carry no favourite (is_favorite is false).
 */
export interface BookContactsResponse { contacts: ContactRecord[]; has_more: boolean; offset: number }

/**
 * GET /api/address-books/:id/contacts/:contactId (read); POST
 * /api/address-books/:id/contacts and PUT .../:contactId (edit) take the
 * body of POST and PUT /api/contacts (ContactInput, version-checked) and
 * answer { contact }. DELETE .../:contactId and POST .../contacts/bulk-delete
 * ({ ids }) (edit) move contacts to the book's bin. GET, PUT and DELETE
 * .../:contactId/photo as for a person's contact (edit for the changes).
 */
export interface BookContactResponse { contact: ContactDetail }

/**
 * POST /api/address-books/:id/copy (edit): copies of the caller's own
 * contacts in the book, each with a new id and UID and its photo, not
 * linked to the original, which stays as it was. At most 1000 at once.
 */
export interface CopyToBookRequest { ids: string[] }
export interface CopyToBookResponse { copied: number; contact_ids: string[] }

/**
 * POST /api/address-books/:id/imports (edit): a vCard or CSV file as the
 * raw body, staged for the caller to review, matched against the book's
 * contacts. The review and commit are the caller's own import's: GET
 * /api/contacts/imports/:importId and POST .../commit, where `merge` is
 * refused (a book's contacts are never merged). The commit writes into the
 * book while the caller may still edit it.
 */
export type BookImportResponse = ImportSummary;

// --- The phone ---------------------------------------------------------------------

/**
 * GET /api/address-books/phone (X-Background-Sync: 1, for apps that see the
 * `contacts-books` feature): the books, Company included, the person keeps
 * on their phones (every visible one unless switched off in
 * contacts_phone_books_off). Each book's contacts come from its contacts
 * route. Answers MODULE_DISABLED while phone contacts are forbidden.
 */
export interface PhoneBooksResponse { books: { id: string; name: string }[] }

// --- Administration ---------------------------------------------------------------------

/** GET /api/admin/address-books (contacts.books.manage): every book, deleted ones included. */
export interface AdminAddressBook extends Omit<AddressBook, 'permission'> {
  created_by: { id: string; full_name: string | null; email: string } | null;
  deleted_at: string | null;
}
export interface AdminAddressBooksResponse { books: AdminAddressBook[] }

/** POST /api/admin/address-books/:id/restore (contacts.books.manage): a deleted book back with its contacts and shares. */
export interface RestoreAddressBookResponse { book: AdminAddressBook }

/** A book a person manages by having created it, for the Deactivate and Delete dialogs (GET /api/admin/users/:id/accounts). */
export interface ManagedBook { id: string; name: string }

/** On a personal contact's detail: the shared books (and Company) that hold an entry with the same email or phone. */
export interface AlsoIn { book_id: string; name: string }
