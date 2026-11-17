import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { AddressBook, AdminAddressBook, AlsoIn, BookPermission, BookShare, ManagedBook, ShareCandidatesResponse, SharePermission } from '../contracts/address-books';
import type { ContactDetail, ContactRecord, KeptProperty } from '../contracts/contacts';
import type { Principal } from '../contracts/organisation';

import crypto from 'node:crypto';
import fs from 'node:fs';
import { db } from '../state';
import { badRequest, forbidden, notFound } from '../http/errors';
import { withTransaction } from './transactions';
import { accessLevel, assertCan, assertReach, grantsOn, heldBy, lockGrant, namedGrants, reachCandidates, setGrant, visible } from './access';
import { groupMemberIds } from './groups';
import { contactSearchCondition, displayName, getContact, insertContact, listContacts } from './contacts';
import { valueKey } from './contact-keys';
import { COMPANY, companyContacts, listDirectory } from './directory';
import { publishBooksChanged } from './realtime';
import { attachContactPhoto, photoPath, withContactPhotoLock, writePhotoFiles } from './contact-photos';
import { recordDraft } from './contacts-import';

// Shared address books (F4): a book belongs to the organisation, its
// creator manages it through a grant, and administrators with
// contacts.books.manage manage every book. Who may do what is the access
// service's answer, asked before any change and again inside the change's
// transaction, after the book's row is locked (shares lock it for update,
// contact writes in share mode), so a share removed meanwhile is seen. The
// book's contacts live in the contact tables with the book as owner
// (contacts.ts); nothing here writes them directly.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_ORDER: readonly BookPermission[] = ['read', 'edit', 'manage'];
const COPY_MAX = 1000;

const book = (id: string) => ({ kind: 'address_book' as const, id });
const hidden = () => notFound('BOOK_NOT_FOUND', 'Address book not found');
const iso = (value: unknown) => (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString();

/** 404 for an id that is no book the person can see, 403 for less than `permission`; answers their level. Company is read-only for everyone. */
async function assertBook(userId: string, bookId: string, permission: BookPermission, executor: SqlExecutor = db): Promise<BookPermission> {
  if (bookId === COMPANY) {
    if (permission !== 'read') throw forbidden('BOOK_FORBIDDEN', 'The company directory is read-only; each person keeps their own entry under Settings › Profile.');
    return 'read';
  }
  if (!UUID.test(bookId)) throw hidden();
  return assertCan(userId, book(bookId), permission, executor);
}

/** The check a write to the book's contacts runs first in its transaction. */
const bookWrite = (userId: string, bookId: string) => async (cx: SqlExecutor) => {
  await cx.execute('SELECT id FROM address_books WHERE id = ? LOCK IN SHARE MODE', [bookId]);
  return assertBook(userId, bookId, 'edit', cx);
};

async function presentBooks(ids: readonly string[], permissions: ReadonlyMap<string, BookPermission>, executor: SqlExecutor = db): Promise<AddressBook[]> {
  if (!ids.length) return [];
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT b.id, b.name, b.description, b.created_at, b.updated_at,
      (SELECT COUNT(*) FROM contacts c WHERE c.address_book_id = b.id) AS contact_count
    FROM address_books b WHERE b.id IN (${ids.map(() => '?').join(', ')}) ORDER BY b.name, b.id`, [...ids]);
  return rows.map(row => ({
    id: String(row.id), name: String(row.name), description: row.description == null ? null : String(row.description),
    permission: permissions.get(String(row.id))!, contact_count: Number(row.contact_count), created_at: iso(row.created_at), updated_at: iso(row.updated_at),
  }));
}

/** The company directory as a book: every active person, read-only. */
async function companyBook(executor: SqlExecutor = db): Promise<AddressBook> {
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT COUNT(*) AS people, MIN(created_at) AS created_at,
      GREATEST(MAX(COALESCE(updated_at, created_at)), COALESCE((SELECT MAX(updated_at) FROM directory_entries), MIN(created_at))) AS updated_at
    FROM users WHERE is_active = TRUE`);
  return { id: COMPANY, name: 'Company', description: null, permission: 'read', contact_count: Number(row.people), created_at: iso(row.created_at), updated_at: iso(row.updated_at) };
}

