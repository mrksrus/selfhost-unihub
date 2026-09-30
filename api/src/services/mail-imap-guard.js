// Bound individual network waits, not the whole import. imap-simple does not
// reject every outstanding command when its socket closes. Merely racing the
// whole worker would release its account lock while its continuation can write.
const { installConditionalStore } = require('./mail-imap-conditional-store');
const IMAP_COMMAND_TIMEOUT_MS = 120000;
const guards = new WeakMap();

// Wrapping is installed once per transport. A pooled transport handed to the
// next job is rebound to that job's signal; the previous listener is removed.
function guardImapConnection(connection, { signal, timeoutMs = IMAP_COMMAND_TIMEOUT_MS } = {}) {
  const existing = guards.get(connection);
  if (existing) { existing.bind(signal); return connection; }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new TypeError('Invalid IMAP command deadline');
  installConditionalStore(connection.imap);
  const pending = new Set();
  let stopped = null, bound = null;
  const abortError = () => Object.assign(new Error('Mail sync cancelled; completed messages are retained.'), { code: 'MAIL_SYNC_CANCELLED' });
  const onAbort = () => stop(abortError());
  function bind(next) {
    if (stopped) return;
    bound?.removeEventListener('abort', onAbort);
    bound = next || null;
    bound?.addEventListener('abort', onAbort, { once: true });
    if (bound?.aborted) onAbort();
  }
  function stop(error) {
    if (stopped) return;
    stopped = error;
    bound?.removeEventListener('abort', onAbort);
    // Destroy, not LOGOUT: end() queues behind the very command that stalled.
    // Mark terminal first so neither late replies nor error events can dispatch
    // another command. Reject only the network waits; the worker still unwinds
    // and settles durable writeback outcomes while holding its account lock.
    // node-imap's destroy() only calls socket.end(), which can still leave a
    // half-open socket waiting on the peer. Hard-close it before clearing the
    // protocol queue so late data cannot be handled as a new command reply.
    try { connection.imap._sock?.destroy(); } catch { /* already disconnected */ }
    try { connection.imap.destroy(); } catch { /* already disconnected */ }
    for (const reject of [...pending]) reject(stopped);
  }
  function run(start) {
    if (stopped) return Promise.reject(stopped);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        if (error || stopped) reject(error || stopped); else resolve(result);
      };
      const cancel = error => finish(error);
      const timer = setTimeout(() => stop(Object.assign(new Error('IMAP command timeout; reconnect before retrying.'), { code: 'MAIL_IMAP_TIMEOUT' })), timeoutMs);
      pending.add(cancel);
      try { start(finish); } catch (error) { finish(error); }
    });
  }
  // Streaming FETCH has no callback wrapper; share this connection's deadline.
  guards.set(connection, { run, bind, get stopped() { return !!stopped; }, get pending() { return pending.size; } });
  for (const method of ['getBoxes', 'openBox', 'search']) {
    if (typeof connection[method] !== 'function') continue;
    const original = connection[method].bind(connection);
    connection[method] = (...args) => run(done => {
      Promise.resolve(original(...args)).then(value => done(null, value), done);
    });
  }
  // These callback commands are the only remote mutations used by writebacks.
  for (const method of ['addFlags', 'delFlags', 'addFlagsSince', 'delFlagsSince', 'move']) {
    if (typeof connection.imap[method] !== 'function') continue;
    const original = connection.imap[method].bind(connection.imap);
    connection.imap[method] = (...args) => {
      const callback = args.pop();
      run(done => original(...args, done)).then(value => callback(null, value), callback);
    };
  }
  connection.on('error', stop);
  connection.on('close', () => stop(new Error('IMAP connection closed unexpectedly')));
  connection.on('end', () => stop(new Error('IMAP connection ended unexpectedly')));
  connection.end = () => stop(new Error('IMAP connection closed'));
  bind(signal);
  return connection;
}

function runGuardedImap(connection, start) {
  const guard = guards.get(connection);
  if (!guard) throw new Error('A guarded IMAP connection is required');
  return guard.run(start);
}
// Reusable only if never stopped and no guarded wait is outstanding.
function imapGuardIdle(connection) {
  const guard = guards.get(connection);
  return !!guard && !guard.stopped && guard.pending === 0;
}

module.exports = { guardImapConnection, runGuardedImap, imapGuardIdle, IMAP_COMMAND_TIMEOUT_MS };
