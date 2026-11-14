import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { RouteRequest } from './types';
import type { RouteSpec, RouteTable, UploadBody } from './http/route';

import { BACKUP_DISABLED_MESSAGE, DISABLED_BACKUP_ROUTES } from './services/backup-availability';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import routes = require('./routes');
import { verifyToken, validateCsrfToken, refreshSessionCookies, hasPermission } from './auth';
import {
  parseBody,
  parseRawBodyToFile,
  uploadSpoolRoot,
  sweepStaleSpoolOnce,
  getAllowedOriginForRequest,
  isRequestBodyTooLarge,
} from './http/request';
import { parseSingleByteRange, fileValidators, rangeAllowed } from './http/range';
import { clientError } from './http/errors';
import { log, newRequestId, withRequestId } from './log';
import { compileRouteMatcher } from './http/route-matcher';
import { DEFAULT_BODY_LIMIT, routePolicies } from './http/route';
import { getUserModules } from './services/module-settings';
import { getActiveRestoreSections } from './services/restore-locks';
import { assertAllowed, resolvePolicy, withRequestPolicies } from './services/settings';
import { appLockRefusal } from './services/devices';
import { twoFactorRequirement } from './services/sign-in-policies';
import { buildContentDisposition } from './http/content-disposition';
import { BACKUP_IMPORTS_ROOT } from './services/export-jobs';

// Every route is a spec (http/route.ts); the boundary reads policy from it and
// nothing else. Bodies are untrusted at dispatch; each route keeps its validation.
const routeTable = routes as RouteTable;

const BACKUP_UPLOAD_ROOT = BACKUP_IMPORTS_ROOT;
// Compiled once from the route table: every key with a :param segment becomes a
// segment matcher, so adding a route needs no change here.
const matchRoute = compileRouteMatcher(Object.keys(routeTable));

// The routes the compliance gates leave open (http/route.ts gates);
// 'background-sync' ones to the Android app's own contacts sync only, which
// sends the header on every request.
function gatesExempt(spec: RouteSpec, req: RouteRequest) {
  return spec.gates === 'exempt' || (spec.gates === 'background-sync' && req.headers['x-background-sync'] === '1');
}

