// Live status push (Server-Sent Events) for the browser.
//
// The bus lives in this API process only. UniHub runs one API process (the mail
// scheduler and backup workers already rely on in-process coordination), so an
// event published here reaches every stream that process holds. A second API
// replica would neither see these events nor receive its own users' streams.
//
// Events are hints that tell the browser which queries to refetch. They carry
// identifiers, states and counters only: never message content, subjects,
// addresses, folder names or provider error text. Delivery is best effort;
// the browser refetches the authoritative state over the normal API, and keeps
// a slow polling safety net while connected.
//
// Producers do not publish here directly: realtime.ts fronts this bus and the
// Android stream bus (android-push.ts) and owns the mail and calendar producers.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventEmitter } from 'node:events';

import crypto from 'node:crypto';

interface EventStream {
  userId: string;
  tokenHash: string | null;
  modules: Set<string>;
  revalidate: ((stream: EventStream) => Promise<boolean>) | null;
  req: IncomingMessage;
  res: ServerResponse;
  closed: boolean;
  revalidating: boolean;
  onClose: (() => void) | null;
}
interface AttachOptions {
  userId: unknown;
  req: IncomingMessage;
  res: ServerResponse;
  token?: string | null;
  modules?: Iterable<string> | null;
  revalidate?: ((stream: EventStream) => Promise<boolean>) | null;
}
interface PendingEvent { type: string; data: unknown; module: string | null }
interface ThrottleState { pending: PendingEvent | null; timer: NodeJS.Timeout | null }
interface PublishOptions<T> {
  module?: string | null;
  throttleKey?: string | null;
  merge?: ((previous: T, next: T) => T) | null;
}
type TimerApi = Pick<typeof globalThis, 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'>;
type BusOptions = Partial<Record<keyof typeof DEFAULTS, number>> & { now?: () => number; timers?: TimerApi };
interface ShutdownOptions {
  bus?: ReturnType<typeof createServerEvents>;
  server?: { close?: () => unknown } | null;
  signals?: Pick<EventEmitter, 'on' | 'removeListener'>;
  kill?: (signal: NodeJS.Signals) => unknown;
  graceMs?: number;
  timers?: Pick<TimerApi, 'setTimeout'>;
  onShutdown?: readonly (() => unknown)[];
}

const DEFAULTS = Object.freeze({
  heartbeatMs: 25 * 1000,
  retryMs: 10 * 1000,
  maxPerUser: 5,
  maxTotal: 200,
  throttleMs: 1000,
  // A client that stops reading must not grow the API's memory without bound.
  maxBufferedBytes: 256 * 1024,
});

const hashToken = (token: unknown) => token ? crypto.createHash('sha256').update(String(token)).digest('hex') : null;

