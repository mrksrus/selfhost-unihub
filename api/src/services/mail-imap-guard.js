// Bound individual network waits, not the whole import. Merely racing the
// whole worker would release its account lock while its continuation can write.
// Every IMAP command of a guarded ImapFlow client runs through runGuardedImap:
// one deadline per command, and a stopped client never dispatches again.
const IMAP_COMMAND_TIMEOUT_MS = 120000;
const guards = new WeakMap();
// ImapFlow fails the whole connection when a literal/line/response exceeds its
// configured size before buffering it; callers see the byte-budget code.
const LIMIT_CODES = new Set(['LiteralTooLarge', 'ResponseTooLarge', 'LineTooLarge']);

// Wrapping is installed once per transport. A pooled transport handed to the
// next job is rebound to that job's signal; the previous listener is removed.
function guardImapConnection(connection, { signal, timeoutMs = IMAP_COMMAND_TIMEOUT_MS } = {}) {
  const existing = guards.get(connection);
  if (existing) { existing.bind(signal); return connection; }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new TypeError('Invalid IMAP command deadline');
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
    stopped = LIMIT_CODES.has(error?.code)
      ? Object.assign(new Error('IMAP response exceeds byte budget'), { code: 'MAIL_IMAP_LIMIT' })
      : error || new Error('IMAP connection closed');
    bound?.removeEventListener('abort', onAbort);
    // Hard close, not LOGOUT: a LOGOUT queues behind the very command that
    // stalled. Mark terminal first so neither late replies nor error events can
    // dispatch another command. ImapFlow's close() destroys the socket and its
    // parser synchronously and rejects its queued commands, so late data can
    // never be read as a reply. Reject only the network waits; the worker still
    // unwinds and settles durable writeback outcomes while holding its lock.
    try { connection.close(); } catch { /* already disconnected */ }
    for (const reject of [...pending]) reject(stopped);
  }
  // start() issues the command and returns its promise.
  function run(start) {
    if (stopped) return Promise.reject(stopped);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        if (error || stopped) reject(stopped || error); else resolve(result);
      };
      const cancel = error => finish(error);
      const timer = setTimeout(() => stop(Object.assign(new Error('IMAP command timeout; reconnect before retrying.'), { code: 'MAIL_IMAP_TIMEOUT' })), timeoutMs);
      pending.add(cancel);
      try { Promise.resolve(start()).then(value => finish(null, value), finish); } catch (error) { finish(error); }
    });
  }
  guards.set(connection, { run, bind, stop, get stopped() { return !!stopped; }, get pending() { return pending.size; } });
  connection.on('error', stop);
  connection.on('close', () => stop(new Error('IMAP connection closed unexpectedly')));
  bind(signal);
  return connection;
}

function runGuardedImap(connection, start) {
  const guard = guards.get(connection);
  if (!guard) throw new Error('A guarded IMAP connection is required');
  return guard.run(start);
}
// Idempotent hard close for guarded and unguarded clients.
function closeImapConnection(connection, error) {
  const guard = guards.get(connection);
  if (guard) guard.stop(error || new Error('IMAP connection closed'));
  else { try { connection?.close?.(); } catch { /* already closed */ } }
}
// Reusable only if never stopped and no guarded wait is outstanding.
function imapGuardIdle(connection) {
  const guard = guards.get(connection);
  return !!guard && !guard.stopped && guard.pending === 0;
}
// The session survived and can serve the next command.
function imapSessionUsable(connection) {
  return imapGuardIdle(connection) && connection.usable === true && !connection.isClosed;
}

module.exports = { guardImapConnection, runGuardedImap, closeImapConnection, imapGuardIdle, imapSessionUsable, IMAP_COMMAND_TIMEOUT_MS };