/** GET /api/address-books: Company, then the books a grant reaches the person through, by name. */
async function listBooks(userId: string, executor: SqlExecutor = db): Promise<AddressBook[]> {
  const ids = await visible(userId, 'address_book', executor);
  const permissions = new Map<string, BookPermission>();
  for (const id of ids) {
    const level = await accessLevel(userId, book(id), executor);
    if (level) permissions.set(id, level);
  }
  return [await companyBook(executor), ...await presentBooks([...permissions.keys()], permissions, executor)];
}

async function getBook(userId: string, bookId: string): Promise<AddressBook> {
  const permission = await assertBook(userId, bookId, 'read');
  if (bookId === COMPANY) return companyBook();
  return (await presentBooks([bookId], new Map([[bookId, permission]])))[0];
}

/** Everyone a share to these principals reaches, for the hint that their books changed. */
async function peopleOf(principals: readonly Principal[], executor: SqlExecutor = db): Promise<string[]> {
  if (principals.some(principal => principal.kind === 'everyone')) {
    const [rows] = await executor.execute<RowDataPacket[]>('SELECT id FROM users WHERE is_active = TRUE');
    return rows.map(row => String(row.id));
  }
  const people = principals.flatMap(principal => principal.kind === 'user' ? [principal.id] : []);
  for (const principal of principals) if (principal.kind === 'group') people.push(...await groupMemberIds(principal.id, executor));
  return people;
}

/** Tells the people a book reaches that it changed (deleted, restored); the page refetches. */
// After the change committed, so a failed lookup only loses the hint.
async function hintBookReach(bookId: string) {
  publishBooksChanged(await grantsOn(book(bookId)).then(grants => peopleOf(grants.map(grant => grant.principal))).catch(() => []));
}

/** Tells everyone their books changed: the directory lost or regained a person. */
async function hintEveryone() {
  publishBooksChanged(await peopleOf([{ kind: 'everyone' }]));
}

function bookInput(input: unknown): { name: string; description: string | null } {
  const body = (input && typeof input === 'object' ? input : {}) as { name?: unknown; description?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100) throw badRequest('BOOK_NAME_INVALID', 'An address book needs a name of at most 100 characters.');
  if (body.description != null && (typeof body.description !== 'string' || body.description.length > 500)) {
    throw badRequest('BOOK_DESCRIPTION_INVALID', 'A description has at most 500 characters.');
  }
  const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null;
  return { name, description };
}

/** POST /api/address-books: anyone creates a book of the organisation and manages it. */
async function createBook(userId: string, input: unknown): Promise<AddressBook> {
  const { name, description } = bookInput(input);
  const id = crypto.randomUUID();
  await withTransaction(async cx => {
    await cx.execute('INSERT INTO address_books (id, name, description, created_by) VALUES (?, ?, ?, ?)', [id, name, description, userId]);
    await setGrant(cx, book(id), { kind: 'user', id: userId }, 'manage', userId);
  });
  return getBook(userId, id);
}

/** PUT /api/address-books/:id (manage): its name and description. */
async function renameBook(userId: string, bookId: string, input: unknown): Promise<AddressBook> {
  const { name, description } = bookInput(input);
  await assertBook(userId, bookId, 'manage');
  await withTransaction(async cx => {
    await cx.execute('SELECT id FROM address_books WHERE id = ? FOR UPDATE', [bookId]);
    await assertBook(userId, bookId, 'manage', cx);
    await cx.execute('UPDATE address_books SET name = ?, description = ? WHERE id = ?', [name, description, bookId]);
  });
  return getBook(userId, bookId);
}

