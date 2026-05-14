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
  getAllowedOriginForRequest,
};
