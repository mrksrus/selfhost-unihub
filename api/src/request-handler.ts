import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { ApiError, RouteRequest, RouteResponse } from './types';

import { BACKUP_DISABLED_MESSAGE, DISABLED_BACKUP_ROUTES } from './services/backup-availability';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import routes = require('./routes');
import { verifyToken, validateCsrfToken, refreshSessionCookies } from './auth';
import {
  parseBody,
  parseRawBodyToFile,
  getAllowedOriginForRequest,
  isRequestBodyTooLarge,
} from './http/request';
import { parseSingleByteRange, fileValidators, rangeAllowed } from './http/range';
import { clientError } from './http/errors';
import { compileRouteMatcher } from './http/route-matcher';
import { getModuleForPath } from './services/module-catalog';
import { isModuleEnabled } from './services/module-settings';
import { getActiveRestoreSections } from './services/restore-locks';
import { getRestoreSectionForWrite } from './services/backup-catalog';
import {
  BACKUP_UPLOAD_MAX_SIZE,
  MAIL_COMPOSE_REQUEST_MAX_SIZE,
} from './config';

// Bodies are untrusted at dispatch. Each route retains its existing validation.
type RouteTable = Record<string, (req: RouteRequest, userId: string | null | undefined, body: unknown, res: ServerResponse) => Promise<RouteResponse>>;

const BACKUP_UPLOAD_ROOT = '/app/uploads/backups/imports';
// Compiled once from the route table: every key with a :param segment becomes a
// segment matcher, so adding a route needs no change here.
const matchRoute = compileRouteMatcher(Object.keys(routes));

// Request body limits in bytes. The default covers the small JSON documents
// most routes take, with room for the ordinary text their validators accept
// (names, titles, patterns); the routes below carry files, archives, imports,
// bulk selections, or text columns sized well beyond that.
const DEFAULT_BODY_LIMIT = 16384;
const BODY_LIMIT_BY_PATH_PREFIX: readonly [string, number][] = [
  ['/api/notifications/', 16384],
];
const BODY_LIMIT_BY_ROUTE: Readonly<Record<string, number>> = {
  'GET /api/modules': 16384,
  'PUT /api/modules': 16384,
  // Credentials: a passphrase may be up to 1024 characters, so the JSON needs
  // more than a bare id but nowhere near the default.
  'POST /api/auth/signin': 4096,
  'POST /api/auth/signup': 4096,
  'PUT /api/auth/password': 4096,
  'PUT /api/admin/users/:id/password': 4096,
  // Contact notes are a TEXT column
  'POST /api/contacts': 65536,
  'PUT /api/contacts/:id': 65536,
  'POST /api/contacts/import': 500000, // vCard import can be large
  // A contact selection: up to 5000 IDs of ~39 bytes each
  'POST /api/contacts/bulk-delete': 250000,
  'POST /api/contacts/bulk-update': 250000,
  'POST /api/recordings/uploads/:id/chunk': 1200 * 1024, // Recording chunks are base64 encoded JSON.
  // Chord sheets (metadata.chords, 10000 characters), a TEXT description and tags
  'PUT /api/recordings/:id': 262144,
  'POST /api/recordings/uploads/start': 50000,
  'POST /api/backup/import': BACKUP_UPLOAD_MAX_SIZE,
  'POST /api/mail/send': MAIL_COMPOSE_REQUEST_MAX_SIZE,
  'POST /api/mail/drafts': MAIL_COMPOSE_REQUEST_MAX_SIZE,
  'PUT /api/mail/drafts/:id': MAIL_COMPOSE_REQUEST_MAX_SIZE,
  // Calendar account metadata payloads
  'POST /api/calendar/accounts': 50000,
  'PUT /api/calendar/accounts/:id': 50000,
  'PUT /api/mail/accounts/:id/calendar': 50000,
  // Synced events can carry long descriptions
  'POST /api/calendar/events': 100000,
  'PUT /api/calendar/events/:id': 100000,
  // Mail account credentials and custom host metadata
  'POST /api/mail/accounts': 50000,
  'PUT /api/mail/accounts/:id': 50000,
  // Bulk operations and sync need more space (100 emails * ~36 chars UUID + JSON overhead)
  'POST /api/mail/emails/bulk-update': 50000,
  'POST /api/mail/emails/bulk-delete': 50000,
  'POST /api/mail/emails/bulk-move': 50000,
  'POST /api/mail/sync': 50000,
};
function bodyLimitFor(routeKey: string, pathname: string) {
  for (const [prefix, limit] of BODY_LIMIT_BY_PATH_PREFIX) if (pathname.startsWith(prefix)) return limit;
  return BODY_LIMIT_BY_ROUTE[routeKey] ?? DEFAULT_BODY_LIMIT;
}

