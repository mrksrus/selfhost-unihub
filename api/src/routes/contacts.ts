import type { RouteRequest } from '../types';
import type { ContactListResponse, ContactResponse } from '../contracts/contacts';
import { clientError } from '../http/errors';
import { defineRoutes } from '../http/route';
import { log } from '../log';
import {
  listContacts, getContact, createContact, updateContact, setFavorite, deleteContacts, bulkUpdateContacts,
} from '../services/contacts';

// Contacts: list, read, write, favourite and bulk actions (F12, D17). Import
// and export are in contacts-transfer.ts, photos in contacts-photos.ts,
// duplicates and merges in contacts-merge.ts. Every route is gated by the
// Contacts module and refused while the contacts section is restored.
type Request = RouteRequest & { url: string; params: Record<string, string> };

// Bounds one SQL statement; the bulk body limit fits this many IDs.
const BULK_MAX_IDS = 5000;
// A full contact: 64 KB of notes plus up to 100 values in each list.
const CONTACT_BODY_LIMIT = 512 * 1024;
const BULK_BODY_LIMIT = 250000;

function failed(error: unknown, fallback: string) {
  const answer = clientError(error, fallback);
  if (answer.status >= 500) log.error('contacts', fallback, error);
  // A stale full update answers with the contact as it is now.
  const details = answer.details as { contact?: unknown } | undefined;
  if (answer.code === 'VERSION_CONFLICT' && details?.contact) return { error: answer.error, status: answer.status, code: answer.code, contact: details.contact };
  return answer;
}

function bulkIds(ids: unknown): string[] | { error: string; status: number } {
  if (!Array.isArray(ids) || ids.length === 0) return { error: 'ids array is required', status: 400 };
  if (ids.length > BULK_MAX_IDS) return { error: `At most ${BULK_MAX_IDS} contacts at a time`, status: 400 };
  if (!ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 64)) return { error: 'ids must be contact IDs', status: 400 };
  return ids;
}

// Reads stay open while a restore runs (it writes in one transaction); writes are refused.
const readRoute = { auth: 'user' as const, module: 'contacts' };
const contactRoute = { ...readRoute, restoreSection: 'contacts' };

export = defineRoutes({
  'GET /api/contacts': { ...readRoute, handler: async (req: Request, userId: string) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limitNum = Number.parseInt(url.searchParams.get('limit') || '2000', 10);
      const offsetNum = Number.parseInt(url.searchParams.get('offset') || '0', 10);
      const answer: ContactListResponse = await listContacts(userId, {
        q: (url.searchParams.get('q') || '').trim(),
        group: url.searchParams.get('group') || 'all',
        limit: Number.isInteger(limitNum) && limitNum >= 1 ? Math.min(limitNum, 2000) : 2000,
        offset: Number.isSafeInteger(offsetNum) && offsetNum >= 0 ? Math.min(offsetNum, 10000000) : 0,
        includeMerged: (url.searchParams.get('include') || '').split(',').includes('merged'),
      });
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to get contacts'); }
  } },

  'GET /api/contacts/:id': { ...readRoute, handler: async (req: Request, userId: string) => {
    try { return { contact: await getContact(userId, req.params.id) }; } catch (error) { return failed(error, 'Failed to get contact'); }
  } },

  'POST /api/contacts': { ...contactRoute, body: { limit: CONTACT_BODY_LIMIT }, handler: async (_req: Request, userId: string, body: unknown) => {
    try {
      const answer: ContactResponse = { contact: await createContact(userId, body) };
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to create contact'); }
  } },

  'PUT /api/contacts/:id': { ...contactRoute, body: { limit: CONTACT_BODY_LIMIT }, handler: async (req: Request, userId: string, body: unknown) => {
    try {
      const answer: ContactResponse = { contact: await updateContact(userId, req.params.id, body, req.headers['if-match']) };
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to update contact'); }
  } },

  // 0.28 turns a delete into a move to the bin (P-31, D13).
  'DELETE /api/contacts/:id': { ...contactRoute, destructive: ['contacts.delete'], handler: async (req: Request, userId: string) => {
    try {
      await deleteContacts(userId, [req.params.id]);
      return { message: 'Contact deleted' };
    } catch (error) { return failed(error, 'Failed to delete contact'); }
  } },

  'POST /api/contacts/bulk-delete': { ...contactRoute, destructive: ['contacts.delete'], body: { limit: BULK_BODY_LIMIT }, handler: async (_req: Request, userId: string, body: unknown) => {
    const ids = bulkIds((body as { ids?: unknown } | null)?.ids);
    if (!Array.isArray(ids)) return ids;
    try {
      const deleted = await deleteContacts(userId, ids);
      return { message: `${deleted} contact(s) deleted`, deleted };
    } catch (error) { return failed(error, 'Failed to delete contacts'); }
  } },

  'POST /api/contacts/bulk-update': { ...contactRoute, body: { limit: BULK_BODY_LIMIT }, handler: async (_req: Request, userId: string, body: unknown) => {
    const ids = bulkIds((body as { ids?: unknown } | null)?.ids);
    if (!Array.isArray(ids)) return ids;
    try {
      return { updated: await bulkUpdateContacts(userId, ids, (body as { contact?: unknown }).contact) };
    } catch (error) { return failed(error, 'Failed to update contacts'); }
  } },

  // Truthy as in 0.25, for the clients that send 1 or "true".
  'PUT /api/contacts/:id/favorite': { ...contactRoute, handler: async (req: Request, userId: string, body: unknown) => {
    try {
      await setFavorite(userId, req.params.id, !!(body as { is_favorite?: unknown } | null)?.is_favorite);
      return { message: 'Favorite status updated' };
    } catch (error) { return failed(error, 'Failed to update favorite'); }
  } },
});
