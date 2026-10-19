// One front for the live channels this process holds: the browser event
// stream (server-events.ts) and the Android app's notification stream
// (android-push.ts). Producers publish here and session changes close streams
// here, so the channels can later move behind a database outbox or into
// another process without touching a producer. The buses stay as they are.
//
// A browser stream filters events by the user's enabled modules; a device
// stream is bound to its device id as its only "module". An event published
// with a module therefore never reaches a phone, and one published without a
// module reaches every channel of the user. Every producer below names a
// module, so phones receive nothing from them today.
import { serverEvents } from './server-events';
import { androidStreams } from './android-push';
import { OPERATION_STATES } from './mail-engine/operation-states';
import { JOB_KINDS } from './mail-engine/job-kinds';

type Bus = Pick<typeof serverEvents, 'publish' | 'hasListeners' | 'closeUser' | 'closeToken' | 'setUserModules' | 'stats'>;
interface PublishOptions<T> {
  module?: string | null;
  throttleKey?: string | null;
  merge?: ((previous: T, next: T) => T) | null;
}
interface CloseOptions { reason?: string }
interface CloseUserOptions extends CloseOptions { exceptToken?: string | null }
type Realtime = ReturnType<typeof createRealtime>;

interface MailJobHint {
  user_id?: string;
  mail_account_id?: unknown;
  state?: string;
  kind?: string;
  phase?: string | null;
  id?: unknown;
  operation_id?: string | null;
  processed?: unknown;
  total?: unknown;
  result?: { inserted?: unknown; updated?: unknown; processed?: unknown };
}
interface OperationHint { accountId: string | null; operationIds: (string | null)[]; state: string | null }

function createRealtime({ browser, devices }: { browser: Bus; devices: Bus }) {
  const buses = [browser, devices];

  function publishToUser<T>(userId: unknown, type: string, data: T, options: PublishOptions<T> = {}) {
    let delivered = 0;
    for (const bus of buses) delivered += bus.publish(userId, type, data, options);
    return delivered;
  }

  function publishToUsers<T>(userIds: Iterable<unknown>, type: string, data: T, options: PublishOptions<T> = {}) {
    let delivered = 0;
    for (const userId of new Set(userIds)) delivered += publishToUser(userId, type, data, options);
    return delivered;
  }

  /** Ends the streams opened with this session token, on every channel. */
  function closeSession(token: unknown, { reason = 'session_ended' }: CloseOptions = {}) {
    let closed = 0;
    for (const bus of buses) closed += bus.closeToken(token, { reason });
    return closed;
  }

  /** Ends a user's streams on every channel, except those of `exceptToken`. */
  function closeUser(userId: unknown, { exceptToken = null, reason = 'session_ended' }: CloseUserOptions = {}) {
    let closed = 0;
    for (const bus of buses) closed += bus.closeUser(userId, { exceptToken, reason });
    return closed;
  }

  function isOnline(userId: unknown) {
    return buses.some(bus => bus.hasListeners(userId));
  }

  // Module filters belong to browser streams; a device stream's filter is its
  // device id and must not be replaced by the module set.
  function setUserModules(userId: unknown, modules: Iterable<string>) {
    browser.setUserModules(userId, modules);
  }

  function stats() {
    return { browser: browser.stats(), devices: devices.stats() };
  }

  return { publishToUser, publishToUsers, closeSession, closeUser, isOnline, setUserModules, stats };
}

const realtime = createRealtime({ browser: serverEvents, devices: androidStreams });

// --- Mail event producers -------------------------------------------------
// Each producer reduces its input to ids/states/counters before publishing.

const MAIL_JOB_STATES = new Set(['queued', 'running', 'idle', 'error', 'cancelled', 'paused']);
// 'accepted' is published by admission before a row state exists.
const MAIL_OPERATION_STATES = new Set<string>(['accepted', ...OPERATION_STATES]);
const MAIL_CHANGE_REASONS = new Set(['import', 'flags', 'folders', 'content', 'operation', 'local']);
const MAIL_JOB_KINDS = new Set<string>(JOB_KINDS);

