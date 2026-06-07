const fs = require('fs');
const path = require('path');
const { ALLOWED_ORIGINS } = require('../config');

function getRequestContentLength(req) {
  const rawLength = req.headers['content-length'];
  if (rawLength === undefined) return null;
  const value = Number.parseInt(String(rawLength), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function isRequestBodyTooLarge(req, maxSize) {
  const contentLength = getRequestContentLength(req);
  return contentLength !== null && contentLength > maxSize;
}

// Parse JSON body (configurable max size, default 1000 chars)
async function parseBody(req, maxSize = 1000) {
  return new Promise((resolve) => {
    let body = '';
    let currentSize = 0;
    let tooLarge = false;
    let settled = false;

    const settle = (value) => {
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
      body += chunk.toString();
    });
    req.on('end', () => {
      if (settled) return;
      if (tooLarge || body.length > maxSize) { settle(null); return; }
      try {
        settle(body ? JSON.parse(body) : {});
      } catch {
        settle({});
      }
    });
    req.on('error', () => {
      settle(null);
    });
  });
}

async function parseRawBody(req, maxSize = 1000) {
  return new Promise((resolve) => {
    const chunks = [];
    let currentSize = 0;
    let tooLarge = false;
    let settled = false;

    const settle = (value) => {
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

async function parseRawBodyToFile(req, targetPath, maxSize) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

  return new Promise((resolve) => {
    const output = fs.createWriteStream(targetPath, { flags: 'wx', mode: 0o600 });
    let currentSize = 0;
    let settled = false;
    let failing = false;

    const cleanupPartialFile = async () => {
      output.destroy();
      await fs.promises.rm(targetPath, { force: true }).catch(() => {});
    };
    const settle = (value) => {
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
    req.on('end', () => {
      if (!settled) output.end();
    });
    req.on('aborted', fail);
    req.on('error', fail);
    output.on('error', () => {
      fail();
    });
    output.on('finish', () => {
      if (!failing) settle({ filePath: targetPath, size: currentSize });
    });
  });
}

function getAllowedOriginForRequest(req) {
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

module.exports = {
  getRequestContentLength,
  isRequestBodyTooLarge,
  parseBody,
  parseRawBody,
  parseRawBodyToFile,
  getAllowedOriginForRequest,
};
