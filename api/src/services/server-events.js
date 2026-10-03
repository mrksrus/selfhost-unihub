'use strict';
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
const crypto = require('node:crypto');

const DEFAULTS = Object.freeze({
  heartbeatMs: 25 * 1000,
  retryMs: 10 * 1000,
  maxPerUser: 5,
  maxTotal: 200,
  throttleMs: 1000,
  // A client that stops reading must not grow the API's memory without bound.
  maxBufferedBytes: 256 * 1024,
});

const MAIL_JOB_STATES = new Set(['queued', 'running', 'idle', 'error', 'cancelled', 'paused']);
const MAIL_OPERATION_STATES = new Set(['accepted', 'queued', 'executing', 'verifying', 'retry_wait', 'reconciling',
  'confirmed', 'needs_attention', 'rejected', 'cancelled', 'superseded']);
const MAIL_CHANGE_REASONS = new Set(['import', 'flags', 'folders', 'content', 'operation', 'local']);
const MAIL_JOB_KINDS = new Set(['sync', 'recent', 'flags', 'history', 'presence', 'body', 'prune', 'operation', 'reconcile']);

const id = value => {
  const text = value === null || value === undefined ? '' : String(value);
  return /^[A-Za-z0-9_-]{1,64}$/.test(text) ? text : null;
};
const count = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const hashToken = token => token ? crypto.createHash('sha256').update(String(token)).digest('hex') : null;

