import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { AddressBook, BookPermission, BookShare, ManagedBook, ShareCandidatesResponse, SharePermission } from '../contracts/address-books';
import type { ContactRecord, KeptProperty } from '../contracts/contacts';
import type { Principal } from '../contracts/organisation';

import crypto from 'node:crypto';
import fs from 'node:fs';
import { db } from '../state';
import { badRequest, forbidden, notFound } from '../http/errors';
import { can as roleCan } from '../security/permissions';
import { withTransaction } from './transactions';
import { accessLevel, assertCan, grantsOn, heldBy, lockGrant, setGrant, visible } from './access';
import { groupExists, groupNames, groupsOf, listGroups, membershipOf, peopleMatching, shareAGroup } from './groups';
import { getContact, insertContact } from './contacts';
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
const MAX_CANDIDATES = 20;
const COPY_MAX = 1000;

const book = (id: string) => ({ kind: 'address_book' as const, id });
const hidden = () => notFound('BOOK_NOT_FOUND', 'Address book not found');
const iso = (value: unknown) => (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString();

/** 404 for an id that is no book the person can see, 403 for less than `permission`; answers their level. */
async function assertBook(userId: string, bookId: string, permission: BookPermission, executor: SqlExecutor = db): Promise<BookPermission> {
  if (!UUID.test(bookId)) throw hidden();
  return assertCan(userId, book(bookId), permission, executor);
}

/** The check a write to the book's contacts runs first in its transaction. */
const bookWrite = (userId: string, bookId: string) => async (cx: SqlExecutor) => {
  await cx.execute('SELECT id FROM address_books WHERE id = ? LOCK IN SHARE MODE', [bookId]);
  return assertBook(userId, bookId, 'edit', cx);
};

async function presentBooks(ids: readonly string[], permissions: ReadonlyMap<string, BookPermission>): Promise<AddressBook[]> {
  if (!ids.length) return [];
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT b.id, b.name, b.description, b.created_at, b.updated_at,
      (SELECT COUNT(*) FROM contacts c WHERE c.address_book_id = b.id) AS contact_count
    FROM address_books b WHERE b.id IN (${ids.map(() => '?').join(', ')}) ORDER BY b.name, b.id`, [...ids]);
  return rows.map(row => ({
    id: String(row.id), name: String(row.name), description: row.description == null ? null : String(row.description),
    permission: permissions.get(String(row.id))!, contact_count: Number(row.contact_count), created_at: iso(row.created_at), updated_at: iso(row.updated_at),
  }));
}

/** GET /api/address-books: the books a grant reaches the person through, by name. */
async function listBooks(userId: string): Promise<AddressBook[]> {
  const ids = await visible(userId, 'address_book');
  const permissions = new Map<string, BookPermission>();
  for (const id of ids) {
    const level = await accessLevel(userId, book(id));
    if (level) permissions.set(id, level);
  }
  return presentBooks([...permissions.keys()], permissions);
}

async function getBook(userId: string, bookId: string): Promise<AddressBook> {
  const permission = await assertBook(userId, bookId, 'read');
  return (await presentBooks([bookId], new Map([[bookId, permission]])))[0];
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
  return { deleted: true };
}

/** An administrator (contacts.books.manage, checked by the route) brings a deleted book back as it was. */
async function restoreBook(bookId: string): Promise<void> {
  if (!UUID.test(bookId)) throw hidden();
  const [[row]] = await db.execute<RowDataPacket[]>('SELECT deleted_at FROM address_books WHERE id = ?', [bookId]);
  if (!row) throw hidden();
  await db.execute('UPDATE address_books SET deleted_at = NULL WHERE id = ?', [bookId]);
}

// --- Shares ----------------------------------------------------------------------

/** GET /api/address-books/:id/shares (manage). */
async function bookShares(userId: string, bookId: string, executor: SqlExecutor = db): Promise<BookShare[]> {
  await assertBook(userId, bookId, 'manage', executor);
  const grants = await grantsOn(book(bookId), executor);
  const userIds = grants.flatMap(grant => grant.principal.kind === 'user' ? [grant.principal.id] : []);
  const [people] = userIds.length ? await executor.execute<RowDataPacket[]>(`SELECT id, full_name, email FROM users WHERE id IN (${userIds.map(() => '?').join(', ')})`, userIds) : [[]];
  const byId = new Map(people.map(row => [String(row.id), row]));
  const groups = await groupNames(grants.flatMap(grant => grant.principal.kind === 'group' ? [grant.principal.id] : []), executor);
  return grants.map(({ principal, permission }) => {
    const person = principal.kind === 'user' ? byId.get(principal.id) : undefined;
    return {
      principal, permission: permission as BookPermission, email: person ? String(person.email) : null,
      name: principal.kind === 'everyone' ? 'Everyone' : principal.kind === 'group' ? groups.get(principal.id) ?? '' : person?.full_name ?? String(person?.email ?? ''),
    };
  });
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

const outOfReach = () => forbidden('SHARE_OUT_OF_REACH', 'You can share only with your own groups and the people in them.');

// Whom the caller may give a share or a higher one: an administrator anyone
// active, any group or everyone; anyone else their own groups and the active
// people in them, never everyone.
async function assertReach(cx: SqlExecutor, userId: string, principal: Principal) {
  const [[caller]] = await cx.execute<RowDataPacket[]>('SELECT role FROM users WHERE id = ?', [userId]);
  const admin = roleCan(caller?.role, 'contacts.books.manage');
  if (principal.kind === 'everyone') { if (!admin) throw outOfReach(); return; }
  if (principal.kind === 'group') {
    if (!await groupExists(principal.id, cx)) throw notFound('GROUP_NOT_FOUND', 'Group not found');
    if (!admin && !await membershipOf(principal.id, userId, cx)) throw outOfReach();
    return;
  }
  const [[person]] = await cx.execute<RowDataPacket[]>('SELECT id FROM users WHERE id = ? AND is_active = TRUE', [principal.id]);
  if (!person) throw notFound('USER_NOT_FOUND', 'User not found');
  if (!admin && !await shareAGroup(userId, principal.id, cx)) throw outOfReach();
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
    if (raised) await assertReach(cx, userId, principal);
    if (current !== permission) await setGrant(cx, book(bookId), principal, permission, userId);
    return bookShares(userId, bookId, cx);
  });
}

/** GET /api/address-books/:id/share-candidates?q= (manage): people and groups within the caller's reach. */
async function shareCandidates(userId: string, bookId: string, query: string): Promise<ShareCandidatesResponse> {
  await assertBook(userId, bookId, 'manage');
  const [[caller]] = await db.execute<RowDataPacket[]>('SELECT role FROM users WHERE id = ?', [userId]);
  const admin = roleCan(caller?.role, 'contacts.books.manage');
  const people = await peopleMatching(query, admin ? {} : { sharingGroupsWith: userId });
  const needle = query.trim().toLowerCase();
  const groups = (admin ? await listGroups() : await groupsOf(userId))
    .filter(group => group.name.toLowerCase().includes(needle)).slice(0, MAX_CANDIDATES).map(({ id, name }) => ({ id, name }));
  return { people, groups, everyone: admin };
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

export {
  assertBook, bookWrite, listBooks, getBook, createBook, renameBook, deleteBook, restoreBook,
  bookShares, setShare, shareCandidates, managedBooksOf, copyToBook,
};
