// IMAP IDLE push for INBOX (RFC 2177). One dedicated, read-only session per
// eligible account sits in IDLE on the account's INBOX, separate from the job
// connection pool. It only notices changes: an untagged EXISTS/EXPUNGE/FLAGS
// (VANISHED arrives as an expunge) is coalesced for a moment and turned into
// ordinary durable jobs through mail-sync-control, which nudges the scheduler.
// All provider reads that change local state stay in fenced durable jobs; this
// session never fetches, stores, moves or expunges anything. The wire carries
// only LOGIN/CAPABILITY negotiation, EXAMINE, IDLE/DONE, a keepalive NOOP and
// LOGOUT/close.
//
// Eligibility is recomputed from the database every pollMs (a backstop for
// every lifecycle change: account add/reconnect, settings, canary hold/release,
// restore, recovery pauses). Paths that must stop the socket at once call
// stopAccount(): stopMailAccountWork (disconnect, purge, settings change,
// module off) and the background toggle.
import type { RowDataPacket } from 'mysql2/promise';
import type { Socket } from 'node:net';
import type { ImapFlow } from 'imapflow';
import { fingerprint } from './mail-engine/connection-pool';

type IdleClient = ImapFlow & { socket?: Socket; isClosed?: boolean };
type IdleError = Error & { authenticationFailed?: boolean };
interface Eligible {
  accountId: string;
  userId: string;
  mailboxId: string;
  remoteName: string;
  syncMode: string;
  fingerprint: string;
}
interface Session extends Eligible {
  client: IdleClient | null;
  state: string;
  generation: number;
  failures: number;
  quickReturn: number;
  idleSince: number | null;
  retryAt: number | null;
  retryTimer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  pending: Set<string>;
}
type IdleInput = { accountId: string; userId: string; mailboxId: string; kinds: string[] };
type Overrides = Partial<typeof DEFAULTS> & { now?: () => number; random?: () => number; timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval }; log?: (...args: unknown[]) => void; listEligible?: () => Promise<Eligible[]>; connect?: (entry: Session) => Promise<IdleClient>; enqueue?: (input: IdleInput) => Promise<unknown> }

function envInt(name: string, fallback: number, low: number, high: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= low && value <= high ? value : fallback;
}

const DEFAULTS = Object.freeze({
  // Providers limit simultaneous connections per account (often 10–20) and the
  // process limits sockets; 0 turns IDLE off and leaves 30 s polling.
  maxSessions: envInt('UNIHUB_MAIL_IDLE_MAX_SESSIONS', 50, 0, 10000),
  pollMs: 60 * 1000,
  debounceMs: 2000,
  // RFC 2177: re-issue IDLE before 29 minutes; shorter also keeps NAT state.
  idleRestartMs: 10 * 60 * 1000,
  backoffBaseMs: 5000,
  backoffMaxMs: 15 * 60 * 1000,
  // A session that stayed up this long resets the backoff.
  stableMs: 60 * 1000,
  // A server without IDLE is asked again only this rarely (or after a settings change).
  unsupportedRetryMs: 6 * 60 * 60 * 1000,
  openTimeoutMs: 60 * 1000,
});

// Kinds each untagged event can justify. flags/presence are the ordinary
// background sweeps (throttled; Sync mode only); a throttled one completes
// without connecting, so a burst of own writebacks costs nothing.
function kindsFor(event: string, syncMode: string) {
  if (event === 'exists') return ['recent'];
  if (syncMode !== 'sync') return [];
  if (event === 'flags') return ['flags'];
  if (event === 'expunge') return ['presence'];
  return [];
}

function supportsIdle(client: Pick<IdleClient, 'capabilities'> | null | undefined) {
  const caps = client?.capabilities;
  return caps instanceof Map ? caps.has('IDLE') || caps.has('IMAP4rev2') || caps.has('IMAP4REV2') : false;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => { onTimeout?.(); reject(Object.assign(new Error('IMAP IDLE setup timeout'), { code: 'MAIL_IMAP_TIMEOUT' })); }, ms);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}

function closeClient(client: IdleClient | null) {
  if (!client) return;
  try { client.close(); } catch { /* already closed */ }
}

