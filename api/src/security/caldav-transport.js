const crypto = require('node:crypto');
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

// A credential scope is the origin the user's password may be sent to. Known
// providers that shard accounts across hosts (iCloud) add a host suffix, e.g.
// { origin: 'https://caldav.icloud.com', hostSuffixes: ['.icloud.com'] }.
function credentialScopeAllows(url, scope) {
  if (scope && typeof scope === 'object') {
    if (url.origin === parseCalDavUrl(scope.origin).origin) return true;
    return (scope.hostSuffixes || []).some(suffix => url.port === '' && url.hostname.toLowerCase().endsWith(String(suffix).toLowerCase()));
  }
  return url.origin === parseCalDavUrl(scope).origin;
}

function resolveCalDavUrl(value, base, credentialOrigin) {
  const url = parseCalDavUrl(value, base);
  if (!credentialScopeAllows(url, credentialOrigin)) {
    throw networkPolicyError('CalDAV returned a different server origin. Configure that server URL explicitly before sending it your credentials.');
  }
  return url.toString();
}

// Some servers (Baikal, older SabreDAV setups) only offer HTTP Digest. Node
// joins repeated WWW-Authenticate headers, so the Digest challenge is read
// from wherever it starts.
function parseDigestChallenge(header) {
  const value = [].concat(header || []).join(', ');
  const start = value.search(/(^|[\s,])digest\s/i);
  if (start < 0 || /(^|,\s*)basic(\s|,|$)/i.test(value)) return null;
  const params = {};
  for (const match of value.slice(start).replace(/^[\s,]*digest\s+/i, '').matchAll(/([a-z0-9_-]+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/gi)) {
    const name = match[1].toLowerCase();
    if (!(name in params)) params[name] = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3];
  }
  const algorithm = String(params.algorithm || 'MD5').toUpperCase();
  if (!params.nonce || params.realm === undefined || !['MD5', 'SHA-256'].includes(algorithm)) return null;
  const qops = params.qop ? params.qop.split(',').map(item => item.trim().toLowerCase()) : null;
  if (qops && !qops.includes('auth')) return null;
  return { realm: params.realm, nonce: params.nonce, opaque: params.opaque, algorithm, qop: qops ? 'auth' : null };
}

function digestAuthorization(challenge, { method, uri, username, password }) {
  const hash = value => crypto.createHash(challenge.algorithm === 'SHA-256' ? 'sha256' : 'md5').update(value).digest('hex');
  const quote = value => `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
  const cnonce = crypto.randomBytes(12).toString('hex');
  const nc = '00000001';
  const ha1 = hash(`${username}:${challenge.realm}:${password}`);
  const ha2 = hash(`${method}:${uri}`);
  const response = challenge.qop
    ? hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${challenge.qop}:${ha2}`)
    : hash(`${ha1}:${challenge.nonce}:${ha2}`);
  const parts = [`username=${quote(username)}`, `realm=${quote(challenge.realm)}`, `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(uri)}`, `algorithm=${challenge.algorithm}`, `response="${response}"`];
  if (challenge.opaque !== undefined) parts.push(`opaque=${quote(challenge.opaque)}`);
  if (challenge.qop) parts.push(`qop=${challenge.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

function requestOnce(url, target, { method, username, password, authorization, body, depth, signal, headers: extraHeaders, contentType, accept, anonymous }, request = https.request) {
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
        ...(anonymous ? {} : { Authorization: authorization || `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }),
        ...(depth == null ? {} : { Depth: depth }),
        ...(body ? { 'Content-Type': contentType || 'application/xml; charset=utf-8' } : {}),
        Accept: accept || 'application/xml,text/xml',
        'Accept-Encoding': 'identity',
        'User-Agent': 'UniHub-CalDAV',
        ...(extraHeaders || {}),
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
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const READ_METHODS = new Set(['PROPFIND', 'REPORT', 'GET', 'HEAD', 'OPTIONS']);

// anonymous: no credentials are sent, so redirects may cross origins (every hop
// is still HTTPS and checked against the outbound network policy). Discovery
// uses it to learn where a domain's /.well-known/caldav really points.
// acceptStatuses: non-2xx statuses returned to the caller instead of thrown.
async function davRequest(urlString, {
  method = 'PROPFIND', username, password, body, depth = ['PROPFIND', 'REPORT'].includes(method) ? '0' : null,
  credentialOrigin = urlString, headers, contentType, accept, anonymous = false, acceptStatuses = [], timeoutMs = DAV_TIMEOUT_MS, signal,
}, { request = https.request, resolveTarget = resolveMailConnectionTarget } = {}) {
  let current = anonymous ? parseCalDavUrl(urlString).toString() : resolveCalDavUrl(urlString, undefined, credentialOrigin);
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The caller's signal (account work stopped by a mail disconnect) stops the
  // request before it is sent. A read is also aborted while it waits; a sent
  // write is let finish, since the server may already have applied it and the
  // caller has to record that.
  const readOnly = READ_METHODS.has(method);
  const stop = () => controller.abort();
  if (readOnly) {
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', stop, { once: true });
  }
  const throwIfStopped = () => { signal?.throwIfAborted(); controller.signal.throwIfAborted(); };
  try {
    for (let redirects = 0; redirects <= MAX_DAV_REDIRECTS; redirects += 1) {
      throwIfStopped();
      const url = parseCalDavUrl(current);
      const target = await resolveTarget(url.hostname, { timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())) });
      throwIfStopped();
      const options = { method, username, password, body, depth, headers, contentType, accept, anonymous, signal: controller.signal };
      let response = await requestOnce(url, target, options, request);
      const challenge = response.status === 401 && !anonymous ? parseDigestChallenge(response.headers?.['www-authenticate']) : null;
      if (challenge) {
        throwIfStopped();
        const authorization = digestAuthorization(challenge, { method, uri: `${url.pathname}${url.search}`, username, password });
        response = await requestOnce(url, target, { ...options, authorization }, request);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.location || redirects === MAX_DAV_REDIRECTS) throw new Error('CalDAV redirect limit exceeded or redirect destination missing.');
        current = anonymous ? parseCalDavUrl(response.location, current).toString() : resolveCalDavUrl(response.location, current, credentialOrigin);
        continue;
      }
      if ((response.status < 200 || response.status >= 300) && !acceptStatuses.includes(response.status)) {
        const error = new Error(`CalDAV request failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      return { status: response.status, url: current, text: response.text, headers: response.headers || {} };
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

module.exports = { parseDigestChallenge, digestAuthorization, parseCalDavUrl, resolveCalDavUrl, credentialScopeAllows, davRequest, MAX_DAV_RESPONSE_BYTES };
