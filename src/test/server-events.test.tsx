import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { ServerEventsProvider } from '@/components/ServerEventsProvider';
import { SessionQueryProvider } from '@/components/SessionQueryProvider';
import { useServerEventsConnected } from '@/hooks/use-server-events';
import { useMailSyncJobs, type MailSyncJob } from '@/hooks/use-mail-sync-jobs';
import { setOfflineMode } from '@/lib/offline';
import type { MailAccount } from '@/lib/mail-api';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

class MockEventSource {
  static instances: MockEventSource[] = [];
  listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(public url: string, public init?: EventSourceInit) { MockEventSource.instances.push(this); }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() { this.closed = true; }
  emit(type: string, data: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  fail() { this.onerror?.(new Event('error')); }
  static get latest() { return MockEventSource.instances[MockEventSource.instances.length - 1]; }
}

let client: QueryClient;
let hidden = false;
const tick = (ms = 10) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const emit = (type: string, data: unknown = {}) => act(() => { MockEventSource.latest.emit(type, data); });

function Status() {
  return <div>{useServerEventsConnected() ? 'live' : 'polling'}</div>;
}
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}><ServerEventsProvider enabled>{children}</ServerEventsProvider></QueryClientProvider>
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  vi.clearAllMocks();
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  hidden = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  setOfflineMode(false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('live status stream', () => {
  it('opens one credentialed stream per session and reports when it is live', async () => {
    render(<Status />, { wrapper });
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.latest.url).toBe('/api/events');
    expect(MockEventSource.latest.init).toEqual({ withCredentials: true });
    expect(screen.getByText('polling')).toBeInTheDocument();
    await emit('ready', { v: 1 });
    expect(screen.getByText('live')).toBeInTheDocument();
  });

  it('opens no stream unless the session asks for live updates, and closes it with the session', () => {
    const view = render(<SessionQueryProvider><Status /></SessionQueryProvider>);
    expect(MockEventSource.instances).toHaveLength(0);
    view.rerender(<SessionQueryProvider key="b" liveUpdates><Status /></SessionQueryProvider>);
    expect(MockEventSource.instances).toHaveLength(1);
    view.rerender(<SessionQueryProvider key="c" liveUpdates><Status /></SessionQueryProvider>);
    expect(MockEventSource.instances[0].closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);
    view.unmount();
    expect(MockEventSource.instances[1].closed).toBe(true);
  });

  it('turns job, operation and list events into coalesced query invalidations', async () => {
    renderHook(() => useQueryClient(), { wrapper });
    await emit('ready');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await emit('mail.job', { accountId: 'a', state: 'running' });
    await emit('mail.job', { accountId: 'a', state: 'running' });
    await emit('mail.job', { accountId: 'a', state: 'idle' });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ['mail-sync-jobs'] });
    await tick(1500);
    expect(invalidate).toHaveBeenCalledTimes(2);
    await emit('mail.operation', { accountId: 'a', operationIds: ['op'], state: 'confirmed' });
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ['mail-writebacks'] });
  });

  it('refreshes only the lists of the changed account plus counts', async () => {
    const queries = [['emails', 'a', 'inbox', 1, '', false], ['emails', 'b', 'inbox', 1, '', false], ['emails', 'all', 'inbox', 1, '', false],
      ['mail-unread-counts', 'a'], ['mail-folders'], ['contacts']];
    for (const key of queries) client.setQueryData(key, { emails: [] });
    renderHook(() => useQueryClient(), { wrapper });
    await emit('ready');
    await emit('mail.changed', { accountId: 'a', reason: 'import' });
    const stale = queries.filter(key => client.getQueryState(key)?.isInvalidated).map(key => key.slice(0, 2).join(':'));
    expect(stale).toEqual(['emails:a', 'emails:all', 'mail-unread-counts:a']);
  });

  it('does not refetch while the tab is hidden and catches up when it is shown', async () => {
    renderHook(() => useQueryClient(), { wrapper });
    await emit('ready');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    hidden = true;
    await emit('mail.job', { accountId: 'a', state: 'running' });
    await tick(5000);
    expect(invalidate).not.toHaveBeenCalled();
    hidden = false;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mail-sync-jobs'] });
  });

  it('backs off exponentially after errors and catches up after reconnecting', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    render(<Status />, { wrapper });
    await emit('ready');
    act(() => MockEventSource.latest.fail());
    expect(screen.getByText('polling')).toBeInTheDocument();
    expect(MockEventSource.instances[0].closed).toBe(true);
    await tick(1999);
    expect(MockEventSource.instances).toHaveLength(1);
    await tick(1);
    expect(MockEventSource.instances).toHaveLength(2);
    act(() => MockEventSource.latest.fail());
    await tick(3999);
    expect(MockEventSource.instances).toHaveLength(2);
    await tick(1);
    expect(MockEventSource.instances).toHaveLength(3);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await emit('ready');
    expect(screen.getByText('live')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mail-sync-jobs'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mail-writebacks'] });
  });

  it('never reconnects a stream the server ended for a signed-out session', async () => {
    render(<Status />, { wrapper });
    await emit('ready');
    await emit('end', { reason: 'session_ended' });
    expect(screen.getByText('polling')).toBeInTheDocument();
    await tick(10 * 60_000);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('waits before reconnecting after a server shutdown', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    render(<Status />, { wrapper });
    await emit('ready');
    await emit('end', { reason: 'shutdown' });
    await tick(4999);
    expect(MockEventSource.instances).toHaveLength(1);
    await tick(1);
    expect(MockEventSource.instances).toHaveLength(2);
  });
});

describe('polling fallback', () => {
  const accounts: MailAccount[] = [{ id: 'account', email_address: 'person@example.test', display_name: 'Test', provider: 'custom', is_active: true, last_synced_at: null }];
  const job = (state: MailSyncJob['state']): MailSyncJob => ({ account_id: 'account', state, processed: 0,
    phase: null, total: null, started_at: null, updated_at: null, error: null });

  it('slows status polling while live and restores it when the stream fails', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { accounts: [job('running')] } });
    renderHook(() => useMailSyncJobs(accounts), { wrapper });
    await tick();
    expect(api.get).toHaveBeenCalledTimes(1);
    await emit('ready');
    await tick(30_000);
    expect(api.get).toHaveBeenCalledTimes(1);
    // A job event refetches immediately instead of waiting for a poll.
    await emit('mail.job', { accountId: 'account', state: 'running' });
    await tick();
    expect(api.get).toHaveBeenCalledTimes(2);
    act(() => MockEventSource.latest.fail());
    await tick(3000);
    expect(api.get).toHaveBeenCalledTimes(3);
  });
});
