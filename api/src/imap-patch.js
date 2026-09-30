// Patch underlying 'imap' so connection errors never crash the process (e.g. ECONNRESET during TLS).
// imap-simple can emit 'error' on the connection before connect() promise resolves, causing unhandled crash.
// We must copy static methods (e.g. parseHeader) from OriginalImap so imap-simple's getMessage() works.
try {
  const imapPath = require.resolve('imap');
  require(imapPath);
  const OriginalImap = require.cache[imapPath].exports;
  const PatchedImap = function (config) {
    OriginalImap.apply(this, arguments);
    this.on('error', (err) => {
      console.error('[IMAP] Connection error (caught):', err.message);
    });
  };
  PatchedImap.prototype = Object.create(OriginalImap.prototype);
  PatchedImap.prototype.constructor = PatchedImap;
  // Copy static methods (e.g. parseHeader) so imap-simple's getMessage.js can call Imap.parseHeader()
  Object.getOwnPropertyNames(OriginalImap).forEach((key) => {
    if (key !== 'prototype' && key !== 'length' && key !== 'name' && typeof OriginalImap[key] === 'function') {
      PatchedImap[key] = OriginalImap[key];
    }
  });
  require.cache[imapPath].exports = PatchedImap;
} catch (e) {
  console.warn('[IMAP] Could not patch imap module:', e.message);
}
