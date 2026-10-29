import type { RouteRequest } from '../types';
import { clientError } from '../http/errors';
import { defineRoutes } from '../http/route';
import { log } from '../log';
import { mergeDuplicates, previewMerge } from '../services/contacts-legacy';

// Duplicates and merges. Until the duplicate engine, merge review and undo
// land, these are the 0.25 automatic merge routes on the new model; a merge
// keeps every member's values instead of three.
const contactRoute = { auth: 'user' as const, module: 'contacts', restoreSection: 'contacts' };

export = defineRoutes({
  'POST /api/contacts/merge-duplicates': { ...contactRoute, destructive: ['contacts.delete'], handler: async (_req: RouteRequest, userId: string) => {
    try {
      const { merged, removed, groups } = await mergeDuplicates(userId);
      if (groups === 0) return { merged: 0, removed: 0, groups: 0, message: 'No duplicates detected.' };
      return { merged, removed, groups, message: `Merged ${merged} duplicate group(s), removed ${removed} duplicate contact(s).` };
    } catch (error) {
      log.error('contacts', 'Failed to merge duplicates', error);
      return clientError(error, 'Failed to merge duplicates');
    }
  } },

  // Reads only; POST as in 0.25.
  'POST /api/contacts/merge-duplicates/preview': { ...contactRoute, restoreSection: null, handler: async (_req: RouteRequest, userId: string) => {
    try {
      return { ...await previewMerge(userId) };
    } catch (error) {
      log.error('contacts', 'Failed to preview duplicate merge', error);
      return clientError(error, 'Failed to preview duplicate merge');
    }
  } },
});
