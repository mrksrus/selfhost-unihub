import type { EventEmitter } from 'node:events';

type MailTransportError = Error & { code?: string };
interface GuardedConnection extends Pick<EventEmitter, 'on'> { close: () => void; usable?: boolean; isClosed?: boolean }
interface GuardOptions { signal?: AbortSignal; timeoutMs?: number }
interface ConnectionGuard {
  bind: (signal?: AbortSignal) => void;
  stop: (error?: MailTransportError | null) => void;
  run: <T>(start: () => T | PromiseLike<T>, deadlineMs?: number) => Promise<T>;
  readonly stopped: boolean;
  readonly pending: number;
}

// Bound individual network waits, not the whole import. Merely racing the
// whole worker would release its account lock while its continuation can write.
// Every IMAP command of a guarded ImapFlow client runs through runGuardedImap:
// one deadline per command, and a stopped client never dispatches again.
const IMAP_COMMAND_TIMEOUT_MS = 120000;
// Upper bound for any command deadline, including a body FETCH's longer one.
const MAX_IMAP_COMMAND_TIMEOUT_MS = 300000;
const validDeadline = (ms: number) => Number.isSafeInteger(ms) && ms >= 1 && ms <= MAX_IMAP_COMMAND_TIMEOUT_MS;
const guards = new WeakMap<GuardedConnection, ConnectionGuard>();
// ImapFlow fails the whole connection when a literal/line/response exceeds its
// configured size before buffering it; callers see the byte-budget code.
const LIMIT_CODES = new Set(['LiteralTooLarge', 'ResponseTooLarge', 'LineTooLarge']);

// Wrapping is installed once per transport. A pooled transport handed to the
// next job is rebound to that job's signal; the previous listener is removed.
function guardImapConnection<T extends GuardedConnection>(connection: T, { signal, timeoutMs = IMAP_COMMAND_TIMEOUT_MS }: GuardOptions = {}): T {
  const existing = guards.get(connection);
  if (existing) { existing.bind(signal); return connection; }
  if (!validDeadline(timeoutMs)) throw new TypeError('Invalid IMAP command deadline');
  const pending = new Set<(error: unknown) => void>();
  let stopped: MailTransportError | null = null, bound: AbortSignal | null = null;
  const abortError = () => Object.assign(new Error('Mail sync cancelled; completed messages are retained.'), { code: 'MAIL_SYNC_CANCELLED' });
  const onAbort = () => stop(abortError());
  function bind(next?: AbortSignal) {
    if (stopped) return;
    bound?.removeEventListener('abort', onAbort);
    bound = next || null;
    bound?.addEventListener('abort', onAbort, { once: true });
    if (bound?.aborted) onAbort();
  }
  function stop(error?: MailTransportError | null) {
    if (stopped) return;
    stopped = LIMIT_CODES.has(error?.code || '')
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
  // start() issues the command and returns its promise. A command may set its
  // own deadline (a large message's FETCH); others use the connection's.
  function run<T>(start: () => T | PromiseLike<T>, deadlineMs = timeoutMs): Promise<T> {
    if (stopped) return Promise.reject(stopped);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, result?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        if (error || stopped) reject(stopped || error); else resolve(result as T);
      };
      const cancel = (error: unknown) => finish(error);
      const timer = setTimeout(() => stop(Object.assign(new Error('IMAP command timeout; reconnect before retrying.'), { code: 'MAIL_IMAP_TIMEOUT' })), deadlineMs);
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

function runGuardedImap<T>(connection: GuardedConnection, start: () => T | PromiseLike<T>, { timeoutMs }: Pick<GuardOptions, 'timeoutMs'> = {}): Promise<T> {
  const guard = guards.get(connection);
  if (!guard) throw new Error('A guarded IMAP connection is required');
  if (timeoutMs !== undefined && !validDeadline(timeoutMs)) throw new TypeError('Invalid IMAP command deadline');
  return guard.run(start, timeoutMs);
}
// Idempotent hard close for guarded and unguarded clients.
function closeImapConnection(connection: GuardedConnection, error?: MailTransportError) {
  const guard = guards.get(connection);
  if (guard) guard.stop(error || new Error('IMAP connection closed'));
  else { try { connection?.close?.(); } catch { /* already closed */ } }
}
// Reusable only if never stopped and no guarded wait is outstanding.
function imapGuardIdle(connection: GuardedConnection) {
  const guard = guards.get(connection);
  return !!guard && !guard.stopped && guard.pending === 0;
}
// The session survived and can serve the next command.
function imapSessionUsable(connection: GuardedConnection) {
  return imapGuardIdle(connection) && connection.usable === true && !connection.isClosed;
}

export {
  guardImapConnection,
  runGuardedImap,
  closeImapConnection,
  imapGuardIdle,
  imapSessionUsable,
  IMAP_COMMAND_TIMEOUT_MS,
  MAX_IMAP_COMMAND_TIMEOUT_MS,
};