/** DELETE /api/address-books/:id (manage): hidden at once; its contacts, shares and bin stay until an administrator restores it or the purge. */
async function deleteBook(userId: string, bookId: string): Promise<{ deleted: true }> {
  await assertBook(userId, bookId, 'manage');
  await withTransaction(async cx => {
    await cx.execute('SELECT id FROM address_books WHERE id = ? FOR UPDATE', [bookId]);
    await assertBook(userId, bookId, 'manage', cx);
    await cx.execute('UPDATE address_books SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [bookId]);
  });
  await hintBookReach(bookId);
  return { deleted: true };
}

/** GET /api/admin/address-books (contacts.books.manage, checked by the route): every book, deleted ones included. */
async function adminBooks(bookId?: string): Promise<AdminAddressBook[]> {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT b.id, b.name, b.description, b.created_at, b.updated_at, b.deleted_at,
      (SELECT COUNT(*) FROM contacts c WHERE c.address_book_id = b.id) AS contact_count, u.id AS creator_id, u.full_name, u.email
    FROM address_books b LEFT JOIN users u ON u.id = b.created_by ${bookId ? 'WHERE b.id = ?' : ''} ORDER BY b.name, b.id`, bookId ? [bookId] : []);
  return rows.map(row => ({
    id: String(row.id), name: String(row.name), description: row.description == null ? null : String(row.description), contact_count: Number(row.contact_count),
    created_at: iso(row.created_at), updated_at: iso(row.updated_at), deleted_at: row.deleted_at == null ? null : iso(row.deleted_at),
    created_by: row.creator_id == null ? null : { id: String(row.creator_id), full_name: row.full_name == null ? null : String(row.full_name), email: String(row.email) },
  }));
}

/** POST /api/admin/address-books/:id/restore (contacts.books.manage, checked by the route): a deleted book back as it was. */
async function restoreBook(bookId: string): Promise<AdminAddressBook> {
  if (!UUID.test(bookId)) throw hidden();
  const [[row]] = await db.execute<RowDataPacket[]>('SELECT id FROM address_books WHERE id = ?', [bookId]);
  if (!row) throw hidden();
  await db.execute('UPDATE address_books SET deleted_at = NULL WHERE id = ?', [bookId]);
  await hintBookReach(bookId);
  return (await adminBooks(bookId))[0];
}

// --- Shares ----------------------------------------------------------------------

/** GET /api/address-books/:id/shares (manage). */
async function bookShares(userId: string, bookId: string, executor: SqlExecutor = db): Promise<BookShare[]> {
  await assertBook(userId, bookId, 'manage', executor);
  return (await namedGrants(book(bookId), executor)).map(share => ({ ...share, permission: share.permission as BookPermission }));
}

function shareInput(input: unknown): { principal: Principal; permission: SharePermission | null } {
  const body = (input && typeof input === 'object' ? input : {}) as { principal?: { kind?: unknown; id?: unknown }; permission?: unknown };
  const { kind, id } = body.principal && typeof body.principal === 'object' ? body.principal : { kind: undefined, id: undefined };
  const permission = body.permission === null ? null : body.permission === 'read' || body.permission === 'edit' ? body.permission : undefined;
  if (permission === undefined) throw badRequest('SHARE_INVALID', 'A share is read, edit or null to remove it.');
  if (kind === 'everyone') return { principal: { kind }, permission };
  if ((kind === 'user' || kind === 'group') && typeof id === 'string' && UUID.test(id)) return { principal: { kind, id: id.toLowerCase() }, permission };
  throw badRequest('SHARE_INVALID', 'Expected { principal: { kind: user | group | everyone, id }, permission }.');
}

/** PUT /api/address-books/:id/shares (manage): gives, changes or removes one share; giving or raising one is checked against the caller's reach. */
async function setShare(userId: string, bookId: string, input: unknown): Promise<BookShare[]> {
  const { principal, permission } = shareInput(input);
  await assertBook(userId, bookId, 'manage');
  return withTransaction(async cx => {
    await cx.execute('SELECT id FROM address_books WHERE id = ? FOR UPDATE', [bookId]);
    await assertBook(userId, bookId, 'manage', cx);
    const current = await lockGrant(cx, book(bookId), principal);
    if (current === 'manage') throw badRequest('SHARE_IS_CREATOR', 'The person who created the book manages it; that stays as it is.');
    const raised = permission !== null && (current === null || SHARE_ORDER.indexOf(permission) > SHARE_ORDER.indexOf(current as BookPermission));
    if (raised) await assertReach(cx, userId, principal, 'contacts.books.manage');
    if (current !== permission) await setGrant(cx, book(bookId), principal, permission, userId);
    return bookShares(userId, bookId, cx);
  }).then(async shares => { publishBooksChanged(await peopleOf([principal]).catch(() => [])); return shares; });
}

/** GET /api/address-books/:id/share-candidates?q= (manage): people and groups within the caller's reach. */
async function shareCandidates(userId: string, bookId: string, query: string): Promise<ShareCandidatesResponse> {
  await assertBook(userId, bookId, 'manage');
  return reachCandidates(userId, query, 'contacts.books.manage');
}

/** The live books the person created and manages, for the administrator's view of them. */
async function managedBooksOf(userId: string): Promise<ManagedBook[]> {
  const ids = await heldBy(userId, 'address_book', 'manage');
  if (!ids.length) return [];
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT id, name FROM address_books WHERE deleted_at IS NULL AND id IN (${ids.map(() => '?').join(', ')}) ORDER BY name, id`, ids);
  return rows.map(row => ({ id: String(row.id), name: String(row.name) }));
}

