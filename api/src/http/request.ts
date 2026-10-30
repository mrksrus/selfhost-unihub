import type { IncomingMessage } from 'node:http';
import fs from 'fs';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { ALLOWED_ORIGINS } from '../config';

function getRequestContentLength(req: IncomingMessage) {
  const rawLength = req.headers['content-length'];
  if (rawLength === undefined) return null;
  const value = Number.parseInt(String(rawLength), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function isRequestBodyTooLarge(req: IncomingMessage, maxSize: number) {
  const contentLength = getRequestContentLength(req);
  return contentLength !== null && contentLength > maxSize;
}

// Parse JSON body (configurable max size, default 1000 chars)
async function parseBody(req: IncomingMessage, maxSize = 1000) {
  return new Promise<unknown>((resolve, reject) => {
    let body = '';
    const decoder = new StringDecoder('utf8');
    let currentSize = 0;
    let tooLarge = false;
    let settled = false;

    const settle = (value: unknown) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on('data', chunk => {
      if (settled || tooLarge) return;
      currentSize += chunk.length;
      if (currentSize > maxSize) {
        tooLarge = true;
        body = '';
        req.pause();
        settle(null);
        return;
      }
      body += decoder.write(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      body += decoder.end();
      if (tooLarge || body.length > maxSize) { settle(null); return; }
      try {
        settle(body ? JSON.parse(body) : {});
      } catch {
        settled = true;
        reject(Object.assign(new Error('Invalid JSON request body'), { status: 400 }));
      }
    });
    req.on('error', () => {
      settle(null);
    });
  });
}

async function parseRawBody(req: IncomingMessage, maxSize = 1000) {
  return new Promise<Buffer | null>((resolve) => {
    const chunks: Buffer[] = [];
    let currentSize = 0;
    let tooLarge = false;
    let settled = false;

    const settle = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on('data', chunk => {
      if (settled || tooLarge) return;
      currentSize += chunk.length;
      if (currentSize > maxSize) {
        tooLarge = true;
        req.pause();
        settle(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      if (tooLarge || currentSize > maxSize) { settle(null); return; }
      settle(Buffer.concat(chunks));
    });
    req.on('error', () => {
      settle(null);
    });
  });
}

async function parseRawBodyToFile(req: IncomingMessage, targetPath: string, maxSize: number) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

  return new Promise<{ filePath: string; size: number } | null>((resolve) => {
    const output = fs.createWriteStream(targetPath, { flags: 'wx', mode: 0o600 });
    let currentSize = 0;
    let settled = false;
    let failing = false;

    const cleanupPartialFile = async () => {
      output.destroy();
      await fs.promises.rm(targetPath, { force: true }).catch(() => {});
    };
    const settle = (value: { filePath: string; size: number } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = () => {
      if (settled || failing) return;
      failing = true;
      req.pause();
      cleanupPartialFile().finally(() => settle(null));
    };

    req.on('data', chunk => {
      if (settled) return;
      currentSize += chunk.length;
      if (currentSize > maxSize) {
        fail();
        return;
      }
      if (!output.write(chunk)) {
        req.pause();
        output.once('drain', () => {
          if (!settled) req.resume();
        });
      }
    });
    let ended = false;
    req.on('end', () => {
      ended = true;
      if (!settled) output.end();
    });
    req.on('aborted', fail);
    req.on('error', fail);
    // A client that disconnects mid-body may produce neither 'aborted' nor
    // 'error'; the partial file must still go and the request must settle.
    req.on('close', () => { if (!ended) fail(); });
    output.on('error', () => {
      fail();
    });
    output.on('finish', () => {
      if (!failing) settle({ filePath: targetPath, size: currentSize });
    });
  });
}

// Raw uploads (route body kind 'upload') are spooled here, on the uploads
// volume, so a handler can rename a kept file without copying it.
function uploadSpoolRoot() {
  return path.resolve(process.env.UPLOAD_SPOOL_ROOT || '/app/uploads/spool');
}

const STALE_SPOOL_AGE_MS = 60 * 60 * 1000;
let spoolSwept = false;

// Spool files outlive their request only when the process died while one ran.
// The first upload of a process removes those older than an hour; no request
// holds a spool file that long (the body limits and handler time limits are far shorter).
async function sweepStaleSpoolOnce(root = uploadSpoolRoot()) {
  if (spoolSwept) return;
  spoolSwept = true;
  await sweepStaleSpool(root, Date.now());
}

async function sweepStaleSpool(root: string, now: number) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.upload')) continue;
    const target = path.join(root, entry.name);
    const stat = await fs.promises.lstat(target).catch(() => null);
    if (stat && now - stat.mtimeMs > STALE_SPOOL_AGE_MS) await fs.promises.rm(target, { force: true }).catch(() => {});
  }
}

function getAllowedOriginForRequest(req: IncomingMessage) {
  const requestOrigin = req.headers.origin;
  if (!requestOrigin) return null;

  if (ALLOWED_ORIGINS.length > 0) {
    return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : null;
  }

  const host = req.headers.host;
  if (!host) return null;
  const sameHostOrigins = new Set([`http://${host}`, `https://${host}`]);
  return sameHostOrigins.has(requestOrigin) ? requestOrigin : null;
}

export {
  getRequestContentLength,
  isRequestBodyTooLarge,
  parseBody,
  parseRawBody,
  parseRawBodyToFile,
  uploadSpoolRoot,
  sweepStaleSpool,
  sweepStaleSpoolOnce,
  getAllowedOriginForRequest,
};
