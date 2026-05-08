const { ALLOWED_ORIGINS } = require('../config');

// Parse JSON body (configurable max size, default 1000 chars)
async function parseBody(req, maxSize = 1000) {
  return new Promise((resolve) => {
    let body = '';
    let currentSize = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      currentSize += chunk.length;
      if (currentSize > maxSize) {
        tooLarge = true;
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (tooLarge || body.length > maxSize) { resolve(null); return; }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => {
      resolve(null);
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