// --- Copying the person's contacts into a book -------------------------------------

function idsInput(input: unknown): string[] {
  const ids = (input && typeof input === 'object' ? input as { ids?: unknown } : {}).ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > COPY_MAX || !ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
    throw badRequest('INVALID_INPUT', `Expected { ids: [...] } with 1 to ${COPY_MAX} contacts.`);
  }
  return [...new Set(ids as string[])];
}

/**
 * POST /api/address-books/:id/copy (edit): copies of the person's own
 * contacts, each with a new id and UID, its kept properties and its photo,
 * in one transaction; the originals stay as they were. An id that is not
 * the person's contact is refused and nothing is copied.
 */
async function copyToBook(userId: string, bookId: string, input: unknown): Promise<{ copied: number; contact_ids: string[] }> {
  const ids = idsInput(input);
  await assertBook(userId, bookId, 'edit');
  const sources: (ContactRecord & { properties: KeptProperty[] })[] = [];
  for (const id of ids) sources.push(await getContact(userId, id));
  const owner = { bookId };
  // The photo files as stored: the copy names the same content under the book.
  const photos = new Map<string, Parameters<typeof attachContactPhoto>[3]>();
  for (const source of sources) {
    if (!source.photo) continue;
    const [[row]] = await db.execute<RowDataPacket[]>('SELECT sha256, thumb_sha256, width, height FROM contact_photos WHERE contact_id = ? AND user_id = ?', [source.id, userId]);
    if (!row) continue;
    const read = (sha: string) => fs.promises.readFile(photoPath(userId, sha)).catch(() => null);
    const [full, thumb] = await Promise.all([read(row.sha256), read(row.thumb_sha256)]);
    if (full && thumb) photos.set(source.id, { full, thumb, sha256: row.sha256, thumbSha256: row.thumb_sha256, width: Number(row.width), height: Number(row.height) });
  }
  return withContactPhotoLock(owner, async () => {
    for (const photo of photos.values()) await writePhotoFiles(owner, photo);
    const created = await withTransaction(async cx => {
      await bookWrite(userId, bookId)(cx);
      const made: string[] = [];
      for (const source of sources) {
        const properties = source.properties.map(property => ({ name: property.name, group: property.group, params: property.params, value: property.value }));
        const draft = recordDraft(source);
        // New value ids: a copy shares nothing with its original.
        const id = await insertContact(cx, owner, { ...draft, is_favorite: false, values: draft.values.map(({ id: _id, ...value }) => value) }, { properties });
        const photo = photos.get(source.id);
        if (photo) await attachContactPhoto(cx, owner, id, photo, 'import');
        made.push(id);
      }
      return made;
    });
    return { copied: created.length, contact_ids: created };
  });
}

// --- Where the books show beside the person's own contacts -----------------------

/** GET /api/address-books/phone: the visible books, Company first, less those the person switched off for their phones. */
async function phoneBooks(userId: string): Promise<{ id: string; name: string }[]> {
  const { getSettings } = require('./settings') as typeof import('./settings');
  // Unknown ids (a book gone, a setting restored elsewhere) match nothing.
  const off = new Set((await getSettings('user', userId, userId)).contacts_phone_books_off.value);
  return (await listBooks(userId)).filter(item => !off.has(item.id)).map(({ id, name }) => ({ id, name }));
}