function frame(type: string, data: unknown) {
  // JSON.stringify never emits a raw newline, so one data line is enough.
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createServerEvents(options: BusOptions = {}) {
  const config = { ...DEFAULTS, ...options };
  const now = config.now || Date.now;
  const timers = config.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
  const streams = new Set<EventStream>();
  const byUser = new Map<string, Set<EventStream>>();
  const throttles = new Map<string, ThrottleState>();
  let heartbeat: NodeJS.Timeout | null = null;
  let closing = false;

  function startHeartbeat() {
    if (heartbeat || !config.heartbeatMs) return;
    heartbeat = timers.setInterval(() => { void tick(); }, config.heartbeatMs);
    heartbeat.unref?.();
  }
  function stopHeartbeat() {
    if (!heartbeat) return;
    timers.clearInterval(heartbeat);
    heartbeat = null;
  }

  function write(stream: EventStream, text: string) {
    if (stream.closed) return false;
    try {
      stream.res.write(text);
    } catch {
      close(stream);
      return false;
    }
    if (Number(stream.res.writableLength || 0) > config.maxBufferedBytes) {
      close(stream, { reason: 'slow_client', quiet: true });
      return false;
    }
    return true;
  }

  function close(stream: EventStream, { reason = null, quiet = false }: { reason?: string | null; quiet?: boolean } = {}) {
    if (stream.closed) return;
    if (reason && !quiet) {
      try { stream.res.write(frame('end', { reason })); } catch { /* socket already gone */ }
    }
    stream.closed = true;
    streams.delete(stream);
    const own = byUser.get(stream.userId);
    if (own) {
      own.delete(stream);
      if (!own.size) byUser.delete(stream.userId);
    }
    for (const event of ['close', 'error']) stream.res.off?.(event, stream.onClose!);
    try { stream.res.end(); } catch { /* already ended */ }
    if (!streams.size) stopHeartbeat();
  }

  // revalidate(stream) resolves false when the session behind the stream is no
  // longer valid (sign-out, revoked or expired session, deactivated user). It
  // may also refresh stream.modules from the user's module settings.
  async function tick() {
    for (const stream of [...streams]) {
      if (stream.closed) continue;
      if (!write(stream, ': ping\n\n')) continue;
      if (typeof stream.revalidate !== 'function' || stream.revalidating) continue;
      stream.revalidating = true;
      try {
        if (await stream.revalidate(stream) === false) close(stream, { reason: 'session_ended' });
      } catch {
        // A transient database error keeps the stream; the next tick retries.
      } finally {
        stream.revalidating = false;
      }
    }
  }

  function attach({ userId, req, res, token = null, modules = null, revalidate = null }: AttachOptions) {
    const user = userId === null || userId === undefined || userId === '' ? null : String(userId);
    if (!user) return { ok: false, status: 401, error: 'Unauthorized' };
    if (closing) return { ok: false, status: 503, error: 'Server is shutting down' };
    if ((byUser.get(user)?.size || 0) >= config.maxPerUser) {
      return { ok: false, status: 429, error: 'Too many live update streams for this account' };
    }
    if (streams.size >= config.maxTotal) return { ok: false, status: 503, error: 'Live updates are at capacity' };
    const stream: EventStream = {
      userId: user,
      tokenHash: hashToken(token),
      modules: modules instanceof Set ? modules : new Set(modules || []),
      revalidate,
      req,
      res,
      closed: false,
      revalidating: false,
      onClose: null,
    };
    // Listen on the response: a request emits 'close' as soon as its (empty)
    // body has been read, while the response closes with the connection.
    stream.onClose = () => close(stream);
    for (const event of ['close', 'error']) res.on?.(event, stream.onClose);
    streams.add(stream);
    if (!byUser.has(user)) byUser.set(user, new Set());
    byUser.get(user)!.add(stream);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      // Nginx must pass each event on immediately instead of buffering it.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    write(stream, `retry: ${config.retryMs}\n\n`);
    write(stream, frame('ready', { v: 1 }));
    startHeartbeat();
    return { ok: true, stream, close: () => close(stream) };
  }

  function deliver(userId: string, type: string, data: unknown, module: string | null) {
    const own = byUser.get(String(userId));
    if (!own) return 0;
    let delivered = 0;
    const text = frame(type, data);
    for (const stream of [...own]) {
      if (module && !stream.modules.has(module)) continue;
      if (write(stream, text)) delivered++;
    }
    return delivered;
  }

  // At most one event per throttle key and interval. The latest event in an
  // interval replaces earlier ones and is sent when the interval ends, so the
  // final state of a burst is never lost.
  // merge(previous, next) may combine a replaced pending payload with the new one.
  function publish<T>(userId: unknown, type: string, data: T, { module = null, throttleKey = null, merge = null }: PublishOptions<T> = {}) {
    if (userId === null || userId === undefined || closing) return 0;
    const user = String(userId);
    if (!byUser.has(user)) return 0;
    if (!throttleKey || !config.throttleMs) return deliver(user, type, data, module);
    const key = `${user}\u0000${throttleKey}`;
    const entry = throttles.get(key);
    if (entry) {
      const merged = entry.pending && typeof merge === 'function' ? merge(entry.pending.data as T, data) : data;
      entry.pending = { type, data: merged, module };
      return 0;
    }
    const delivered = deliver(user, type, data, module);
    const state: ThrottleState = { pending: null, timer: null };
    const flush = () => {
      const next = state.pending;
      if (!next) { throttles.delete(key); return; }
      state.pending = null;
      deliver(user, next.type, next.data, next.module);
      state.timer = timers.setTimeout(flush, config.throttleMs);
      state.timer.unref?.();
    };
    state.timer = timers.setTimeout(flush, config.throttleMs);
    state.timer.unref?.();
    throttles.set(key, state);
    return delivered;
  }

  function closeUser(userId: unknown, { exceptToken = null, reason = 'session_ended' }: { exceptToken?: string | null; reason?: string } = {}) {
    const except = hashToken(exceptToken);
    let closed = 0;
    for (const stream of [...(byUser.get(String(userId)) || [])]) {
      if (except && stream.tokenHash === except) continue;
      close(stream, { reason });
      closed++;
    }
    return closed;
  }

  function closeToken(token: unknown, { reason = 'session_ended' } = {}) {
    const hash = hashToken(token);
    if (!hash) return 0;
    let closed = 0;
    for (const stream of [...streams]) {
      if (stream.tokenHash !== hash) continue;
      close(stream, { reason });
      closed++;
    }
    return closed;
  }

  function closeAll({ reason = 'shutdown' } = {}) {
    closing = true;
    for (const stream of [...streams]) close(stream, { reason });
    for (const { timer } of throttles.values()) timers.clearTimeout(timer!);
    throttles.clear();
    stopHeartbeat();
  }

  function setUserModules(userId: unknown, modules: Iterable<string>) {
    for (const stream of byUser.get(String(userId)) || []) stream.modules = new Set(modules);
  }

  return {
    attach,
    publish,
    closeUser,
    closeToken,
    closeAll,
    setUserModules,
    tick,
    hasListeners: (userId: unknown) => byUser.has(String(userId)),
    stats: () => ({ streams: streams.size, users: byUser.size, throttled: throttles.size }),
    config,
  };
}

const serverEvents = createServerEvents();

// The supervisor stops the API with SIGTERM (or by closing the IPC channel,
// which drop-privileges.js turns into SIGTERM). End every stream with a final
// 'end' event first so browsers back off instead of seeing a broken
// connection, then let the signal terminate the process as it did before.
// onShutdown hooks (e.g. the mail IDLE supervisor) close long-lived provider
// sockets on the same path; they must not throw or block the re-raise.
function installShutdownHandler({ bus = serverEvents, server = null, signals = process,
  kill = signal => process.kill(process.pid, signal), graceMs = 200, timers = { setTimeout }, onShutdown = [] }: ShutdownOptions = {}) {
  const handlers: Record<string, () => void> = {};
  const onSignal = (signal: NodeJS.Signals) => {
    for (const [name, handler] of Object.entries(handlers)) signals.removeListener(name, handler);
    for (const hook of onShutdown) { try { hook(); } catch { /* shutting down anyway */ } }
    bus.closeAll({ reason: 'shutdown' });
    try { server?.close?.(); } catch { /* not listening */ }
    // Give the final writes a moment to flush, then re-raise with no handler.
    timers.setTimeout(() => kill(signal), graceMs);
  };
  for (const name of ['SIGTERM', 'SIGINT'] as const) {
    handlers[name] = () => onSignal(name);
    signals.on(name, handlers[name]);
  }
  return () => { for (const [name, handler] of Object.entries(handlers)) signals.removeListener(name, handler); };
}

export {
  createServerEvents,
  installShutdownHandler,
  serverEvents,
  hashToken,
  DEFAULTS,
};
