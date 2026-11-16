import type { RowDataPacket } from 'mysql2/promise';
import type { AuthRequest, SqlExecutor } from '../types';
import type { ContactDetail, ContactRecord } from '../contracts/contacts';
import type { DirectoryEntry } from '../contracts/directory';

import crypto from 'node:crypto';
import { db } from '../state';
import { badRequest, notFound } from '../http/errors';
import { withTransaction } from './transactions';
import { recordAudit } from './audit';
import { membershipsByUser } from './groups';

// The company directory (F11): every active person with their account's name
// and email and the phone, job title and department of directory_entries.
// It is computed on every read, never stored as contacts, so a deactivated
// person leaves it at once. It shows as the read-only address book
// `company`; its entries in contact shape carry the person's id.

const COMPANY = 'company';
const LIMITS = { phone: 64, job_title: 255, department: 255 } as const;
type Field = keyof typeof LIMITS;

const iso = (value: unknown) => (value instanceof Date ? value : new Date(`${String(value ?? '').replace(' ', 'T')}Z`)).toISOString();
const text = (value: unknown) => (value == null || value === '' ? null : String(value));

// A number that changes whenever a shown field changes (48 bits, a safe integer).
function versionOf(entry: Omit<DirectoryEntry, 'version'>) {
  const hash = crypto.createHash('sha256').update(JSON.stringify([entry.full_name, entry.email, entry.phone, entry.job_title, entry.department, entry.groups.map(group => group.name)])).digest();
  return hash.readUIntBE(0, 6);
}

/** GET /api/directory: every active person, by name. */
async function listDirectory(executor: SqlExecutor = db): Promise<(DirectoryEntry & { created_at: string; updated_at: string })[]> {
  const [people] = await executor.execute<RowDataPacket[]>(`SELECT u.id, u.full_name, u.email, u.created_at, GREATEST(COALESCE(u.updated_at, u.created_at), COALESCE(d.updated_at, u.created_at)) AS updated_at,
      d.phone, d.job_title, d.department
    FROM users u LEFT JOIN directory_entries d ON d.user_id = u.id WHERE u.is_active = TRUE ORDER BY COALESCE(NULLIF(u.full_name, ''), u.email), u.id`);
  const groups = await membershipsByUser(executor);
  return people.map(row => {
    const entry = {
      user_id: String(row.id), full_name: text(row.full_name), email: String(row.email),
      phone: text(row.phone), job_title: text(row.job_title), department: text(row.department), groups: (groups.get(String(row.id)) ?? []).map(({ id, name }) => ({ id, name })),
    };
    return { ...entry, version: versionOf(entry), created_at: iso(row.created_at), updated_at: iso(row.updated_at) };
  });
}

async function directoryEntry(userId: string, executor: SqlExecutor = db): Promise<DirectoryEntry> {
  const entry = (await listDirectory(executor)).find(item => item.user_id === userId);
  if (!entry) throw notFound('USER_NOT_FOUND', 'User not found');
  const { created_at: _created, updated_at: _updated, ...shown } = entry;
  return shown;
}

function entryInput(input: unknown): Partial<Record<Field, string | null>> {
  const body = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const values: Partial<Record<Field, string | null>> = {};
  for (const field of Object.keys(LIMITS) as Field[]) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value != null && typeof value !== 'string') throw badRequest('DIRECTORY_INVALID', `${field} must be text or null.`);
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed.length > LIMITS[field]) throw badRequest('DIRECTORY_INVALID', `${field} has at most ${LIMITS[field]} characters.`);
    values[field] = trimmed || null;
  }
  return values;
}

/**
 * PUT /api/directory/me and the administrator's correction: the fields given,
 * the others as they were. An administrator's change is recorded in the
 * activity log in the same transaction.
 */
async function updateDirectoryEntry(userId: string, input: unknown, admin?: { adminId: string; req: AuthRequest | null }): Promise<DirectoryEntry> {
  const values = entryInput(input);
  await withTransaction(async cx => {
    const [[person]] = await cx.execute<RowDataPacket[]>('SELECT id FROM users WHERE id = ? AND is_active = TRUE LOCK IN SHARE MODE', [userId]);
    if (!person) throw notFound('USER_NOT_FOUND', 'User not found');
    const fields = Object.keys(values) as Field[];
    const updatedBy = admin?.adminId ?? userId;
    await cx.execute(`INSERT INTO directory_entries (user_id, ${[...fields, 'updated_by'].join(', ')}) VALUES (?, ${[...fields, 'updated_by'].map(() => '?').join(', ')})
      ON DUPLICATE KEY UPDATE ${[...fields, 'updated_by'].map(field => `${field} = VALUES(${field})`).join(', ')}`, [userId, ...fields.map(field => values[field] ?? null), updatedBy]);
    if (admin) await recordAudit({ action: 'admin.directory_changed', actorId: admin.adminId, targetUserId: userId, req: admin.req, details: { fields: fields.join(',') } }, cx);
  });
  return directoryEntry(userId);
}

// An entry in the contact shape of a book's contacts, for the phone and the book views.
function asContact(entry: DirectoryEntry & { created_at: string; updated_at: string }): ContactRecord {
  const name = entry.full_name || entry.email;
  return {
    id: entry.user_id, uid: `urn:uuid:${entry.user_id}`, version: entry.version, display_name: name,
    name: { display: entry.full_name, given: null, family: null, middle: null, prefix: null, suffix: null },
    organization: { name: null, department: entry.department }, job_title: entry.job_title,
    birthday: null, anniversary: null, notes: null, is_favorite: false,
    emails: [{ value: entry.email, label: 'work', custom_label: null, preferred: true }],
    phones: entry.phone ? [{ value: entry.phone, label: 'work', custom_label: null, preferred: false }] : [],
    addresses: [], urls: [], impp: [], related: [], nicknames: [], categories: [], photo: null, kept_properties: 0,
    created_at: entry.created_at, updated_at: entry.updated_at,
    first_name: name, last_name: null, email: entry.email, email2: null, email3: null, phone: entry.phone, phone2: null, phone3: null, company: null,
  };
}

/** The directory as the contacts of the book `company`, searched and paged as a book's contacts are. */
async function companyContacts({ q = '', limit = 2000, offset = 0 }: { q?: string; limit?: number; offset?: number }, executor: SqlExecutor = db) {
  const needle = q.trim().toLowerCase();
  const all = (await listDirectory(executor)).filter(entry => !needle
    || [entry.full_name, entry.email, entry.phone, entry.job_title, entry.department].some(value => value?.toLowerCase().includes(needle)));
  return { contacts: all.slice(offset, offset + limit).map(asContact), has_more: offset + limit < all.length, offset };
}

async function companyContact(contactId: string): Promise<ContactDetail> {
  const entry = (await listDirectory()).find(item => item.user_id === contactId);
  if (!entry) throw notFound('CONTACT_NOT_FOUND', 'Contact not found');
  return { ...asContact(entry), properties: [] };
}

export { COMPANY, listDirectory, directoryEntry, updateDirectoryEntry, companyContacts, companyContact, asContact };
