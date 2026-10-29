import type { ServerResponse } from 'node:http';
import type { RouteRequest } from '../types';
import type { UploadBody } from '../http/route';
import type { ContactResponse } from '../contracts/contacts';
import fs from 'node:fs';
import { clientError } from '../http/errors';
import { defineRoutes } from '../http/route';
import { log } from '../log';
import { getContact } from '../services/contacts';
import { CONTACT_PHOTO_MAX_BYTES, contactPhotoFile, removeContactPhoto, setContactPhoto } from '../services/contact-photos';

// Contact photos (D6): GET, PUT and DELETE /api/contacts/:id/photo. A PUT
// takes the picture as the raw body of any type; the server converts it
// (services/contact-photos.ts). Reads stay open during a contacts restore;
// writes are refused. Every route is gated by the Contacts module.
type Request = RouteRequest & { url: string; params: Record<string, string> };

function failed(error: unknown, fallback: string) {
  const answer = clientError(error, fallback);
  if (answer.status >= 500) log.error('contacts', fallback, error);
  return answer;
}

// The photo is private and may change or be revoked at any moment: the
// browser keeps it (private) but asks every time (no-cache), and the ETag
// (the file's sha256) turns an unchanged photo into a 304. The URL's v=
// parameter only makes a new picture a new address for the page.
async function sendPhoto(req: Request, res: ServerResponse, file: { path: string; etag: string; bytes: number }) {
  const etag = `"${file.etag}"`;
  const headers = {
    ETag: etag,
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Cookie, Authorization',
  };
  const ifNoneMatch = String(req.headers['if-none-match'] || '');
  if (ifNoneMatch && ifNoneMatch.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const bytes = await fs.promises.readFile(file.path);
  res.writeHead(200, { ...headers, 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.length), 'Content-Disposition': 'inline; filename="photo.jpg"' });
  res.end(bytes);
}

const readRoute = { auth: 'user' as const, module: 'contacts' };
const writeRoute = { ...readRoute, restoreSection: 'contacts' };

export = defineRoutes({
  'GET /api/contacts/:id/photo': { ...readRoute, response: 'stream', handler: async (req: Request, userId: string, _body: unknown, res: ServerResponse) => {
    try {
      const size = new URL(req.url, 'http://unihub.invalid').searchParams.get('size') || 'full';
      if (size !== 'full' && size !== 'thumb') return { error: 'size must be full or thumb', status: 400, code: 'INVALID_INPUT' };
      await sendPhoto(req, res, await contactPhotoFile(userId, req.params.id, size));
      return undefined;
    } catch (error) { return failed(error, 'Failed to load contact photo'); }
  } },

  'PUT /api/contacts/:id/photo': { ...writeRoute, body: { kind: 'upload', limit: CONTACT_PHOTO_MAX_BYTES }, handler: async (req: Request, userId: string, body: unknown) => {
    try {
      await setContactPhoto(userId, req.params.id, { path: (body as UploadBody).path }, 'upload');
      const answer: ContactResponse = { contact: await getContact(userId, req.params.id) };
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to save contact photo'); }
  } },

  'DELETE /api/contacts/:id/photo': { ...writeRoute, handler: async (req: Request, userId: string) => {
    try {
      await removeContactPhoto(userId, req.params.id);
      const answer: ContactResponse = { contact: await getContact(userId, req.params.id) };
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to remove contact photo'); }
  } },
});