const id = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /^[A-Za-z0-9_-]{1,64}$/.test(text) ? text : null;
};
const count = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

function publishMailJob(job: MailJobHint | null | undefined, hub: Realtime = realtime) {
  const userId = job?.user_id;
  const accountId = id(job?.mail_account_id);
  if (!userId || !accountId || !MAIL_JOB_STATES.has(job.state || '') || !hub.isOnline(userId)) return;
  const kind = MAIL_JOB_KINDS.has(job.kind || '') ? job.kind : null;
  hub.publishToUser(userId, 'mail.job', {
    accountId,
    jobId: id(job.id),
    kind,
    state: job.state,
    phase: MAIL_JOB_KINDS.has(job.phase || '') || job.phase === 'reconcile' ? job.phase : null,
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
  else if (kind === 'body' && (count(result.processed) || 0) > 0) reason = 'content';
  // Sync policy removed, merged or refiled local copies in this batch.
  else if (kind === 'prune' && (count(result.processed) || 0) > 0) reason = 'content';
  else if (changedRows > 0) reason = kind === 'recent' || kind === 'history' ? 'import' : 'flags';
  if (reason) publishMailChanged(userId, accountId, reason, hub);
  // A scan can settle a flag or move by observation; mutation jobs settle them directly.
  if (kind === 'operation' || kind === 'reconcile' || (changedRows > 0 && ['recent', 'flags', 'presence'].includes(kind || ''))) {
    publishMailOperation(userId, { accountId, operationIds: job.operation_id ? [job.operation_id] : [], state: null }, hub);
  }
}

// Coalesced operation events keep every id; a mixed burst reports no single state.
function mergeOperations(previous: OperationHint, next: OperationHint) {
  const operationIds = [...new Set([...previous.operationIds, ...next.operationIds])].slice(0, 100);
  return { accountId: next.accountId, operationIds, state: previous.state === next.state ? next.state : null };
}

function publishMailOperation(userId: unknown, { accountId = null, operationIds = [], state = null }: { accountId?: unknown; operationIds?: unknown; state?: string | null } = {}, hub: Realtime = realtime) {
  if (!userId || !hub.isOnline(userId)) return;
  const ids = [...new Set((Array.isArray(operationIds) ? operationIds : []).map(id).filter(Boolean))].slice(0, 100);
  const account = id(accountId);
  hub.publishToUser(userId, 'mail.operation', {
    accountId: account,
    operationIds: ids,
    state: MAIL_OPERATION_STATES.has(state || '') ? state : null,
  }, { module: 'mail', throttleKey: `mail.operation:${account || '*'}`, merge: mergeOperations });
}

function publishMailChanged(userId: unknown, accountId: unknown, reason: string, hub: Realtime = realtime) {
  if (!userId || !hub.isOnline(userId)) return;
  const account = id(accountId);
  hub.publishToUser(userId, 'mail.changed', { accountId: account, reason: MAIL_CHANGE_REASONS.has(reason) ? reason : null },
    { module: 'mail', throttleKey: `mail.changed:${account || '*'}` });
}

// --- Calendar event producers ---------------------------------------------

const CALENDAR_CHANGE_REASONS = new Set(['sync', 'status', 'local']);

function publishCalendarChanged(userId: unknown, accountId: unknown, reason: string, hub: Realtime = realtime) {
  if (!userId || !hub.isOnline(userId)) return;
  const account = id(accountId);
  hub.publishToUser(userId, 'calendar.changed', { accountId: account, reason: CALENDAR_CHANGE_REASONS.has(reason) ? reason : null },
    { module: 'calendar', throttleKey: `calendar.changed:${account || '*'}` });
}

export {
  createRealtime,
  realtime,
  publishMailJob,
  publishMailOperation,
  publishMailChanged,
  publishCalendarChanged,
};
export type { Realtime, PublishOptions };
