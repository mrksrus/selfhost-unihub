import type { RouteRequest } from '../types';
import { clientError } from '../http/errors';
import { defineRoutes } from '../http/route';
import { log } from '../log';
import { exportVCards, importVCards } from '../services/contacts-legacy';

// Contact import and export. Until the vCard and CSV pipeline lands (two-step
// import with preview, vCard 4.0/3.0 and CSV export), these are the 0.25
// routes on the new model; they keep every value instead of three.
type Request = RouteRequest & { url: string };

const readRoute = { auth: 'user' as const, module: 'contacts' };
const contactRoute = { ...readRoute, restoreSection: 'contacts' };

export = defineRoutes({
  'GET /api/contacts/export': { ...readRoute, handler: async (_req: Request, userId: string) => {
    try {
      const vcf = await exportVCards(userId);
      if (!vcf) return { error: 'No contacts to export', status: 404 };
      return { __raw: vcf, __contentType: 'text/vcard', __filename: 'contacts.vcf' };
    } catch (error) {
      log.error('contacts', 'Failed to export contacts', error);
      return clientError(error, 'Failed to export contacts');
    }
  } },

  'POST /api/contacts/import': { ...contactRoute, body: { limit: 500000 }, handler: async (_req: Request, userId: string, body: unknown) => {
    const vcf = (body as { vcf_data?: unknown } | null)?.vcf_data;
    if (!vcf || typeof vcf !== 'string') return { error: 'Missing vcf_data field', status: 400 };
    try {
      return { ...await importVCards(userId, vcf) };
    } catch (error) {
      if (!(error as { status?: number }).status) log.error('contacts', 'Failed to import contacts', error);
      return clientError(error, 'Failed to import contacts');
    }
  } },
});