const PUBLIC_ROUTE_KEYS = new Set([
  'GET /health',
  'GET /api/version',
  'GET /api/auth/signup-mode',
  'POST /api/auth/signup',
  'POST /api/auth/signin',
  'POST /api/auth/2fa/login',
  'GET /api/backup/export',
]);

function sanitizeHeaderFilename(filename: unknown) {
  const sanitized = String(filename || 'download')
    .replace(/[\r\n"\\]/g, '_')
    .replace(/[^\x20-\x7E]/g, '_')
    .trim();
  return sanitized || 'download';
}

function buildContentDisposition(dispositionType: unknown, filename: unknown) {
  const safeDispositionType = dispositionType === 'inline' ? 'inline' : 'attachment';
  const rawFilename = String(filename || 'download').replace(/[\r\n]/g, ' ').trim() || 'download';
  const safeFilename = sanitizeHeaderFilename(rawFilename);
  const encodedFilename = encodeURIComponent(rawFilename);
  return `${safeDispositionType}; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`;
}

function requestUrl(req: RouteRequest) {
  const host = req.headers.host;
  try {
    if (typeof host !== 'string' || !host || /[\s/\\?#@]/.test(host)) throw new Error();
    new URL(`http://${host}`);
    if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) throw new Error();
    // Routing does not depend on the client's Host value.
    return new URL(req.url, 'http://unihub.invalid');
  } catch {
    throw Object.assign(new Error('Invalid request address'), { status: 400 });
  }
}

// Enclose parsing, routing and headers as well as the asynchronous route body.
// A malformed request must never become an unhandled rejected HTTP callback.
async function handleRequest(req: RouteRequest, res: ServerResponse) {
  try {
    await dispatchRequest(req, res);
  } catch (error) {
    const response = clientError(error, 'Internal Server Error');
    if (response.status === 500) console.error('Request dispatch error:', req.method, (error as ApiError).message);
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(response));
  }
}

async function dispatchRequest(req: RouteRequest, res: ServerResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const url = requestUrl(req);
  // A path that matches no key keeps its own key and is a 404 below.
  const match = matchRoute(req.method!, url.pathname);
  const routeKey = match ? match.key : `${req.method} ${url.pathname}`;
  req.params = match ? match.params : {};

  // CORS headers
  const allowedOrigin = getAllowedOriginForRequest(req);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  // Every header the client sends: a browser drops a cross-origin request
  // whose preflight leaves one out, and mail changes then look lost.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, Idempotency-Key, X-Background-Sync');

  if (req.method === 'OPTIONS') {
    if (req.headers.origin && !allowedOrigin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origin not allowed' }));
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.headers.origin && !allowedOrigin) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return;
  }

  const handler = (routes as unknown as RouteTable)[routeKey];
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  let temporaryUploadPath: string | null = null;
  try {
    const userId = await verifyToken(req, { renew: true });
    if (userId) refreshSessionCookies(req, res);
    if (!userId && !PUBLIC_ROUTE_KEYS.has(routeKey)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized', status: 401 }));
      return;
    }

    // Validate CSRF token for authenticated state-changing requests
    if (userId && !validateCsrfToken(req, res)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'CSRF token validation failed', status: 403 }));
      return;
    }

    const moduleId = getModuleForPath(url.pathname);
    if (userId && moduleId && !await isModuleEnabled(userId, moduleId)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'This module is disabled. Enable it in Settings.', code: 'MODULE_DISABLED', module: moduleId }));
      return;
    }

    // Reject before parsing or spooling a potentially huge backup upload.
    if (DISABLED_BACKUP_ROUTES.has(routeKey)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: BACKUP_DISABLED_MESSAGE, status: 503 }));
      return;
    }

    if (userId && ['POST', 'PUT', 'DELETE'].includes(req.method!)) {
      const section = url.pathname === '/api/modules' ? 'settings' : getRestoreSectionForWrite(url.pathname);
      if (section) {
        const activeSections = await getActiveRestoreSections(userId);
        if ((section === '*' && activeSections.size > 0) || activeSections.has(section)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: `Restore in progress for ${section}. This section is temporarily read-only.`,
            code: 'RESTORE_IN_PROGRESS',
            status: 409,
          }));
          return;
        }
      }
    }

    const maxBodySize = bodyLimitFor(routeKey, url.pathname);
    if (isRequestBodyTooLarge(req, maxBodySize)) {
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: `Request body too large (max ${maxBodySize} bytes)` }));
      return;
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const expectsBackupUpload = routeKey === 'POST /api/backup/import'
      && (
        contentType.includes('application/zip')
        || contentType.includes('application/octet-stream')
        || contentType.includes('application/vnd.unihub.backup')
      );
    let body;
    if (expectsBackupUpload) {
      temporaryUploadPath = path.join(BACKUP_UPLOAD_ROOT, `${crypto.randomUUID()}.zip`);
      body = await parseRawBodyToFile(req, temporaryUploadPath, maxBodySize);
    } else {
      body = await parseBody(req, maxBodySize);
    }

    if (body === null) {
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: `Request body too large (max ${maxBodySize} bytes)` }), () => {
        req.destroy();
      });
      return;
    }

    const result = await handler(req, userId, body, res);

    // A streaming route (GET /api/events) has written and owns the response.
    if (result?.__handled === true) return;

    if (result.__redirect) {
      res.writeHead(302, { Location: result.__redirect });
      res.end();
      return;
    }

    if (Object.prototype.hasOwnProperty.call(result, '__html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(result.__html);
      return;
    }

    // Raw response (used by vCard export and attachments)
    if (result.__raw) {
      const filename = result.__filename || 'download';
      const dispositionType = result.__disposition === 'inline' ? 'inline' : 'attachment';
      const contentDisposition = buildContentDisposition(dispositionType, filename);

      res.writeHead(200, {
        'Content-Type': result.__contentType || 'application/octet-stream',
        'Content-Disposition': contentDisposition,
        'Cache-Control': 'no-cache',
      });
      res.end(result.__raw);
      return;
    }

    if (result.__streamPath) {
      const filename = result.__filename || 'download';
      const dispositionType = result.__disposition === 'inline' ? 'inline' : 'attachment';
      const contentDisposition = buildContentDisposition(dispositionType, filename);
      const contentLength = result.__contentLength === undefined || result.__contentLength === null
        ? null
        : Number(result.__contentLength);
      const headers: OutgoingHttpHeaders = {
        'Content-Type': result.__contentType || 'application/octet-stream',
        'Content-Disposition': contentDisposition,
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'bytes',
      };
      const validators = fileValidators(await fs.promises.stat(result.__streamPath).catch(() => null));
      if (validators) {
        headers.ETag = validators.etag;
        headers['Last-Modified'] = validators.lastModified;
      }

      let status = 200;
      let streamOptions: { start: number; end: number } | undefined;
      if (req.headers.range && Number.isSafeInteger(contentLength) && contentLength! > 0
        && rangeAllowed(req.headers['if-range'], validators)) {
        const range = parseSingleByteRange(req.headers.range, contentLength!);
        if (!range) {
          res.writeHead(416, {
            ...headers,
            'Content-Range': `bytes */${contentLength}`,
            'Content-Length': '0',
          });
          res.end();
          return;
        }
        status = 206;
        streamOptions = range;
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${contentLength}`;
        headers['Content-Length'] = String(range.end - range.start + 1);
      } else if (Number.isSafeInteger(contentLength) && contentLength! >= 0) {
        headers['Content-Length'] = String(contentLength);
      }
      res.writeHead(status, headers);
      const stream = fs.createReadStream(result.__streamPath, streamOptions);
      stream.on('error', (error) => {
        console.error('Stream response error:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end();
      });
      res.once('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }

    const status = result.status || 200;
    delete result.status;

    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (error) {
    // Error contract (docs/ARCHITECTURE.md, Request Handling): a thrown error
    // with a 4xx status answers with it; anything else is a generic 500 whose
    // text stays in the log, with the route but never the request body.
    const response = clientError(error, 'Internal Server Error');
    if (response.status === 500) console.error('Request error:', req.method, routeKey, error);
    if (!res.headersSent) res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  } finally {
    if (temporaryUploadPath) {
      await fs.promises.rm(temporaryUploadPath, { force: true }).catch(() => {});
    }
  }
}

// Start server

export {
  handleRequest,
  BODY_LIMIT_BY_ROUTE,
};