function createIdleSupervisor(overrides: Overrides = {}) {
  const options = { ...DEFAULTS, ...overrides };
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const timers = options.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
  const log = options.log || ((...args) => console.log(...args));
  const listEligible = options.listEligible || defaultListEligible;
  const connect = options.connect || defaultConnect;
  const enqueue = options.enqueue || (input => (require('./mail-sync-control') as typeof import('./mail-sync-control')).enqueueIdleRefresh(input));
  const sessions = new Map<string, Session>();
  // Not tracked, not retried until the account's connection fingerprint
  // (host, port, user, password, trust) changes: auth failure, no IDLE.
  const blocked = new Map<string, { fingerprint: string; reason: string; until: number }>();
  // stopAccount() after a poll read the database must win over that poll.
  const stopRequests = new Map<string, number>();
  let pollTimer: NodeJS.Timeout | null = null, running = false, reconciling: Promise<void> | null = null, again = false;

  function unref<T extends NodeJS.Timeout | null>(timer: T) { timer?.unref?.(); return timer; }

  function stale(entry: Session, generation: number) {
    return !running || sessions.get(entry.accountId) !== entry || entry.generation !== generation;
  }

  function teardown(entry: Session) {
    entry.generation++;
    if (entry.retryTimer) timers.clearTimeout(entry.retryTimer);
    if (entry.debounceTimer) timers.clearTimeout(entry.debounceTimer);
    entry.retryTimer = entry.debounceTimer = null;
    entry.pending.clear();
    const client = entry.client;
    entry.client = null;
    entry.state = 'stopped';
    closeClient(client);
  }

  function flush(entry: Session) {
    entry.debounceTimer = null;
    const kinds = [...entry.pending];
    entry.pending.clear();
    if (!kinds.length || sessions.get(entry.accountId) !== entry) return;
    Promise.resolve()
      .then(() => enqueue({ accountId: entry.accountId, userId: entry.userId, mailboxId: entry.mailboxId, kinds }))
      .catch(error => log(`[MAIL IDLE] Refresh for account ${entry.accountId} failed: ${(error as Error).message}`));
  }

  function schedule(entry: Session, kinds: string[]) {
    if (!kinds.length || sessions.get(entry.accountId) !== entry) return;
    for (const kind of kinds) entry.pending.add(kind);
    // Coalescing window, not a sliding one: a steady stream of events still
    // yields one refresh every debounceMs.
    if (!entry.debounceTimer) entry.debounceTimer = unref(timers.setTimeout(() => flush(entry), options.debounceMs));
  }

  function backoffDelay(failures: number) {
    const base = Math.min(options.backoffMaxMs, options.backoffBaseMs * 2 ** Math.min(failures - 1, 30));
    return Math.max(1, Math.round(base * (0.5 + random() * 0.5)));
  }

  function fail(entry: Session, generation: number, error: unknown) {
    if (stale(entry, generation)) return;
    const client = entry.client;
    entry.client = null;
    closeClient(client);
    if ((error as IdleError)?.authenticationFailed) {
      blocked.set(entry.accountId, { fingerprint: entry.fingerprint, reason: 'auth', until: Infinity });
      sessions.delete(entry.accountId);
      teardown(entry);
      log(`[MAIL IDLE] Account ${entry.accountId}: login rejected; IDLE stays off until its settings change`);
      return;
    }
    const lasted = entry.idleSince != null && now() - entry.idleSince >= options.stableMs;
    entry.failures = lasted ? 1 : entry.failures + 1;
    entry.idleSince = null;
    entry.state = 'backoff';
    const delay = backoffDelay(entry.failures);
    entry.retryAt = now() + delay;
    entry.retryTimer = unref(timers.setTimeout(() => {
      entry.retryTimer = null;
      if (stale(entry, generation)) return;
      open(entry);
    }, delay));
  }

  async function open(entry: Session) {
    const generation = ++entry.generation;
    entry.state = 'connecting';
    let client: IdleClient | null = null;
    try {
      client = await connect(entry);
      if (stale(entry, generation)) { closeClient(client); return; }
      entry.client = client;
      if (!supportsIdle(client)) {
        blocked.set(entry.accountId, { fingerprint: entry.fingerprint, reason: 'unsupported', until: now() + options.unsupportedRetryMs });
        sessions.delete(entry.accountId);
        teardown(entry);
        return;
      }
      let lost: IdleError | null = null;
      const ended = new Promise<void>(resolve => {
        client!.on('close', () => { lost = lost || new Error('IMAP IDLE connection closed'); resolve(); });
        client!.on('error', error => { lost = error || new Error('IMAP IDLE connection failed'); resolve(); });
      });
      for (const event of ['exists', 'expunge', 'flags']) {
        client!.on(event, () => { if (!stale(entry, generation)) schedule(entry, kindsFor(event, entry.syncMode)); });
      }
      // EXAMINE: read-only, so the session can never change \Recent or flags.
      await withTimeout(client!.mailboxOpen(entry.remoteName, { readOnly: true }), options.openTimeoutMs, () => closeClient(client));
      if (stale(entry, generation)) return;
      try { client!.socket?.unref?.(); } catch { /* closed */ }
      entry.state = 'idling';
      entry.idleSince = now();
      // Mail that arrived while no session was listening raises no event.
      schedule(entry, ['recent']);
      for (;;) {
        const started = now();
        const result = await Promise.race([client!.idle(), ended]);
        if (stale(entry, generation)) return;
        if (lost || client!.usable === false || client!.isClosed) throw lost || new Error('IMAP IDLE connection closed');
        // IDLE refused (tagged NO/BAD) or a loop that returns at once: stop
        // rather than spin, and retry with backoff.
        if (result === false) throw new Error('IMAP IDLE refused');
        if (now() - started < 1000 && entry.quickReturn++ > 2) throw new Error('IMAP IDLE ended repeatedly');
        if (now() - started >= 1000) entry.quickReturn = 0;
      }
    } catch (error) {
      if (stale(entry, generation)) { closeClient(client); return; }
      fail(entry, generation, error);
    }
  }

  function startSession(row: Eligible) {
    const entry: Session = { accountId: row.accountId, userId: row.userId, mailboxId: row.mailboxId, remoteName: row.remoteName,
      syncMode: row.syncMode, fingerprint: row.fingerprint, client: null, state: 'connecting', generation: 0,
      failures: 0, quickReturn: 0, idleSince: null, retryAt: null, retryTimer: null, debounceTimer: null, pending: new Set() };
    sessions.set(entry.accountId, entry);
    void open(entry);
  }

  function stopAccount(accountId: unknown) {
    const key = String(accountId || '');
    stopRequests.set(key, now());
    const entry = sessions.get(key);
    if (!entry) return false;
    sessions.delete(key);
    teardown(entry);
    return true;
  }

  async function reconcileOnce() {
    const startedAt = now();
    const rows = await listEligible();
    if (!running) return;
    const wanted = new Map<string, Eligible>();
    for (const row of rows) {
      if (wanted.size >= options.maxSessions) break;
      const key = String(row.accountId);
      if (wanted.has(key)) continue;
      const block = blocked.get(key);
      if (block && block.fingerprint === row.fingerprint && block.until > now()) continue;
      if (block) blocked.delete(key);
      if ((stopRequests.get(key) ?? -Infinity) >= startedAt) continue;
      wanted.set(key, { ...row, accountId: key });
    }
    for (const [key, entry] of [...sessions]) {
      const row = wanted.get(key);
      if (!row || row.fingerprint !== entry.fingerprint || row.mailboxId !== entry.mailboxId
        || row.remoteName !== entry.remoteName || row.syncMode !== entry.syncMode || row.userId !== entry.userId) {
        sessions.delete(key);
        teardown(entry);
      }
    }
    for (const [key, row] of wanted) {
      if (sessions.size >= options.maxSessions) break;
      if (!sessions.has(key)) startSession(row);
    }
    for (const key of [...stopRequests.keys()]) if (stopRequests.get(key)! < startedAt) stopRequests.delete(key);
  }

  // Overlapping triggers coalesce into one follow-up pass.
  function reconcile() {
    if (!running) return Promise.resolve();
    if (reconciling) { again = true; return reconciling; }
    reconciling = (async () => {
      try {
        do { again = false; await reconcileOnce(); } while (again && running);
      } catch (error) {
        log(`[MAIL IDLE] Eligibility check failed: ${(error as Error).message}`);
      } finally { reconciling = null; }
    })();
    return reconciling;
  }

  function start() {
    if (running || options.maxSessions < 1) return Promise.resolve();
    running = true;
    pollTimer = unref(timers.setInterval(() => { void reconcile(); }, options.pollMs));
    return reconcile();
  }

  function stop() {
    running = false;
    if (pollTimer) timers.clearInterval(pollTimer);
    pollTimer = null;
    for (const [key, entry] of [...sessions]) { sessions.delete(key); teardown(entry); }
  }

  // Healthy: the session is selected on INBOX and listening. The periodic
  // INBOX follow-up relaxes only while this holds.
  function isHealthy(accountId: unknown) {
    const entry = sessions.get(String(accountId || ''));
    return !!entry && entry.state === 'idling' && !!entry.client && entry.client.usable !== false && !entry.client.isClosed;
  }

  function status() {
    return [...sessions.values()].map(entry => ({ accountId: entry.accountId, state: entry.state,
      failures: entry.failures, retryAt: entry.retryAt }));
  }

  return { start, stop, stopAccount, refresh: reconcile, isHealthy, status,
    blocked: () => new Map(blocked), size: () => sessions.size, options };
}