// If-None-Match compares weakly (RFC 9110): W/"x" matches "x", and * matches any.
function etagMatches(header: string | undefined, etag: string) {
  if (!header) return false;
  return header.split(',').some(tag => { const value = tag.trim(); return value === '*' || value.replace(/^W\//, '') === etag; });
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

interface Refusal { status: number; body: Record<string, unknown> }

// The gates after sign-in, CSRF and permission, in order, before the body is
// read and before any side effect: the first refusal answers the request.
async function gateRefusal(spec: RouteSpec, req: RouteRequest, routeKey: string, url: URL, userId: string | null): Promise<Refusal | null> {
  if (userId && spec.module) {
    // A module the person switched off, or one an administrator's policy
    // forbids them (0.30: with the policy and its reason in details).
    const module = (await getUserModules(userId)).find(entry => entry.id === spec.module);
    if (!module?.enabled) {
      const policy = module?.policy;
      return { status: 403, body: { error: policy?.reason ?? 'This module is disabled. Enable it in Settings.', code: 'MODULE_DISABLED', module: spec.module,
        ...(policy ? { details: { policy: policy.key, reason: policy.reason } } : {}) } };
    }
    // Phone contacts forbidden (0.30): the Android app's contacts sync is
    // told the module is off, and every app in the support window then
    // removes UniHub's contacts from the phone (it treats the listing as
    // gone); the same routes keep working for the page.
    if (spec.module === 'contacts' && req.headers['x-background-sync'] === '1') {
      const phoneSync = await resolvePolicy(userId, 'contacts.phone_sync');
      if (!phoneSync.allowed) {
        return { status: 403, body: { error: phoneSync.reason, code: 'MODULE_DISABLED', module: 'contacts', details: { policy: 'contacts.phone_sync', reason: phoneSync.reason } } };
      }
    }
  }

  // Reject before parsing or spooling a potentially huge backup upload.
  if (DISABLED_BACKUP_ROUTES.has(routeKey)) return { status: 503, body: { error: BACKUP_DISABLED_MESSAGE, status: 503 } };

  const section = spec.restoreSection;
  if (userId && section) {
    const activeSections = await getActiveRestoreSections(userId);
    if ((section === '*' && activeSections.size > 0) || activeSections.has(section)) {
      return { status: 409, body: {
        error: `Restore in progress for ${section}. This section is temporarily read-only.`,
        code: 'RESTORE_IN_PROGRESS',
        status: 409,
      } };
    }
  }

  // F13: a data-safety policy that forbids the person this route's action
  // refuses it with 403 POLICY_FORBIDS and its plain reason.
  const policies = routePolicies(spec, url.searchParams);
  if (userId && policies.length) await assertAllowed(userId, policies);

  // The app lock (0.29): a device short of the lock the person's policies
  // require is refused the locked parts with 403 APP_LOCK_REQUIRED and the
  // administrator's reason, administrators included on their own devices.
  // Exempt routes (http/route.ts gates) stay open; with no requirement
  // nothing changes.
  if (userId && spec.auth !== 'public' && !gatesExempt(spec, req)) {
    const modules = [spec.module, ...spec.appLockModules ?? []].filter((module): module is string => !!module);
    const refusal = await appLockRefusal(userId, req.sessionDeviceId ?? null, modules);
    if (refusal) {
      return { status: 403, body: {
        error: refusal.reason ?? 'Your administrator requires the app lock on this device.',
        code: 'APP_LOCK_REQUIRED',
        status: 403,
        details: refusal,
      } };
    }

    // Two-factor authentication required (0.30, auth.two_factor): a person
    // without it gets 7 days from the first time this gate (or a policy save)
    // finds the rule applying to them; after that every route that is not
    // exempt answers 403 TWO_FACTOR_REQUIRED, administrators included.
    const { refused } = await twoFactorRequirement(userId, req.twoFactor ?? null);
    if (refused) return { status: 403, body: { error: refused.reason, code: 'TWO_FACTOR_REQUIRED', status: 403, details: refused } };
  }
  return null;
}

// The checks before a route runs, in order: the session, CSRF, the
// permission, then the gates. Writes the refusal and answers null, or
// answers the signed-in person (null for a public route without one).
async function admit(spec: RouteSpec, req: RouteRequest, res: ServerResponse, routeKey: string, url: URL): Promise<{ userId: string | null } | null> {
  const userId = (await verifyToken(req, { renew: true })) ?? null;
  if (userId) refreshSessionCookies(req, res);
  if (!userId && spec.auth !== 'public') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized', status: 401 }));
    return null;
  }

  // Validate CSRF token for authenticated state-changing requests
  if (userId && !validateCsrfToken(req, spec.csrf)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'CSRF token validation failed', status: 403 }));
    return null;
  }

  if (spec.auth === 'admin' && !(await hasPermission(userId, spec.permission!))) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden', status: 403 }));
    return null;
  }

  const refusal = await gateRefusal(spec, req, routeKey, url, userId);
  if (refusal) {
    res.writeHead(refusal.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(refusal.body));
    return null;
  }
  return { userId };
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
    // Sign-in, CSRF, permission and the gates, with the person's rules read
    // once for all of them (settings.ts withRequestPolicies); null when one
    // of them answered. The route runs outside, with fresh reads.
    const admitted = await withRequestPolicies(() => admit(spec, req, res, routeKey, url));
    if (!admitted) return;
    const { userId } = admitted;

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
    } else if (spec.body?.kind === 'upload') {
      const root = uploadSpoolRoot();
      await sweepStaleSpoolOnce(root);
      temporaryUploadPath = path.join(root, `${crypto.randomUUID()}.upload`);
      const spooled = await parseRawBodyToFile(req, temporaryUploadPath, maxBodySize);
      if (spooled && spooled.size === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'The upload is empty.', code: 'UPLOAD_EMPTY', status: 400 }));
        return;
      }
      const rawType = req.headers['content-type'];
      const contentType = typeof rawType === 'string' ? rawType.trim() : '';
      body = spooled && ({ path: spooled.filePath, size: spooled.size, contentType,
        mediaType: contentType.split(';')[0].trim().toLowerCase() } satisfies UploadBody);
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

      const headers: OutgoingHttpHeaders = { 'Cache-Control': 'no-cache', ...result.__headers };
      if (result.__etag) {
        headers.ETag = `"${result.__etag}"`;
        if (etagMatches(req.headers['if-none-match'], headers.ETag)) {
          res.writeHead(304, headers);
          res.end();
          return;
        }
      }
      res.writeHead(200, {
        'Content-Type': result.__contentType || 'application/octet-stream',
        'Content-Disposition': contentDisposition,
        ...headers,
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
      const ranges = result.__ranges !== false;
      const headers: OutgoingHttpHeaders = {
        'Content-Type': result.__contentType || 'application/octet-stream',
        'Content-Disposition': contentDisposition,
        'Cache-Control': 'no-cache',
        'Accept-Ranges': ranges ? 'bytes' : 'none',
        ...result.__headers,
      };
      const validators = ranges ? fileValidators(await fs.promises.stat(result.__streamPath).catch(() => null)) : null;
      if (validators) {
        headers.ETag = validators.etag;
        headers['Last-Modified'] = validators.lastModified;
      }

      let status = 200;
      let streamOptions: { start: number; end: number } | undefined;
      if (ranges && req.headers.range && Number.isSafeInteger(contentLength) && contentLength! > 0
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
