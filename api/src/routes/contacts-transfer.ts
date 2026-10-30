import type { ServerResponse } from 'node:http';
import type { RouteRequest } from '../types';
import { once } from 'node:events';
import type { UploadBody } from '../http/route';
import type { ImportStatus, ImportSummary } from '../contracts/contacts';
import { clientError } from '../http/errors';
import { buildContentDisposition } from '../http/content-disposition';
import { defineRoutes } from '../http/route';
import { log } from '../log';
import { stageImport, commitImport, importStatus } from '../services/contacts-import';
import { buildExport, exportFormat } from '../services/contacts-export';
import { IMPORT_LIMITS } from '../services/contacts-vcard-read';

// Contact import and export (D6): vCard 4.0/3.0/2.1, Google and Outlook CSV.
// Import is two steps: POST the raw file for a preview (nothing is written),
// then commit per-group decisions and poll the status. Export is vCard 4.0 by
// default, or vCard 3.0, Google CSV or Outlook CSV, for all contacts (GET) or
// a selection (POST); a vCard export is streamed slice by slice with the
// contacts' photos. The table is registered once in routes/index.ts.
type Request = RouteRequest & { url: string; params: Record<string, string> };

const readRoute = { auth: 'user' as const, module: 'contacts' };
const contactRoute = { ...readRoute, restoreSection: 'contacts' };
// One id per contact; at most the cards one import may hold.
const EXPORT_MAX_IDS = IMPORT_LIMITS.cards;
const COMMIT_BODY_LIMIT = 4 * 1024 * 1024;
const EXPORT_BODY_LIMIT = 1024 * 1024;

function failed(error: unknown, fallback: string) {
  const answer = clientError(error, fallback);
  if (answer.status >= 500) log.error('contacts', fallback, error);
  return answer;
}

// A refusal (bad format, nothing to export) is an ordinary JSON answer; once
// the vCard has begun, a failure aborts the connection so the download is
// seen as broken rather than ending in an error text.
async function exportAnswer(userId: string, format: unknown, ids: string[] | null, res: ServerResponse) {
  const file = await buildExport(userId, exportFormat(format), ids);
  if (!file.slices) return { __raw: file.body, __contentType: file.contentType, __filename: file.filename };
  res.writeHead(200, { 'Content-Type': file.contentType, 'Content-Disposition': buildContentDisposition('attachment', file.filename), 'Cache-Control': 'no-cache' });
  try {
    for await (const slice of file.slices) {
      if (res.destroyed) break;
      if (!res.write(slice)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
    }
    if (res.destroyed) { await file.slices.return(undefined); return undefined; }
    res.end();
  } catch (error) {
    log.error('contacts', 'Contact export stopped', error);
    res.destroy();
  }
  return undefined;
}

export = defineRoutes({
  'POST /api/contacts/imports': { ...contactRoute, body: { kind: 'upload', limit: IMPORT_LIMITS.fileBytes }, handler: async (_req: Request, userId: string, body: unknown) => {
    try {
      const answer: ImportSummary = await stageImport(userId, body as UploadBody);
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to read the import file'); }
  } },

  'GET /api/contacts/imports/:id': { ...readRoute, handler: async (req: Request, userId: string) => {
    try {
      const answer: ImportStatus = await importStatus(userId, req.params.id);
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to get the import'); }
  } },

  'POST /api/contacts/imports/:id/commit': { ...contactRoute, body: { limit: COMMIT_BODY_LIMIT }, handler: async (req: Request, userId: string, body: unknown) => {
    try {
      const answer: ImportStatus = await commitImport(userId, req.params.id, body);
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to import contacts'); }
  } },

  'GET /api/contacts/export': { ...readRoute, response: 'stream', handler: async (req: Request, userId: string, _body: unknown, res: ServerResponse) => {
    try {
      return await exportAnswer(userId, new URL(req.url, 'http://localhost').searchParams.get('format'), null, res);
    } catch (error) { return failed(error, 'Failed to export contacts'); }
  } },

  // Reads only; POST because a selection does not fit a URL.
  'POST /api/contacts/export': { ...readRoute, restoreSection: null, response: 'stream', body: { limit: EXPORT_BODY_LIMIT },
    handler: async (_req: Request, userId: string, body: unknown, res: ServerResponse) => {
    const { ids, format } = (body || {}) as { ids?: unknown; format?: unknown };
    if (!Array.isArray(ids) || !ids.length) return { error: 'ids array is required', status: 400 };
    if (ids.length > EXPORT_MAX_IDS) return { error: `At most ${EXPORT_MAX_IDS} contacts at a time`, status: 400 };
    if (!ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 64)) return { error: 'ids must be contact IDs', status: 400 };
    try {
      return await exportAnswer(userId, format, ids as string[], res);
    } catch (error) { return failed(error, 'Failed to export contacts'); }
  } },
});