function frame(type, data) {
  // JSON.stringify never emits a raw newline, so one data line is enough.
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createServerEvents(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const now = config.now || Date.now;
  const timers = config.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
  const streams = new Set();
  const byUser = new Map();
  const throttles = new Map();
  let heartbeat = null;
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

  function write(stream, text) {
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

  function close(stream, { reason = null, quiet = false } = {}) {
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
    for (const event of ['close', 'error']) stream.res.off?.(event, stream.onClose);
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

  function attach({ userId, req, res, token = null, modules = null, revalidate = null }) {
    const user = userId === null || userId === undefined || userId === '' ? null : String(userId);
    if (!user) return { ok: false, status: 401, error: 'Unauthorized' };
    if (closing) return { ok: false, status: 503, error: 'Server is shutting down' };
    if ((byUser.get(user)?.size || 0) >= config.maxPerUser) {
      return { ok: false, status: 429, error: 'Too many live update streams for this account' };
    }
    if (streams.size >= config.maxTotal) return { ok: false, status: 503, error: 'Live updates are at capacity' };
    const stream = {
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
    byUser.get(user).add(stream);
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

  function deliver(userId, type, data, module) {
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
  function publish(userId, type, data, { module = null, throttleKey = null, merge = null } = {}) {
    if (userId === null || userId === undefined || closing) return 0;
    const user = String(userId);
    if (!byUser.has(user)) return 0;
    if (!throttleKey || !config.throttleMs) return deliver(user, type, data, module);
    const key = `${user}\u0000${throttleKey}`;
    const entry = throttles.get(key);
    if (entry) {
      const merged = entry.pending && typeof merge === 'function' ? merge(entry.pending.data, data) : data;
      entry.pending = { type, data: merged, module };
      return 0;
    }
    const delivered = deliver(user, type, data, module);
    const state = { pending: null, timer: null };
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

  function closeUser(userId, { exceptToken = null, reason = 'session_ended' } = {}) {
    const except = hashToken(exceptToken);
    let closed = 0;
    for (const stream of [...(byUser.get(String(userId)) || [])]) {
      if (except && stream.tokenHash === except) continue;
      close(stream, { reason });
      closed++;
    }
    return closed;
  }

  function closeToken(token, { reason = 'session_ended' } = {}) {
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
    for (const { timer } of throttles.values()) timers.clearTimeout(timer);
    throttles.clear();
    stopHeartbeat();
  }

  function setUserModules(userId, modules) {
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
    hasListeners: userId => byUser.has(String(userId)),
    stats: () => ({ streams: streams.size, users: byUser.size, throttled: throttles.size }),
    config,
  };
}

const serverEvents = createServerEvents();

// --- Mail event producers -------------------------------------------------
// Each producer reduces its input to ids/states/counters before publishing.

function publishMailJob(job, bus = serverEvents) {
  const userId = job?.user_id;
  const accountId = id(job?.mail_account_id);
  if (!userId || !accountId || !MAIL_JOB_STATES.has(job.state) || !bus.hasListeners(userId)) return;
  const kind = MAIL_JOB_KINDS.has(job.kind) ? job.kind : null;
  bus.publish(userId, 'mail.job', {
    accountId,
    jobId: id(job.id),
    kind,
    state: job.state,
    phase: MAIL_JOB_KINDS.has(job.phase) || job.phase === 'reconcile' ? job.phase : null,
    processed: count(job.processed),
    total: count(job.total),
  }, { module: 'mail', throttleKey: `mail.job:${accountId}` });
  if (job.state === 'running') return;
  // A finished job may have changed lists or settled provider changes.
  const result = job.result || {};
  const changedRows = (count(result.inserted) || 0) + (count(result.updated) || 0);
  let reason = null;
  if (kind === 'operation' || kind === 'reconcile') reason = 'operation';
  else if (kind === 'sync' && job.state === 'idle') reason = 'folders';
  else if (kind === 'body' && count(result.processed) > 0) reason = 'content';
  // Sync policy removed, merged or refiled local copies in this batch.
  else if (kind === 'prune' && count(result.processed) > 0) reason = 'content';
  else if (changedRows > 0) reason = kind === 'recent' || kind === 'history' ? 'import' : 'flags';
  if (reason) publishMailChanged(userId, accountId, reason, bus);
  // A scan can settle a flag or move by observation; mutation jobs settle them directly.
  if (kind === 'operation' || kind === 'reconcile' || (changedRows > 0 && ['recent', 'flags', 'presence'].includes(kind))) {
    publishMailOperation(userId, { accountId, operationIds: job.operation_id ? [job.operation_id] : [], state: null }, bus);
  }
}

// Coalesced operation events keep every id; a mixed burst reports no single state.
function mergeOperations(previous, next) {
  const operationIds = [...new Set([...previous.operationIds, ...next.operationIds])].slice(0, 100);
  return { accountId: next.accountId, operationIds, state: previous.state === next.state ? next.state : null };
}

function publishMailOperation(userId, { accountId = null, operationIds = [], state = null } = {}, bus = serverEvents) {
  if (!userId || !bus.hasListeners(userId)) return;
  const ids = [...new Set((Array.isArray(operationIds) ? operationIds : []).map(id).filter(Boolean))].slice(0, 100);
  const account = id(accountId);
  bus.publish(userId, 'mail.operation', {
    accountId: account,
    operationIds: ids,
    state: MAIL_OPERATION_STATES.has(state) ? state : null,
  }, { module: 'mail', throttleKey: `mail.operation:${account || '*'}`, merge: mergeOperations });
}

function publishMailChanged(userId, accountId, reason, bus = serverEvents) {
  if (!userId || !bus.hasListeners(userId)) return;
  const account = id(accountId);
  bus.publish(userId, 'mail.changed', { accountId: account, reason: MAIL_CHANGE_REASONS.has(reason) ? reason : null },
    { module: 'mail', throttleKey: `mail.changed:${account || '*'}` });
}

// --- Calendar event producers ---------------------------------------------

const CALENDAR_CHANGE_REASONS = new Set(['sync', 'status', 'local']);

function publishCalendarChanged(userId, accountId, reason, bus = serverEvents) {
  if (!userId || !bus.hasListeners(userId)) return;
  const account = id(accountId);
  bus.publish(userId, 'calendar.changed', { accountId: account, reason: CALENDAR_CHANGE_REASONS.has(reason) ? reason : null },
    { module: 'calendar', throttleKey: `calendar.changed:${account || '*'}` });
}

// The supervisor stops the API with SIGTERM (or by closing the IPC channel,
// which drop-privileges.js turns into SIGTERM). End every stream with a final
// 'end' event first so browsers back off instead of seeing a broken
// connection, then let the signal terminate the process as it did before.
// onShutdown hooks (e.g. the mail IDLE supervisor) close long-lived provider
// sockets on the same path; they must not throw or block the re-raise.
function installShutdownHandler({ bus = serverEvents, server = null, signals = process,
  kill = signal => process.kill(process.pid, signal), graceMs = 200, timers = { setTimeout }, onShutdown = [] } = {}) {
  const handlers = {};
  const onSignal = signal => {
    for (const [name, handler] of Object.entries(handlers)) signals.removeListener(name, handler);
    for (const hook of onShutdown) { try { hook(); } catch { /* shutting down anyway */ } }
    bus.closeAll({ reason: 'shutdown' });
    try { server?.close?.(); } catch { /* not listening */ }
    // Give the final writes a moment to flush, then re-raise with no handler.
    timers.setTimeout(() => kill(signal), graceMs);
  };
  for (const name of ['SIGTERM', 'SIGINT']) {
    handlers[name] = () => onSignal(name);
    signals.on(name, handlers[name]);
  }
  return () => { for (const [name, handler] of Object.entries(handlers)) signals.removeListener(name, handler); };
}

module.exports = {
  createServerEvents,
  installShutdownHandler,
  serverEvents,
  publishMailJob,
  publishMailOperation,
  publishMailChanged,
  publishCalendarChanged,
  hashToken,
  DEFAULTS,
};
