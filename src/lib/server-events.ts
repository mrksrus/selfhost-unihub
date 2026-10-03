import type { QueryClient } from '@tanstack/react-query';
import { mailQueryKeys } from '@/lib/mail-api';

// Live status updates from GET /api/events (Server-Sent Events). Events are
// hints: each one only marks the matching queries stale, and the normal API
// requests fetch the authoritative state. Polling stays as the fallback while
// the stream is unavailable.

export const SERVER_EVENTS_PATH = `${import.meta.env.VITE_API_URL || '/api'}/events`;

export interface MailJobEvent { accountId: string; jobId: string | null; kind: string | null; state: string; phase: string | null; processed: number | null; total: number | null }
export interface MailOperationEvent { accountId: string | null; operationIds: string[]; state: string | null }
export interface MailChangedEvent { accountId: string | null; reason: string | null }

/** Polling intervals while the live stream is connected (a slow safety net). */
export const LIVE_POLL_MS = { syncJobs: 60_000, writebacks: 60_000, mailList: 300_000 } as const;

const SYNC_JOBS_KEY = ['mail-sync-jobs'] as const;
// Calendar sync changes events, calendars, account status and the mail account's calendar section.
const CALENDAR_ROOTS = new Set(['calendar-events', 'calendar-accounts', 'calendar-calendars', 'upcoming-events', 'mail-calendar']);
const COUNT_ROOTS = new Set(['mail-unread-counts', 'dashboard-unread-mail', 'email-count', 'stats']);
// Refetches of one kind of query start at most this often, however many events arrive.
const COALESCE_MS = 1500;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 5 * 60_000;
// A connection that stayed open this long resets the backoff.
const STABLE_MS = 30_000;

type Group = 'jobs' | 'writebacks' | 'lists' | 'calendar';

interface Options {
  client: QueryClient;
  onConnectedChange: (connected: boolean) => void;
  url?: string;
  EventSourceImpl?: typeof EventSource;
  random?: () => number;
  doc?: Document;
  win?: Window;
}

function parse<T>(event: Event): T | null {
  try {
    const value = JSON.parse(String((event as MessageEvent).data));
    return value && typeof value === 'object' ? value as T : null;
  } catch {
    return null;
  }
}

/** Starts the stream and returns its stop function. */
export function startServerEvents({
  client, onConnectedChange, url = SERVER_EVENTS_PATH,
  EventSourceImpl = globalThis.EventSource, random = Math.random,
  doc = document, win = window,
}: Options): () => void {
  if (typeof EventSourceImpl !== 'function') return () => {};
  let source: EventSource | null = null;
  let stopped = false;
  let connected = false;
  let everConnected = false;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  const lastRun = new Map<Group, number>();
  const timers = new Map<Group, ReturnType<typeof setTimeout>>();
  const due = new Set<Group>();
  // Accounts whose lists changed; '*' stands for every account.
  const changedAccounts = new Set<string>();
  let foldersChanged = false;

  const setConnected = (value: boolean) => {
    if (connected === value) return;
    connected = value;
    onConnectedChange(value);
  };

  function run(group: Group) {
    timers.delete(group);
    due.delete(group);
    lastRun.set(group, Date.now());
    if (group === 'jobs') void client.invalidateQueries({ queryKey: SYNC_JOBS_KEY });
    if (group === 'writebacks') void client.invalidateQueries({ queryKey: mailQueryKeys.writebacks });
    if (group === 'calendar') void client.invalidateQueries({ predicate: query => CALENDAR_ROOTS.has(String(query.queryKey[0])) });
    if (group === 'lists') {
      const accounts = new Set(changedAccounts);
      const folders = foldersChanged;
      changedAccounts.clear();
      foldersChanged = false;
      void client.invalidateQueries({ predicate: query => {
        const [root, account] = query.queryKey;
        if (COUNT_ROOTS.has(String(root))) return true;
        if (folders && root === mailQueryKeys.folders[0]) return true;
        return root === mailQueryKeys.all[0] && (accounts.has('*') || account === 'all' || accounts.has(String(account)));
      } });
    }
  }

  // A hidden tab keeps the stream but defers refetches until it is visible.
  function schedule(group: Group) {
    due.add(group);
    if (doc.visibilityState === 'hidden' || timers.has(group)) return;
    const wait = (lastRun.get(group) ?? -Infinity) + COALESCE_MS - Date.now();
    if (wait <= 0) run(group);
    else timers.set(group, setTimeout(() => run(group), wait));
  }

  const onVisible = () => {
    if (doc.visibilityState !== 'visible') return;
    for (const group of [...due]) if (!timers.has(group)) schedule(group);
  };

  function catchUp() {
    // Events sent while the stream was down are lost; refetch what they cover.
    changedAccounts.add('*');
    foldersChanged = true;
    schedule('jobs');
    schedule('writebacks');
    schedule('lists');
    schedule('calendar');
  }

  function close() {
    clearTimeout(stableTimer);
    source?.close();
    source = null;
    setConnected(false);
  }

  function reconnectLater(minimumMs = 0) {
    if (stopped) return;
    clearTimeout(retryTimer);
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 12));
    attempts++;
    // Jitter spreads reconnects of many tabs after a server restart.
    const delay = Math.max(minimumMs, Math.round(ceiling / 2 + random() * ceiling / 2));
    retryTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (stopped) return;
    clearTimeout(retryTimer);
    close();
    const current = new EventSourceImpl(url, { withCredentials: true });
    source = current;
    const live = (listener: (event: Event) => void) => (event: Event) => { if (source === current) listener(event); };
    current.addEventListener('ready', live(() => {
      setConnected(true);
      if (everConnected) catchUp();
      everConnected = true;
      clearTimeout(stableTimer);
      stableTimer = setTimeout(() => { attempts = 0; }, STABLE_MS);
    }));
    current.addEventListener('mail.job', live(() => schedule('jobs')));
    current.addEventListener('mail.operation', live(() => schedule('writebacks')));
    current.addEventListener('mail.changed', live(event => {
      const data = parse<MailChangedEvent>(event);
      changedAccounts.add(data?.accountId ? String(data.accountId) : '*');
      if (data?.reason === 'folders' || data?.reason === 'operation') foldersChanged = true;
      schedule('lists');
    }));
    current.addEventListener('calendar.changed', live(() => schedule('calendar')));
    current.addEventListener('end', live(event => {
      const reason = parse<{ reason?: string }>(event)?.reason;
      close();
      // A signed-out or revoked session must not reconnect; the next API
      // request reports it and the session provider is replaced.
      if (reason === 'session_ended' || reason === 'signed_out') { stopped = true; return; }
      reconnectLater(reason === 'shutdown' ? 5000 : 0);
    }));
    // Close on any error and reconnect on our own schedule: the browser's
    // automatic retry neither backs off nor recovers from a refused (429/401)
    // response.
    current.onerror = live(() => {
      close();
      reconnectLater();
    });
  }

  const onOnline = () => {
    if (stopped || connected) return;
    attempts = 0;
    connect();
  };

  doc.addEventListener('visibilitychange', onVisible);
  win.addEventListener('online', onOnline);
  connect();

  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    doc.removeEventListener('visibilitychange', onVisible);
    win.removeEventListener('online', onOnline);
    close();
  };
}
