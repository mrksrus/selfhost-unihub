const https = require('node:https');
const net = require('node:net');
const { resolveMailConnectionTarget, networkPolicyError } = require('./outbound-network');

const MAX_DAV_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_DAV_REDIRECTS = 5;
const DAV_TIMEOUT_MS = 20000;

function parseCalDavUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw networkPolicyError('CalDAV URL is invalid.'); }
  if (url.protocol !== 'https:') throw networkPolicyError('CalDAV URL must use HTTPS.');
  if (url.username || url.password) throw networkPolicyError('CalDAV URL must not contain credentials.');
  url.hash = '';
  return url;
}

function resolveCalDavUrl(value, base, credentialOrigin) {
  const url = parseCalDavUrl(value, base);
  if (url.origin !== parseCalDavUrl(credentialOrigin).origin) {
    throw networkPolicyError('CalDAV returned a different server origin. Configure that server URL explicitly before sending it your credentials.');
  }
  return url.toString();
}

function requestOnce(url, target, { method, username, password, body, depth, signal }, request = https.request) {
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: 'https:',
      hostname: target.address,
      family: target.family,
      port: Number(url.port) || 443,
      path: `${url.pathname}${url.search}`,
      method,
      // A fresh connection to the checked literal IP cannot re-resolve DNS or
      // accidentally reuse a socket from an earlier host/policy decision.
      agent: false,
      servername: net.isIP(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: true,
      signal,
      maxHeaderSize: 32 * 1024,
      headers: {
        Host: url.host,
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        Depth: depth,
        'Content-Type': 'application/xml; charset=utf-8',
        Accept: 'application/xml,text/xml',
        'Accept-Encoding': 'identity',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, response => {
      const chunks = [];
      let size = 0;
      const fail = error => { reject(error); response.destroy(); req.destroy(); };
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('CalDAV response ended unexpectedly.')));
      if (Number(response.headers['content-length']) > MAX_DAV_RESPONSE_BYTES) {
        fail(new Error('CalDAV response exceeds the 16 MiB limit.'));
        return;
      }
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_DAV_RESPONSE_BYTES) return fail(new Error('CalDAV response exceeds the 16 MiB limit.'));
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode,
        location: response.headers.location,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function davRequest(urlString, {
  method = 'PROPFIND', username, password, body, depth = '0', credentialOrigin = urlString,
}, { request = https.request, resolveTarget = resolveMailConnectionTarget } = {}) {
  let current = resolveCalDavUrl(urlString, undefined, credentialOrigin);
  const controller = new AbortController();
  const deadline = Date.now() + DAV_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), DAV_TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= MAX_DAV_REDIRECTS; redirects += 1) {
      controller.signal.throwIfAborted();
      const url = parseCalDavUrl(current);
      const target = await resolveTarget(url.hostname, { timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())) });
      controller.signal.throwIfAborted();
      const response = await requestOnce(url, target, { method, username, password, body, depth, signal: controller.signal }, request);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.location || redirects === MAX_DAV_REDIRECTS) throw new Error('CalDAV redirect limit exceeded or redirect destination missing.');
        current = resolveCalDavUrl(response.location, current, credentialOrigin);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        const error = new Error(`CalDAV request failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      return { status: response.status, url: current, text: response.text };
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { parseCalDavUrl, resolveCalDavUrl, davRequest, MAX_DAV_RESPONSE_BYTES };