// One row per eligible account: active, connected, no pause of any kind
// (module, settings, recovery, canary hold), a mapped INBOX, mail module and
// background sync on, no mail restore running. Both modes import new INBOX mail.
async function defaultListEligible() {
  const { db }: typeof import('../state') = require('../state');
  const { getBackgroundPausedModulesByUser } = require('./module-settings') as typeof import('./module-settings');
  const { getActiveRestoreSectionsByUser } = require('./restore-locks') as typeof import('./restore-locks');
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT a.id, a.user_id, a.sync_mode, a.imap_host, a.imap_port, a.username,
      a.email_address, a.encrypted_password, a.allow_self_signed, a.trusted_imap_fingerprint256,
      m.id AS mailbox_id, m.remote_name
    FROM mail_accounts a
    JOIN mail_remote_mailboxes m ON m.mail_account_id = a.id AND m.user_id = a.user_id AND m.state = 'active'
    JOIN mail_folder_remote_boxes b ON b.mail_account_id = m.mail_account_id AND BINARY b.remote_name = BINARY m.remote_name
    JOIN mail_folders f ON f.id = b.folder_id AND f.user_id = m.user_id AND f.slug = 'inbox'
    LEFT JOIN mail_engine_accounts e ON e.mail_account_id = a.id
    WHERE a.is_active = TRUE AND a.disconnected_at IS NULL AND e.paused_reason IS NULL
      AND a.sync_mode IN ('sync','download')
    ORDER BY a.id, (BINARY m.remote_name = BINARY 'INBOX') DESC, m.id`);
  if (!rows.length) return [];
  const paused = await getBackgroundPausedModulesByUser();
  const restoring = await getActiveRestoreSectionsByUser();
  return rows.filter(row => !paused.get(row.user_id)?.has('mail') && !restoring.get(row.user_id)?.has('mail'))
    .map(row => ({ accountId: String(row.id), userId: row.user_id, syncMode: row.sync_mode, mailboxId: row.mailbox_id,
      remoteName: row.remote_name, fingerprint: fingerprint(row as RowDataPacket & Parameters<typeof fingerprint>[0]) }));
}

// Same host policy, pinned address and TLS trust decision as every job; the
// account row is re-read so a reconnect never uses stale credentials.
async function defaultConnect(entry: Eligible) {
  const { db }: typeof import('../state') = require('../state');
  const [[account]] = await db.execute<RowDataPacket[]>('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ? AND is_active = TRUE AND disconnected_at IS NULL',
    [entry.accountId, entry.userId]);
  if (!account) throw new Error('Mail account no longer active');
  const config: Parameters<typeof import('./mail-imap-client').connectImap>[0] | null = await (require('./mail-host-policy') as typeof import('./mail-host-policy')).buildImapConnectionConfig(account as RowDataPacket & Parameters<typeof import('./mail-host-policy').buildImapConnectionConfig>[0], { keepalive: true });
  if (!config) throw Object.assign(new Error('Mail credentials unavailable'), { authenticationFailed: true });
  config.imap.idleRestartMs = DEFAULTS.idleRestartMs;
  return (require('./mail-imap-client') as typeof import('./mail-imap-client')).connectImap(config);
}

const idleSupervisor = createIdleSupervisor();

export { createIdleSupervisor, idleSupervisor, kindsFor, supportsIdle, defaultListEligible, DEFAULTS };
