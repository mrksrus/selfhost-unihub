import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { RouteRequest } from './types';
import type { RouteTable } from './http/route';

import { BACKUP_DISABLED_MESSAGE, DISABLED_BACKUP_ROUTES } from './services/backup-availability';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import routes = require('./routes');
import { verifyToken, validateCsrfToken, refreshSessionCookies, isAdmin } from './auth';
import {
  parseBody,
  parseRawBodyToFile,
  getAllowedOriginForRequest,
  isRequestBodyTooLarge,
} from './http/request';
import { parseSingleByteRange, fileValidators, rangeAllowed } from './http/range';
import { clientError } from './http/errors';
import { log, newRequestId, withRequestId } from './log';
import { compileRouteMatcher } from './http/route-matcher';
import { DEFAULT_BODY_LIMIT } from './http/route';
import { isModuleEnabled } from './services/module-settings';
import { getActiveRestoreSections } from './services/restore-locks';

// Every route is a spec (http/route.ts); the boundary reads policy from it and
// nothing else. Bodies are untrusted at dispatch; each route keeps its validation.
const routeTable = routes as RouteTable;

const BACKUP_UPLOAD_ROOT = '/app/uploads/backups/imports';
// Compiled once from the route table: every key with a :param segment becomes a
// segment matcher, so adding a route needs no change here.
const matchRoute = compileRouteMatcher(Object.keys(routeTable));

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
// Every request gets an id: the X-Request-Id response header, the body of a
// 500 (so a person can report it) and every log line written while it runs.
async function handleRequest(req: RouteRequest, res: ServerResponse) {
  const requestId = newRequestId();
  res.setHeader('X-Request-Id', requestId);
  return withRequestId(requestId, async () => {
    try {
      await dispatchRequest(req, res);
    } catch (error) {
      const response = clientError(error, 'Internal Server Error');
      if (response.status === 500) log.error('HTTP', 'Request dispatch failed', error, { method: req.method });
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(response.status >= 500 ? { ...response, requestId } : response));
    }
  });
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

  const spec = routeTable[routeKey];
  if (!spec) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  let temporaryUploadPath: string | null = null;
  try {
    const userId = await verifyToken(req, { renew: true });
    if (userId) refreshSessionCookies(req, res);
    if (!userId && spec.auth !== 'public') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized', status: 401 }));
      return;
    }

    // Validate CSRF token for authenticated state-changing requests
    if (userId && !validateCsrfToken(req, spec.csrf)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'CSRF token validation failed', status: 403 }));
      return;
    }

    if (spec.auth === 'admin' && !(await isAdmin(userId))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden', status: 403 }));
      return;
    }

    if (userId && spec.module && !await isModuleEnabled(userId, spec.module)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'This module is disabled. Enable it in Settings.', code: 'MODULE_DISABLED', module: spec.module }));
      return;
    }

    // Reject before parsing or spooling a potentially huge backup upload.
    if (DISABLED_BACKUP_ROUTES.has(routeKey)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: BACKUP_DISABLED_MESSAGE, status: 503 }));
      return;
    }

    const section = spec.restoreSection;
    if (userId && section) {
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

    const maxBodySize = spec.body?.limit ?? DEFAULT_BODY_LIMIT;
    if (isRequestBodyTooLarge(req, maxBodySize)) {
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: `Request body too large (max ${maxBodySize} bytes)` }));
      return;
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const expectsBackupUpload = spec.body?.kind === 'backup-upload'
      && (
        contentType.includes('application/zip')
        || contentType.includes('application/octet-stream')
        || contentType.includes('application/vnd.unihub.backup')
      );
    let body: unknown;
    if (spec.body?.kind === 'none') {
      body = undefined;
    } else if (expectsBackupUpload) {
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

    const result = spec.auth === 'public'
      ? await spec.handler(req, userId ?? null, body, res)
      : await spec.handler(req, userId!, body, res);

    // A streaming route (GET /api/events, the Android notification stream) has
    // written and owns the response; only a refusal before that is serialized.
    if (spec.response === 'stream' && (result === undefined || res.headersSent)) return;
    if (!result) throw new Error('Route returned no response');

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
        log.error('HTTP', 'Stream response failed', error, { route: routeKey });
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
    res.end(JSON.stringify(status >= 500 ? { ...result, requestId: res.getHeader('X-Request-Id') } : result));
  } catch (error) {
    // Error contract (docs/ARCHITECTURE.md, Request Handling): a thrown error
    // with a 4xx status answers with it; anything else is a generic 500 whose
    // text stays in the log, with the route but never the request body.
    const response = clientError(error, 'Internal Server Error');
    if (response.status === 500) log.error('HTTP', 'Request failed', error, { route: routeKey });
    if (!res.headersSent) res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response.status >= 500 ? { ...response, requestId: res.getHeader('X-Request-Id') } : response));
  } finally {
    if (temporaryUploadPath) {
      await fs.promises.rm(temporaryUploadPath, { force: true }).catch(() => {});
    }
  }
}

export {
  handleRequest,
};