/** On a personal contact's detail: Company and the visible books holding an entry with one of its emails or phones, by name. */
async function alsoIn(userId: string, contact: Pick<ContactRecord, 'emails' | 'phones'>): Promise<AlsoIn[]> {
  const keys = (kind: 'email' | 'phone', values: readonly { value: string }[]) => [...new Set(values.map(item => valueKey(kind, item.value)).filter(Boolean))];
  const emails = keys('email', contact.emails);
  const phones = keys('phone', contact.phones);
  if (!emails.length && !phones.length) return [];
  const found: AlsoIn[] = [];
  const matches = (await listDirectory()).some(entry => emails.includes(valueKey('email', entry.email)) || (!!entry.phone && phones.includes(valueKey('phone', entry.phone))));
  if (matches) found.push({ book_id: COMPANY, name: 'Company' });
  const books = await visible(userId, 'address_book');
  if (!books.length) return found;
  const list = (items: readonly string[]) => items.map(() => '?').join(', ');
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT b.id, b.name FROM address_books b WHERE b.id IN (${list(books)}) AND EXISTS (SELECT 1 FROM contact_values v WHERE v.address_book_id = b.id
      AND (${[emails.length ? `(v.kind = 'email' AND v.value_key IN (${list(emails)}))` : '', phones.length ? `(v.kind = 'phone' AND v.value_key IN (${list(phones)}))` : ''].filter(Boolean).join(' OR ')}))
    ORDER BY b.name, b.id`, [...books, ...emails, ...phones]);
  return [...found, ...rows.map(row => ({ book_id: String(row.id), name: String(row.name) }))];
}

/** A personal contact's detail with the books that also hold it. */
async function withAlsoIn(userId: string, contact: ContactDetail): Promise<ContactDetail> {
  return { ...contact, also_in: await alsoIn(userId, contact) };
}

/** For /api/search: matching entries of Company and the visible books, each naming its book. */
async function searchBooks(userId: string, q: string, limit: number) {
  const company = (await companyContacts({ q, limit })).contacts.map(contact => ({ book: { id: COMPANY, name: 'Company' }, contact }));
  const books = await visible(userId, 'address_book');
  if (!books.length) return company;
  const search = contactSearchCondition(q);
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT c.id, c.first_name, c.middle_name, c.last_name, c.display_name, c.company, b.id AS book_id, b.name AS book_name,
      (SELECT v.value FROM contact_values v WHERE v.contact_id = c.id AND v.kind = 'email' ORDER BY v.position LIMIT 1) AS email,
      (SELECT v.value FROM contact_values v WHERE v.contact_id = c.id AND v.kind = 'phone' ORDER BY v.position LIMIT 1) AS phone
    FROM contacts c JOIN address_books b ON b.id = c.address_book_id
    WHERE c.address_book_id IN (${books.map(() => '?').join(', ')}) AND ${search.sql}
    ORDER BY c.first_name, c.last_name, c.id LIMIT ${limit}`, [...books, ...search.params]);
  return [...company, ...rows.map(row => {
    const values = [{ kind: 'email', value: row.email || '' }, { kind: 'phone', value: row.phone || '' }].filter(value => value.value);
    return { book: { id: String(row.book_id), name: String(row.book_name) },
      contact: { id: String(row.id), display_name: displayName(row as Parameters<typeof displayName>[0], values), email: row.email ?? null, phone: row.phone ?? null, company: row.company ?? null } };
  })];
}

/**
 * For the offline snapshot, in its transaction: Company and the visible
 * books with their contacts (no photos), and the directory with its groups.
 */
async function offlineBooks(connection: SqlExecutor, userId: string) {
  const books = await listBooks(userId, connection);
  const withContacts = [];
  for (const item of books) {
    // shortcut: a book is read whole; the snapshot's measured size still refuses more than 32 MiB. Page it if books grow that large.
    const { contacts } = item.id === COMPANY ? await companyContacts({ limit: 1000000 }, connection) : await listContacts({ bookId: item.id }, { limit: 1000000 }, connection);
    withContacts.push({ ...item, contacts: contacts.map(contact => ({ ...contact, photo: null })) });
  }
  const directory = (await listDirectory(connection)).map(({ created_at: _created, updated_at: _updated, ...entry }) => entry);
  return { books: withContacts, directory };
}

export {
  assertBook, bookWrite, listBooks, getBook, createBook, renameBook, deleteBook, restoreBook, adminBooks,
  bookShares, setShare, shareCandidates, managedBooksOf, copyToBook,
  phoneBooks, withAlsoIn, searchBooks, offlineBooks, hintEveryone, peopleOf,
};
