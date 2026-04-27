const { ALLOWED_ORIGINS } = require('../config');

// Parse JSON body (configurable max size, default 1000 chars)
async function parseBody(req, maxSize = 1000) {
  return new Promise((resolve) => {
    let body = '';
    let currentSize = 0;
    let resolved = false;
    req.on('data', chunk => {
      if (resolved) return;
      currentSize += chunk.length;
      if (currentSize > maxSize) {
        resolved = true;
        resolve(null);
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (resolved) return;
      if (body.length > maxSize) { resolve(null); return; }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => {
      if (!resolved) resolve(null);
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
  parseBody,
  getAllowedOriginForRequest,
};
