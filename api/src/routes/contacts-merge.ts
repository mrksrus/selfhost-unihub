import type { RouteRequest } from '../types';
import type { AutoMergeResult, DuplicatesResponse, MergeResult, UndoMergeResult } from '../contracts/contacts';
import { clientError } from '../http/errors';
import { defineRoutes } from '../http/route';
import { log } from '../log';
import { dismissDuplicates, findDuplicates, parseConfidence } from '../services/contact-duplicates';
import { autoMerge, listMerges, mergeContacts, undoMerge } from '../services/contact-merge';

// Duplicates, merges and their 30-day undo (slices 5 and 6). Every route is
// gated by the Contacts module; the writing ones are refused while the
// contacts section is restored. A merge moves the merged-away contacts into
// the bin, where the undo finds them; their later removal is the bin's
// (bin.delete, F13), so a merge itself names no policy.
type Request = RouteRequest & { url: string; params: Record<string, string> };

const readRoute = { auth: 'user' as const, module: 'contacts' };
const contactRoute = { ...readRoute, restoreSection: 'contacts' };
const SMALL_BODY = 16 * 1024;
// 500 group ids of 32 characters with JSON quoting.
const AUTO_BODY = 64 * 1024;

function failed(error: unknown, fallback: string) {
  const answer = clientError(error, fallback);
  if (answer.status >= 500) log.error('contacts', fallback, error);
  // A stale merge answers with the contacts as they are now; a missing choice names the fields.
  const details = answer.details as { contacts?: unknown; conflicts?: unknown } | undefined;
  if (answer.code === 'VERSION_CONFLICT' && details?.contacts) return { error: answer.error, status: answer.status, code: answer.code, contacts: details.contacts };
  if (answer.code === 'CHOICE_REQUIRED' && details?.conflicts) return { error: answer.error, status: answer.status, code: answer.code, conflicts: details.conflicts };
  return answer;
}

export = defineRoutes({
  'GET /api/contacts/duplicates': { ...readRoute, handler: async (req: Request, userId: string) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const answer: DuplicatesResponse = { groups: await findDuplicates(userId, parseConfidence(url.searchParams.get('min'))) };
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to find duplicates'); }
  } },

  'POST /api/contacts/duplicates/dismiss': { ...contactRoute, body: { limit: SMALL_BODY }, handler: async (_req: Request, userId: string, body: unknown) => {
    try { return { ...await dismissDuplicates(userId, body) }; } catch (error) { return failed(error, 'Failed to keep the contacts apart'); }
  } },

  'GET /api/contacts/merges': { ...readRoute, handler: async (_req: Request, userId: string) => {
    try { return { merges: await listMerges(userId) }; } catch (error) { return failed(error, 'Failed to list merges'); }
  } },

  'POST /api/contacts/merges': { ...contactRoute, body: { limit: SMALL_BODY }, handler: async (_req: Request, userId: string, body: unknown) => {
    try {
      const answer: MergeResult = await mergeContacts(userId, body);
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to merge contacts'); }
  } },

  'POST /api/contacts/merges/auto': { ...contactRoute, body: { limit: AUTO_BODY }, handler: async (_req: Request, userId: string, body: unknown) => {
    try {
      const answer: AutoMergeResult = await autoMerge(userId, body);
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to merge contacts'); }
  } },

  'POST /api/contacts/merges/:id/undo': { ...contactRoute, handler: async (req: Request, userId: string) => {
    try {
      const answer: UndoMergeResult = await undoMerge(userId, req.params.id);
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to undo the merge'); }
  } },
});
