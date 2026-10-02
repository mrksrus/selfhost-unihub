'use strict';
// The only place that constructs ImapFlow clients. Callers keep building the
// transport-neutral { imap: {...} } config in mail-host-policy.js (pinned IP,
// TLS hostname, trust decision); this module only translates it. Tests replace
// connectImap through this module object, never the library.
const { ImapFlow } = require('imapflow');

// Raw messages are capped at 50 MiB (mail-engine/transport.js), the largest
// message Gmail accepts. ImapFlow checks a literal's announced size before
// buffering it, so a larger body fails the connection instead of being read
// into memory.
const MAX_LITERAL_BYTES = 50 * 1024 * 1024;
const MAX_RESPONSE_BYTES = MAX_LITERAL_BYTES + 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
// A keepalive session may sit parked or between commands for a while; its
// stalled commands are bounded by the per-command guard deadline instead.
const KEEPALIVE_SOCKET_TIMEOUT_MS = 5 * 60 * 1000;

function positive(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

// transport, mail-imap-guard and connection-pool rely on these library
// internals (exec, close semantics, mailbox state); fail closed on an
// incompatible major version rather than guessing.
function assertSupportedLibrary() {
  if (!/^2\./.test(String(ImapFlow.version || '')) || typeof ImapFlow.prototype.exec !== 'function') {
    throw new Error('Unsupported ImapFlow protocol boundary');
  }
}

function imapFlowOptions(config) {
  const imap = config?.imap;
  if (!imap || typeof imap !== 'object') throw new TypeError('IMAP connection config is required');
  const tls = { ...(imap.tlsOptions || {}) };
  if (!tls.servername) delete tls.servername;
  const socketTimeout = positive(imap.socketTimeout, 60000);
  // An IDLE session (mail-idle.js) re-issues IDLE every maxIdleTime itself; the
  // socket watchdog only has to catch a peer that went silent for longer.
  const idleMs = positive(imap.idleRestartMs, 0);
  return {
    host: imap.host,
    port: Number(imap.port) || 993,
    secure: imap.tls !== false,
    // Plain TCP only exists for loopback test peers; never upgrade implicitly.
    ...(imap.tls === false ? { doSTARTTLS: false } : {}),
    // Connect to the pinned address but verify the certificate (and send SNI)
    // for the account's hostname, exactly as the previous node-imap config did.
    ...(tls.servername ? { servername: tls.servername } : {}),
    tls,
    auth: { user: imap.user, pass: imap.password },
    connectionTimeout: positive(imap.connTimeout, 60000),
    greetingTimeout: positive(imap.authTimeout, 30000),
    socketTimeout: idleMs ? idleMs + 60 * 1000
      : imap.keepalive ? Math.max(socketTimeout, KEEPALIVE_SOCKET_TIMEOUT_MS) : socketTimeout,
    ...(idleMs ? { maxIdleTime: idleMs } : {}),
    // Never log protocol traffic: it carries credentials and message content.
    logger: false,
    logRaw: false,
    emitLogs: false,
    // No background IDLE/NOOP between our own commands and no COMPRESS: the
    // command stream on the wire is exactly what the mail engine issues. The
    // IDLE supervisor calls idle() explicitly on its own dedicated session.
    disableAutoIdle: true,
    disableCompression: true,
    maxLiteralSize: MAX_LITERAL_BYTES,
    maxResponseSize: MAX_RESPONSE_BYTES,
    maxLineLength: MAX_LINE_BYTES,
  };
}

function connectTimeoutError() {
  return Object.assign(new Error('IMAP connect/authentication timeout'), { code: 'MAIL_IMAP_TIMEOUT' });
}

// Resolves with an authenticated client. The whole setup (TCP, TLS, greeting,
// LOGIN, capability negotiation) is bounded by connTimeout + authTimeout, like
// node-imap's separate connect and authentication timers.
async function connectImap(config) {
  assertSupportedLibrary();
  const options = imapFlowOptions(config);
  const client = new ImapFlow(options);
  // Connection-level failures are surfaced to the guard and to the pending
  // command; an unlistened 'error' event would crash the process.
  client.on('error', () => {});
  let timer, timedOut = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { client.close(); } catch { /* already closed */ }
      reject(connectTimeoutError());
    }, options.connectionTimeout + options.greetingTimeout);
  });
  try {
    await Promise.race([client.connect(), deadline]);
  } catch (error) {
    try { client.close(); } catch { /* already closed */ }
    throw timedOut ? connectTimeoutError() : error;
  } finally {
    clearTimeout(timer);
    deadline.catch(() => {});
  }
  return client;
}

module.exports = { connectImap, imapFlowOptions, MAX_LITERAL_BYTES };
